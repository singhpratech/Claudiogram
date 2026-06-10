// Battle tests for the ingest invariants (CLAUDE.md "do not break these"):
//   1. transcripts are READ-ONLY — ingest must never modify, create, or delete
//      anything under the projects dir (fixtures are chmod 444 to prove it)
//   2. usage/cost counted once per message.id (multi-line API responses)
//   3. user_msgs / tools counted once per line uuid
//   4. re-ingest after shrink (compaction) and replay (session resume) converges
//
// Runs fully sandboxed: CLAUDIOGRAM_DATA_DIR + fixture projects dir in tmp.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-test-'));
process.env.CLAUDIOGRAM_DATA_DIR = path.join(TMP, 'data');
const PROJECTS = path.join(TMP, 'projects');
const PROJ_DIR = path.join(PROJECTS, '-Users-test-myproj');
fs.mkdirSync(PROJ_DIR, { recursive: true });

// Import AFTER env is set — db.js resolves its path at module load.
const { fullScan } = await import('../lib/ingest.js');
const { db } = await import('../lib/db.js');

const FILE = path.join(PROJ_DIR, 'sess1.jsonl');
const CWD = '/Users/test/myproj';
const T = (s) => `2026-06-01T10:00:${String(s).padStart(2, '0')}.000Z`;
const line = (o) => JSON.stringify(o) + '\n';

// One API response spread over three JSONL lines (real Claude Code shape):
// same message.id + usage on every line, distinct line uuids.
const USAGE = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const L = {
  user: line({ type: 'user', uuid: 'u1', sessionId: 'sess1', timestamp: T(0), cwd: CWD,
    message: { role: 'user', content: 'hello world' } }),
  asText: line({ type: 'assistant', uuid: 'a1', sessionId: 'sess1', timestamp: T(5), cwd: CWD,
    message: { id: 'msg_01', model: 'claude-opus-4-8', usage: USAGE, content: [{ type: 'text', text: 'hi' }] } }),
  asBash: line({ type: 'assistant', uuid: 'a2', sessionId: 'sess1', timestamp: T(6), cwd: CWD,
    message: { id: 'msg_01', model: 'claude-opus-4-8', usage: USAGE, content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } }),
  asRead: line({ type: 'assistant', uuid: 'a3', sessionId: 'sess1', timestamp: T(7), cwd: CWD,
    message: { id: 'msg_01', model: 'claude-opus-4-8', usage: USAGE, content: [{ type: 'tool_use', id: 't2', name: 'Read', input: {} }] } }),
  synthetic: line({ type: 'assistant', uuid: 'a4', sessionId: 'sess1', timestamp: T(8), cwd: CWD,
    message: { id: 'msg_02', model: '<synthetic>', usage: USAGE, content: [{ type: 'text', text: 'x' }] } }),
};
const ALL = L.user + L.asText + L.asBash + L.asRead + L.synthetic;

const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const counters = () => {
  const m = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(input_tokens + output_tokens), 0) AS tok FROM messages`).get();
  const s = db.prepare(`SELECT user_msgs, assistant_msgs, tokens, tools FROM sessions WHERE id = 'sess1'`).get();
  return { msgRows: Number(m.n), tokens: Number(m.tok), user_msgs: Number(s.user_msgs),
    assistant_msgs: Number(s.assistant_msgs), sessTokens: Number(s.tokens), tools: JSON.parse(s.tools || '{}') };
};

let fixtureHash;
before(() => {
  fs.writeFileSync(FILE, ALL);
  fs.chmodSync(FILE, 0o444); // write-protected: ingest must cope with read-only sources
  fixtureHash = sha(FILE);
});
after(() => {
  fs.chmodSync(FILE, 0o644); // Windows: read-only attribute blocks deletion
  try { db.close(); } catch {} // Windows: can't remove a dir holding an open usage.db
  fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test('initial ingest: usage once per message.id, tools per line, synthetic skipped', async () => {
  await fullScan({ dir: PROJECTS });
  const c = counters();
  assert.equal(c.msgRows, 1, 'three lines, one message.id → one usage row');
  assert.equal(c.tokens, 150, 'tokens counted once, not 3×');
  assert.equal(c.user_msgs, 1);
  assert.equal(c.assistant_msgs, 1);
  assert.deepEqual(c.tools, { Bash: 1, Read: 1 }, 'tool blocks counted per line');
});

test('transcripts untouched: same bytes, same dir listing, still chmod 444', () => {
  assert.equal(sha(FILE), fixtureHash, 'transcript bytes must be identical after ingest');
  assert.deepEqual(fs.readdirSync(PROJ_DIR), ['sess1.jsonl'], 'nothing created or deleted in the projects dir');
  assert.equal(fs.statSync(FILE).mode & 0o777, 0o444, 'permissions unchanged');
});

test('re-scan with no changes is a no-op', async () => {
  const beforeC = counters();
  await fullScan({ dir: PROJECTS });
  assert.deepEqual(counters(), beforeC);
});

test('shrink (compaction) then re-ingest converges — no double counting', async () => {
  const beforeC = counters();
  fs.chmodSync(FILE, 0o644);
  fs.writeFileSync(FILE, L.user + L.asText); // file got SMALLER → offset reset, full re-read
  await fullScan({ dir: PROJECTS });
  assert.deepEqual(counters(), beforeC, 'counters must not grow on shrink-triggered re-read');
});

test('session resume replays old lines — only genuinely new data counts', async () => {
  const beforeC = counters();
  // Resume appends: replayed old lines (same uuids/msg id) + one new exchange.
  const fresh =
    line({ type: 'user', uuid: 'u2', sessionId: 'sess1', timestamp: T(20), cwd: CWD,
      message: { role: 'user', content: 'second question' } }) +
    line({ type: 'assistant', uuid: 'a5', sessionId: 'sess1', timestamp: T(25), cwd: CWD,
      message: { id: 'msg_03', model: 'claude-opus-4-8', usage: USAGE, content: [{ type: 'tool_use', id: 't3', name: 'Bash', input: {} }] } });
  fs.writeFileSync(FILE, L.user + L.asText + L.asBash + L.asRead + fresh);
  await fullScan({ dir: PROJECTS });
  const c = counters();
  assert.equal(c.msgRows, beforeC.msgRows + 1, 'exactly one new usage row (msg_03)');
  assert.equal(c.tokens, beforeC.tokens + 150);
  assert.equal(c.user_msgs, beforeC.user_msgs + 1, 'replayed u1 not recounted');
  assert.deepEqual(counters().tools, { Bash: 2, Read: 1 }, 'replayed a2/a3 tool lines not recounted');
});

test('truncated trailing line is left for the next pass, then picked up', async () => {
  const beforeC = counters();
  const full = fs.readFileSync(FILE, 'utf8');
  const extra = line({ type: 'assistant', uuid: 'a6', sessionId: 'sess1', timestamp: T(30), cwd: CWD,
    message: { id: 'msg_04', model: 'claude-opus-4-8', usage: USAGE, content: [{ type: 'text', text: 'y' }] } });
  fs.writeFileSync(FILE, full + extra.slice(0, 40)); // mid-write: invalid JSON tail
  await fullScan({ dir: PROJECTS });
  assert.equal(counters().msgRows, beforeC.msgRows, 'partial line must not be ingested');
  fs.writeFileSync(FILE, full + extra); // write completes
  await fullScan({ dir: PROJECTS });
  assert.equal(counters().msgRows, beforeC.msgRows + 1, 'completed line ingested exactly once');
});
