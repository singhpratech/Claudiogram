# Claudiogram — Build Contract

Personal Claude Code usage observatory. Local app, zero npm dependencies, Node.js >= 22.5
(built-in `node:sqlite`). Reads `~/.claude/projects/**/*.jsonl`, ingests into SQLite,
serves a dashboard at `http://localhost:4242`.

## File map (ownership — do not write outside your set)

```
package.json            (scaffolded — do not touch)
server.js               BACKEND  — node:http server, routing, static, SSE
lib/db.js               BACKEND  — node:sqlite open/migrate + all SQL query functions
lib/ingest.js           BACKEND  — JSONL scanner/parser, incremental ingest, fs.watch
lib/pricing.js          BACKEND  — model pricing table + cost(usage, model) function
lib/insights.js         BACKEND  — headless `claude -p` story generation + caching
public/index.html       FRONTEND
public/styles.css       FRONTEND
public/app.js           FRONTEND — entry, router, SSE client, data layer
public/charts.js        FRONTEND — chart renderers (canvas pulse, SVG heatmap/bars/areas)
public/views.js         FRONTEND — view builders (Pulse, Rhythm, Cost, Capsule)
data/                   runtime  — usage.db lives here (gitignored)
```

## Source data format (verified against real data on this machine)

- Files: `~/.claude/projects/<encoded-dir>/<session-uuid>.jsonl`. 385 files, 351MB, ~2.5M lines.
- Each line is one JSON object. Relevant line types:
  - `type:"assistant"` — has `message.model`, `message.id`, `message.usage`, `timestamp` (ISO),
    `sessionId`, `isSidechain` (bool), `cwd`, `uuid`, `message.content` (array of blocks).
  - `type:"user"` — `message.content` is a string OR array of blocks (`text`, `tool_result`),
    plus `timestamp`, `sessionId`, `cwd`, sometimes `isMeta:true`.
  - Other types (`mode`, `permission-mode`, `summary`, `system`, ...) — skip.
- `usage` shape: `{input_tokens, output_tokens, cache_read_input_tokens,
  cache_creation_input_tokens, cache_creation:{ephemeral_5m_input_tokens, ephemeral_1h_input_tokens}}`.
  `cache_creation` breakdown may be missing on old lines — fall back to
  `cache_creation_input_tokens` treated as 5m.
- **CRITICAL DEDUP RULE**: Claude Code writes ONE LINE PER CONTENT BLOCK; every line of the
  same API response repeats the same `message.id` and the same `usage`. Verified: 23,670
  usage lines → only 10,154 unique message ids. Count usage **once per `message.id`**
  (`INSERT OR IGNORE`, PK = message.id, fallback `uuid` when id missing).
- Skip lines where `message.model === "<synthetic>"` (error placeholders).
- Tool counting: every assistant line's `message.content` blocks with `type:"tool_use"` have a
  `name`. Count these per line (lines are distinct blocks — no dedup needed for tools).
- Project name: `basename(cwd)` from any line in the file (cwd is reliable; the encoded dir
  name is ambiguous). Fallback: last `-` segment of the dir name.
- Session id: `sessionId` field (== filename uuid).
- First prompt for a session: first `type:"user"` line, not `isMeta`, whose text (string content
  or first `text` block) does NOT start with `<` (skips `<command-name>`, `<local-command`,
  `<system-reminder>` wrappers) and is not a tool_result array. Truncate to 200 chars.
- `isSidechain:true` = subagent traffic. Count its tokens (real usage) but store the flag so
  the UI can split "main session vs agents".

## Pricing (USD per 1M tokens; cost = tokens/1e6 * rate)

Longest-prefix match on the model string:

| prefix                  | input | output |
|-------------------------|-------|--------|
| claude-fable-5          | 10    | 50     |
| claude-opus-4-8         | 5     | 25     |
| claude-opus-4-7         | 5     | 25     |
| claude-opus-4-6         | 5     | 25     |
| claude-opus-4-5         | 5     | 25     |
| claude-opus-4-1         | 15    | 75     |
| claude-opus-4-2         | 15    | 75     |
| claude-opus-4-0 / claude-opus-4-20250514 | 15 | 75 |
| claude-3-opus           | 15    | 75     |
| claude-sonnet           | 3     | 15     |
| claude-3-7-sonnet / claude-3-5-sonnet / claude-3-sonnet | 3 | 15 |
| claude-haiku-4-5        | 1     | 5      |
| claude-3-5-haiku        | 0.8   | 4      |
| claude-3-haiku          | 0.25  | 1.25   |
| (unknown fallback)      | 5     | 25     |

Cache pricing relative to that model's INPUT rate:
- cache read = 0.1 × input rate
- cache write 5m (`ephemeral_5m_input_tokens`) = 1.25 × input rate
- cache write 1h (`ephemeral_1h_input_tokens`) = 2 × input rate

`cost` per message = input + output + cacheRead + cacheW5m + cacheW1h priced as above.
Also compute `cache_savings` where useful: cacheRead tokens × (1.0 − 0.1) × input rate
(what those tokens would have cost uncached minus what they cost).

Since the user is on a subscription, label all dollar figures in the UI as
**"API-equivalent value"** — what this usage would cost at API prices.

## SQLite schema (data/usage.db, WAL mode)

```sql
CREATE TABLE IF NOT EXISTS messages (
  msg_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  project TEXT NOT NULL,
  ts INTEGER NOT NULL,             -- epoch ms
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
  tokens INTEGER DEFAULT 0,        -- input+output only (headline number)
  cost REAL DEFAULT 0,
  first_prompt TEXT,
  tools TEXT DEFAULT '{}',         -- JSON {toolName: count}
  models TEXT DEFAULT '{}'         -- JSON {model: outputTokens}
);

CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY, size INTEGER, offset INTEGER, mtime INTEGER
);
CREATE TABLE IF NOT EXISTS insights (
  key TEXT PRIMARY KEY, story TEXT, created_at INTEGER
);
```

