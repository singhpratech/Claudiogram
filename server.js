// server.js — node:http server: routing, static, SSE (contract: "HTTP API" section).
// Boot: full ingest scan → start watcher → listen.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as db from './lib/db.js';
import { fullScan, watch } from './lib/ingest.js';
import { getStory } from './lib/insights.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 4242;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-cache',
  });
  res.end(body);
}

function qNum(url, name) {
  const v = url.searchParams.get(name);
  if (v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function qStr(url, name) {
  const v = url.searchParams.get(name);
  return v === null || v === '' ? undefined : v;
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        // Don't destroy the socket here — the caller still needs to deliver
        // the 413 response on it. Pause so we stop buffering the flood.
        req.pause();
        const err = new Error('body too large');
        err.status = 413;
        reject(err);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

const sseClients = new Set();

function sseBroadcast(obj) {
  if (!sseClients.size) return;
  const frame = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of sseClients) res.write(frame);
}

setInterval(() => {
  for (const res of sseClients) res.write(': ping\n\n');
}, 25000).unref();

function handleEvents(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
}

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------

const routes = {
  'GET /api/summary': (url) => db.summary(qNum(url, 'from'), qNum(url, 'to')),

  'GET /api/timeseries': (url) => {
    let bucket = qStr(url, 'bucket') || 'day';
    if (!['day', 'week', 'month'].includes(bucket)) bucket = 'day';
    let by = qStr(url, 'by');
    if (by !== 'model' && by !== 'project') by = undefined;
    return db.timeseries({
      bucket,
      by,
      from: qNum(url, 'from'),
      to: qNum(url, 'to'),
      project: qStr(url, 'project'),
    });
  },

  // ?metric= accepted but ignored: the response carries both tokens and cost
  // per day, so the metric pivot happens client-side
  'GET /api/heatmap': () => db.heatmap(),

  'GET /api/punchcard': (url) => db.punchcard({
    from: qNum(url, 'from'),
    to: qNum(url, 'to'),
    project: qStr(url, 'project'),
  }),

  'GET /api/day': (url) => {
    const date = qStr(url, 'date');
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      const err = new Error('date param required as YYYY-MM-DD');
      err.status = 400;
      throw err;
    }
    return db.day(date);
  },

  'GET /api/projects': () => db.projects(),

  'GET /api/sessions': (url) => {
    let limit = qNum(url, 'limit') ?? 50;
    limit = Math.max(1, Math.min(500, Math.floor(limit)));
    let offset = qNum(url, 'offset') ?? 0;
    // Cap at MAX_SAFE_INTEGER: anything above int64 max binds as REAL and
    // SQLite's OFFSET clause throws a datatype mismatch.
    offset = Math.max(0, Math.min(Math.floor(offset), Number.MAX_SAFE_INTEGER));
    return db.sessions({
      from: qNum(url, 'from'),
      to: qNum(url, 'to'),
      project: qStr(url, 'project'),
      limit,
      offset,
    });
  },

  'GET /api/live': () => db.live(),

  'GET /api/burn': () => db.burn(),
};

async function handleStory(req, res) {
  let body = {};
  try {
    const raw = await readBody(req);
    if (raw) body = JSON.parse(raw);
  } catch (err) {
    const tooBig = err && err.status === 413;
    res.writeHead(tooBig ? 413 : 400, { 'Content-Type': 'application/json', Connection: 'close' });
    res.end(JSON.stringify({ error: tooBig ? 'body too large' : 'invalid JSON body' }), () => req.destroy());
    return;
  }
  const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? undefined : Number(v));
  const from = num(body.from);
  const to = num(body.to);
  const label = typeof body.label === 'string' && body.label ? body.label : 'period';

  try {
    const result = await getStory({ from, to, label });
    sendJson(res, 200, result);
  } catch (err) {
    if (err.code === 'TIMEOUT') return sendJson(res, 504, { error: err.message });
    sendJson(res, 500, { error: err.message });
  }
}

// ---------------------------------------------------------------------------
// Static files (hardened against path traversal)
// ---------------------------------------------------------------------------

function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return sendJson(res, 400, { error: 'bad path' });
  }
  // fs path APIs throw synchronously on null bytes — reject before touching fs
  if (rel.includes('\0')) return sendJson(res, 400, { error: 'bad path' });
  if (rel === '/' || rel === '') rel = '/index.html';
  const resolved = path.resolve(PUBLIC_DIR, '.' + path.posix.normalize(rel));
  if (resolved !== PUBLIC_DIR && !resolved.startsWith(PUBLIC_DIR + path.sep)) {
    return sendJson(res, 403, { error: 'forbidden' });
  }
  try {
    fs.stat(resolved, (err, st) => {
      if (err || !st.isFile()) return sendJson(res, 404, { error: 'not found' });
      const type = MIME[path.extname(resolved).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size });
      const stream = fs.createReadStream(resolved);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    });
  } catch {
    return sendJson(res, 400, { error: 'bad path' });
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://localhost:${PORT}`);
  } catch {
    return sendJson(res, 400, { error: 'bad request' });
  }
  const pathname = url.pathname;

  if (pathname === '/api/events' && req.method === 'GET') return handleEvents(req, res);
  if (pathname === '/api/story' && req.method === 'POST') return void handleStory(req, res);

  const route = routes[`${req.method} ${pathname}`];
  if (route) {
    try {
      return sendJson(res, 200, route(url));
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error(`[api] ${pathname}:`, err);
      return sendJson(res, status, { error: err.message });
    }
  }

  if (pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'unknown endpoint' });
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' });
  serveStatic(req, res, pathname);
});

// Boot: full scan → watcher → listen.
const scan = await fullScan();

watch((newMessages) => {
  for (const m of newMessages) {
    sseBroadcast({
      type: 'pulse',
      ts: m.ts,
      project: m.project,
      model: m.model,
      in: m.input_tokens,
      out: m.output_tokens,
      cost: m.cost,
    });
  }
  sseBroadcast({ type: 'refresh' });
});

// Localhost-only by default: this dashboard exposes your full usage history
// and a claude-CLI shell-out — it must not be reachable from the LAN unless
// the user explicitly opts in with HOST=0.0.0.0.
const HOST = process.env.HOST || '127.0.0.1';
server.listen(PORT, HOST, () => {
  console.log(
    `[claudiogram] ready on http://localhost:${PORT} — ` +
    `${db.countMessages()} rows (${scan.newMessages} new) from ${scan.files} files, scan ${scan.ms}ms`,
  );
});
