// lib/db.js — node:sqlite open/migrate + all SQL query functions (contract: schema + API).
// Single synchronous connection, WAL mode, prepared statements.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cacheSavings } from './pricing.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// CLAUDIOGRAM_DATA_DIR lets the test suite sandbox the DB away from data/.
const DATA_DIR = process.env.CLAUDIOGRAM_DATA_DIR || path.join(ROOT, 'data');
mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'usage.db'));
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA synchronous = NORMAL;');
db.exec('PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS messages (
  msg_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  project TEXT NOT NULL,
  ts INTEGER NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_w5m_tokens INTEGER NOT NULL DEFAULT 0,
  cache_w1h_tokens INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  is_sidechain INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_msg_ts ON messages(ts);
CREATE INDEX IF NOT EXISTS idx_msg_proj ON messages(project, ts);
CREATE INDEX IF NOT EXISTS idx_msg_sess ON messages(session_id);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project TEXT,
  first_ts INTEGER, last_ts INTEGER,
  assistant_msgs INTEGER DEFAULT 0,
  user_msgs INTEGER DEFAULT 0,
  tokens INTEGER DEFAULT 0,
  cost REAL DEFAULT 0,
  first_prompt TEXT,
  tools TEXT DEFAULT '{}',
  models TEXT DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY, size INTEGER, offset INTEGER, mtime INTEGER
);
-- Per-line dedup gate for session counters (user_msgs, tools). Assistant usage
-- is deduped by messages.msg_id; user lines and tool_use blocks have no msg id,
-- so re-reads (file shrink/compaction, session resume replays) would double-count
-- them without this. One row per counted line uuid.
CREATE TABLE IF NOT EXISTS seen_lines (
  uuid TEXT PRIMARY KEY
);
CREATE TABLE IF NOT EXISTS insights (
  key TEXT PRIMARY KEY, story TEXT, created_at INTEGER
);
`);

// ---------------------------------------------------------------------------
// Local-time helpers (all bucketing in the user's local timezone)
// ---------------------------------------------------------------------------

const LOCAL_DATE = `date(ts/1000, 'unixepoch', 'localtime')`;
const LOCAL_HOUR = `CAST(strftime('%H', ts/1000, 'unixepoch', 'localtime') AS INTEGER)`;
// strftime %w: 0=Sunday..6=Saturday → remap to 0=Monday..6=Sunday
const LOCAL_DOW_MON0 = `(CAST(strftime('%w', ts/1000, 'unixepoch', 'localtime') AS INTEGER) + 6) % 7`;

/** 'YYYY-MM-DD' local for an epoch-ms timestamp (defaults to now). */
export function localDateStr(ms = Date.now()) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Local-midnight epoch ms for a 'YYYY-MM-DD' string. */
export function dateStrToLocalEpoch(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

function dayIndex(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
}

function range(from, to, extra = []) {
  const w = [...extra];
  const p = [];
  if (from != null) { w.push('ts >= ?'); p.push(from); }
  if (to != null) { w.push('ts <= ?'); p.push(to); }
  return { where: w.length ? 'WHERE ' + w.join(' AND ') : '', params: p };
}

// ---------------------------------------------------------------------------
// Ingest-side statements (hot path — prepared once)
// ---------------------------------------------------------------------------

const insMsgStmt = db.prepare(`
  INSERT OR IGNORE INTO messages
    (msg_id, session_id, project, ts, model, input_tokens, output_tokens,
     cache_read_tokens, cache_w5m_tokens, cache_w1h_tokens, cost, is_sidechain)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const getSessStmt = db.prepare(`SELECT * FROM sessions WHERE id = ?`);