Incremental ingest: per file store byte `offset` already consumed; on change re-read from
offset (lines are append-only). If file shrank, re-read from 0. Full scan on boot, then
`fs.watch(projectsDir, {recursive:true})` with 500ms debounce per file.

## HTTP API (server.js, port 4242, env PORT overrides)

All responses JSON. Times are epoch ms. `from`/`to` query params optional (default: all time).

- `GET /api/summary` → `{ totals:{tokens, inputTokens, outputTokens, cacheReadTokens,
  cacheWriteTokens, cost, cacheSavings, sessions, projects, messages, activeDays,
  firstTs, lastTs, currentStreak, longestStreak, busiestDay:{date, tokens, cost}},
  today:{tokens, cost, sessions, messages}, models:[{model, msgs, inputTokens, outputTokens,
  cacheReadTokens, cost}], sidechain:{tokens, cost} }`
- `GET /api/timeseries?bucket=day|week|month&from&to&by=model|project&project=<name>`
  → `{ rows:[{t, key, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, cost}] }`
  (`key` = model or project name; omit `by` → key:"all"; `project` filters to one project)
- `GET /api/heatmap?metric=tokens|cost` → `{ days:[{date:"YYYY-MM-DD", tokens, cost,
  sessions, messages}] }` — last 371 days, only days with activity.
- `GET /api/punchcard?from&to&project` → `{ grid:[[..24 numbers..] x7] }` tokens by local
  day-of-week (0=Mon) × hour. Plus `{hours:[24], days:[7]}` marginals.
- `GET /api/day?date=YYYY-MM-DD` → DRILL-DOWN: `{ date, totals:{tokens, inputTokens,
  outputTokens, cacheReadTokens, cost, messages, sessions}, hours:[{h, tokens, cost} x24],
  projects:[{project, tokens, cost, sessions, messages}], models:[{model, tokens, cost}],
  sessions:[full session rows for that day] }`
- `GET /api/projects` → `{ projects:[{project, sessions, messages, tokens, cost, firstTs,
  lastTs}] }` sorted by cost desc.
- `GET /api/sessions?from&to&project&limit=50&offset=0` → `{ sessions:[ session row +
  parsed tools/models ], total }` sorted last_ts desc.
- `GET /api/live` → `{ minutes:[{t, tokens, cost, out}] }` per-minute buckets for the last
  90 minutes (zeros filled), local time.
- `GET /api/burn` → `{ window1h:{tokens,cost}, window5h:{tokens,cost}, window24h:{...},
  medianActiveDay:{tokens,cost}, p90ActiveDay:{...}, paceTokensPerHour, projectedDay:{...} }`
  (pace = last 60 min; honest estimates, no fake limit math)
- `POST /api/story` body `{from, to, label}` → `{ story, cached:bool }`. Builds a compact
  stats digest (totals, top projects, top sessions w/ first prompts, rhythm) for the period,
  shells out to `claude -p <prompt>` (see insights.js below), caches in `insights` table
  keyed by `label:from:to`. 120s timeout → `{error}` with 504.
- `GET /api/events` — SSE (`Content-Type: text/event-stream`). Events:
  - `data: {"type":"pulse","ts":..,"project":"..","model":"..","in":N,"out":N,"cost":..}`
    one per newly ingested message (live watcher only)
  - `data: {"type":"refresh"}` after any ingest batch completes
  - heartbeat comment `: ping` every 25s
- Static: `/` → `public/index.html`, plus css/js with correct MIME. No directory traversal
  (resolve + prefix check).

## insights.js (AI story via the user's Claude Code subscription)

`generateStory(digest, label)`:
- Prompt: "You are narrating a developer's Claude Code usage history... Write a vivid,
  warm, specific ~250-word story of this period: what they built, when they grinded,
  notable bursts, cache wins. Use the data; do not invent. End with one playful insight.
  DATA:\n<JSON digest>"
- `child_process.execFile('claude', ['-p', prompt], {timeout:120000, maxBuffer:10MB})`,
  cwd = os.tmpdir() (avoid loading this project's context). stdout = story.
- If `claude` binary missing → `{error:"claude CLI not found"}`.

## Conventions

- ESM (`"type":"module"`). Node built-ins only. No npm installs anywhere.
- Frontend: vanilla ES modules, no frameworks, no CDN — must work fully offline.
- All charts hand-rolled: pulse monitor = `<canvas>` with rAF animation; heatmap, punchcard,
  bars, stacked areas, donuts = inline SVG built via DOM.
- Number formatting: `12.4k`, `3.1M`, `1.2B` tokens; `$12.34` money; shared helpers.
- The frontend fetches `/api/*`, subscribes to `/api/events`; on `refresh` refetch current
  view; on `pulse` feed the live waveform + tickers.
- Local timezone everywhere (data is the user's own machine).

## Drill-down requirements (frontend — non-negotiable)

- **Global metric toggle** (tokens ⇄ cost) in the header; every chart re-renders in the
  selected metric.
- **Heatmap day click** → day drawer/panel using `/api/day`: hourly bars, project split,
  model split, that day's sessions.
- **Project click** (anywhere a project appears: bars, session cards, day drawer) →
  project view: timeseries filtered to that project, its sessions, punchcard, totals.
- **Session click** → expand card: first prompt, duration, tool usage counts, model mix,
  token/cost breakdown.
- Breadcrumb or back affordance so drill-downs never dead-end.
