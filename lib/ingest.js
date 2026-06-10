// lib/ingest.js — JSONL scanner/parser, incremental ingest, fs.watch.
// Streams files line-by-line from a stored byte offset; never loads a whole file.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { performance } from 'node:perf_hooks';
import * as db from './db.js';
import { normalizeUsage, costForTokens } from './pricing.js';

// CLAUDIOGRAM_PROJECTS_DIR lets the test suite point ingest at a fixture dir.
const DEFAULT_DIR = process.env.CLAUDIOGRAM_PROJECTS_DIR
  || path.join(os.homedir(), '.claude', 'projects');
const DEBOUNCE_MS = 500;

// Serialize all ingest work so SQLite transactions never overlap
// (fullScan + multiple debounced watcher fires can race otherwise).
let chain = Promise.resolve();
function serialize(fn) {
  const run = chain.then(fn, fn);
  chain = run.then(() => undefined, () => undefined);
  return run;
}

// ---------------------------------------------------------------------------
// Line parsing helpers
// ---------------------------------------------------------------------------

function fallbackProject(dirName) {
  const segs = String(dirName).split('-').filter(Boolean);
  return segs.length ? segs[segs.length - 1] : String(dirName || 'unknown');
}

/**
 * Extract the user-visible text of a user line, or null if it has none
 * (e.g. a pure tool_result array). Used for user_msgs counting + first prompt.
 */
function userText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const block = content.find((b) => b && b.type === 'text' && typeof b.text === 'string');
    return block ? block.text : null;
  }
  return null;
}

/** First-prompt rule: non-meta user text that does not start with '<'. */
function promptCandidate(text) {
  const t = text.trim();
  if (!t || t.startsWith('<')) return null;
  return t.slice(0, 200);
}

function getSessionAgg(map, id, project, ts) {
  let s = map.get(id);
  if (!s) {
    s = {
      id,
      project,
      first_ts: ts,
      last_ts: ts,
      assistant_msgs: 0,
      user_msgs: 0,
      tokens: 0,
      cost: 0,
      first_prompt: null,
      first_prompt_ts: Infinity,
      tools: {},
      models: {},
    };
    map.set(id, s);
  }
  if (ts < s.first_ts) s.first_ts = ts;
  if (ts > s.last_ts) s.last_ts = ts;
  if (project && !s.project) s.project = project;
  return s;
}

/**
 * Parse one JSONL object. Mutates `ctx.sessions` (parse-phase aggregates) and
 * pushes assistant usage candidates onto `ctx.candidates`.
 */
function handleLine(obj, ctx) {
  const type = obj.type;
  if (type !== 'assistant' && type !== 'user') return; // mode/summary/system/...

  const ts = Date.parse(obj.timestamp);
  if (!Number.isFinite(ts)) return;
  const sessionId = typeof obj.sessionId === 'string' && obj.sessionId ? obj.sessionId : ctx.fileSession;
  if (!sessionId) return;

  let project;
  if (typeof obj.cwd === 'string' && obj.cwd) {
    project = path.basename(obj.cwd) || obj.cwd;
    ctx.project = project; // cwd is reliable; remember it for lines without one
  } else {
    project = ctx.project || fallbackProject(ctx.dirName);
  }

  const s = getSessionAgg(ctx.sessions, sessionId, project, ts);
  const msg = obj.message || {};

  if (type === 'user') {
    if (obj.isMeta) return;
    const text = userText(msg.content);
    if (text === null) return; // tool_result-only line, not a user message
    // Counting is deferred to the write phase, gated on the line uuid, so a
    // re-read (shrink/compaction) or a resumed-session replay never double-counts.
    ctx.lineEffects.push({ uuid: obj.uuid, sid: sessionId, kind: 'user' });
    const prompt = promptCandidate(text);
    if (prompt && ts < s.first_prompt_ts) {
      s.first_prompt = prompt;
      s.first_prompt_ts = ts;
    }
    return;
  }

  // assistant line — tools counted per line (lines are distinct blocks),
  // gated on line uuid in the write phase like user_msgs above
  if (Array.isArray(msg.content)) {
    const toolCounts = {};
    let hasTools = false;
    for (const b of msg.content) {
      if (b && b.type === 'tool_use' && typeof b.name === 'string' && b.name) {
        toolCounts[b.name] = (toolCounts[b.name] || 0) + 1;
        hasTools = true;
      }
    }
    if (hasTools) ctx.lineEffects.push({ uuid: obj.uuid, sid: sessionId, kind: 'tools', tools: toolCounts });
  }

  const model = msg.model;
  if (typeof model !== 'string' || !model || model === '<synthetic>') return;
  const usage = msg.usage;
  if (!usage || typeof usage !== 'object') return;
  const msgId = (typeof msg.id === 'string' && msg.id) ? msg.id : obj.uuid;
  if (!msgId) return;

  const n = normalizeUsage(usage);
  ctx.candidates.push({
    msg_id: msgId,
    session_id: sessionId,
    project,
    ts,
    model,
    input_tokens: n.input,
    output_tokens: n.output,
    cache_read_tokens: n.cacheRead,
    cache_w5m_tokens: n.cacheW5m,
    cache_w1h_tokens: n.cacheW1h,
    cost: costForTokens(model, n),
    is_sidechain: obj.isSidechain ? 1 : 0,
  });
}