const putSessStmt = db.prepare(`
  INSERT OR REPLACE INTO sessions
    (id, project, first_ts, last_ts, assistant_msgs, user_msgs, tokens, cost, first_prompt, tools, models)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const getFileStmt = db.prepare(`SELECT path, size, offset, mtime FROM files WHERE path = ?`);
const putFileStmt = db.prepare(`INSERT OR REPLACE INTO files (path, size, offset, mtime) VALUES (?, ?, ?, ?)`);
const countMsgStmt = db.prepare(`SELECT COUNT(*) AS n FROM messages`);

/** INSERT OR IGNORE one message row; returns true if a new row was inserted. */
export function insertMessage(m) {
  return insMsgStmt.run(
    m.msg_id, m.session_id, m.project, m.ts, m.model,
    m.input_tokens, m.output_tokens, m.cache_read_tokens,
    m.cache_w5m_tokens, m.cache_w1h_tokens, m.cost, m.is_sidechain,
  ).changes > 0;
}

export function getSession(id) { return getSessStmt.get(id); }

// `| 0` would wrap above 2^31 (3e9 tokens → negative); SQLite INTEGER is 64-bit.
const int = (v) => Math.trunc(Number(v)) || 0;

export function saveSession(s) {
  putSessStmt.run(
    s.id, s.project ?? null, s.first_ts ?? null, s.last_ts ?? null,
    int(s.assistant_msgs), int(s.user_msgs), int(s.tokens), Number(s.cost) || 0,
    s.first_prompt ?? null,
    typeof s.tools === 'string' ? s.tools : JSON.stringify(s.tools || {}),
    typeof s.models === 'string' ? s.models : JSON.stringify(s.models || {}),
  );
}

const seenLineStmt = db.prepare(`INSERT OR IGNORE INTO seen_lines (uuid) VALUES (?)`);

/** Mark a line uuid as counted; returns true the first time, false on replays. */
export function markLineSeen(uuid) { return seenLineStmt.run(uuid).changes > 0; }

export function getFileMeta(p) { return getFileStmt.get(p); }
export function setFileMeta(p, size, offset, mtime) { putFileStmt.run(p, size, offset, mtime); }

export function begin() { db.exec('BEGIN'); }
export function commit() { db.exec('COMMIT'); }
export function rollback() { try { db.exec('ROLLBACK'); } catch { /* not in txn */ } }

export function countMessages() { return countMsgStmt.get().n; }

// ---------------------------------------------------------------------------
// Shared aggregation pieces
// ---------------------------------------------------------------------------

function perDayRows(from, to) {
  const { where, params } = range(from, to);
  return db.prepare(`
    SELECT ${LOCAL_DATE} AS date,
           COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens,
           COALESCE(SUM(cost), 0) AS cost,
           COUNT(DISTINCT session_id) AS sessions,
           COUNT(*) AS messages
    FROM messages ${where}
    GROUP BY date ORDER BY date
  `).all(...params);
}

function modelRows(from, to) {
  const { where, params } = range(from, to);
  return db.prepare(`
    SELECT model,
           COUNT(*) AS msgs,
           COALESCE(SUM(input_tokens), 0) AS inputTokens,
           COALESCE(SUM(output_tokens), 0) AS outputTokens,
           COALESCE(SUM(cache_read_tokens), 0) AS cacheReadTokens,
           COALESCE(SUM(cost), 0) AS cost
    FROM messages ${where}
    GROUP BY model ORDER BY cost DESC
  `).all(...params);
}

function computeStreaks(dates /* sorted asc 'YYYY-MM-DD' */) {
  let longest = 0;
  let run = 0;
  let prev = null;
  for (const d of dates) {
    const idx = dayIndex(d);
    run = (prev !== null && idx === prev + 1) ? run + 1 : 1;
    if (run > longest) longest = run;
    prev = idx;
  }
  // Current streak: consecutive days ending today (or yesterday if today is quiet so far).
  const set = new Set(dates.map(dayIndex));
  const todayIdx = dayIndex(localDateStr());
  let anchor = set.has(todayIdx) ? todayIdx : (set.has(todayIdx - 1) ? todayIdx - 1 : null);
  let current = 0;
  while (anchor !== null && set.has(anchor)) { current++; anchor--; }
  return { current, longest };
}

function todayBounds() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start: start.getTime(), end: end.getTime() };
}

// ---------------------------------------------------------------------------
// GET /api/summary
// ---------------------------------------------------------------------------

export function summary(from, to) {
  const { where, params } = range(from, to);
  const t = db.prepare(`
    SELECT COUNT(*) AS messages,
           COALESCE(SUM(input_tokens), 0) AS inputTokens,
           COALESCE(SUM(output_tokens), 0) AS outputTokens,
           COALESCE(SUM(cache_read_tokens), 0) AS cacheReadTokens,
           COALESCE(SUM(cache_w5m_tokens + cache_w1h_tokens), 0) AS cacheWriteTokens,
           COALESCE(SUM(cost), 0) AS cost,
           COUNT(DISTINCT session_id) AS sessions,
           COUNT(DISTINCT project) AS projects,
           MIN(ts) AS firstTs,
           MAX(ts) AS lastTs
    FROM messages ${where}
  `).get(...params);

  const models = modelRows(from, to);
  const savings = models.reduce((s, m) => s + cacheSavings(m.model, m.cacheReadTokens), 0);

  const days = perDayRows(from, to);
  const streaks = computeStreaks(days.map((d) => d.date));
  let busiest = null;
  for (const d of days) {
    if (!busiest || d.tokens > busiest.tokens) busiest = d;
  }

  const sideW = range(from, to, ['is_sidechain = 1']);
  const side = db.prepare(`
    SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens,
           COALESCE(SUM(cost), 0) AS cost
    FROM messages ${sideW.where}
  `).get(...sideW.params);

  const { start, end } = todayBounds();
  const today = db.prepare(`
    SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens,
           COALESCE(SUM(cost), 0) AS cost,
           COUNT(DISTINCT session_id) AS sessions,
           COUNT(*) AS messages
    FROM messages WHERE ts >= ? AND ts < ?
  `).get(start, end);

  return {
    totals: {
      tokens: t.inputTokens + t.outputTokens,
      inputTokens: t.inputTokens,
      outputTokens: t.outputTokens,
      cacheReadTokens: t.cacheReadTokens,
      cacheWriteTokens: t.cacheWriteTokens,
      cost: t.cost,
      cacheSavings: savings,
      sessions: t.sessions,
      projects: t.projects,
      messages: t.messages,
      activeDays: days.length,
      firstTs: t.firstTs ?? null,
      lastTs: t.lastTs ?? null,
      currentStreak: streaks.current,
      longestStreak: streaks.longest,
      busiestDay: busiest
        ? { date: busiest.date, tokens: busiest.tokens, cost: busiest.cost }
        : null,
    },
    today: { tokens: today.tokens, cost: today.cost, sessions: today.sessions, messages: today.messages },
    models,
    sidechain: { tokens: side.tokens, cost: side.cost },
  };
}

// ---------------------------------------------------------------------------
// GET /api/timeseries
// ---------------------------------------------------------------------------

export function timeseries({ bucket = 'day', from, to, by, project } = {}) {
  let bucketExpr;
  if (bucket === 'month') bucketExpr = `strftime('%Y-%m-01', ts/1000, 'unixepoch', 'localtime')`;
  else if (bucket === 'week') bucketExpr = `date(ts/1000, 'unixepoch', 'localtime', '+1 day', 'weekday 1', '-7 days')`;
  else bucketExpr = LOCAL_DATE;

  const keyExpr = by === 'model' ? 'model' : by === 'project' ? 'project' : `'all'`;
  const extra = [];
  const extraParams = [];
  if (project != null) { extra.push('project = ?'); extraParams.push(project); }
  const { where, params } = range(from, to, extra);

  const rows = db.prepare(`
    SELECT ${bucketExpr} AS d, ${keyExpr} AS key,
           COALESCE(SUM(input_tokens), 0) AS inputTokens,
           COALESCE(SUM(output_tokens), 0) AS outputTokens,
           COALESCE(SUM(cache_read_tokens), 0) AS cacheReadTokens,
           COALESCE(SUM(cache_w5m_tokens + cache_w1h_tokens), 0) AS cacheWriteTokens,
           COALESCE(SUM(cost), 0) AS cost
    FROM messages ${where}
    GROUP BY d, key ORDER BY d
  `).all(...extraParams, ...params);

  return {
    rows: rows.map((r) => ({
      t: dateStrToLocalEpoch(r.d),
      key: r.key,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      cacheReadTokens: r.cacheReadTokens,
      cacheWriteTokens: r.cacheWriteTokens,
      cost: r.cost,
    })),
  };
}

// ---------------------------------------------------------------------------
// GET /api/heatmap — last 371 days, only days with activity
// ---------------------------------------------------------------------------

export function heatmap() {
  const { start } = todayBounds();
  const fromTs = start - 370 * 86400000;
  return { days: perDayRows(fromTs, undefined) };
}

// ---------------------------------------------------------------------------
// GET /api/punchcard — tokens by local day-of-week (0=Mon) × hour
// ---------------------------------------------------------------------------

export function punchcard({ from, to, project } = {}) {
  const extra = [];
  const extraParams = [];
  if (project != null) { extra.push('project = ?'); extraParams.push(project); }
  const { where, params } = range(from, to, extra);

  const rows = db.prepare(`
    SELECT ${LOCAL_DOW_MON0} AS d, ${LOCAL_HOUR} AS h,
           COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens
    FROM messages ${where}
    GROUP BY d, h
  `).all(...extraParams, ...params);

  const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
  for (const r of rows) grid[r.d][r.h] = r.tokens;
  const hours = new Array(24).fill(0);
  const days = new Array(7).fill(0);
  for (let d = 0; d < 7; d++) {
    for (let h = 0; h < 24; h++) {
      hours[h] += grid[d][h];
      days[d] += grid[d][h];
    }
  }
  return { grid, hours, days };
}

// ---------------------------------------------------------------------------
// GET /api/day?date=YYYY-MM-DD — drill-down
// ---------------------------------------------------------------------------

export function day(date) {
  const start = dateStrToLocalEpoch(date);
  const [y, m, d] = date.split('-').map(Number);
  const end = new Date(y, m - 1, d + 1).getTime();

  const totals = db.prepare(`
    SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens,
           COALESCE(SUM(input_tokens), 0) AS inputTokens,
           COALESCE(SUM(output_tokens), 0) AS outputTokens,
           COALESCE(SUM(cache_read_tokens), 0) AS cacheReadTokens,
           COALESCE(SUM(cost), 0) AS cost,
           COUNT(*) AS messages,
           COUNT(DISTINCT session_id) AS sessions
    FROM messages WHERE ts >= ? AND ts < ?
  `).get(start, end);

  const hourRows = db.prepare(`
    SELECT ${LOCAL_HOUR} AS h,
           COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens,
           COALESCE(SUM(cost), 0) AS cost
    FROM messages WHERE ts >= ? AND ts < ? GROUP BY h
  `).all(start, end);
  const hours = Array.from({ length: 24 }, (_, h) => ({ h, tokens: 0, cost: 0 }));
  for (const r of hourRows) { hours[r.h].tokens = r.tokens; hours[r.h].cost = r.cost; }

  const projects = db.prepare(`
    SELECT project,
           COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens,
           COALESCE(SUM(cost), 0) AS cost,
           COUNT(DISTINCT session_id) AS sessions,
           COUNT(*) AS messages
    FROM messages WHERE ts >= ? AND ts < ?
    GROUP BY project ORDER BY tokens DESC
  `).all(start, end);

  const models = db.prepare(`
    SELECT model,
           COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens,
           COALESCE(SUM(cost), 0) AS cost
    FROM messages WHERE ts >= ? AND ts < ?
    GROUP BY model ORDER BY tokens DESC
  `).all(start, end);

  const sessRows = db.prepare(`
    SELECT * FROM sessions
    WHERE id IN (SELECT DISTINCT session_id FROM messages WHERE ts >= ? AND ts < ?)
    ORDER BY last_ts DESC
  `).all(start, end);

  return { date, totals, hours, projects, models, sessions: sessRows.map(parseSessionRow) };
}

// ---------------------------------------------------------------------------
// GET /api/projects
// ---------------------------------------------------------------------------

export function projects() {
  const rows = db.prepare(`
    SELECT project,
           COUNT(DISTINCT session_id) AS sessions,
           COUNT(*) AS messages,
           COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens,
           COALESCE(SUM(cost), 0) AS cost,
           MIN(ts) AS firstTs,
           MAX(ts) AS lastTs
    FROM messages
    GROUP BY project ORDER BY cost DESC
  `).all();
  return { projects: rows };
}

// ---------------------------------------------------------------------------
// GET /api/sessions
// ---------------------------------------------------------------------------

function parseSessionRow(r) {
  let tools = {};
  let models = {};
  try { tools = JSON.parse(r.tools || '{}'); } catch { /* keep {} */ }
  try { models = JSON.parse(r.models || '{}'); } catch { /* keep {} */ }
  return { ...r, tools, models };
}

export function sessions({ from, to, project, limit = 50, offset = 0 } = {}) {
  const w = [];
  const p = [];
  if (project != null) { w.push('project = ?'); p.push(project); }
  if (from != null) { w.push('last_ts >= ?'); p.push(from); }
  if (to != null) { w.push('first_ts <= ?'); p.push(to); }
  const where = w.length ? 'WHERE ' + w.join(' AND ') : '';

  const total = db.prepare(`SELECT COUNT(*) AS n FROM sessions ${where}`).get(...p).n;
  const rows = db.prepare(`
    SELECT * FROM sessions ${where} ORDER BY last_ts DESC LIMIT ? OFFSET ?
  `).all(...p, limit, offset);

  return { sessions: rows.map(parseSessionRow), total };
}

// ---------------------------------------------------------------------------
// GET /api/live — per-minute buckets, last 90 minutes, zeros filled
// ---------------------------------------------------------------------------

export function live() {
  const nowMin = Math.floor(Date.now() / 60000);
  const startMin = nowMin - 89;
  const rows = db.prepare(`
    SELECT ts/60000 AS m,
           COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens,
           COALESCE(SUM(cost), 0) AS cost,
           COALESCE(SUM(output_tokens), 0) AS out
    FROM messages WHERE ts >= ?
    GROUP BY m
  `).all(startMin * 60000);

  const byMin = new Map(rows.map((r) => [r.m, r]));
  const minutes = [];
  for (let m = startMin; m <= nowMin; m++) {
    const r = byMin.get(m);
    minutes.push({ t: m * 60000, tokens: r ? r.tokens : 0, cost: r ? r.cost : 0, out: r ? r.out : 0 });
  }
  return { minutes };
}

// ---------------------------------------------------------------------------
// GET /api/burn
// ---------------------------------------------------------------------------

function windowAgg(ms) {
  const r = db.prepare(`
    SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens,
           COALESCE(SUM(cost), 0) AS cost
    FROM messages WHERE ts >= ?
  `).get(Date.now() - ms);
  return { tokens: r.tokens, cost: r.cost };
}

function percentile(sorted, q) {
  if (!sorted.length) return 0;
  if (sorted.length === 1) return sorted[0];
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function burn() {
  const window1h = windowAgg(3600000);
  const window5h = windowAgg(5 * 3600000);
  const window24h = windowAgg(24 * 3600000);

  const days = perDayRows(undefined, undefined);
  const tokensSorted = days.map((d) => d.tokens).sort((a, b) => a - b);
  const costSorted = days.map((d) => d.cost).sort((a, b) => a - b);

  const { start, end } = todayBounds();
  const today = db.prepare(`
    SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens,
           COALESCE(SUM(cost), 0) AS cost
    FROM messages WHERE ts >= ? AND ts < ?
  `).get(start, end);

  const paceTokensPerHour = window1h.tokens; // last 60 min
  const paceCostPerHour = window1h.cost;
  const hoursLeft = Math.max(0, (end - Date.now()) / 3600000);

  return {
    window1h,
    window5h,
    window24h,
    medianActiveDay: { tokens: Math.round(percentile(tokensSorted, 0.5)), cost: percentile(costSorted, 0.5) },
    p90ActiveDay: { tokens: Math.round(percentile(tokensSorted, 0.9)), cost: percentile(costSorted, 0.9) },
    paceTokensPerHour,
    projectedDay: {
      tokens: Math.round(today.tokens + paceTokensPerHour * hoursLeft),
      cost: today.cost + paceCostPerHour * hoursLeft,
    },
  };
}

// ---------------------------------------------------------------------------
// Insights cache + digest queries
// ---------------------------------------------------------------------------

const insightGetStmt = db.prepare(`SELECT key, story, created_at FROM insights WHERE key = ?`);
const insightSetStmt = db.prepare(`INSERT OR REPLACE INTO insights (key, story, created_at) VALUES (?, ?, ?)`);

export function insightGet(key) { return insightGetStmt.get(key); }
export function insightSet(key, story) { insightSetStmt.run(key, story, Date.now()); }

export function rangeTotals(from, to) {
  const { where, params } = range(from, to);
  const t = db.prepare(`
    SELECT COUNT(*) AS messages,
           COALESCE(SUM(input_tokens), 0) AS inputTokens,
           COALESCE(SUM(output_tokens), 0) AS outputTokens,
           COALESCE(SUM(cache_read_tokens), 0) AS cacheReadTokens,
           COALESCE(SUM(cache_w5m_tokens + cache_w1h_tokens), 0) AS cacheWriteTokens,
           COALESCE(SUM(cost), 0) AS cost,
           COUNT(DISTINCT session_id) AS sessions,
           COUNT(DISTINCT project) AS projects,
           MIN(ts) AS firstTs, MAX(ts) AS lastTs
    FROM messages ${where}
  `).get(...params);
  const models = modelRows(from, to);
  t.tokens = t.inputTokens + t.outputTokens;
  t.cacheSavings = models.reduce((s, m) => s + cacheSavings(m.model, m.cacheReadTokens), 0);
  t.activeDays = perDayRows(from, to).length;
  return t;
}

export function topProjects(from, to, limit = 5) {
  const { where, params } = range(from, to);
  return db.prepare(`
    SELECT project,
           COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens,
           COALESCE(SUM(cost), 0) AS cost,
           COUNT(DISTINCT session_id) AS sessions
    FROM messages ${where}
    GROUP BY project ORDER BY tokens DESC LIMIT ?
  `).all(...params, limit);
}

export function topSessions(from, to, limit = 8) {
  const w = [];
  const p = [];
  if (from != null) { w.push('last_ts >= ?'); p.push(from); }
  if (to != null) { w.push('first_ts <= ?'); p.push(to); }
  const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
  return db.prepare(`
    SELECT id, project, first_ts, last_ts, tokens, cost, first_prompt
    FROM sessions ${where} ORDER BY tokens DESC LIMIT ?
  `).all(...p, limit);
}

export function modelMix(from, to) { return modelRows(from, to); }
