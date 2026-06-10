// ============================================================================
// CLAUDIOGRAM — charts.js
// Hand-rolled renderers: canvas phosphor engine, SVG heatmap/punchcard/bars,
// cumulative trace with scope cursors, donuts, trace-bar lists, odometers.
// Zero dependencies. All colors from the P31 token palette.
// ============================================================================

import { state, REDUCED, CH, channelOf, fmtTokens, fmtMoney, fmtNum, dayKeyLocal } from './app.js';

const NS = 'http://www.w3.org/2000/svg';
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const DOW = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
let uid = 0;

// ---------------------------------------------------------------------------
// Element helpers
// ---------------------------------------------------------------------------

export function S(tag, attrs = {}, ...children) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'style') el.style.cssText = v;
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v);
  }
  for (const c of children) if (c) el.appendChild(c);
  return el;
}

export function H(tag, cls = '', html = '') {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (html) el.innerHTML = html;
  return el;
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
export { esc };

export function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function fmtDateShort(t) {
  const d = new Date(t);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

// ---------------------------------------------------------------------------
// Shared tooltip — the cursor readout box
// ---------------------------------------------------------------------------

/**
 * Current UI scale — CSS zoom applied to <html> by the keyboard control.
 * clientX/getBoundingClientRect are viewport px; chart-internal layout px
 * (plotW, padL, style.left targets) differ by this factor when zoom ≠ 1.
 */
export function uiZoom() { return parseFloat(document.documentElement.style.zoom) || 1; }

/**
 * Map a clientX into an svg's own coordinate space. Rect-ratio based, so it
 * is correct under root zoom AND under `max-width: 100%` down-scaling.
 */
function localX(svg, clientX) {
  const r = svg.getBoundingClientRect();
  const w = parseFloat(svg.getAttribute('width')) || r.width;
  return (clientX - r.left) * (w / (r.width || 1));
}

export const tip = {
  show(html, x, y) {
    const el = document.getElementById('tooltip');
    if (!el) return;
    el.innerHTML = html;
    el.hidden = false;
    const z = uiZoom();
    const r = el.getBoundingClientRect();
    let lx = x + 14, ly = y + 12;
    if (lx + r.width > innerWidth - 8) lx = x - r.width - 14;
    if (ly + r.height > innerHeight - 8) ly = y - r.height - 12;
    // style.left is layout px (multiplied by zoom at render) — convert back
    el.style.left = Math.max(4, lx) / z + 'px';
    el.style.top = Math.max(4, ly) / z + 'px';
  },
  hide() {
    const el = document.getElementById('tooltip');
    if (el) el.hidden = true;
  },
};

export function tipBox(title, rows, footer) {
  let h = `<div class="t-label">${esc(title)}</div>`;
  for (const [k, v] of rows) h += `<div class="t-row"><span class="t-label">${esc(k)}</span><b>${esc(v)}</b></div>`;
  if (footer) h += `<div class="t-faint">${esc(footer)}</div>`;
  return h;
}

// ---------------------------------------------------------------------------
// THE PHOSPHOR ENGINE — one rAF loop, shared buffer, hero + header mini-trace
// ---------------------------------------------------------------------------

const BG_FADE = 'rgba(8,12,10,0.06)';
const COL_BG = [0x08, 0x0C, 0x0A];
const COL_ACCENT = [0x53, 0xFC, 0xA1];
const COL_AMBER = [0xFF, 0xB4, 0x54];

function lerpColor(a, b, k, alpha = 1) {
  const c = a.map((v, i) => Math.round(v + (b[i] - v) * k));
  return `rgba(${c[0]},${c[1]},${c[2]},${alpha})`;
}

// Redrawing every frame over the fade veil reaches the drawn color at
// equilibrium — so "40% opacity history" must be dimmed in COLOR, not alpha.
function dimToward(base, k) {
  return base.map((v, i) => Math.round(COL_BG[i] + (v - COL_BG[i]) * k));
}

export const engine = {
  buf: [],                 // [{t, tokens, cost}] one-minute buckets, ascending
  seam: Infinity,          // first live minute (everything before = seeded history)
  maxTok: 100, maxCost: 0.01,
  blips: [],               // {at, ch}
  flashAt: -1e9,
  pending: null,
  lastEventAt: 0,
  muted: new Set(),
  solo: null,
  mix: 0,                  // 0 = tokens, 1 = cost (eased)
  headDisp: { tok: 0, cost: 0 },
  targets: [],
  running: false,
  lastFrame: 0,
  hover: null,             // {canvas, x}
  _staticTimer: 0,

  hasSignal() { return this.buf.some((b) => b.tokens > 0); },

  seed(minutes) {
    this.buf = (minutes || []).map((m) => ({ t: m.t, tokens: m.tokens || 0, cost: m.cost || 0 }));
    this.buf.sort((a, b) => a.t - b.t);
    const now = Math.floor(Date.now() / 60000) * 60000;
    if (!this.buf.length) this.buf.push({ t: now, tokens: 0, cost: 0 });
    // seam at the start of the current minute: the head bucket (where live
    // pulses accumulate) must sit on the bright/live side immediately
    this.seam = now;
    this._rollMinutes();
    this._recomputeMax();
    const head = this.buf[this.buf.length - 1];
    this.headDisp = { tok: head.tokens, cost: head.cost };
    this.requestStatic();
  },

  attach(canvas, opts = {}) {
    const ctx = canvas.getContext('2d');
    const t = { canvas, ctx, opts, w: 0, h: 0 };
    this.targets.push(t);
    this._size(t);
    ctx.fillStyle = '#080C0A';
    ctx.fillRect(0, 0, t.w, t.h);
    if (REDUCED) this._drawStatic(t);
    else if (!this.running) { this.running = true; this.lastFrame = 0; requestAnimationFrame(this._loop); }
    return t;
  },

  detach(canvas) {
    this.targets = this.targets.filter((t) => t.canvas !== canvas);
    if (this.hover && this.hover.canvas === canvas) this.hover = null;
    if (!this.targets.length) this.running = false;
  },

  resize() {
    for (const t of this.targets) this._size(t);
    this.requestStatic();
  },

  pulse(ev) {
    this.lastEventAt = Date.now();
    if (!this.pending) this.pending = { tokens: 0, cost: 0, blips: [] };
    this.pending.tokens += (ev.in || 0) + (ev.out || 0);
    this.pending.cost += ev.cost || 0;
    const cap = document.hidden ? 4 : 24;
    if (this.pending.blips.length < cap) this.pending.blips.push(channelOf(ev.model));
    if (REDUCED || document.hidden) this._flushPending();
    if (REDUCED) this.requestStatic();
  },

  bucketAt(xRatio) {
    const L = this.buf.length;
    if (!L) return null;
    const i = Math.max(0, Math.min(L - 1, Math.round(xRatio * (L - 1))));
    return this.buf[i];
  },

  setHover(canvas, x) { this.hover = x == null ? null : { canvas, x }; },
  setChannelFilter(muted, solo) { this.muted = muted; this.solo = solo; },
  channelVisible(ch) { return this.solo ? this.solo === ch : !this.muted.has(ch); },

  requestStatic() {
    if (!REDUCED) return;
    clearTimeout(this._staticTimer);
    this._staticTimer = setTimeout(() => { for (const t of this.targets) this._drawStatic(t); }, 80);
  },

  _size(t) {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const r = t.canvas.getBoundingClientRect();
    t.w = Math.max(20, r.width);
    t.h = Math.max(10, r.height);
    t.canvas.width = Math.round(t.w * dpr);
    t.canvas.height = Math.round(t.h * dpr);
    t.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  },

  _rollMinutes() {
    const m = Math.floor(Date.now() / 60000) * 60000;
    if (!this.buf.length) this.buf.push({ t: m, tokens: 0, cost: 0 });
    let last = this.buf[this.buf.length - 1].t;
    let guard = 0;
    while (last < m && guard++ < 200) { last += 60000; this.buf.push({ t: last, tokens: 0, cost: 0 }); }
    if (this.buf.length > 120) this.buf.splice(0, this.buf.length - 120);
  },

  _recomputeMax() {
    let mt = 100, mc = 0.01;
    for (const b of this.buf) { if (b.tokens > mt) mt = b.tokens; if (b.cost > mc) mc = b.cost; }
    this.maxTok = mt; this.maxCost = mc;
  },

  _flushPending() {
    if (!this.pending) return;
    this._rollMinutes();
    const head = this.buf[this.buf.length - 1];
    head.tokens += this.pending.tokens;
    head.cost += this.pending.cost;
    const now = performance.now();
    for (const ch of this.pending.blips) {
      if (this.channelVisible(ch)) this.blips.push({ at: now, ch });
    }
    if (this.blips.length > 40) this.blips.splice(0, this.blips.length - 40);
    this.flashAt = now;
    this.pending = null;
    this._recomputeMax();
  },

  _loop: null, // bound below

  _frame(now) {
    if (!this.running) return;
    requestAnimationFrame(this._loop);
    if (document.hidden) return;
    const dt = Math.min(120, this.lastFrame ? now - this.lastFrame : 16);
    this.lastFrame = now;
    this._flushPending();
    this._rollMinutes();
    const mt = state.metric === 'cost' ? 1 : 0;
    this.mix += (mt - this.mix) * Math.min(1, dt / 110);
    if (Math.abs(this.mix - mt) < 0.005) this.mix = mt;
    const head = this.buf[this.buf.length - 1];
    const k = 1 - Math.exp(-dt / 70); // ~180ms ease-in for spikes
    this.headDisp.tok += (head.tokens - this.headDisp.tok) * k;
    this.headDisp.cost += (head.cost - this.headDisp.cost) * k;
    for (const t of this.targets) this._draw(t, now);
  },

  _geometry(t) {
    const mini = !!t.opts.mini;
    const baseY = t.h - (mini ? 4 : 12);
    const topY = mini ? 3 : 14;
    const lt = Math.log1p(Math.max(this.maxTok, 10));
    const lc = Math.log1p(Math.max(this.maxCost, 0.001));
    const span = baseY - topY;
    const yOf = (tok, cost) => {
      const nt = Math.log1p(Math.max(0, tok)) / lt;
      const nc = Math.log1p(Math.max(0, cost)) / lc;
      const n = nt + (nc - nt) * this.mix;
      return baseY - Math.min(1, n) * span;
    };
    return { mini, baseY, topY, yOf };
  },

  _points(t, geo, withHead) {
    const L = this.buf.length;
    const pts = [];
    for (let i = 0; i < L; i++) {
      const b = this.buf[i];
      const isHead = withHead && i === L - 1;
      pts.push({
        x: L > 1 ? (i / (L - 1)) * t.w : t.w,
        y: geo.yOf(isHead ? this.headDisp.tok : b.tokens, isHead ? this.headDisp.cost : b.cost),
        t: b.t,
        zero: b.tokens <= 0,
      });
    }
    return pts;
  },

  _strokeSeg(ctx, pts, from, to, color, width) {
    if (to <= from) return;
    ctx.beginPath();
    ctx.moveTo(pts[from].x, pts[from].y);
    for (let i = from + 1; i <= to; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();
  },

  _graticule(ctx, w, h) {
    ctx.save();
    ctx.setLineDash([1, 3]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#16201B';
    for (let i = 1; i < 10; i++) {
      const x = Math.round((i / 10) * w) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
    for (let j = 1; j < 6; j++) {
      const y = Math.round((j / 6) * h) + 0.5;
      ctx.strokeStyle = j === 3 ? '#2A3A32' : '#16201B';
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }
    ctx.restore();
  },

  _draw(t, now) {
    const { ctx, w, h } = { ctx: t.ctx, w: t.w, h: t.h };
    ctx.fillStyle = BG_FADE;
    ctx.fillRect(0, 0, w, h); // the afterglow veil — one fillRect per frame
    const geo = this._geometry(t);
    if (!geo.mini) this._graticule(ctx, w, h);
    const L = this.buf.length;
    if (L < 2) return;
    const pts = this._points(t, geo, true);
    const idle = Date.now() - this.lastEventAt > 5000;
    if (idle && !geo.mini) {
      for (const p of pts) if (p.zero && p.t >= this.seam) p.y += Math.random() * 2 - 1; // thermal noise
    }
    let seamIdx = pts.findIndex((p) => p.t >= this.seam);
    if (seamIdx < 0) seamIdx = L - 1;
    const col = (a) => lerpColor(COL_ACCENT, COL_AMBER, this.mix, a);
    const dimCol = lerpColor(dimToward(COL_ACCENT, 0.4), dimToward(COL_AMBER, 0.4), this.mix);
    this._strokeSeg(ctx, pts, 0, Math.min(seamIdx, L - 1), dimCol, geo.mini ? 1 : 1.4);
    this._strokeSeg(ctx, pts, Math.max(0, seamIdx - 1), L - 1, col(0.95), geo.mini ? 1 : 1.6);
    const head = pts[L - 1];
    ctx.beginPath();
    ctx.arc(head.x - 1, head.y, geo.mini ? 1.3 : 2, 0, 7);
    ctx.fillStyle = col(1);
    ctx.fill();
    // pulse flash at the head — phosphor decays it
    const fAge = now - this.flashAt;
    if (fAge >= 0 && fAge < 160) {
      ctx.globalAlpha = 0.8 * (1 - fAge / 160);
      ctx.strokeStyle = col(1);
      ctx.lineWidth = geo.mini ? 1 : 2;
      ctx.beginPath(); ctx.moveTo(head.x - 1, geo.baseY); ctx.lineTo(head.x - 1, head.y); ctx.stroke();
      ctx.globalAlpha = 1;
    }
    // channel blips at the baseline
    for (const b of this.blips) {
      const age = now - b.at;
      if (age > 700 || !this.channelVisible(b.ch)) continue;
      ctx.globalAlpha = 0.9 * (1 - age / 700);
      ctx.fillStyle = CH[b.ch].color;
      ctx.fillRect(w - 4, geo.baseY - (geo.mini ? 2 : 3), geo.mini ? 2 : 3, geo.mini ? 2 : 3);
    }
    ctx.globalAlpha = 1;
    // idle sweep beam — instrument left on overnight
    if (idle && !geo.mini) {
      const sx = ((now % 8000) / 8000) * w;
      let sy = geo.baseY;
      for (let i = 1; i < L; i++) if (pts[i].x >= sx) { sy = pts[i - 1].y + (pts[i].y - pts[i - 1].y) * ((sx - pts[i - 1].x) / Math.max(1, pts[i].x - pts[i - 1].x)); break; }
      ctx.save();
      ctx.shadowColor = col(0.9); ctx.shadowBlur = 8;
      ctx.beginPath(); ctx.arc(sx, sy, 1.6, 0, 7); ctx.fillStyle = col(1); ctx.fill();
      ctx.restore();
    }
    // hover hairline
    if (!geo.mini && this.hover && this.hover.canvas === t.canvas) {
      ctx.strokeStyle = 'rgba(255,180,84,0.6)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(this.hover.x + 0.5, 0); ctx.lineTo(this.hover.x + 0.5, h); ctx.stroke();
    }
  },

  _drawStatic(t) {
    // prefers-reduced-motion: no afterglow, no noise, no sweep — one clean frame
    this._flushPending();
    this._rollMinutes();
    const { ctx, w, h } = { ctx: t.ctx, w: t.w, h: t.h };
    ctx.fillStyle = '#080C0A';
    ctx.fillRect(0, 0, w, h);
    const geo = this._geometry(t);
    this.mix = state.metric === 'cost' ? 1 : 0;
    if (!geo.mini) this._graticule(ctx, w, h);
    if (this.buf.length < 2) return;
    const head = this.buf[this.buf.length - 1];
    this.headDisp = { tok: head.tokens, cost: head.cost };
    const pts = this._points(t, geo, true);
    let seamIdx = pts.findIndex((p) => p.t >= this.seam);
    if (seamIdx < 0) seamIdx = pts.length - 1;
    const col = (a) => lerpColor(COL_ACCENT, COL_AMBER, this.mix, a);
    const dimCol = lerpColor(dimToward(COL_ACCENT, 0.4), dimToward(COL_AMBER, 0.4), this.mix);
    this._strokeSeg(ctx, pts, 0, seamIdx, dimCol, geo.mini ? 1 : 1.4);
    this._strokeSeg(ctx, pts, Math.max(0, seamIdx - 1), pts.length - 1, col(0.95), geo.mini ? 1 : 1.6);
  },
};
engine._loop = engine._frame.bind(engine);

// ---------------------------------------------------------------------------
// Odometer — rolling tabular digits, most-significant first
// ---------------------------------------------------------------------------

export function odometer(el, text) {
  text = String(text);
  if (el._odText === text && el._odDone) return;
  if (REDUCED || el._odText == null) {
    el._odText = text; el._odDone = true;
    el.classList.add('od');
    el.textContent = text;
    return;
  }
  const old = el._odText;
  el._odText = text; el._odDone = false;
  const len = Math.max(old.length, text.length);
  const o = old.padStart(len, ' ');
  const n = text.padStart(len, ' ');
  el.textContent = '';
  el.classList.add('od');
  let delay = 0;
  for (let i = 0; i < len; i++) {
    const c = H('span', 'od-c');
    if (o[i] === n[i]) { c.textContent = n[i]; el.appendChild(c); continue; }
    const col = H('span', 'od-col');
    const a = H('span'); a.textContent = o[i];
    const b = H('span'); b.textContent = n[i];
    col.append(a, b);
    col.style.transitionDelay = delay + 'ms';
    delay += 30;
    c.appendChild(col);
    el.appendChild(c);
    requestAnimationFrame(() => requestAnimationFrame(() => { col.style.transform = 'translateY(-1.1em)'; }));
  }
  clearTimeout(el._odTimer);
  el._odTimer = setTimeout(() => { if (el._odText === text) { el.textContent = text; el._odDone = true; } }, 420 + delay);
}

// ---------------------------------------------------------------------------
// Path morph (line charts) — numeric interpolation over 240ms
// ---------------------------------------------------------------------------

function easeInOut(k) { return k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2; }

export function morphYs(fromYs, toYs, apply) {
  if (REDUCED || !fromYs || fromYs.length !== toYs.length) { apply(toYs); return; }
  const start = performance.now();
  const dur = 240;
  function step(now) {
    const k = Math.min(1, (now - start) / dur);
    const e = easeInOut(k);
    apply(fromYs.map((f, i) => f + (toYs[i] - f) * e));
    if (k < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

// ---------------------------------------------------------------------------
// HEATMAP — The Year Field (53×7, quantized phosphor)
// ---------------------------------------------------------------------------

export function heatmap(host, days, opts = {}) {
  host.innerHTML = '';
  const cell = 13, step = 16, left = 30, top = 18;
  const byDate = new Map(days.map((d) => [d.date, d]));
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todayKey = dayKeyLocal(today.getTime());
  const start = new Date(today);
  start.setDate(start.getDate() - 370);
  while ((start.getDay() + 6) % 7 !== 0) start.setDate(start.getDate() - 1); // back to Monday

  // current streak (walk back from today, allow streak ending yesterday)
  const streak = new Set();
  {
    const c = new Date(today);
    if (!byDate.has(dayKeyLocal(c.getTime()))) c.setDate(c.getDate() - 1);
    while (byDate.has(dayKeyLocal(c.getTime()))) { streak.add(dayKeyLocal(c.getTime())); c.setDate(c.getDate() - 1); }
  }

  const cols = [];
  {
    const cur = new Date(start);
    while (cur <= today) {
      const col = [];
      for (let r = 0; r < 7; r++) {
        col.push(cur <= today ? dayKeyLocal(cur.getTime()) : null);
        cur.setDate(cur.getDate() + 1);
      }
      cols.push(col);
    }
  }

  const W = left + cols.length * step + 4;
  const Hh = top + 7 * step + 4;
  const svg = S('svg', { width: W, height: Hh, viewBox: `0 0 ${W} ${Hh}`, role: 'img', 'aria-label': 'Activity heatmap, last 371 days' });
  const fid = `hmblur${++uid}`;
  svg.appendChild(S('defs', {}, S('filter', { id: fid, x: '-80%', y: '-80%', width: '260%', height: '260%' }, S('feGaussianBlur', { stdDeviation: 3 }))));

  // weekday labels M/W/F
  for (const [r, lbl] of [[0, 'M'], [2, 'W'], [4, 'F']]) {
    svg.appendChild(S('text', { class: 'tick', x: left - 10, y: top + r * step + 10, 'text-anchor': 'middle', text: lbl }));
  }

  const cells = []; // {rect, bloom, date, data}
  let lastMonth = -1, lastLabelX = -100;
  cols.forEach((col, ci) => {
    const g = S('g', { class: 'hm-col' + (opts.animate && !REDUCED ? ' pre' : '') });
    const x = left + ci * step;
    const firstDate = col.find(Boolean);
    if (firstDate) {
      const m = new Date(firstDate + 'T00:00').getMonth();
      if (m !== lastMonth) {
        if (x - lastLabelX > 28) {
          svg.appendChild(S('text', { class: 'tick', x, y: 10, text: MONTHS[m] }));
          lastLabelX = x;
        }
        lastMonth = m;
      }
    }
    col.forEach((date, r) => {
      if (!date) return;
      const y = top + r * step;
      const data = byDate.get(date);
      const bloom = S('rect', { x, y, width: cell, height: cell, rx: 2, filter: `url(#${fid})`, opacity: 0, 'pointer-events': 'none' });
      bloom.style.fill = 'var(--heat-4)';
      const rect = S('rect', { class: 'hm-cell', x, y, width: cell, height: cell, rx: 2, 'data-date': date });
      if (date === todayKey) { rect.style.stroke = 'var(--accent-alt)'; rect.style.strokeWidth = '1'; }
      else if (streak.has(date)) { rect.style.stroke = 'var(--accent)'; rect.style.strokeWidth = '1'; }
      else if (!data) { rect.style.stroke = 'var(--graticule)'; rect.style.strokeWidth = '1'; }
      g.append(bloom, rect);
      cells.push({ rect, bloom, date, data, x, y });
    });
    svg.appendChild(g);
    if (opts.animate && !REDUCED) {
      g.style.transitionDelay = `${ci * 8}ms`;
      requestAnimationFrame(() => requestAnimationFrame(() => g.classList.remove('pre')));
    }
  });

  const chX = S('line', { class: 'crosshair', x1: 0, y1: 0, x2: 0, y2: 0 });
  const chY = S('line', { class: 'crosshair', x1: 0, y1: 0, x2: 0, y2: 0 });
  svg.append(chX, chY);

  function applyMetric(metric) {
    const vals = days.map((d) => d[metric]).filter((v) => v > 0).sort((a, b) => a - b);
    const th = [percentile(vals, 25), percentile(vals, 50), percentile(vals, 75), percentile(vals, 90)];
    for (const c of cells) {
      const v = c.data ? c.data[metric] : 0;
      let lvl = 0;
      if (v > 0) lvl = v <= th[0] ? 1 : v <= th[1] ? 2 : v <= th[2] ? 3 : 4;
      c.rect.style.fill = `var(--heat-${lvl})`;
      c.bloom.setAttribute('opacity', v > 0 && v >= th[3] && th[3] > 0 ? 0.55 : 0);
    }
  }
  applyMetric(opts.metric || 'tokens');

  svg.addEventListener('mousemove', (e) => {
    const r = e.target.closest && e.target.closest('.hm-cell');
    if (!r) { tip.hide(); chX.classList.remove('on'); chY.classList.remove('on'); return; }
    const c = cells.find((cc) => cc.rect === r);
    if (!c) return;
    chX.setAttribute('x1', left - 2); chX.setAttribute('x2', c.x); chX.setAttribute('y1', c.y + cell / 2); chX.setAttribute('y2', c.y + cell / 2);
    chY.setAttribute('x1', c.x + cell / 2); chY.setAttribute('x2', c.x + cell / 2); chY.setAttribute('y1', 14); chY.setAttribute('y2', c.y);
    chX.classList.add('on'); chY.classList.add('on');
    const d = c.data;
    tip.show(tipBox(c.date, [
      ['TOKENS', d ? fmtTokens(d.tokens) : '0'],
      ['$EQ', d ? fmtMoney(d.cost) : '$0.00'],
      ['SESSIONS', d ? fmtNum(d.sessions) : '0'],
      ['MESSAGES', d ? fmtNum(d.messages) : '0'],
    ], 'CLICK → DAY INSPECTOR'), e.clientX, e.clientY);
  });
  svg.addEventListener('mouseleave', () => { tip.hide(); chX.classList.remove('on'); chY.classList.remove('on'); });
  svg.addEventListener('click', (e) => {
    const r = e.target.closest && e.target.closest('.hm-cell');
    if (r && opts.onDay) opts.onDay(r.getAttribute('data-date'));
  });

  const wrap = H('div', 'hm-wrap');
  wrap.appendChild(svg);
  host.appendChild(wrap);
  return { update: applyMetric };
}

// ---------------------------------------------------------------------------
// PUNCHCARD — 24×7 dot matrix with edge marginals + crosshair
// ---------------------------------------------------------------------------

export function punchcard(host, data, opts = {}) {
  host.innerHTML = '';
  const grid = data.grid || [];
  const hours = data.hours || Array.from({ length: 24 }, (_, h) => grid.reduce((s, row) => s + (row[h] || 0), 0));
  const dayTotals = data.days || grid.map((row) => row.reduce((s, v) => s + (v || 0), 0));
  const compact = !!opts.compact;
  const maxR = compact ? 5 : 7;
  const cw = compact ? 21 : 27, rh = compact ? 20 : 26;
  const left = 40, top = 38, right = 46, bottom = 18;
  const W = left + 24 * cw + right, Hh = top + 7 * rh + bottom;

  let maxV = 0;
  for (const row of grid) for (const v of row) if (v > maxV) maxV = v;
  const nz = [];
  for (const row of grid) for (const v of row) if (v > 0) nz.push(v);
  nz.sort((a, b) => a - b);
  const th = [percentile(nz, 25), percentile(nz, 50), percentile(nz, 75)];
  const opac = (v) => (v <= th[0] ? 0.4 : v <= th[1] ? 0.6 : v <= th[2] ? 0.8 : 1);
  const maxHr = Math.max(1, ...hours);
  const maxDay = Math.max(1, ...dayTotals);

  const svg = S('svg', { width: W, height: Hh, viewBox: `0 0 ${W} ${Hh}`, role: 'img', 'aria-label': 'Punchcard: tokens by weekday and hour' });

  // hour marginal meters (top)
  const hourBars = [];
  for (let h = 0; h < 24; h++) {
    const bh = Math.max(hours[h] > 0 ? 1.5 : 0, (hours[h] / maxHr) * 12);
    const b = S('rect', { class: 'pc-marginal', x: left + h * cw + cw / 2 - 1.5, y: 14 - bh, width: 3, height: bh });
    hourBars.push(b);
    svg.appendChild(b);
  }
  // day marginal meters (right)
  const dayBars = [];
  for (let d = 0; d < 7; d++) {
    const bw = Math.max(dayTotals[d] > 0 ? 1.5 : 0, (dayTotals[d] / maxDay) * (right - 14));
    const b = S('rect', { class: 'pc-marginal', x: left + 24 * cw + 6, y: top + d * rh + rh / 2 - 1.5, width: bw, height: 3 });
    dayBars.push(b);
    svg.appendChild(b);
  }
  // labels
  for (let d = 0; d < 7; d++) {
    svg.appendChild(S('text', { class: 'tick', x: left - 8, y: top + d * rh + rh / 2 + 3, 'text-anchor': 'end', text: DOW[d] }));
  }
  for (let h = 0; h < 24; h += 3) {
    svg.appendChild(S('text', { class: 'tick', x: left + h * cw + cw / 2, y: Hh - 4, 'text-anchor': 'middle', text: String(h).padStart(2, '0') }));
  }

  // quiet band — longest all-zero hour run (≥3h), wrap-aware
  if (nz.length) {
    const zero = hours.map((v) => v === 0);
    let best = { len: 0, start: 0 };
    for (let s = 0; s < 24; s++) {
      if (!zero[s]) continue;
      let len = 0;
      while (len < 24 && zero[(s + len) % 24]) len++;
      if (len > best.len) best = { len, start: s };
    }
    if (best.len >= 3 && best.len < 24) {
      const endH = (best.start + best.len) % 24;
      const lbl = `QUIET BAND ${String(best.start).padStart(2, '0')}:00–${String(endH).padStart(2, '0')}:00`;
      svg.appendChild(S('text', { class: 'tick', x: left + 24 * cw - 2, y: 28, 'text-anchor': 'end', text: lbl }));
    }
  }

  // dots + single max cell ring
  let maxCell = null;
  for (let d = 0; d < 7; d++) {
    for (let h = 0; h < 24; h++) {
      const v = grid[d] ? grid[d][h] || 0 : 0;
      if (v <= 0) continue;
      const r = Math.max(1.2, Math.sqrt(v / maxV) * maxR);
      const dot = S('circle', { class: 'pc-dot', cx: left + h * cw + cw / 2, cy: top + d * rh + rh / 2, r: r.toFixed(2), opacity: opac(v) });
      svg.appendChild(dot);
      if (v === maxV && !maxCell) { maxCell = dot; dot.style.stroke = 'var(--accent-alt)'; dot.style.strokeWidth = '1'; }
    }
  }

  const chR = S('line', { class: 'crosshair' });
  const chC = S('line', { class: 'crosshair' });
  svg.append(chR, chC);

  // hover hit cells
  for (let d = 0; d < 7; d++) {
    for (let h = 0; h < 24; h++) {
      const hit = S('rect', { class: 'pc-hover-rect', x: left + h * cw, y: top + d * rh, width: cw, height: rh });
      hit.addEventListener('mousemove', (e) => {
        const v = grid[d] ? grid[d][h] || 0 : 0;
        hourBars.forEach((b, i) => b.classList.toggle('hot', i === h));
        dayBars.forEach((b, i) => b.classList.toggle('hot', i === d));
        chR.setAttribute('x1', left); chR.setAttribute('x2', left + 24 * cw); chR.setAttribute('y1', top + d * rh + rh / 2); chR.setAttribute('y2', top + d * rh + rh / 2);
        chC.setAttribute('x1', left + h * cw + cw / 2); chC.setAttribute('x2', left + h * cw + cw / 2); chC.setAttribute('y1', 16); chC.setAttribute('y2', top + 7 * rh);
        chR.classList.add('on'); chC.classList.add('on');
        tip.show(tipBox(`${DOW[d]} · ${String(h).padStart(2, '0')}:00`, [['TOKENS', fmtTokens(v)]], 'MEASURE ONLY'), e.clientX, e.clientY);
      });
      svg.appendChild(hit);
    }
  }
  svg.addEventListener('mouseleave', () => {
    tip.hide();
    chR.classList.remove('on'); chC.classList.remove('on');
    hourBars.forEach((b) => b.classList.remove('hot'));
    dayBars.forEach((b) => b.classList.remove('hot'));
  });

  if (!nz.length) {
    host.appendChild(H('div', 'empty', 'SIGNAL FLAT — INSTRUMENT ARMED, AWAITING TOKENS.'));
    return { update() {} };
  }
  const wrap = H('div', 'hm-wrap');
  wrap.appendChild(svg);
  host.appendChild(wrap);
  return { update() {} };
}

// ---------------------------------------------------------------------------
// STACKED BARS — timeseries by model/project, tweened geometry
// ---------------------------------------------------------------------------

export function stackedBars(host, opts = {}) {
  host.innerHTML = '';
  const Hh = opts.height || 240;
  const W = Math.max(240, host.clientWidth || 600);
  const padL = 8, padR = opts.overlay ? 64 : 14, padT = 20, padB = 18;
  const plotW = W - padL - padR, plotH = Hh - padT - padB;
  const svg = S('svg', { width: W, height: Hh, viewBox: `0 0 ${W} ${Hh}` });
  host.appendChild(svg);

  const gGrat = S('g'); svg.appendChild(gGrat);
  const gBars = S('g'); svg.appendChild(gBars);
  const gOver = S('g'); svg.appendChild(gOver);
  const gHits = S('g'); svg.appendChild(gHits);
  const ch = S('line', { class: 'crosshair' }); svg.appendChild(ch);

  for (let j = 1; j <= 3; j++) {
    gGrat.appendChild(S('line', { class: 'grat', x1: padL, x2: W - padR, y1: padT + (plotH * j) / 4, y2: padT + (plotH * j) / 4 }));
  }
  gGrat.appendChild(S('line', { class: 'grat-axis', x1: padL, x2: W - padR, y1: padT + plotH + 0.5, y2: padT + plotH + 0.5 }));

  let cur = null; // {data, rects: Map, overlayPath, maxTotal}

  function build(data, overlay) {
    gBars.innerHTML = ''; gOver.innerHTML = ''; gHits.innerHTML = '';
    svg.querySelectorAll('.sb-label').forEach((n) => n.remove());
    const n = data.length;
    cur = { data, rects: new Map(), overlay };
    if (!n) return;
    const slot = plotW / n;
    const barW = Math.max(1.5, Math.min(20, slot - 2));
    const maxTotal = Math.max(1e-9, ...data.map((d) => d.total));
    cur.maxTotal = maxTotal;
    const yOf = (v) => padT + (1 - v / maxTotal) * plotH;

    data.forEach((d, i) => {
      const x = padL + i * slot + (slot - barW) / 2;
      let acc = 0;
      for (const p of d.parts) {
        if (p.value <= 0) continue;
        const y0 = yOf(acc), y1 = yOf(acc + p.value);
        const rect = S('rect', { class: 'sb-seg', x: x.toFixed(1), width: barW.toFixed(1), fill: p.color, 'data-key': p.key });
        rect.style.y = y1 + 'px';
        rect.style.height = Math.max(0.5, y0 - y1) + 'px';
        if (opts.onSeg) {
          rect.style.cursor = 'pointer';
          rect.addEventListener('click', (e) => { e.stopPropagation(); opts.onSeg(p.key, d.t); });
        }
        gBars.appendChild(rect);
        cur.rects.set(`${i}|${p.key}`, rect);
        acc += p.value;
      }
      const hit = S('rect', { class: 'sb-hit', x: padL + i * slot, y: padT, width: slot, height: plotH });
      hit.addEventListener('mousemove', (e) => {
        ch.setAttribute('x1', x + barW / 2); ch.setAttribute('x2', x + barW / 2);
        ch.setAttribute('y1', padT); ch.setAttribute('y2', padT + plotH);
        ch.classList.add('on');
        const rows = d.parts.filter((p) => p.value > 0).sort((a, b) => b.value - a.value).slice(0, 9)
          .map((p) => [`${p.glyph} ${p.label}`, opts.fmt(p.value)]);
        rows.push(['TOTAL', opts.fmt(d.total)]);
        tip.show(tipBox(opts.label ? opts.label(d.t) : fmtDateShort(d.t), rows, opts.onBar ? 'CLICK → DAY INSPECTOR' : ''), e.clientX, e.clientY);
      });
      hit.addEventListener('mouseleave', () => { tip.hide(); ch.classList.remove('on'); });
      if (opts.onBar) hit.addEventListener('click', () => opts.onBar(d.t));
      gHits.appendChild(hit);
    });

    // y-axis tick label (inside the plot unless an overlay axis claims the margin)
    if (opts.overlay) svg.appendChild(S('text', { class: 'tick sb-label', x: W - padR + 4, y: padT + 8, text: opts.fmt(maxTotal) }));
    else svg.appendChild(S('text', { class: 'tick sb-label', x: W - padR - 4, y: padT + 8, 'text-anchor': 'end', text: opts.fmt(maxTotal) }));
    // x labels
    const ticks = Math.min(6, n);
    for (let k = 0; k < ticks; k++) {
      const i = Math.round((k / Math.max(1, ticks - 1)) * (n - 1));
      svg.appendChild(S('text', {
        class: 'tick sb-label', x: padL + i * slot + slot / 2, y: Hh - 4,
        'text-anchor': k === 0 ? 'start' : k === ticks - 1 ? 'end' : 'middle',
        text: opts.label ? opts.label(data[i].t) : fmtDateShort(data[i].t),
      }));
    }

    // overlay cumulative line (right axis)
    if (overlay && overlay.length === n) {
      const omax = Math.max(1e-9, ...overlay.map((o) => o.v));
      const pts = overlay.map((o, i) => `${(padL + i * slot + slot / 2).toFixed(1)},${(padT + (1 - o.v / omax) * plotH).toFixed(1)}`);
      gOver.appendChild(S('polyline', { points: pts.join(' '), fill: 'none', stroke: 'var(--accent)', 'stroke-width': 1.4, opacity: 0.9 }));
      let oy = padT + (1 - overlay[n - 1].v / omax) * plotH + 3;
      if (Math.abs(oy - (padT + 8)) < 14) oy = padT + 22; // dodge the y-max label
      gOver.appendChild(S('text', { class: 'tick sb-label', x: W - padR + 4, y: oy, style: 'fill: var(--accent)', text: opts.fmt(overlay[n - 1].v) }));
    }
  }

  build(opts.data, opts.overlay);

  return {
    update(data, overlay) {
      // same shape → tween geometry via CSS y/height transitions; else rebuild
      if (!cur || data.length !== cur.data.length) { build(data, overlay); return; }
      const n = data.length;
      const slot = plotW / n;
      const maxTotal = Math.max(1e-9, ...data.map((d) => d.total));
      const yOf = (v) => padT + (1 - v / maxTotal) * plotH;
      let mismatch = false;
      data.forEach((d, i) => {
        let acc = 0;
        for (const p of d.parts) {
          if (p.value <= 0) continue;
          const rect = cur.rects.get(`${i}|${p.key}`);
          if (!rect) { mismatch = true; continue; }
          const y0 = yOf(acc), y1 = yOf(acc + p.value);
          rect.style.y = y1 + 'px';
          rect.style.height = Math.max(0.5, y0 - y1) + 'px';
          acc += p.value;
        }
      });
      if (mismatch) { build(data, overlay); return; }
      cur.data = data;
      const lbl = svg.querySelector('.sb-label');
      if (lbl) lbl.textContent = opts.fmt(maxTotal);
      if (overlay) build(data, overlay); // overlay scale changed — rebuild is cheap & rare
    },
    setSolo(key) {
      gBars.querySelectorAll('.sb-seg').forEach((r) => {
        r.classList.toggle('dimmed', !!key && r.getAttribute('data-key') !== key);
      });
    },
  };
}

// ---------------------------------------------------------------------------
// CUMULATIVE TRACE — long-exposure value curve + scope cursors + flags
// ---------------------------------------------------------------------------

export function cumulativeTrace(host, opts = {}) {
  host.innerHTML = '';
  host.classList.add('cum-wrap');
  const rows = opts.rows; // [{t, tok, cost}]
  const Hh = opts.height || 300;
  const W = Math.max(280, host.clientWidth || 800);
  const padL = 10, padR = 110, padT = 26, padB = 22;
  const plotW = W - padL - padR, plotH = Hh - padT - padB;
  const n = rows.length;

  const cumTok = [], cumCost = [];
  let st = 0, sc = 0;
  for (const r of rows) { st += r.tok; sc += r.cost; cumTok.push(st); cumCost.push(sc); }

  const svg = S('svg', { width: W, height: Hh, viewBox: `0 0 ${W} ${Hh}` });
  const gid = `cumgrad${++uid}`, fid = `cumblur${++uid}`;
  svg.appendChild(S('defs', {},
    S('linearGradient', { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 },
      S('stop', { offset: '0%', 'stop-color': '#53FCA1', 'stop-opacity': 0.12 }),
      S('stop', { offset: '100%', 'stop-color': '#53FCA1', 'stop-opacity': 0 })),
    S('filter', { id: fid, x: '-30%', y: '-30%', width: '160%', height: '160%' }, S('feGaussianBlur', { stdDeviation: 3 }))));

  for (let j = 1; j <= 3; j++) svg.appendChild(S('line', { class: 'grat', x1: padL, x2: W - padR, y1: padT + (plotH * j) / 4, y2: padT + (plotH * j) / 4 }));
  svg.appendChild(S('line', { class: 'grat-axis', x1: padL, x2: W - padR, y1: padT + plotH + 0.5, y2: padT + plotH + 0.5 }));

  const xOf = (i) => padL + (n > 1 ? (i / (n - 1)) * plotW : plotW);
  const ysFor = (metric) => {
    const arr = metric === 'cost' ? cumCost : cumTok;
    const max = Math.max(1e-9, arr[n - 1]);
    return arr.map((v) => padT + (1 - v / max) * plotH);
  };

  const area = S('path', { fill: `url(#${gid})` });
  const glow = S('path', { fill: 'none', stroke: 'var(--accent)', 'stroke-width': 3, opacity: 0.4, filter: `url(#${fid})` });
  const line = S('path', { fill: 'none', stroke: 'var(--accent)', 'stroke-width': 1.6 });
  svg.append(area, glow, line);

  const buildD = (ys) => 'M' + ys.map((y, i) => `${xOf(i).toFixed(1)},${y.toFixed(1)}`).join('L');
  const applyYs = (ys) => {
    const d = buildD(ys);
    line.setAttribute('d', d); glow.setAttribute('d', d);
    area.setAttribute('d', `${d}L${xOf(n - 1).toFixed(1)},${padT + plotH}L${xOf(0).toFixed(1)},${padT + plotH}Z`);
  };

  let curYs = ysFor(opts.metric);
  applyYs(curYs);

  // terminal readout
  const termVal = S('text', { x: W - padR + 8, y: 0, style: 'font-family: var(--font-mono); font-size: 24px; font-weight: 700; fill: var(--text-primary);' });
  const termUnit = S('text', { class: 'tick', x: W - padR + 8, y: 0 });
  svg.append(termVal, termUnit);
  function setTerminal(metric) {
    const v = metric === 'cost' ? cumCost[n - 1] : cumTok[n - 1];
    termVal.textContent = metric === 'cost' ? fmtMoney(v) : fmtTokens(v);
    termUnit.textContent = metric === 'cost' ? 'API-EQ TOTAL' : 'TOK TOTAL';
    const y = Math.max(padT + 18, curYs[n - 1]);
    termVal.setAttribute('y', y); termUnit.setAttribute('y', y + 14);
  }
  setTerminal(opts.metric);

  // hover crosshair
  const chv = S('line', { class: 'crosshair' });
  const dot = S('circle', { r: 3, fill: 'var(--accent)', opacity: 0 });
  svg.append(chv, dot);

  // scope cursors A/B
  const cursors = { a: null, b: null };
  const curEls = ['a', 'b'].map(() => {
    const g = S('g', { opacity: 0, 'pointer-events': 'none' },
      S('line', { y1: padT - 8, y2: padT + plotH, stroke: 'var(--accent-alt)', 'stroke-width': 1, 'stroke-dasharray': '4 3' }),
      S('rect', { y: padT - 14, width: 8, height: 8, fill: 'var(--accent-alt)', rx: 1 }));
    svg.appendChild(g);
    return g;
  });
  const readout = H('div', 'cursor-readout');
  readout.style.display = 'none';
  host.appendChild(readout);

  function placeCursor(which, i) {
    cursors[which] = i;
    const g = curEls[which === 'a' ? 0 : 1];
    const x = xOf(i);
    g.setAttribute('opacity', 1);
    g.querySelector('line').setAttribute('x1', x);
    g.querySelector('line').setAttribute('x2', x);
    g.querySelector('rect').setAttribute('x', x - 4);
    updateReadout();
  }
  function clearCursors() {
    cursors.a = cursors.b = null;
    curEls.forEach((g) => g.setAttribute('opacity', 0));
    readout.style.display = 'none';
  }
  function updateReadout() {
    if (cursors.a == null || cursors.b == null) { readout.style.display = 'none'; return; }
    const i0 = Math.min(cursors.a, cursors.b), i1 = Math.max(cursors.a, cursors.b);
    const dd = Math.max(1, Math.round((rows[i1].t - rows[i0].t) / 86400000));
    const dCost = cumCost[i1] - cumCost[i0], dTok = cumTok[i1] - cumTok[i0];
    const parts = [`<span class="cr-k">Δt</span> ${dd}d`];
    if (state.metric === 'cost') parts.push(`<span class="cr-k">Δ$EQ</span> ${fmtMoney(dCost)}`, `<span class="cr-k">Δtok</span> ${fmtTokens(dTok)}`);
    else parts.push(`<span class="cr-k">Δtok</span> ${fmtTokens(dTok)}`, `<span class="cr-k">Δ$EQ</span> ${fmtMoney(dCost)}`);
    readout.innerHTML = parts.join(' &nbsp;·&nbsp; ');
    readout.style.display = 'block';
  }

  const idxAt = (clientX) => {
    const x = localX(svg, clientX) - padL;
    return Math.max(0, Math.min(n - 1, Math.round((x / plotW) * (n - 1))));
  };

  let drag = null; // 'a' | 'b'
  let moved = false;
  svg.addEventListener('mousedown', (e) => {
    if (n < 2) return;
    moved = false;
    const i = idxAt(e.clientX);
    const near = (which) => cursors[which] != null && Math.abs(xOf(cursors[which]) - localX(svg, e.clientX)) < 9;
    if (near('a')) drag = 'a';
    else if (near('b')) drag = 'b';
    else { placeCursor('a', i); drag = 'b'; placeCursor('b', i); }
    e.preventDefault();
  });
  svg.addEventListener('mousemove', (e) => {
    if (n < 1) return;
    const i = idxAt(e.clientX);
    if (drag) { moved = true; placeCursor(drag, i); return; }
    const x = xOf(i);
    chv.setAttribute('x1', x); chv.setAttribute('x2', x);
    chv.setAttribute('y1', padT); chv.setAttribute('y2', padT + plotH);
    chv.classList.add('on');
    dot.setAttribute('cx', x); dot.setAttribute('cy', curYs[i]); dot.setAttribute('opacity', 1);
    const m = state.metric;
    tip.show(tipBox(fmtDateShort(rows[i].t), [
      ['RUNNING ' + (m === 'cost' ? '$EQ' : 'TOK'), m === 'cost' ? fmtMoney(cumCost[i]) : fmtTokens(cumTok[i])],
      ['THAT DAY', m === 'cost' ? fmtMoney(rows[i].cost) : fmtTokens(rows[i].tok)],
    ], 'DRAG = CURSORS · CLICK → DAY'), e.clientX, e.clientY);
  });
  // mouseup/mouseleave on the svg itself — a window-level listener would leak
  // one closure per re-render (this chart rebuilds on every SSE refresh)
  svg.addEventListener('mouseup', () => { drag = null; });
  svg.addEventListener('mouseleave', () => { drag = null; chv.classList.remove('on'); dot.setAttribute('opacity', 0); tip.hide(); });
  svg.addEventListener('click', (e) => {
    if (moved || n < 1) return;
    if (e.target.closest('.flag')) return;
    if (opts.onDay) opts.onDay(rows[idxAt(e.clientX)].t);
  });
  svg.addEventListener('dblclick', clearCursors);

  // annotation flags ①②③
  for (const f of opts.flags || []) {
    if (f.i == null || f.i < 0 || f.i >= n) continue;
    const x = xOf(f.i), y = curYs[f.i];
    const g = S('g', { class: 'flag' },
      S('line', { x1: x, x2: x, y1: y - 4, y2: y - 14, stroke: 'var(--accent-alt)', 'stroke-width': 1 }),
      S('text', { x, y: y - 18, 'text-anchor': 'middle', text: f.glyph }));
    g.addEventListener('mousemove', (e) => { e.stopPropagation(); tip.show(tipBox(f.glyph + ' ' + f.caption, [], 'CLICK → DAY INSPECTOR'), e.clientX, e.clientY); });
    g.addEventListener('click', (e) => { e.stopPropagation(); if (opts.onDay) opts.onDay(rows[f.i].t); });
    svg.appendChild(g);
  }

  host.insertBefore(svg, readout);

  return {
    update(metric) {
      const next = ysFor(metric);
      morphYs(curYs, next, (ys) => { curYs = ys; applyYs(ys); });
      curYs = next;
      setTerminal(metric);
      updateReadout();
    },
  };
}

// ---------------------------------------------------------------------------
// MIX BAR — single 12px 100% stacked bar (+ leader-dot legend)
// ---------------------------------------------------------------------------

export function mixBar(host, parts, opts = {}) {
  host.innerHTML = '';
  const bar = H('div', 'mixbar');
  const total = parts.reduce((s, p) => s + p.value, 0) || 1;
  const segs = new Map();
  for (const p of parts) {
    if (p.value <= 0) continue;
    const seg = H('span', 'seg' + (opts.onSeg ? ' clickable' : ''));
    seg.style.width = ((p.value / total) * 100).toFixed(2) + '%';
    seg.style.background = p.color;
    seg.addEventListener('mousemove', (e) => {
      tip.show(tipBox(`${p.glyph} ${p.label}`, [
        [opts.valLabel || 'TOKENS', opts.fmt ? opts.fmt(p.value) : fmtTokens(p.value)],
        ...(p.extra || []),
        ['SHARE', ((p.value / total) * 100).toFixed(1) + '%'],
      ], opts.onSeg ? 'CLICK → FILTER' : ''), e.clientX, e.clientY);
    });
    seg.addEventListener('mouseleave', () => tip.hide());
    if (opts.onSeg) seg.addEventListener('click', () => opts.onSeg(p.key));
    bar.appendChild(seg);
    segs.set(p.key, seg);
  }
  host.appendChild(bar);
  if (opts.legend) {
    const lg = H('div', 'leader-rows');
    for (const p of parts) {
      if (p.value <= 0) continue;
      const row = H('div', 'leader-row');
      row.innerHTML = `<span class="glyph" style="color:${p.color}">${esc(p.glyph)}</span>` +
        `<span class="lr-name">${esc(p.label)}</span><span class="lr-dots"></span>` +
        `<span class="lr-val">${((p.value / total) * 100).toFixed(0)}% · ${esc(opts.fmt ? opts.fmt(p.value) : fmtTokens(p.value))}</span>`;
      lg.appendChild(row);
    }
    host.appendChild(lg);
  }
  return {
    setSolo(key) { for (const [k, seg] of segs) seg.classList.toggle('dimmed', !!key && k !== key); },
  };
}

// ---------------------------------------------------------------------------
// DONUT — model mix (output-token shares), 4px stroke
// ---------------------------------------------------------------------------

export function donut(host, parts, opts = {}) {
  host.innerHTML = '';
  const size = opts.size || 110, stroke = opts.stroke || 4;
  const r = size / 2 - stroke - 2;
  const C = 2 * Math.PI * r;
  const total = parts.reduce((s, p) => s + p.value, 0);
  const svg = S('svg', { width: size, height: size, viewBox: `0 0 ${size} ${size}` });
  svg.appendChild(S('circle', { cx: size / 2, cy: size / 2, r, fill: 'none', stroke: 'var(--graticule)', 'stroke-width': stroke }));
  let off = 0;
  if (total > 0) {
    for (const p of parts) {
      if (p.value <= 0) continue;
      const frac = p.value / total;
      const c = S('circle', {
        cx: size / 2, cy: size / 2, r, fill: 'none', stroke: p.color, 'stroke-width': stroke,
        'stroke-dasharray': `${(frac * C).toFixed(2)} ${(C - frac * C).toFixed(2)}`,
        'stroke-dashoffset': (-off * C).toFixed(2),
        transform: `rotate(-90 ${size / 2} ${size / 2})`,
      });
      c.addEventListener('mousemove', (e) => tip.show(tipBox(`${p.glyph} ${p.label}`, [['OUT TOK', fmtTokens(p.value)], ['SHARE', (frac * 100).toFixed(1) + '%']]), e.clientX, e.clientY));
      c.addEventListener('mouseleave', () => tip.hide());
      svg.appendChild(c);
      off += frac;
    }
  }
  svg.appendChild(S('text', { x: size / 2, y: size / 2, 'text-anchor': 'middle', style: 'font-family: var(--font-mono); font-size: 13px; font-weight: 700; fill: var(--text-primary);', text: opts.center || fmtTokens(total) }));
  svg.appendChild(S('text', { class: 'tick', x: size / 2, y: size / 2 + 13, 'text-anchor': 'middle', text: opts.centerSub || 'OUT TOK' }));
  host.appendChild(svg);
}

// ---------------------------------------------------------------------------
// HOURLY OSCILLOGRAM — 24 bars on a graticule (Day Inspector hero)
// ---------------------------------------------------------------------------

export function hourBars(host, hours, opts = {}) {
  host.innerHTML = '';
  const Hh = opts.height || 120;
  const W = Math.max(220, host.clientWidth || 440);
  const padL = 4, padR = 4, padT = 12, padB = 16;
  const plotW = W - padL - padR, plotH = Hh - padT - padB;
  const svg = S('svg', { width: W, height: Hh, viewBox: `0 0 ${W} ${Hh}` });
  const fid = `hbblur${++uid}`;
  svg.appendChild(S('defs', {}, S('filter', { id: fid, x: '-80%', y: '-80%', width: '260%', height: '260%' }, S('feGaussianBlur', { stdDeviation: 3 }))));
  for (let j = 1; j <= 2; j++) svg.appendChild(S('line', { class: 'grat', x1: padL, x2: W - padR, y1: padT + (plotH * j) / 3, y2: padT + (plotH * j) / 3 }));
  svg.appendChild(S('line', { class: 'grat-axis', x1: padL, x2: W - padR, y1: padT + plotH + 0.5, y2: padT + plotH + 0.5 }));

  const metric = opts.metric || 'tokens';
  const vOf = (hh) => (metric === 'cost' ? hh.cost : hh.tokens);
  const max = Math.max(1e-9, ...hours.map(vOf));
  const peakIdx = hours.reduce((bi, hh, i) => (vOf(hh) > vOf(hours[bi]) ? i : bi), 0);
  const slot = plotW / 24, barW = Math.max(2, slot - 3);
  const rects = [];
  hours.forEach((hh, i) => {
    const v = vOf(hh);
    const bh = v > 0 ? Math.max(1.5, (v / max) * plotH) : 0;
    const x = padL + i * slot + (slot - barW) / 2;
    if (i === peakIdx && v > 0) {
      svg.appendChild(S('rect', { x, y: padT + plotH - bh, width: barW, height: bh, fill: 'var(--accent)', filter: `url(#${fid})`, opacity: 0.6 }));
    }
    const rect = S('rect', { x, y: padT + plotH - bh, width: barW, height: Math.max(0, bh), fill: 'var(--accent)', opacity: v > 0 ? 0.9 : 0 });
    rect.style.transition = 'y var(--t-morph) var(--ease-inout), height var(--t-morph) var(--ease-inout)';
    if (i === peakIdx && v > 0) { rect.style.stroke = 'var(--accent-alt)'; rect.style.strokeWidth = '1'; }
    svg.appendChild(rect);
    rects.push(rect);
    const hit = S('rect', { class: 'sb-hit', x: padL + i * slot, y: padT, width: slot, height: plotH });
    hit.addEventListener('mousemove', (e) => tip.show(tipBox(`${String(hh.h).padStart(2, '0')}:00`, [['TOKENS', fmtTokens(hh.tokens)], ['$EQ', fmtMoney(hh.cost)]]), e.clientX, e.clientY));
    hit.addEventListener('mouseleave', () => tip.hide());
    svg.appendChild(hit);
  });
  for (let h = 0; h < 24; h += 6) {
    svg.appendChild(S('text', { class: 'tick', x: padL + h * slot + slot / 2, y: Hh - 3, 'text-anchor': 'middle', text: String(h).padStart(2, '0') }));
  }
  svg.appendChild(S('text', { class: 'tick', x: padL + 23 * slot + slot / 2, y: Hh - 3, 'text-anchor': 'middle', text: '23' }));
  host.appendChild(svg);
  return {
    update(metric2) {
      const v2 = (hh) => (metric2 === 'cost' ? hh.cost : hh.tokens);
      const m2 = Math.max(1e-9, ...hours.map(v2));
      hours.forEach((hh, i) => {
        const v = v2(hh);
        const bh = v > 0 ? Math.max(1.5, (v / m2) * plotH) : 0;
        rects[i].style.y = (padT + plotH - bh) + 'px';
        rects[i].style.height = Math.max(0, bh) + 'px';
      });
    },
  };
}

// ---------------------------------------------------------------------------
// WEEKLY CADENCE — 52 hairline columns
// ---------------------------------------------------------------------------

export function cadenceColumns(host, rows, opts = {}) {
  host.innerHTML = '';
  const Hh = opts.height || 200;
  const W = Math.max(200, host.clientWidth || 320);
  const padT = 12, padB = 18, padL = 4, padR = 4;
  const plotW = W - padL - padR, plotH = Hh - padT - padB;
  const svg = S('svg', { width: W, height: Hh, viewBox: `0 0 ${W} ${Hh}` });
  for (let j = 1; j <= 2; j++) svg.appendChild(S('line', { class: 'grat', x1: padL, x2: W - padR, y1: padT + (plotH * j) / 3, y2: padT + (plotH * j) / 3 }));
  svg.appendChild(S('line', { class: 'grat-axis', x1: padL, x2: W - padR, y1: padT + plotH + 0.5, y2: padT + plotH + 0.5 }));
  const n = rows.length;
  if (!n) { host.appendChild(H('div', 'empty', 'SIGNAL FLAT')); return { update() {} }; }
  const max = Math.max(1e-9, ...rows.map((r) => r.v));
  const slot = plotW / n;
  const bw = Math.max(1.5, Math.min(4, slot - 2));
  const bars = [];
  rows.forEach((r, i) => {
    const bh = r.v > 0 ? Math.max(1, (r.v / max) * plotH) : 0;
    const x = padL + i * slot + (slot - bw) / 2;
    const rect = S('rect', { x, y: padT + plotH - bh, width: bw, height: bh, fill: r.current ? 'var(--accent-alt)' : 'var(--accent)', opacity: r.current ? 1 : 0.6 });
    rect.style.transition = 'y var(--t-morph) var(--ease-inout), height var(--t-morph) var(--ease-inout)';
    svg.appendChild(rect);
    bars.push(rect);
    const hit = S('rect', { class: 'sb-hit', x: padL + i * slot, y: padT, width: slot, height: plotH });
    hit.addEventListener('mousemove', (e) => {
      const end = new Date(r.t + 6 * 86400000);
      tip.show(tipBox(`WK ${fmtDateShort(r.t)} – ${fmtDateShort(end.getTime())}`, [[opts.valLabel || 'VALUE', opts.fmt(r.v)]], opts.onWeek ? 'CLICK → CAPSULE' : ''), e.clientX, e.clientY);
    });
    hit.addEventListener('mouseleave', () => tip.hide());
    if (opts.onWeek) hit.addEventListener('click', () => opts.onWeek(r.t));
    svg.appendChild(hit);
  });
  host.appendChild(svg);
  return {
    update(rows2) {
      const m2 = Math.max(1e-9, ...rows2.map((r) => r.v));
      rows2.forEach((r, i) => {
        if (!bars[i]) return;
        const bh = r.v > 0 ? Math.max(1, (r.v / m2) * plotH) : 0;
        bars[i].style.y = (padT + plotH - bh) + 'px';
        bars[i].style.height = bh + 'px';
      });
    },
  };
}

// ---------------------------------------------------------------------------
// TWIN TRACE — would-have-cost vs actual (cache flex), hatched dividend
// ---------------------------------------------------------------------------

export function twinTrace(host, rows, opts = {}) {
  host.innerHTML = '';
  const Hh = opts.height || 96;
  const W = Math.max(200, host.clientWidth || 360);
  const padT = 10, padB = 6, padL = 2, padR = 2;
  const plotW = W - padL - padR, plotH = Hh - padT - padB;
  const n = rows.length;
  const svg = S('svg', { width: W, height: Hh, viewBox: `0 0 ${W} ${Hh}` });
  if (n < 2) { host.appendChild(H('div', 'empty', 'SIGNAL FLAT')); return; }
  const pid = `hatch${++uid}`;
  svg.appendChild(S('defs', {}, S('pattern', { id: pid, width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' },
    S('line', { x1: 0, y1: 0, x2: 0, y2: 6, stroke: '#6EF2B4', 'stroke-width': 1.5, opacity: 0.3 }))));
  const max = Math.max(1e-9, ...rows.map((r) => r.would));
  const xOf = (i) => padL + (i / (n - 1)) * plotW;
  const yOf = (v) => padT + (1 - Math.min(1, v / max)) * plotH;
  const wPts = rows.map((r, i) => `${xOf(i).toFixed(1)},${yOf(r.would).toFixed(1)}`);
  const aPts = rows.map((r, i) => `${xOf(i).toFixed(1)},${yOf(r.actual).toFixed(1)}`);
  svg.appendChild(S('path', { d: `M${wPts.join('L')}L${aPts.slice().reverse().join('L')}Z`, fill: `url(#${pid})` }));
  svg.appendChild(S('polyline', { points: wPts.join(' '), fill: 'none', stroke: 'var(--text-faint)', 'stroke-width': 1, 'stroke-dasharray': '3 3' }));
  svg.appendChild(S('polyline', { points: aPts.join(' '), fill: 'none', stroke: 'var(--accent)', 'stroke-width': 1.4 }));
  const hit = S('rect', { class: 'sb-hit', x: 0, y: 0, width: W, height: Hh });
  hit.addEventListener('mousemove', (e) => {
    const i = Math.max(0, Math.min(n - 1, Math.round(((localX(svg, e.clientX) - padL) / plotW) * (n - 1))));
    tip.show(tipBox(fmtDateShort(rows[i].t), [
      ['WOULD-HAVE', fmtMoney(rows[i].would)],
      ['ACTUAL', fmtMoney(rows[i].actual)],
      ['DIVIDEND', fmtMoney(rows[i].would - rows[i].actual)],
    ], 'THE DIVIDEND — CACHE READ BILLS AT 0.1×'), e.clientX, e.clientY);
  });
  hit.addEventListener('mouseleave', () => tip.hide());
  svg.appendChild(hit);
  host.appendChild(svg);
}

// ---------------------------------------------------------------------------
// TRACE-BAR LIST — ranked horizontal 3px bars (projects, splits, tools)
// ---------------------------------------------------------------------------

export function traceBarList(host, rows, opts = {}) {
  host.innerHTML = '';
  const wrap = H('div', 'tb-rows');
  const max = Math.max(1e-9, ...rows.map((r) => r.value));
  rows.forEach((r, i) => {
    const row = H('div', 'tb-row' + (opts.onClick && !r.footer ? ' clickable' : '') + (r.footer ? ' tb-foot' : '') + (opts.activeName === r.name ? ' tb-active' : ''));
    const rank = H('span', 'tb-rank', opts.rank && !r.footer ? String(i + 1) : '');
    const name = H('span', 'tb-name');
    name.textContent = r.name;
    name.title = r.name;
    const track = H('span', 'tb-track');
    const bar = H('span', 'tb-bar');
    bar.style.width = ((r.value / max) * 100).toFixed(1) + '%';
    if (r.color) bar.style.background = r.color;
    if (opts.glowFirst && i === 0 && !r.footer) bar.appendChild(H('span', 'cap'));
    track.appendChild(bar);
    const vals = H('span', 'tb-vals');
    vals.innerHTML = (r.vals || []).map((v, vi) => (vi === 0 ? `<b>${esc(v)}</b>` : `<span>${esc(v)}</span>`)).join('');
    row.append(rank, name, track, vals);
    if (opts.onClick && !r.footer) row.addEventListener('click', () => opts.onClick(r.name));
    wrap.appendChild(row);
  });
  host.appendChild(wrap);
}

// ---------------------------------------------------------------------------
// PACE BAR — today vs projection with median/p90 tick flags
// ---------------------------------------------------------------------------

export function paceBar(host, { today, projected, median, p90, fmt }) {
  host.innerHTML = '';
  const W = Math.max(160, host.clientWidth || 280);
  const Hh = 56;
  const barY = 24, barH = 14;
  const max = Math.max(projected, p90, median, today, 1e-9) * 1.08;
  const xOf = (v) => Math.min(W - 2, (v / max) * (W - 4) + 2);
  const svg = S('svg', { width: W, height: Hh, viewBox: `0 0 ${W} ${Hh}` });
  const pid = `pacehatch${++uid}`;
  svg.appendChild(S('defs', {}, S('pattern', { id: pid, width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' },
    S('line', { x1: 0, y1: 0, x2: 0, y2: 6, stroke: '#53FCA1', 'stroke-width': 2, opacity: 0.45 }))));
  svg.appendChild(S('rect', { x: 1, y: barY, width: W - 2, height: barH, fill: 'var(--heat-0)', stroke: 'var(--border)', 'stroke-width': 1, rx: 1 }));
  if (projected > today) svg.appendChild(S('rect', { x: xOf(today), y: barY, width: Math.max(0, xOf(projected) - xOf(today)), height: barH, fill: `url(#${pid})` }));
  if (today > 0) svg.appendChild(S('rect', { x: 2, y: barY, width: Math.max(1, xOf(today) - 2), height: barH, fill: 'var(--accent)', opacity: 0.95 }));
  for (const [v, lbl] of [[median, 'MEDIAN'], [p90, 'P90']]) {
    if (!(v > 0)) continue;
    const x = xOf(v);
    svg.appendChild(S('line', { x1: x, x2: x, y1: barY - 8, y2: barY + barH, stroke: 'var(--accent-alt)', 'stroke-width': 1, 'stroke-dasharray': '2 2' }));
    svg.appendChild(S('text', { class: 'tick', x: Math.min(x, W - 26), y: barY - 11, 'text-anchor': 'middle', text: lbl }));
  }
  const hit = S('rect', { x: 0, y: 0, width: W, height: Hh, fill: 'transparent' });
  hit.addEventListener('mousemove', (e) => tip.show(tipBox('PACE PROJECTION', [
    ['TODAY SO FAR', fmt(today)],
    ['PROJECTED', fmt(projected)],
    ['MEDIAN DAY', fmt(median)],
    ['P90 DAY', fmt(p90)],
  ], 'PACE = LAST 60 MIN'), e.clientX, e.clientY));
  hit.addEventListener('mouseleave', () => tip.hide());
  svg.appendChild(hit);
  host.appendChild(svg);
}
