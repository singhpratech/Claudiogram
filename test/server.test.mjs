// Battle tests for the HTTP layer: hostile paths must get clean errors and the
// process must survive them. Runs a real server, sandboxed via env overrides
// (tmp data dir + tmp projects dir) so it never touches real transcripts or DB.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-srv-'));
fs.mkdirSync(path.join(TMP, 'projects'), { recursive: true });

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

let child, base;
before(async () => {
  const port = await freePort();
  base = `http://localhost:${port}`;
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      CLAUDIOGRAM_DATA_DIR: path.join(TMP, 'data'),
      CLAUDIOGRAM_PROJECTS_DIR: path.join(TMP, 'projects'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Wait until it answers (empty projects dir → boots in well under a second).
  for (let i = 0; i < 100; i++) {
    try { await fetch(base + '/', { signal: AbortSignal.timeout(500) }); return; }
    catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('server did not come up');
});
after(async () => {
  if (child && child.exitCode === null) {
    const gone = new Promise((resolve) => child.once('exit', resolve));
    child.kill();
    await gone; // Windows: the data dir stays locked until the child fully exits
  }
  fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test('serves the app shell', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /CLAUDIOGRAM|<!DOCTYPE html>/i);
});

test('null byte in path → 400, process survives', async () => {
  const res = await fetch(base + '/%00x');
  assert.equal(res.status, 400);
  assert.equal((await fetch(base + '/')).status, 200, 'server must still be alive');
});

test('path traversal cannot escape public/', async () => {
  for (const p of ['/../server.js', '/..%2f..%2fserver.js', '/%2e%2e/%2e%2e/etc/passwd']) {
    const res = await fetch(base + p);
    assert.notEqual(res.status, 200, `${p} must not be served`);
  }
  // Belt and braces: even if something slipped through, it must not be file content.
  const probe = await fetch(base + '/..%2flib%2fdb.js');
  if (probe.status === 200) assert.doesNotMatch(await probe.text(), /DatabaseSync/);
});

test('unknown API route → 404 JSON, not a crash', async () => {
  const res = await fetch(base + '/api/nope');
  assert.equal(res.status, 404);
});

test('API works against an empty database (fresh-install path)', async () => {
  const res = await fetch(base + '/api/summary');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(typeof body.totals, 'object', 'summary must have totals even with zero data');
});
