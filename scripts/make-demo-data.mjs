// Generates synthetic Claude Code transcripts — for screenshots and demos.
// No real data: fake projects, fake prompts, seeded PRNG so output is stable.
//
//   node scripts/make-demo-data.mjs [outdir]            (default /tmp/cp-demo)
//   CLAUDIOGRAM_PROJECTS_DIR=<outdir>/projects \
//   CLAUDIOGRAM_DATA_DIR=<outdir>/data PORT=4243 node server.js
import fs from 'node:fs';
import path from 'node:path';

const OUT = process.argv[2] || '/tmp/cp-demo';
const ROOT = path.join(OUT, 'projects');
fs.rmSync(OUT, { recursive: true, force: true });

const PROJECTS = [
  { name: 'claudecodevisualizer', cwd: '/home/dev/claudecodevisualizer', weight: 0.55 },
  { name: 'pulse-charts', cwd: '/home/dev/pulse-charts', weight: 0.3 },
  { name: 'ingest-lab', cwd: '/home/dev/ingest-lab', weight: 0.15 },
];
const MODELS = [
  ['claude-opus-4-8', 0.5],
  ['claude-sonnet-4-6', 0.35],
  ['claude-haiku-4-5', 0.15],
];
const TOOLS = ['Bash', 'Read', 'Edit', 'Write', 'Grep'];
const PROMPTS = [
  'wire up the heatmap drill-down to the day inspector',
  'fix the SSE reconnect backoff, it hammers the server',
  'add a punchcard chart of hour vs weekday',
  'make the cost view stack by model instead of project',
  'profile the ingest loop, full scan feels slow',
  'add keyboard navigation between days',
  'the tooltip clips at the right edge, fix the flip logic',
  'render the cumulative cost curve with two scope cursors',
  'dedupe usage by message id before pricing',
  'add a streak counter to the rhythm view',
  'cache the story responses in sqlite',
  'draw the live waveform with phosphor decay',
];

// Deterministic PRNG (mulberry32) — same demo every run.
let seed = 1337;
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const pickW = (pairs) => {
  let r = rnd();
  for (const [v, w] of pairs) { if ((r -= w) <= 0) return v; }
  return pairs[0][0];
};
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

let uuidN = 0, msgN = 0, sessN = 0;
const uuid = () => `demo-uuid-${++uuidN}`;
const iso = (t) => new Date(t).toISOString();

function writeSession(proj, startTs, exchanges, lines) {
  const sid = `demo-sess-${++sessN}`;
  let t = startTs;
  for (let e = 0; e < exchanges; e++) {
    lines.push(JSON.stringify({
      type: 'user', uuid: uuid(), sessionId: sid, timestamp: iso(t), cwd: proj.cwd,
      message: { role: 'user', content: pick(PROMPTS) },
    }));
    t += int(20, 120) * 1000;
    const model = pickW(MODELS);
    const usage = {
      input_tokens: int(40, 1200),
      output_tokens: int(150, 4500),
      cache_read_input_tokens: int(5000, 220000),
      cache_creation_input_tokens: int(0, 30000),
    };
    const msgId = `demo-msg-${++msgN}`;
    // Real transcripts repeat the same message.id across block lines — mirror that.
    const blocks = int(1, 3);
    for (let b = 0; b < blocks; b++) {
      const content = b === 0
        ? [{ type: 'text', text: 'On it.' }]
        : [{ type: 'tool_use', id: `t-${msgN}-${b}`, name: pick(TOOLS), input: {} }];
      lines.push(JSON.stringify({
        type: 'assistant', uuid: uuid(), sessionId: sid, timestamp: iso(t), cwd: proj.cwd,
        message: { id: msgId, model, usage, content },
      }));
      t += int(2, 15) * 1000;
    }
    t += int(30, 600) * 1000;
  }
  return sid;
}

const now = Date.now();
const DAY = 86400000;
let totalSessions = 0;

for (const proj of PROJECTS) {
  const dir = path.join(ROOT, proj.cwd.replace(/\//g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  for (let d = 150; d >= 0; d--) {
    const day = new Date(now - d * DAY);
    const dow = day.getDay();
    // Weekends lighter; ~40% of weekdays per project have activity, ramping up
    // over time so the cumulative curve bends like a real adoption story.
    const ramp = 0.35 + 0.65 * ((150 - d) / 150);
    const activeP = (dow === 0 || dow === 6 ? 0.18 : 0.5) * proj.weight * 2 * ramp;
    if (rnd() > activeP) continue;
    const sessions = int(1, dow === 0 || dow === 6 ? 1 : 3);
    for (let s = 0; s < sessions; s++) {
      // Work clusters: late morning and a long evening tail.
      const hour = rnd() < 0.35 ? int(10, 13) : int(15, 23);
      const start = new Date(day);
      start.setHours(hour, int(0, 59), int(0, 59), 0);
      if (start.getTime() > now) continue;
      const lines = [];
      const sid = writeSession(proj, start.getTime(), int(4, 26), lines);
      fs.writeFileSync(path.join(dir, `${sid}.jsonl`), lines.join('\n') + '\n');
      totalSessions++;
    }
  }
}

// A session still in flight right now, so the live pulse view has a heartbeat.
const live = PROJECTS[0];
const liveDir = path.join(ROOT, live.cwd.replace(/\//g, '-'));
const liveLines = [];
writeSession(live, now - 48 * 60000, 14, liveLines);
fs.writeFileSync(path.join(liveDir, 'demo-sess-live.jsonl'), liveLines.join('\n') + '\n');
totalSessions++;

console.log(`demo data: ${totalSessions} sessions across ${PROJECTS.length} projects → ${ROOT}`);
console.log(`run: CLAUDIOGRAM_PROJECTS_DIR=${ROOT} CLAUDIOGRAM_DATA_DIR=${path.join(OUT, 'data')} PORT=4243 node server.js`);
