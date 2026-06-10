// lib/ingest.js — JSONL scanner/parser, incremental ingest, fs.watch.
// Streams files line-by-line from a stored byte offset; never loads a whole file.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
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
  // Sanity window: garbage timestamps (year 9999, epoch 0) would permanently
  // skew heatmap/burn buckets. Allow 24h of clock skew into the future.
  if (!Number.isFinite(ts) || ts < 1262304000000 /* 2010-01-01 */ || ts > Date.now() + 86400000) return;
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
    ctx.lineEffects.push({ uuid: obj.uuid, sid: sessionId, kind: 'user', ts });
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
    if (hasTools) ctx.lineEffects.push({ uuid: obj.uuid, sid: sessionId, kind: 'tools', tools: toolCounts, ts });
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
  //
  // Lines are split on raw bytes (0x0a), NOT on a decoded string: invalid
  // UTF-8 decodes to 3-byte U+FFFD replacements, which would inflate
  // string-based byte math and permanently skip valid trailing lines.
  const stream = fs.createReadStream(filePath, { flags: 'r', start: offset, end: size - 1 });

  let consumed = offset;
  const parseBuf = (b) => {
    // Strip a UTF-8 BOM at the very start of the file (parse input only —
    // the byte math still counts the real bytes).
    if (consumed === 0 && b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) b = b.subarray(3);
    if (!b.length) return null;
    try { return JSON.parse(b.toString('utf8')); } catch { return null; }
  };

  let parts = []; // accumulated chunks that contain no newline yet
  for await (const chunk of stream) {
    let buf = chunk;
    let nl = buf.indexOf(0x0a);
    if (nl === -1) { parts.push(buf); continue; }
    if (parts.length) {
      parts.push(buf);
      buf = Buffer.concat(parts);
      parts = [];
      nl = buf.indexOf(0x0a);
    }
    while (nl !== -1) {
      const obj = parseBuf(buf.subarray(0, nl));
      if (obj !== null) handleLine(obj, ctx);
      consumed += nl + 1;
      buf = buf.subarray(nl + 1);
      nl = buf.indexOf(0x0a);
    }
    if (buf.length) parts = [buf];
  }
  // Tail with no trailing newline (end of file, or a write caught mid-line).
  const tail = parts.length === 1 ? parts[0] : Buffer.concat(parts);
  if (tail.length) {
    const obj = parseBuf(tail);
    if (obj !== null) {
      handleLine(obj, ctx);
      consumed = size;
    }
    // else: truncated mid-write — leave the offset before it, retry later
  }

  // Write phase: one synchronous transaction per file.
  const inserted = [];
  db.begin();
  try {
    for (const row of ctx.candidates) {
      // Per-row guard: one unbindable row must skip, not roll back the whole
      // file and permanently block every line after it.
      let isNew = false;
      try { isNew = db.insertMessage(row); }
      catch (err) { console.error(`[ingest] skipped row ${row.msg_id}: ${err.message}`); continue; }
      if (isNew) {
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
    // user_msgs / tools: count each line once ever, keyed on its uuid.
    // Lines without a uuid get a deterministic fallback key so shrink/replay
    // re-reads can't double-count them (identical no-uuid lines collapse —
    // the conservative choice for malformed input).
    for (const e of ctx.lineEffects) {
      const key = e.uuid || `nouuid:${e.sid}:${e.kind}:${e.ts}`;
      if (!db.markLineSeen(key)) continue;
      const s = ctx.sessions.get(e.sid);
      if (!s) continue;
      if (e.kind === 'user') s.user_msgs++;
      else for (const [k, v] of Object.entries(e.tools)) s.tools[k] = (s.tools[k] || 0) + v;
    }
    for (const s of ctx.sessions.values()) {
      const ex = db.getSession(s.id);
      // A session that accumulated nothing real this pass (e.g. every message
      // deduped to another file) must not be created as a phantom zero row.
      if (!ex && !s.assistant_msgs && !s.user_msgs && !s.first_prompt
          && !Object.keys(s.tools).length) continue;
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
