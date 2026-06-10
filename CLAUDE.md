# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `node server.js` — start the app (full scan → fs.watch → http on port 4242, `PORT` env to override)
- `npm run ingest` — one-shot ingest without starting the server
- `npm test` — battle-test suite (`node:test`, zero deps); fully sandboxed via `CLAUDIOGRAM_DATA_DIR` + `CLAUDIOGRAM_PROJECTS_DIR` env overrides, never touches the real DB or transcripts
- `node --check <file>` — there is no build step or linter; syntax-check JS files directly
- Delete `data/usage.db*` to force a full rebuild from transcripts (~2s for ~350MB)

Requires Node ≥ 22.5 for built-in `node:sqlite`. Zero npm dependencies by design — do not add any.

## Architecture

CONTRACT.md is the binding spec: API shapes, SQLite schema, pricing table, and parsing rules live there. Change the contract first, then the code on both sides.

Data flow: `lib/ingest.js` tails `~/.claude/projects/**/*.jsonl` (per-file byte offsets stored in the `files` table, fs.watch + 500ms debounce, all ingest serialized through a promise chain) → `lib/pricing.js` normalizes usage and prices it → `lib/db.js` (node:sqlite, WAL) → `server.js` exposes the JSON API and broadcasts each new message over SSE (`/api/events`) → `public/` renders it (vanilla JS, hand-rolled canvas/SVG charts, hash router in `app.js`, views in `views.js`, chart primitives in `charts.js`).

## The dedup invariants (do not break these)

Claude Code writes one JSONL line per content block, so one API response spans
multiple lines repeating the same `message.id` and `usage`. Counting rules:

- **Token usage / cost**: once per `message.id` — enforced by `INSERT OR IGNORE` on `messages.msg_id`. Naive summing inflates ~2.3×.
- **user_msgs / tool_use counts**: once per line `uuid` — enforced by the `seen_lines` table, applied inside the write transaction. Tool blocks ARE counted per line (lines are distinct blocks).
- Re-ingest must be idempotent: files shrink (compaction) and sessions resume with replayed lines; both paths re-read from offset 0 and must converge, not accumulate. Enforced by `test/ingest.test.mjs` — run `npm test` after touching ingest/db.
- Skip `model === "<synthetic>"`; `isSidechain` rows are counted but tagged.

## Other constraints

- **`~/.claude` is strictly read-only.** The only directory this app may write is its own data dir (`data/`, or `CLAUDIOGRAM_DATA_DIR`). Transcripts are opened with flags `'r'`; never add any fs write/rename/delete call that could target the projects dir — `test/ingest.test.mjs` ingests chmod-444 fixtures and checksums them to enforce this.
- All day/hour bucketing is **local time** (`'localtime'` in SQL, `dayKeyLocal` in JS) — SQLite defaults to UTC, never use bare `date(ts)`.
- All dollar figures are API-equivalent value (user is on subscription); frontend labels them `$EQ`.
- `public/app.js` mirrors the pricing input-rate table from `lib/pricing.js` for client-side display math — change them together.
- The frontend is offline-only: no CDNs, no web fonts, system font stacks.
- The UI-scale control applies CSS `zoom` to `<html>`. Any new chart code mixing `clientX`/`getBoundingClientRect` (viewport px) with layout-px constants must divide the viewport delta by `uiZoom()` from charts.js; ratio-based math (`x / rect.width`) is zoom-safe as-is. New `vh` lengths in CSS need `/ var(--z, 1)`.
- `POST /api/story` shells out to `claude -p` (the user's subscription) — keep it strictly user-initiated and cached in the `insights` table.