// ---------------------------------------------------------------------------
// Per-file incremental ingest
// ---------------------------------------------------------------------------

/**
 * Ingest one .jsonl file from its stored byte offset.
 * Returns { inserted: messageRow[], sessionsTouched: number }.
 */
async function ingestFile(filePath) {
  let st;
  try { st = fs.statSync(filePath); } catch { return { inserted: [], sessionsTouched: 0 }; }
  if (!st.isFile()) return { inserted: [], sessionsTouched: 0 };

  const meta = db.getFileMeta(filePath);
  let offset = meta ? meta.offset : 0;
  if (st.size < offset) offset = 0; // file shrank — re-read from scratch
  const size = st.size;
  if (size <= offset) {
    if (!meta || meta.size !== size || meta.mtime !== st.mtimeMs) {
      db.setFileMeta(filePath, size, offset, st.mtimeMs);
    }
    return { inserted: [], sessionsTouched: 0 };
  }

  const ctx = {
    dirName: path.basename(path.dirname(filePath)),
    fileSession: path.basename(filePath, '.jsonl'),
    project: null,
    sessions: new Map(),
    candidates: [],
    lineEffects: [],
  };

  // Cap the stream at the stat'd size so a file growing mid-read can't skew
  // the partial-tail detection; new bytes get picked up on the next event.
  // flags 'r' is the default, but stated explicitly: transcripts are opened
  // strictly read-only — this module must never be able to modify them.
  const stream = fs.createReadStream(filePath, { flags: 'r', start: offset, end: size - 1, encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let consumed = offset;
  for await (const line of rl) {
    const lineEnd = consumed + Buffer.byteLength(line, 'utf8') + 1; // +1 for '\n'
    const partialTail = lineEnd > size; // last line had no trailing newline
    if (line) {
      let obj = null;
      try { obj = JSON.parse(line); } catch { obj = null; }
      if (partialTail) {
        if (obj === null) break; // truncated mid-write — leave offset before it, retry later
        handleLine(obj, ctx);
        consumed = size;
        break;
      }
      if (obj !== null) handleLine(obj, ctx);
    }
    consumed = Math.min(lineEnd, size);
  }
  rl.close();

  // Write phase: one synchronous transaction per file.
  const inserted = [];
  db.begin();
  try {
    for (const row of ctx.candidates) {
      if (db.insertMessage(row)) {
        inserted.push(row);
        const s = ctx.sessions.get(row.session_id);
        if (s) {
          s.assistant_msgs++;
          s.tokens += row.input_tokens + row.output_tokens;
          s.cost += row.cost;
          s.models[row.model] = (s.models[row.model] || 0) + row.output_tokens;
        }
      }
    }
    // user_msgs / tools: count each line once ever, keyed on its uuid
    // (lines without a uuid can't be deduped and are counted unconditionally)
    for (const e of ctx.lineEffects) {
      if (e.uuid && !db.markLineSeen(e.uuid)) continue;
      const s = ctx.sessions.get(e.sid);
      if (!s) continue;
      if (e.kind === 'user') s.user_msgs++;
      else for (const [k, v] of Object.entries(e.tools)) s.tools[k] = (s.tools[k] || 0) + v;
    }
    for (const s of ctx.sessions.values()) {
      const ex = db.getSession(s.id);
      if (ex) {
        let tools = {};
        let models = {};
        try { tools = JSON.parse(ex.tools || '{}'); } catch { /* keep {} */ }
        try { models = JSON.parse(ex.models || '{}'); } catch { /* keep {} */ }
        for (const [k, v] of Object.entries(s.tools)) tools[k] = (tools[k] || 0) + v;
        for (const [k, v] of Object.entries(s.models)) models[k] = (models[k] || 0) + v;
        db.saveSession({
          id: s.id,
          project: ex.project || s.project,
          first_ts: ex.first_ts == null ? s.first_ts : Math.min(ex.first_ts, s.first_ts),
          last_ts: ex.last_ts == null ? s.last_ts : Math.max(ex.last_ts, s.last_ts),
          assistant_msgs: (ex.assistant_msgs || 0) + s.assistant_msgs,
          user_msgs: (ex.user_msgs || 0) + s.user_msgs,
          tokens: (ex.tokens || 0) + s.tokens,
          cost: (ex.cost || 0) + s.cost,
          first_prompt: ex.first_prompt ?? s.first_prompt,
          tools,
          models,
        });
      } else {
        db.saveSession(s);
      }
    }
    db.setFileMeta(filePath, size, consumed, st.mtimeMs);
    db.commit();
  } catch (err) {
    db.rollback();
    throw err;
  }

  return { inserted, sessionsTouched: ctx.sessions.size };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function listJsonlFiles(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(full);
    }
  }
  return out.sort();
}

/**
 * Scan every .jsonl under `dir` (default ~/.claude/projects), ingesting new
 * bytes incrementally. Returns { files, newMessages, ms }.
 */
export async function fullScan({ dir = DEFAULT_DIR } = {}) {
  return serialize(async () => {
    const t0 = performance.now();
    const files = listJsonlFiles(dir);
    let newMessages = 0;
    for (const f of files) {
      try {
        const res = await ingestFile(f);
        newMessages += res.inserted.length;
      } catch (err) {
        console.error(`[ingest] failed ${f}: ${err.message}`);
      }
    }
    return { files: files.length, newMessages, ms: Math.round(performance.now() - t0) };
  });
}

/**
 * Watch `dir` recursively; debounce 500ms per file; after each ingest batch
 * that changed anything, call onBatch(newMessages[]) with the inserted rows.
 * Returns { close() }.
 */
export function watch(onBatch, { dir = DEFAULT_DIR } = {}) {
  const timers = new Map();

  const fire = (filePath) => {
    timers.delete(filePath);
    serialize(() => ingestFile(filePath))
      .then(({ inserted, sessionsTouched }) => {
        if ((inserted.length > 0 || sessionsTouched > 0) && typeof onBatch === 'function') {
          onBatch(inserted);
        }
      })
      .catch((err) => console.error(`[watch] ingest failed ${filePath}: ${err.message}`));
  };

  const watcher = fs.watch(dir, { recursive: true }, (_event, filename) => {
    if (!filename || !filename.endsWith('.jsonl')) return;
    const full = path.join(dir, filename);
    const existing = timers.get(full);
    if (existing) clearTimeout(existing);
    timers.set(full, setTimeout(() => fire(full), DEBOUNCE_MS));
  });
  watcher.on('error', (err) => console.error(`[watch] watcher error: ${err.message}`));

  return {
    close() {
      watcher.close();
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    },
  };
}
