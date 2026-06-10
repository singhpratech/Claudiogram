<div align="center">

<img src="docs/icon.png" width="110" alt="Claudiogram icon">

# Claudiogram

**Every token a trace.** A personal observatory for your Claude Code usage —
live token pulse, year-long rhythm heatmap, the full cost story, and a time
capsule of every session you've ever run.

[![tests](https://github.com/singhpratech/Claudiogram/actions/workflows/test.yml/badge.svg)](https://github.com/singhpratech/Claudiogram/actions/workflows/test.yml)
![node](https://img.shields.io/badge/node-%E2%89%A5%2022.5-53fca1)
![dependencies](https://img.shields.io/badge/dependencies-zero-53fca1)
![platforms](https://img.shields.io/badge/platforms-macOS%20·%20Linux%20·%20Windows-53fca1)
![license](https://img.shields.io/badge/license-MIT-53fca1)

*Zero npm dependencies. Zero network. Zero writes outside its own folder.
Your data never leaves your machine.*

</div>

---

## Why

Claude Code quietly writes a transcript of every session to `~/.claude/projects/`.
Buried in those JSONL files is the complete story of how you work: every token,
every tool call, every late-night sprint. Claudiogram reads that story —
**strictly read-only** — dedupes it correctly (most tools overcount ~2.3×),
prices it at API list rates, and renders it as a live phosphor-green instrument
panel in your browser.

## Quick start

```bash
git clone https://github.com/singhpratech/Claudiogram.git
cd Claudiogram
node server.js          # → http://localhost:4242
```

Requires [Node.js](https://nodejs.org) ≥ 22.5 (uses the built-in `node:sqlite`).
No `npm install` — there is nothing to install.

Prefer a double-click? Each platform has a launcher in the repo root that checks
for Node, starts the server if it isn't already running, and opens the dashboard:

| Platform | Launcher |
|----------|----------|
| macOS    | **`Claudiogram.app`** — drag it to the Dock (keep it inside this folder). First launch: right-click → **Open** (the app is unsigned, Gatekeeper asks once) |
| Windows  | **`Claudiogram.bat`** — run `powershell -ExecutionPolicy Bypass -File scripts\make-shortcut.ps1` once for a Desktop shortcut with the app icon and no console window |
| Linux    | **`claudiogram.sh`** — run `sh scripts/make-desktop.sh` once to install a per-user app-menu entry with the icon (no root; uninstall = delete two files, the script prints them) |

All launchers find Node themselves (Homebrew, nvm, volta, fnm, asdf, n, …),
survive install paths with spaces, and reuse an already-running server.
`PORT=xxxx` changes the port (`CLAUDIOGRAM_PORT` for the launchers).
Windows needs build 1803+ (built-in `curl`).

## The four instruments

### F1 · PULSE — the live trace

An ECG for your tokens. Real phosphor decay, fed over SSE the moment Claude Code
writes a line — in any project, in any terminal. Burn windows for the last
1h/5h/24h against your typical day, and an honest pace projection.

![PULSE view](docs/pulse.png)

### F2 · RHYTHM — when you actually work

A GitHub-style heatmap of the last 371 days, streak odometers, and an
hour-by-weekday punchcard that knows about your quiet band.

![RHYTHM view](docs/rhythm.png)

### F3 · COST — the spend story

Cumulative API-equivalent value with **draggable scope cursors** (measure
Δ$ / Δtokens between any two dates), daily composition stacked by model or
project, and the cache flex: what caching saved you versus the uncached
would-have-cost.

![COST view](docs/cost.png)

### F4 · CAPSULE — the time capsule

Every session ever, newest first: the prompt that started it, how long it ran,
the tools it used, the model mix. The **TELL ME THE STORY** key asks `claude -p`
(your own subscription, only on click, cached after) to narrate any period.

![CAPSULE view](docs/capsule.png)

**Drill-down everywhere:** click any heatmap day, bar, or curve point → Day
Inspector drawer (hourly bars, projects, models, sessions; arrow keys walk
days). Click any project → project view. Click any session → full detail. The
header latch (or `m`) flips every chart between **tokens ⇄ $EQ**.

> **About the dollars:** all figures are **API-equivalent value** — what your
> usage would have cost at API list prices. On a subscription you didn't pay
> this; it's the flex, not a bill.

## How it counts (the part most tools get wrong)

Claude Code writes **one JSONL line per content block**, so a single API
response — and its `usage` payload — appears on multiple lines repeating the
same `message.id`. Naively summing inflates totals ~2.3× on real data.

Claudiogram counts:

- **Token usage & cost** — once per `message.id` (`INSERT OR IGNORE` at the database layer)
- **User messages & tool calls** — once per line `uuid` (a `seen_lines` ledger inside the write transaction)
- **Re-ingest is idempotent** — files shrink when Claude Code compacts, sessions replay lines on resume; both converge instead of accumulating
- Synthetic placeholder rows are skipped; sidechain (subagent) rows are counted but tagged

## Read-only, by design and by test

Claudiogram **never writes to `~/.claude`**. Transcripts are opened with
read-only flags; the only thing the app ever writes is its own `data/` folder.
This isn't a promise — it's a test: the suite ingests write-protected
(chmod 444) fixtures and verifies byte-identical checksums, identical directory
listings, and unchanged permissions afterward.

```bash
npm test    # 11 tests, sandboxed — never touches your real DB or transcripts
```

CI runs the suite on **macOS, Ubuntu, and Windows** × Node 22 and 24 on every push.

## Demo mode

Want to poke at the UI without your own data (or screenshot it safely)?
Generate a synthetic dataset and boot a sandboxed instance:

```bash
node scripts/make-demo-data.mjs /tmp/cp-demo
CLAUDIOGRAM_PROJECTS_DIR=/tmp/cp-demo/projects \
CLAUDIOGRAM_DATA_DIR=/tmp/cp-demo/data PORT=4243 node server.js
```

All screenshots in this README come from demo mode — fake projects, fake
prompts, seeded PRNG.

## Architecture

```
~/.claude/projects/**/*.jsonl        (Claude Code's transcripts — read-only)
        │
        ▼  byte-offset tailing, fs.watch + debounce
lib/ingest.js ──► lib/pricing.js ──► lib/db.js (node:sqlite, WAL)
        │                                  │
        ▼                                  ▼
   server.js ── JSON API + SSE ──► public/ (vanilla JS, hand-rolled
                                            canvas/SVG charts, hash router)
```

- **No build step.** The frontend is plain ES modules; the charts are
  hand-rolled canvas/SVG — no chart library, no CDN, no web fonts.
- **History outlives the source.** Claude Code prunes transcripts after ~30
  days; Claudiogram's `data/usage.db` keeps everything it has ever ingested.
- Delete `data/usage.db*` to force a full rebuild from surviving transcripts.

### API

| Endpoint | What it returns |
|----------|-----------------|
| `GET /api/summary` | lifetime totals, streaks, today |
| `GET /api/timeseries?by=model\|project` | daily buckets for charts |
| `GET /api/heatmap` | 371-day grid |
| `GET /api/sessions` · `/api/session?id=` | the capsule |
| `GET /api/day?date=` | day inspector drill-down |
| `GET /api/projects` · `/api/project?name=` | project views |
| `GET /api/events` | SSE: every new message, live |
| `POST /api/story` | `claude -p` narration (user-initiated, cached) |

## License

[MIT](LICENSE)
