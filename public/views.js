// ============================================================================
// CLAUDIOGRAM — views.js
// View builders: F1 PULSE, F2 RHYTHM, F3 COST, F4 CAPSULE, the Project route,
// the Day Inspector drawer, and the shared Session Card accordion.
// ============================================================================

import {
  state, bus, api, getSummary, REDUCED,
  CH, channelOf, inputRate,
  fmtTokens, fmtMoney, fmtNum, fmtMetricValue, metricUnit,
  dayKeyLocal, parseDayKey, todayKey, fmtTime, fmtClock, fmtDur, fmtDateLong,
  navigate, openDay, goProject, escStack,
} from './app.js';

import {
  H, esc, tip, tipBox, engine, odometer, heatmap, punchcard, stackedBars,
  cumulativeTrace, mixBar, donut, hourBars, cadenceColumns, twinTrace,
  traceBarList, paceBar, uiZoom,
} from './charts.js';

const MONTH_NAMES = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];

// Per-view UI state that survives re-renders (metric flips, SSE refreshes)
const vs = {
  pulse: { muted: new Set(), solo: null },
  cost: { mode: 'model', rangeKey: '90', solo: null, range: null, cacheOpen: false },
  capsule: { project: null, period: null, lastStory: null },
  project: { rangeKey: '90', solo: null },
};

// ---------------------------------------------------------------------------
// Small shared builders
// ---------------------------------------------------------------------------

function module(title, span, opts = {}) {
  const el = H('section', `module ${span}${opts.cls ? ' ' + opts.cls : ''}`);
  const head = H('div', 'm-head');
  const titleEl = H('span', 'm-title');
  titleEl.textContent = title;
  const ctl = H('div', 'm-ctl');
  head.append(titleEl, ctl);
  const body = H('div', 'm-body');
  el.append(head, body);
  return { el, head, titleEl, ctl, body };
}

function loadModule(body, fetcher, render) {
  body.innerHTML = '';
  body.appendChild(H('div', 'loading', 'ACQUIRING SIGNAL'));
  return fetcher().then((data) => { body.innerHTML = ''; render(data); return data; })
    .catch((e) => {
      body.innerHTML = '';
      const box = H('div', 'errbox');
      box.textContent = `SIGNAL LOST — ${String(e.message || e).slice(0, 80)} `;
      const retry = H('button', '', 'RETRY ▸');
      retry.addEventListener('click', () => loadModule(body, fetcher, render));
      box.appendChild(retry);
      body.appendChild(box);
    });
}

function emptyBox(msg) { return H('div', 'empty', esc(msg)); }

function readoutEl(size, value, unit) {
  const wrap = H('div', 'burn-val');
  const v = H('span', `readout-${size}`);
  odometer(v, value);
  const u = H('span', 'unit');
  u.textContent = unit;
  wrap.append(v, u);
  return { wrap, v, u };
}

function rowTok(r) { return (r.inputTokens || 0) + (r.outputTokens || 0); }
function mOf(o) { return state.metric === 'cost' ? (o.cost || 0) : (o.tokens || 0); }

function parseJSONish(v) {
  if (v == null) return {};
  if (typeof v === 'object') return v;
  try { return JSON.parse(v) || {}; } catch { return {}; }
}

function channelParts(entries, valKey) {
  // entries: [{model, ...}] -> aggregate by channel
  const agg = new Map();
  for (const e of entries) {
    const ch = channelOf(e.model);
    const cur = agg.get(ch) || { value: 0, cost: 0, tokens: 0 };
    cur.value += e[valKey] || 0;
    cur.cost += e.cost || 0;
    cur.tokens += e.tokens != null ? e.tokens : ((e.inputTokens || 0) + (e.outputTokens || 0));
    agg.set(ch, cur);
  }
  const order = ['fable', 'opus', 'sonnet', 'haiku', 'other'];
  return order.filter((ch) => agg.has(ch)).map((ch) => ({
    key: ch, label: CH[ch].label, glyph: CH[ch].glyph, color: CH[ch].color,
    value: agg.get(ch).value, cost: agg.get(ch).cost, tokens: agg.get(ch).tokens,
  })).sort((a, b) => b.value - a.value);
}

function weekStartMs(d = new Date()) {
  const c = new Date(d); c.setHours(0, 0, 0, 0);
  c.setDate(c.getDate() - ((c.getDay() + 6) % 7));
  return c.getTime();
}

// ============================================================================
// SHARED SESSION CARD — one implementation: Capsule, Project spool, Day drawer
// ============================================================================

let expanded = null; // { card, popEsc, prevHash, sessionId }

export function collapseSession() {
  if (!expanded) return false;
  const { card, popEsc, prevHash, sessionId } = expanded;
  expanded = null;
  const body = card.querySelector('.sc-body');
  if (body) {
    body.style.maxHeight = body.scrollHeight + 'px';
    requestAnimationFrame(() => { body.style.maxHeight = '0px'; });
  }
  card.classList.remove('expanded');
  const dg = card.closest('.day-group');
  if (dg) dg.classList.remove('expanded-within');
  popEsc();
  if (location.hash === '#/session/' + sessionId && prevHash) history.replaceState(null, '', prevHash);
  return true;
}

export function sessionCard(s, opts = {}) {
  const tools = parseJSONish(s.tools);
  const models = parseJSONish(s.models);
  const card = H('article', 'sc' + (opts.dense ? ' sc-dense' : '') + (opts.fresh ? ' fresh' : ''));
  card.dataset.sid = s.id;

  const head = H('div', 'sc-head');
  const top = H('div', 'sc-top');
  const time = H('span', 'sc-time');
  time.innerHTML = `${esc(fmtTime(s.first_ts))}–${esc(fmtTime(s.last_ts))} <span class="sc-dur">· ${esc(fmtDur(s.last_ts - s.first_ts))}</span>`;
  top.appendChild(time);
  if (!opts.noProject && s.project) {
    const chip = H('button', 'prj-chip');
    chip.textContent = s.project;
    chip.title = `Open project ${s.project}`;
    chip.addEventListener('click', (e) => { e.stopPropagation(); goProject(s.project); });
    top.appendChild(chip);
  }
  const ro = H('span', 'sc-readout');
  const setRo = () => { ro.innerHTML = `${esc(fmtMetricValue(mOf(s)))} <span class="unit">${esc(metricUnit())}</span>`; };
  setRo();
  card._setRo = setRo;
  top.appendChild(ro);

  const prompt = H('div', 'sc-prompt');
  prompt.textContent = s.first_prompt || '(no prompt captured)';

  const meta = H('div', 'sc-meta');
  const micro = H('span', 'sc-microbar');
  const parts = channelParts(Object.entries(models).map(([model, v]) => ({ model, out: v })), 'out');
  const mtotal = parts.reduce((x, p) => x + p.value, 0) || 1;
  for (const p of parts) {
    const i = H('i');
    i.style.width = ((p.value / mtotal) * 100).toFixed(1) + '%';
    i.style.background = p.color;
    micro.appendChild(i);
  }
  meta.appendChild(micro);
  const topTools = Object.entries(tools).sort((a, b) => b[1] - a[1]).slice(0, 2);
  for (const [name, count] of topTools) meta.appendChild(H('span', 'tool-chip', `${esc(name)} ×${esc(count)}`));
  const msgs = H('span', 'tool-chip', `${esc(fmtNum(s.assistant_msgs || 0))} MSGS`);
  meta.appendChild(msgs);

  head.append(top, prompt, meta);
  card.appendChild(head);

  head.addEventListener('click', () => toggleExpand(card, s, { tools, models, parts, noProject: opts.noProject }));
  return card;
}

function toggleExpand(card, s, extra) {
  if (expanded && expanded.card === card) { collapseSession(); return; }
  collapseSession();

  let body = card.querySelector('.sc-body');
  if (!body) {
    body = H('div', 'sc-body');
    const inner = H('div', 'sc-body-inner');

    const quote = H('blockquote', 'sc-quote sc-wide');
    quote.textContent = s.first_prompt || '(no prompt captured)';
    inner.appendChild(quote);

    // tools column
    const toolsCol = H('div');
    toolsCol.appendChild(H('span', 'label sc-section-title', 'TOOL USAGE'));
    const toolRows = Object.entries(extra.tools).sort((a, b) => b[1] - a[1]);
    if (toolRows.length) {
      const tHost = H('div');
      traceBarList(tHost, toolRows.map(([name, count]) => ({ name, value: count, vals: ['×' + fmtNum(count)] })), {});
      toolsCol.appendChild(tHost);
    } else toolsCol.appendChild(H('div', 'empty', 'NO TOOL CALLS'));
    inner.appendChild(toolsCol);

    // mix + ledger column
    const mixCol = H('div');
    mixCol.appendChild(H('span', 'label sc-section-title', 'MODEL MIX · OUTPUT TOKENS'));
    const dWrap = H('div');
    dWrap.style.display = 'flex';
    dWrap.style.gap = '16px';
    dWrap.style.alignItems = 'center';
    const dHost = H('div');
    donut(dHost, extra.parts, { size: 104 });
    const ledger = H('div', 'ledger');
    const lRows = [
      ['DURATION', fmtDur(s.last_ts - s.first_ts)],
      ['USER MSGS', fmtNum(s.user_msgs || 0)],
      ['ASSISTANT MSGS', fmtNum(s.assistant_msgs || 0)],
      ['TOKENS · IN+OUT', fmtTokens(s.tokens || 0)],
    ];
    for (const [k, v] of lRows) ledger.appendChild(H('div', 'l-row', `<span>${esc(k)}</span><b>${esc(v)}</b>`));
    ledger.appendChild(H('div', 'l-row l-total', `<span>$EQ · API-EQUIVALENT</span><b>${esc(fmtMoney(s.cost || 0))}</b>`));
    dWrap.append(dHost, ledger);
    mixCol.appendChild(dWrap);
    if (!extra.noProject && s.project) {
      const open = H('button', 'sc-open-prj', 'OPEN PROJECT ▸');
      open.style.marginTop = '12px';
      open.addEventListener('click', (e) => { e.stopPropagation(); goProject(s.project); });
      mixCol.appendChild(open);
    }
    inner.appendChild(mixCol);

    body.appendChild(inner);
    card.appendChild(body);
  }

  card.classList.add('expanded');
  const dg = card.closest('.day-group');
  if (dg) dg.classList.add('expanded-within');
  const inner = body.firstChild;
  body.style.maxHeight = '0px';
  requestAnimationFrame(() => { body.style.maxHeight = inner.scrollHeight + 'px'; });
  body.addEventListener('transitionend', function onEnd() {
    if (card.classList.contains('expanded')) body.style.maxHeight = 'none';
    body.removeEventListener('transitionend', onEnd);
  });

  const prevHash = location.hash || '#/capsule';
  if (!prevHash.startsWith('#/session/')) history.replaceState(null, '', '#/session/' + s.id);
  const popEsc = escStack.push(() => collapseSession());
  expanded = { card, popEsc, prevHash: prevHash.startsWith('#/session/') ? '#/capsule' : prevHash, sessionId: s.id };
}

// ============================================================================
// F1 · PULSE — Live Monitor
// ============================================================================

export function renderPulse(root, ctx = {}) {
  const vp = vs.pulse;
  if (root._cleanup) { root._cleanup(); root._cleanup = null; }
  root.innerHTML = '';
  const grid = H('div', 'grid');
  root.appendChild(grid);
  const cleanups = [];
  let dead = false;
  cleanups.push(() => { dead = true; });

  // ---- THE TRACE -----------------------------------------------------------
  const mT = module('THE TRACE · LAST 90 MIN · LOG SCALE', 'span-12');
  const liveBadge = H('span', 'live-badge', 'LIVE');
  mT.ctl.appendChild(liveBadge);
  const legend = H('span');
  legend.style.display = 'inline-flex';
  legend.style.gap = '6px';
  for (const ch of ['fable', 'opus', 'sonnet', 'haiku']) {
    const chip = H('button', 'ch-chip' + (vp.muted.has(ch) || (vp.solo && vp.solo !== ch) ? ' muted' : ''));
    chip.innerHTML = `<span class="swatch" style="background:${CH[ch].color}"></span>${CH[ch].glyph}`;
    chip.title = `${CH[ch].label} — click mutes blips, alt-click solos`;
    chip.addEventListener('click', (e) => {
      if (e.altKey) { vp.solo = vp.solo === ch ? null : ch; }
      else if (vp.solo) { vp.solo = null; }
      else if (vp.muted.has(ch)) vp.muted.delete(ch);
      else vp.muted.add(ch);
      applyChannelFilter();
    });
    chip.dataset.ch = ch;
    legend.appendChild(chip);
  }
  mT.ctl.appendChild(legend);

  const canvas = H('canvas', 'trace-canvas');
  mT.body.appendChild(canvas);
  const traceEmpty = H('div', 'trace-empty');
  traceEmpty.appendChild(H('span', 'empty', 'SIGNAL FLAT — INSTRUMENT ARMED, AWAITING TOKENS.'));
  traceEmpty.style.display = engine.hasSignal() ? 'none' : 'flex';
  mT.body.appendChild(traceEmpty);
  grid.appendChild(mT.el);
  requestAnimationFrame(() => { if (!dead) engine.attach(canvas, { hero: true }); });
  cleanups.push(() => engine.detach(canvas));

  canvas.addEventListener('mousemove', (e) => {
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    engine.setHover(canvas, x);
    const b = engine.bucketAt(x / r.width);
    if (b) {
      const d = new Date(b.t);
      tip.show(tipBox(`${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
        [['TOKENS', fmtTokens(b.tokens)], ['$EQ', fmtMoney(b.cost)]],
        b.t < engine.seam ? 'SEEDED HISTORY' : 'LIVE'), e.clientX, e.clientY);
    }
  });
  canvas.addEventListener('mouseleave', () => { engine.setHover(canvas, null); tip.hide(); });

  function applyChannelFilter() {
    engine.setChannelFilter(vp.muted, vp.solo);
    legend.querySelectorAll('.ch-chip').forEach((c) => {
      const ch = c.dataset.ch;
      c.classList.toggle('muted', vp.solo ? vp.solo !== ch : vp.muted.has(ch));
    });
    ticker.querySelectorAll('.ticker-row').forEach((row) => {
      const ch = row.dataset.ch;
      row.classList.toggle('ch-dimmed', !(vp.solo ? vp.solo === ch : !vp.muted.has(ch)));
    });
    if (mixApi) mixApi.setSolo(vp.solo);
    mixFilterChip.style.display = vp.solo ? '' : 'none';
    if (vp.solo) mixFilterChip.innerHTML = `FILTER: ${esc(CH[vp.solo].label)} ✕`;
  }

  const badgeTimer = setInterval(() => {
    const idle = Date.now() - engine.lastEventAt > 90000;
    liveBadge.textContent = idle ? 'IDLE' : 'LIVE';
    liveBadge.classList.toggle('idle', idle);
    if (engine.hasSignal()) traceEmpty.style.display = 'none';
  }, 1000);
  cleanups.push(() => clearInterval(badgeTimer));

  // ---- BURN CELLS + PACE ----------------------------------------------------
  const burnDefs = [['window1h', 'BURN · 1H WINDOW'], ['window5h', 'BURN · 5H WINDOW'], ['window24h', 'BURN · 24H WINDOW']];
  const burnMods = burnDefs.map(([key, title]) => {
    const m = module(title, 'span-3', { cls: 'burn-cell hoverable' });
    m.el.addEventListener('click', () => openDay(todayKey()));
    grid.appendChild(m.el);
    return { ...m, key };
  });
  const mPace = module('PACE PROJECTION', 'span-3', { cls: 'hoverable' });
  grid.appendChild(mPace.el);

  let burnData = null, summaryData = null;

  function renderBurn() {
    if (!burnData) return;
    const activeDays = summaryData ? summaryData.totals.activeDays : 99;
    for (const bm of burnMods) {
      if (!bm.valEl || !bm.body.contains(bm.valEl)) {
        bm.body.innerHTML = '';
        bm.valEl = null;
        const r = readoutEl('lg', '0', metricUnit());
        bm.valEl = r.v; bm.unitEl = r.u;
        bm.body.appendChild(r.wrap);
        bm.chipHost = H('div');
        bm.body.appendChild(bm.chipHost);
      }
      const w = burnData[bm.key] || { tokens: 0, cost: 0 };
      odometer(bm.valEl, fmtMetricValue(mOf(w)));
      bm.unitEl.textContent = metricUnit();
      const med = mOf(burnData.medianActiveDay || {});
      const p90 = mOf(burnData.p90ActiveDay || {});
      let chip;
      if (activeDays < 3 || !(med > 0)) {
        chip = H('span', 'chip chip-faint', 'CALIBRATING');
        chip.title = 'Medians need at least 3 active days before pace comparisons mean anything.';
      } else {
        const ratio = mOf(w) / med;
        const cls = p90 > 0 && mOf(w) > 1.5 * p90 ? 'chip-warn' : p90 > 0 && mOf(w) > p90 ? 'chip-amber' : 'chip-good';
        chip = H('span', `chip ${cls}`, `${ratio >= 1 ? '▲' : '▽'} ${ratio.toFixed(1)}× MEDIAN`);
        chip.title = `vs your median active day (${fmtMetricValue(med)}) · p90 ${fmtMetricValue(p90)}`;
      }
      bm.chipHost.innerHTML = '';
      bm.chipHost.appendChild(chip);
    }
    renderPace();
  }

  function renderPace() {
    if (!burnData) return;
    mPace.body.innerHTML = '';
    const activeDays = summaryData ? summaryData.totals.activeDays : 99;
    const today = summaryData ? summaryData.today : { tokens: 0, cost: 0 };
    const proj = burnData.projectedDay || { tokens: 0, cost: 0 };
    const med = mOf(burnData.medianActiveDay || {});
    const p90 = mOf(burnData.p90ActiveDay || {});
    const pace = burnData.paceTokensPerHour || 0;
    const barHost = H('div', 'pace-bar-wrap');
    mPace.body.appendChild(barHost);
    paceBar(barHost, { today: mOf(today), projected: mOf(proj), median: med, p90, fmt: (v) => fmtMetricValue(v) });
    const cap = H('div', 'pace-caption');
    if (activeDays < 3) cap.textContent = 'Too early to call a typical day.';
    else if (!(pace > 0)) cap.textContent = 'Idle — projection holds at today’s total.';
    else {
      const ratio = med > 0 ? (mOf(proj) / med) : 0;
      const ratioTxt = med > 0 && isFinite(ratio) ? ` — about ${ratio.toFixed(1)}× a typical day.` : '.';
      cap.textContent = `At ${fmtTokens(pace)} tok/h, today closes near ${fmtMetricValue(mOf(proj))}${ratioTxt}`;
    }
    mPace.body.appendChild(cap);
    mPace.body.appendChild(H('div', 'pace-sub', 'PACE = LAST 60 MIN · HONEST BY DESIGN'));
    mPace.el.onclick = () => openDay(todayKey());
  }

  loadModule(burnMods[0].body, () => Promise.all([api('/api/burn'), getSummary()]), ([b, s]) => {
    burnData = b; summaryData = s;
    renderBurn();
  });

  // ---- TODAY STRIP -----------------------------------------------------------
  const mToday = module('TODAY · LOCAL TIME', 'span-12');
  grid.appendChild(mToday.el);
  const strip = H('div', 'today-strip');
  strip.addEventListener('click', () => openDay(todayKey()));
  mToday.body.appendChild(strip);
  const todayLocal = { sessions: 0, messages: 0, tokens: 0, cost: 0 };
  const stripCells = {};
  for (const [k, lbl] of [['sessions', 'SESSIONS'], ['messages', 'MESSAGES'], ['tokens', 'TOKENS'], ['cost', '$EQ · API-EQUIVALENT']]) {
    const cell = H('div', 'today-cell');
    cell.appendChild(H('span', 'label', lbl));
    const v = H('span', 'readout-sm');
    odometer(v, '0');
    cell.appendChild(v);
    strip.appendChild(cell);
    stripCells[k] = v;
  }
  function paintToday() {
    odometer(stripCells.sessions, fmtNum(todayLocal.sessions));
    odometer(stripCells.messages, fmtNum(todayLocal.messages));
    odometer(stripCells.tokens, fmtTokens(todayLocal.tokens));
    odometer(stripCells.cost, fmtMoney(todayLocal.cost));
  }
  getSummary().then((s) => { Object.assign(todayLocal, s.today); paintToday(); }).catch(() => {});

  // ---- EVENT TICKER + MODEL MIX ----------------------------------------------
  const mTick = module('EVENT TICKER · NEWEST FIRST', 'span-7');
  grid.appendChild(mTick.el);
  const ticker = H('div', 'ticker');
  ticker.appendChild(emptyBox('NO SIGNAL YET — run a Claude Code session and the trace begins here.'));
  mTick.body.appendChild(ticker);

  const mMix = module('TODAY’S MODEL MIX', 'span-5');
  const mixFilterChip = H('button', 'chip active');
  mixFilterChip.style.display = 'none';
  mixFilterChip.addEventListener('click', () => { vp.solo = null; applyChannelFilter(); });
  mMix.ctl.appendChild(mixFilterChip);
  grid.appendChild(mMix.el);
  let mixApi = null;
  let mixDay = null;

  function paintMixModule() {
    if (!mixDay) return;
    mMix.body.innerHTML = '';
    const parts = channelParts(mixDay.models || [], 'tokens');
    if (!parts.length) { mMix.body.appendChild(emptyBox('SIGNAL FLAT — instrument armed, awaiting tokens.')); mixApi = null; return; }
    const host = H('div');
    mMix.body.appendChild(host);
    mixApi = mixBar(host, parts.map((p) => ({ ...p, value: mOf(p), extra: [['TOKENS', fmtTokens(p.tokens)], ['$EQ', fmtMoney(p.cost)]] })), {
      legend: true,
      fmt: (v) => fmtMetricValue(v),
      valLabel: state.metric === 'cost' ? '$EQ' : 'TOKENS',
      onSeg: (key) => { vp.solo = vp.solo === key ? null : key; applyChannelFilter(); },
    });
    if (vp.solo) mixApi.setSolo(vp.solo);
  }

  loadModule(mMix.body, () => api('/api/day?date=' + todayKey()), (day) => {
    mixDay = day;
    paintMixModule();
  });

  let tickerQueue = [];
  let tickerRaf = 0;
  function flushTicker() {
    tickerRaf = 0;
    if (!tickerQueue.length) return;
    const emptyEl = ticker.querySelector('.empty');
    if (emptyEl) emptyEl.remove();
    const frag = document.createDocumentFragment();
    for (const ev of tickerQueue) {
      const ch = channelOf(ev.model);
      const row = H('div', 'ticker-row fresh');
      row.dataset.ch = ch;
      if (!(vp.solo ? vp.solo === ch : !vp.muted.has(ch))) row.classList.add('ch-dimmed');
      const dot = H('span', 't-dot');
      dot.style.background = CH[ch].color;
      const t = H('span', 't-time', esc(fmtClock(ev.ts || Date.now())));
      const proj = H('span', 't-proj', esc(ev.project || '—'));
      proj.addEventListener('click', () => { if (ev.project) goProject(ev.project); });
      const model = H('span', 't-model', esc(String(ev.model || '').replace(/^claude-/, '')));
      const io = H('span', 't-io', `in ${esc(fmtTokens(ev.in || 0))} → out ${esc(fmtTokens(ev.out || 0))}`);
      const cost = H('span', 't-cost', esc(fmtMoney(ev.cost || 0)));
      row.append(dot, t, proj, model, io, cost);
      frag.appendChild(row);
    }
    tickerQueue = [];
    ticker.insertBefore(frag, ticker.firstChild);
    while (ticker.children.length > 50) ticker.lastChild.remove();
  }

  const onPulse = (ev) => {
    tickerQueue.unshift(ev);
    if (tickerQueue.length > 50) tickerQueue.length = 50;
    if (!tickerRaf) tickerRaf = requestAnimationFrame(flushTicker);
    todayLocal.tokens += (ev.in || 0) + (ev.out || 0);
    todayLocal.cost += ev.cost || 0;
    todayLocal.messages += 1;
    paintToday();
    traceEmpty.style.display = 'none';
  };
  bus.on('pulse', onPulse);
  cleanups.push(() => bus.off('pulse', onPulse));

  applyChannelFilter();

  const handle = {
    destroy() { cleanups.forEach((f) => f()); root._cleanup = null; collapseSession(); },
    refresh() {
      Promise.all([api('/api/burn'), getSummary(true)]).then(([b, s]) => {
        burnData = b; summaryData = s;
        Object.assign(todayLocal, s.today);
        renderBurn(); paintToday();
      }).catch(() => {});
      api('/api/day?date=' + todayKey()).then((day) => { mixDay = day; paintMixModule(); }).catch(() => {});
    },
    onMetric() { renderBurn(); paintToday(); paintMixModule(); },
  };
  root._cleanup = () => handle.destroy();
  return handle;
}

// ============================================================================
// F2 · RHYTHM — Heatmap & Punchcard
// ============================================================================

export function renderRhythm(root, ctx = {}) {
  root.innerHTML = '';
  const grid = H('div', 'grid');
  root.appendChild(grid);

  const mHeat = module('THE YEAR FIELD · LAST 371 DAYS', 'span-12');
  grid.appendChild(mHeat.el);
  const mStreak = module('STREAKS', 'span-4');
  const mBusy = module('BUSIEST DAY', 'span-4');
  const mAir = module('ON-AIR SPAN', 'span-4');
  grid.append(mStreak.el, mBusy.el, mAir.el);
  const mPunch = module('PUNCHCARD · WEEKDAY × HOUR · ALL TIME', 'span-8');
  const mCad = module('WEEKLY CADENCE · 52W', 'span-4');
  grid.append(mPunch.el, mCad.el);

  let heatApi = null, cadApi = null, cadRows = null, heatDays = null;

  loadModule(mHeat.body, () => api('/api/heatmap'), (data) => {
    heatDays = data.days || [];
    if (!heatDays.length) { mHeat.body.appendChild(emptyBox('NO SIGNAL YET — run a Claude Code session and the trace begins here.')); return; }
    const host = H('div');
    mHeat.body.appendChild(host);
    heatApi = heatmap(host, heatDays, { metric: state.metric, animate: !ctx.isRefresh, onDay: (d) => openDay(d) });
    if (heatDays.length < 30) {
      mHeat.body.appendChild(H('div', 'pace-sub', `THE FIELD IS YOUNG — ${heatDays.length} DAYS ON RECORD; THE YEAR FILLS IN AS YOU WORK.`));
    }
  });

  loadModule(mStreak.body, () => Promise.all([getSummary(), api('/api/heatmap')]), ([s, hm]) => {
    const t = s.totals;
    const wrap = H('div', 'streak-wrap');
    const dates = new Set((hm.days || []).map((d) => d.date));
    const todayActive = dates.has(todayKey());

    const cur = H('div', 'streak-cell' + (todayActive ? ' lit' : ''));
    cur.appendChild(H('span', 'label', 'CURRENT STREAK'));
    const cv = H('div');
    const cvNum = H('span', 'readout-xl');
    odometer(cvNum, fmtNum(t.currentStreak || 0));
    cv.append(cvNum, H('span', 'streak-unit', 'DAYS'));
    cur.appendChild(cv);
    // streak range tooltip + click → capsule
    let streakStart = null;
    {
      const c = parseDayKey(todayKey());
      if (!dates.has(dayKeyLocal(c.getTime()))) c.setDate(c.getDate() - 1);
      let last = null;
      while (dates.has(dayKeyLocal(c.getTime()))) { last = dayKeyLocal(c.getTime()); c.setDate(c.getDate() - 1); }
      streakStart = last;
    }
    if (streakStart) {
      cur.addEventListener('mousemove', (e) => tip.show(tipBox('CURRENT STREAK', [['FROM', streakStart], ['THROUGH', todayActive ? todayKey() : 'yesterday']], 'CLICK → CAPSULE'), e.clientX, e.clientY));
      cur.addEventListener('mouseleave', () => tip.hide());
      cur.addEventListener('click', () => navigate('#/capsule/' + streakStart.slice(0, 7)));
    }

    const lon = H('div', 'streak-cell');
    lon.appendChild(H('span', 'label', 'LONGEST STREAK'));
    const lv = H('div');
    const lvNum = H('span', 'readout-xl');
    odometer(lvNum, fmtNum(t.longestStreak || 0));
    lv.append(lvNum, H('span', 'streak-unit', 'DAYS'));
    lon.appendChild(lv);

    wrap.append(cur, lon);
    mStreak.body.appendChild(wrap);
  });

  let busyPaint = null;
  loadModule(mBusy.body, () => getSummary(), (s) => {
    const b = s.totals.busiestDay;
    if (!b || !b.date) { mBusy.body.appendChild(emptyBox('SIGNAL FLAT — instrument armed, awaiting tokens.')); return; }
    const dateEl = H('div', 'label');
    dateEl.textContent = b.date;
    const val = H('div', 'readout-sm');
    busyPaint = () => odometer(val, fmtMetricValue(mOf(b)) + ' ' + metricUnit());
    busyPaint();
    const link = H('button', 'inspect-link', 'INSPECT ▸');
    link.addEventListener('click', () => openDay(b.date));
    mBusy.body.append(dateEl, val, H('div'), link);
    mBusy.el.style.cursor = 'pointer';
    mBusy.el.addEventListener('click', () => openDay(b.date));
  });

  loadModule(mAir.body, () => getSummary(), (s) => {
    const t = s.totals;
    if (!t.firstTs) { mAir.body.appendChild(emptyBox('SIGNAL FLAT — instrument armed, awaiting tokens.')); return; }
    const days = Math.max(1, Math.floor((Date.now() - t.firstTs) / 86400000) + 1);
    const pct = Math.round(((t.activeDays || 0) / days) * 100);
    mAir.body.appendChild(H('div', 'onair',
      `ON AIR SINCE <b>${esc(dayKeyLocal(t.firstTs))}</b><br>` +
      `<b>${esc(fmtNum(days))}</b> DAYS · <b>${esc(fmtNum(t.activeDays || 0))}</b> ACTIVE (${pct}%)`));
  });

  loadModule(mPunch.body, () => api('/api/punchcard'), (data) => {
    const host = H('div');
    mPunch.body.appendChild(host);
    punchcard(host, data, {});
    mPunch.body.appendChild(H('div', 'pace-sub', 'DOT AREA ∝ TOKENS · MEASURE ONLY'));
  });

  loadModule(mCad.body, () => api('/api/timeseries?bucket=week'), (data) => {
    const rows = (data.rows || []).slice().sort((a, b) => a.t - b.t).slice(-52);
    const wkNow = weekStartMs();
    cadRows = rows;
    const mk = () => rows.map((r) => ({ t: r.t, v: state.metric === 'cost' ? r.cost : rowTok(r), current: r.t >= wkNow }));
    const host = H('div');
    mCad.body.appendChild(host);
    cadApi = cadenceColumns(host, mk(), {
      fmt: (v) => fmtMetricValue(v),
      valLabel: state.metric === 'cost' ? '$EQ' : 'TOKENS',
      onWeek: (t) => navigate('#/capsule/' + dayKeyLocal(t).slice(0, 7)),
    });
    cadApi._mk = mk;
  });

  return {
    destroy() { collapseSession(); },
    refresh() { return renderRhythm(root, { isRefresh: true }); },
    onMetric() {
      if (heatApi) heatApi.update(state.metric);
      if (cadApi && cadApi._mk) cadApi.update(cadApi._mk());
      if (busyPaint) busyPaint();
    },
  };
}

// ============================================================================
// F3 · COST — The Spend Story
// ============================================================================

export function renderCost(root, ctx = {}) {
  const vc = vs.cost;
  if (root._cleanup) { root._cleanup(); root._cleanup = null; }
  root.innerHTML = '';
  const grid = H('div', 'grid');
  root.appendChild(grid);

  const head = H('div', 'view-head');
  head.appendChild(H('span', 'view-title', 'F3 · COST — THE SPEND STORY'));
  head.appendChild(H('span', 'chip disclaimer-chip', 'ALL $ FIGURES = API-EQUIVALENT VALUE · YOU PAY A SUBSCRIPTION'));
  grid.appendChild(head);

  const mCum = module('LONG-EXPOSURE · CUMULATIVE VALUE · SCOPE CURSORS A/B', 'span-12');
  const mComp = module('DAILY COMPOSITION', 'span-8');
  const mCache = module('CACHE FLEX', 'span-4', { cls: 'hoverable' });
  const mRank = module('PROJECT RANKING · BY API-EQ VALUE', 'span-7');
  const mEcon = module('MODEL ECONOMICS', 'span-5');
  grid.append(mCum.el, mComp.el, mCache.el, mRank.el, mEcon.el);
  mComp.body.appendChild(H('div', 'loading', 'ACQUIRING SIGNAL'));
  mCache.body.appendChild(H('div', 'loading', 'ACQUIRING SIGNAL'));

  let cumApi = null, compApi = null;
  let tsAll = null, tsModel = null, tsProject = null;

  // ---- cumulative hero -------------------------------------------------------
  loadModule(mCum.body, () => Promise.all([
    api('/api/timeseries?bucket=day'),
    api('/api/timeseries?bucket=day&by=model'),
  ]), ([all, mod]) => {
    tsAll = (all.rows || []).slice().sort((a, b) => a.t - b.t);
    tsModel = (mod.rows || []).slice().sort((a, b) => a.t - b.t);
    if (tsAll.length < 2) {
      mCum.body.appendChild(emptyBox('THE FIELD IS YOUNG — the curve appears after two active days.'));
      renderComposition();
      renderCacheFlex();
      return;
    }
    const rows = tsAll.map((r) => ({ t: r.t, tok: rowTok(r), cost: r.cost || 0 }));
    // flags
    const mv = (r) => (state.metric === 'cost' ? r.cost : r.tok);
    let f1 = 0;
    rows.forEach((r, i) => { if (mv(r) > mv(rows[f1])) f1 = i; });
    let f2 = -1, best = -1;
    for (let i = 6; i < rows.length; i++) {
      let sum = 0;
      for (let j = i - 6; j <= i; j++) sum += mv(rows[j]);
      if (sum > best) { best = sum; f2 = i; }
    }
    // current flagship: top model by output tokens over last 30 days
    let f3 = -1, flagModel = null;
    {
      const cutoff = Date.now() - 30 * 86400000;
      const agg = new Map();
      for (const r of tsModel) if (r.t >= cutoff) agg.set(r.key, (agg.get(r.key) || 0) + (r.outputTokens || 0));
      let top = null;
      for (const [k, v] of agg) if (!top || v > agg.get(top)) top = k;
      if (top) {
        flagModel = top;
        const firstT = tsModel.find((r) => r.key === top && rowTok(r) > 0);
        if (firstT) f3 = rows.findIndex((r) => r.t === firstT.t);
      }
    }
    const flags = [];
    flags.push({ i: f1, glyph: '①', caption: `${dayKeyLocal(rows[f1].t)} — ${fmtMetricValue(mv(rows[f1]))} IN ONE SITTING` });
    if (f2 >= 0 && f2 !== f1) flags.push({ i: f2, glyph: '②', caption: `STEEPEST WEEK — ${fmtMetricValue(best)} OVER 7 DAYS ENDING ${dayKeyLocal(rows[f2].t)}` });
    if (f3 >= 0 && flagModel) flags.push({ i: f3, glyph: '③', caption: `FIRST DAY OF ${flagModel.replace(/^claude-/, '').toUpperCase()}` });
    const host = H('div');
    mCum.body.appendChild(host);
    cumApi = cumulativeTrace(host, {
      rows, metric: state.metric, height: 300,
      flags: flags.slice(0, 3),
      onDay: (t) => openDay(dayKeyLocal(t)),
    });
    renderComposition();
    renderCacheFlex();
  }).then((ok) => {
    if (ok !== undefined) return;
    // hero fetch failed — composition and cache must not spin forever
    renderCacheFlex();
    mComp.body.innerHTML = '';
    const box = H('div', 'errbox');
    box.textContent = 'SIGNAL LOST — could not load the daily series. ';
    const retry = H('button', '', 'RETRY ▸');
    retry.addEventListener('click', () => {
      loadModule(mComp.body, () => api('/api/timeseries?bucket=day&by=model'), (mod) => {
        tsModel = (mod.rows || []).slice().sort((a, b) => a.t - b.t);
        renderComposition();
      });
    });
    box.appendChild(retry);
    mComp.body.appendChild(box);
  });

  // ---- daily composition ------------------------------------------------------
  const srcSwitch = H('div', 'switch2' + (vc.mode === 'project' ? ' right' : ''));
  srcSwitch.innerHTML = `<div class="sl"></div><span class="${vc.mode === 'model' ? 'on' : ''}">MODEL</span><span class="${vc.mode === 'project' ? 'on' : ''}">PROJECT</span>`;
  srcSwitch.title = 'Trace source';
  srcSwitch.addEventListener('click', () => {
    vc.mode = vc.mode === 'model' ? 'project' : 'model';
    vc.solo = null;
    srcSwitch.classList.toggle('right', vc.mode === 'project');
    const sp = srcSwitch.querySelectorAll('span');
    sp[0].classList.toggle('on', vc.mode === 'model');
    sp[1].classList.toggle('on', vc.mode === 'project');
    renderComposition();
  });
  const rangeKeys = H('span');
  rangeKeys.style.display = 'inline-flex';
  rangeKeys.style.gap = '4px';
  for (const rk of ['30', '90', 'ALL']) {
    const k = H('button', 'key' + (vc.rangeKey === rk && !vc.range ? ' active' : ''), rk === 'ALL' ? 'ALL' : rk + 'D');
    k.dataset.rk = rk;
    k.addEventListener('click', () => {
      vc.rangeKey = rk; vc.range = null;
      rangeKeys.querySelectorAll('.key').forEach((b) => b.classList.toggle('active', b.dataset.rk === rk));
      customChip.style.display = 'none';
      renderComposition();
    });
    rangeKeys.appendChild(k);
  }
  const customChip = H('button', 'chip active');
  customChip.style.display = vc.range ? '' : 'none';
  if (vc.range) customChip.textContent = `RANGE: ${dayKeyLocal(vc.range.from)} → ${dayKeyLocal(vc.range.to)} ✕`;
  customChip.addEventListener('click', () => { vc.range = null; customChip.style.display = 'none'; renderComposition(); });
  const soloChip = H('button', 'chip active');
  soloChip.style.display = 'none';
  soloChip.addEventListener('click', () => clearCompSolo());
  mComp.ctl.append(soloChip, customChip, rangeKeys, srcSwitch);

  let compSoloPop = null;
  function clearCompSolo() {
    vc.solo = null;
    soloChip.style.display = 'none';
    if (compApi) compApi.setSolo(null);
    if (compSoloPop) { compSoloPop(); compSoloPop = null; }
    mEcon.body.querySelectorAll('tr').forEach((tr) => tr.style.opacity = '');
  }
  function setCompSolo(key) {
    vc.solo = key;
    soloChip.textContent = `FILTER: ${key.replace(/^claude-/, '').toUpperCase()} ✕`;
    soloChip.style.display = '';
    if (compApi) compApi.setSolo(key);
    if (!compSoloPop) compSoloPop = escStack.push(() => { clearCompSolo(); });
    mEcon.body.querySelectorAll('tr[data-model]').forEach((tr) => {
      tr.style.opacity = tr.dataset.model === key ? '' : '0.3';
    });
  }

  function compRows() {
    const src = vc.mode === 'model' ? tsModel : tsProject;
    if (!src) return null;
    let from = 0, to = Infinity;
    if (vc.range) { from = vc.range.from; to = vc.range.to; }
    else if (vc.rangeKey !== 'ALL') from = Date.now() - (+vc.rangeKey) * 86400000;
    const rows = src.filter((r) => r.t >= from && r.t <= to);
    // global key ranking by cost
    const keyAgg = new Map();
    for (const r of rows) keyAgg.set(r.key, (keyAgg.get(r.key) || 0) + (r.cost || 0));
    const ranked = [...keyAgg.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]);
    let keyMeta;
    if (vc.mode === 'model') {
      keyMeta = (k) => { const ch = channelOf(k); return { label: k.replace(/^claude-/, '').toUpperCase(), glyph: CH[ch].glyph, color: CH[ch].color }; };
    } else {
      const top = ranked.slice(0, 7);
      keyMeta = (k) => {
        const i = top.indexOf(k);
        if (i < 0) return { label: 'OTHER', glyph: '·', color: 'var(--prj-other)', other: true };
        return { label: k.toUpperCase(), glyph: k[0].toUpperCase(), color: `var(--prj-${i + 1})` };
      };
    }
    const byT = new Map();
    for (const r of rows) {
      const meta = keyMeta(r.key);
      const key = meta.other ? '·OTHER·' : r.key;
      let d = byT.get(r.t);
      if (!d) { d = { t: r.t, map: new Map() }; byT.set(r.t, d); }
      const cur = d.map.get(key) || { key, label: meta.label, glyph: meta.glyph, color: meta.color, value: 0 };
      cur.value += state.metric === 'cost' ? (r.cost || 0) : rowTok(r);
      d.map.set(key, cur);
    }
    const keyOrder = ranked.map((k) => (vc.mode === 'project' && ranked.indexOf(k) >= 7 ? '·OTHER·' : k));
    const uniqOrder = [...new Set(keyOrder)];
    return [...byT.values()].sort((a, b) => a.t - b.t).map((d) => {
      const parts = uniqOrder.filter((k) => d.map.has(k)).map((k) => d.map.get(k));
      return { t: d.t, parts, total: parts.reduce((s, p) => s + p.value, 0) };
    });
  }

  function renderComposition() {
    if (!tsModel) return;
    const go = () => {
      const data = compRows();
      mComp.body.innerHTML = '';
      if (!data || !data.length) { mComp.body.appendChild(emptyBox('SIGNAL FLAT — no activity in this range.')); compApi = null; return; }
      const host = H('div');
      mComp.body.appendChild(host);
      compApi = stackedBars(host, {
        data, height: 280,
        fmt: (v) => fmtMetricValue(v),
        onBar: (t) => openDay(dayKeyLocal(t)),
        onSeg: (key, t) => {
          if (key === '·OTHER·') { openDay(dayKeyLocal(t)); return; }
          if (vc.mode === 'project') goProject(key);
          else (vc.solo === key ? clearCompSolo() : setCompSolo(key));
        },
      });
      // setCompSolo (not compApi.setSolo) so the FILTER chip and Esc handler
      // are restored after a full re-render, not just the bar dimming
      if (vc.solo) setCompSolo(vc.solo);
    };
    if (vc.mode === 'project' && !tsProject) {
      mComp.body.innerHTML = '';
      mComp.body.appendChild(H('div', 'loading', 'ACQUIRING SIGNAL'));
      api('/api/timeseries?bucket=day&by=project').then((d) => { tsProject = (d.rows || []).slice().sort((a, b) => a.t - b.t); go(); })
        .catch(() => { mComp.body.innerHTML = ''; mComp.body.appendChild(emptyBox('SIGNAL LOST — could not load project series.')); });
    } else go();
  }

  // ---- cache flex --------------------------------------------------------------
  function renderCacheFlex() {
    loadModule(mCache.body, () => getSummary(), (s) => {
      const t = s.totals;
      mCache.body.innerHTML = '';
      const headline = H('div', 'cacheflex-headline');
      const v = H('span', 'readout-lg');
      odometer(v, fmtMoney(t.cacheSavings || 0));
      headline.append(v, H('span', 'unit', 'API-EQ'));
      mCache.body.appendChild(H('span', 'label', 'SAVED BY CACHE'));
      mCache.body.appendChild(headline);

      // twin trace from by-model series (price math mirrors the contract table)
      if (tsModel && tsModel.length) {
        const byDay = new Map();
        const cutoff = Date.now() - 90 * 86400000;
        for (const r of tsModel) {
          if (r.t < cutoff) continue;
          let d = byDay.get(r.t);
          if (!d) { d = { t: r.t, actual: 0, would: 0 }; byDay.set(r.t, d); }
          d.actual += r.cost || 0;
          d.would += (r.cost || 0) + ((r.cacheReadTokens || 0) / 1e6) * 0.9 * inputRate(r.key);
        }
        const rows = [...byDay.values()].sort((a, b) => a.t - b.t);
        if (rows.length >= 2) {
          const legend = H('div', 'leader-rows');
          legend.innerHTML =
            `<div class="leader-row"><span class="glyph" style="color:var(--text-faint)">┄</span><span class="lr-name">WOULD-HAVE-COST</span><span class="lr-dots"></span><span class="lr-val">UNCACHED</span></div>` +
            `<div class="leader-row"><span class="glyph" style="color:var(--accent)">—</span><span class="lr-name">ACTUAL</span><span class="lr-dots"></span><span class="lr-val">THE DIVIDEND ▒</span></div>`;
          const host = H('div');
          host.style.margin = '8px 0';
          mCache.body.appendChild(host);
          twinTrace(host, rows, { height: 90 });
          mCache.body.appendChild(legend);
        }
      }

      // cache-read vs fresh-input split
      const split = H('div');
      split.style.marginTop = '12px';
      mCache.body.appendChild(split);
      mixBar(split, [
        { key: 'cache', label: 'CACHE READ', glyph: '◈', color: 'var(--good)', value: t.cacheReadTokens || 0 },
        { key: 'fresh', label: 'FRESH INPUT', glyph: '◇', color: 'var(--ch-other)', value: t.inputTokens || 0 },
      ], { legend: true, fmt: fmtTokens, valLabel: 'TOKENS' });
      const wr = H('div', 'ledger');
      wr.style.marginTop = '8px';
      wr.appendChild(H('div', 'l-row', `<span>CACHE WRITE · 5M+1H COMBINED</span><b>${esc(fmtTokens(t.cacheWriteTokens || 0))}</b>`));
      mCache.body.appendChild(wr);
      mCache.body.appendChild(H('div', 'cache-note', 'CACHE READ BILLS AT 0.1× INPUT' + (state.metric === 'tokens' ? ' · SAVINGS ARE A PRICE STORY' : '')));

      // expand-in-place: 90-day savings/day columns
      const exp = H('div');
      exp.style.display = vc.cacheOpen ? '' : 'none';
      exp.style.marginTop = '12px';
      mCache.body.appendChild(exp);
      const expKey = H('button', 'key' + (vc.cacheOpen ? ' active' : ''), vc.cacheOpen ? 'COLLAPSE ▴' : 'EXPAND ▾');
      mCache.ctl.innerHTML = '';
      mCache.ctl.appendChild(expKey);
      const buildExp = () => {
        exp.innerHTML = '';
        if (!tsModel) return;
        const byDay = new Map();
        const cutoff = Date.now() - 90 * 86400000;
        for (const r of tsModel) {
          if (r.t < cutoff) continue;
          byDay.set(r.t, (byDay.get(r.t) || 0) + ((r.cacheReadTokens || 0) / 1e6) * 0.9 * inputRate(r.key));
        }
        const rows = [...byDay.entries()].sort((a, b) => a[0] - b[0]).map(([t2, v2]) => ({ t: t2, v: v2 }));
        exp.appendChild(H('span', 'label sc-section-title', 'SAVINGS PER DAY · 90D'));
        const cHost = H('div');
        exp.appendChild(cHost);
        cadenceColumns(cHost, rows, { height: 120, fmt: fmtMoney, valLabel: 'SAVED' });
        exp.appendChild(H('div', 'cache-note', 'SAVINGS = CACHE-READ TOK × (1.0 − 0.1) × INPUT RATE'));
      };
      if (vc.cacheOpen) buildExp();
      expKey.addEventListener('click', () => {
        vc.cacheOpen = !vc.cacheOpen;
        exp.style.display = vc.cacheOpen ? '' : 'none';
        expKey.textContent = vc.cacheOpen ? 'COLLAPSE ▴' : 'EXPAND ▾';
        expKey.classList.toggle('active', vc.cacheOpen);
        if (vc.cacheOpen) buildExp();
      });
    });
  }

  // ---- project ranking ----------------------------------------------------------
  let rankRows = null;
  function paintRank() {
    if (!rankRows) return;
    const host = mRank.body;
    host.innerHTML = '';
    if (!rankRows.length) { host.appendChild(emptyBox('SIGNAL FLAT — instrument armed, awaiting tokens.')); return; }
    const totalAll = rankRows.reduce((s, p) => s + mOf(p), 0) || 1;
    const top = rankRows.slice(0, 12);
    const rest = rankRows.slice(12);
    const rows = top.map((p) => ({
      name: p.project,
      value: mOf(p),
      vals: [fmtMetricValue(mOf(p)), `${fmtNum(p.sessions)} sess`, `${fmtNum(p.messages)} msg`, fmtTokens(p.tokens) + ' tok', ((mOf(p) / totalAll) * 100).toFixed(1) + '%'],
    }));
    if (rest.length) {
      const agg = rest.reduce((a, p) => ({ v: a.v + mOf(p), s: a.s + p.sessions }), { v: 0, s: 0 });
      rows.push({ name: `EVERYTHING ELSE (${rest.length})`, value: agg.v, vals: [fmtMetricValue(agg.v), `${fmtNum(agg.s)} sess`], footer: true });
    }
    traceBarList(host, rows, { rank: true, glowFirst: true, onClick: (name) => goProject(name) });
  }
  loadModule(mRank.body, () => api('/api/projects'), (d) => { rankRows = d.projects || []; paintRank(); });

  // ---- model economics ------------------------------------------------------------
  loadModule(mEcon.body, () => getSummary(), (s) => {
    const models = (s.models || []).slice().sort((a, b) => (b.cost || 0) - (a.cost || 0));
    if (!models.length) { mEcon.body.appendChild(emptyBox('SIGNAL FLAT — instrument armed, awaiting tokens.')); return; }
    const table = H('table', 'mono-table');
    table.innerHTML = '<thead><tr><th>MODEL</th><th>MSGS</th><th>IN</th><th>OUT</th><th>CACHE R</th><th>$EQ</th><th>$/MTOK-OUT</th></tr></thead>';
    const tbody = H('tbody');
    for (const m of models) {
      const ch = channelOf(m.model);
      const eff = m.outputTokens > 0 ? '$' + (m.cost / (m.outputTokens / 1e6)).toFixed(2) : '—';
      const tr = H('tr', 'clickable');
      tr.dataset.model = m.model;
      tr.innerHTML = `<td><span class="swatch" style="background:${CH[ch].color}"></span> <span class="glyph" style="color:${CH[ch].color}">${CH[ch].glyph}</span> ${esc(m.model.replace(/^claude-/, ''))}</td>` +
        `<td>${esc(fmtNum(m.msgs))}</td><td>${esc(fmtTokens(m.inputTokens))}</td><td>${esc(fmtTokens(m.outputTokens))}</td>` +
        `<td>${esc(fmtTokens(m.cacheReadTokens))}</td><td>${esc(fmtMoney(m.cost))}</td><td>${eff}</td>`;
      tr.addEventListener('click', () => {
        if (vc.mode !== 'model') { srcSwitch.click(); }
        vc.solo === m.model ? clearCompSolo() : setCompSolo(m.model);
      });
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    mEcon.body.appendChild(table);
  });

  const handle = {
    destroy() { if (compSoloPop) { compSoloPop(); compSoloPop = null; } root._cleanup = null; collapseSession(); },
    refresh() { return renderCost(root, { isRefresh: true }); },
    onMetric() {
      if (cumApi) cumApi.update(state.metric);
      renderComposition();
      paintRank();
      renderCacheFlex();
    },
  };
  root._cleanup = () => handle.destroy();
  return handle;
}

// ============================================================================
// F4 · CAPSULE — Time Capsule
// ============================================================================

export function renderCapsule(root, ctx = {}) {
  const vcp = vs.capsule;
  if (root._cleanup) { root._cleanup(); root._cleanup = null; }
  if (ctx.from && ctx.to) {
    const f = parseDayKey(ctx.from), t = parseDayKey(ctx.to);
    if (f && t) vcp.period = { from: f.getTime(), to: t.getTime() + 86399999, label: 'custom' };
  }
  root.innerHTML = '';
  const layout = H('div', 'capsule-layout');
  root.appendChild(layout);
  const railCol = H('div', 'spool-rail-col');
  const main = H('div', 'capsule-main');
  const minimap = H('div', 'minimap');
  layout.append(railCol, main, minimap);

  // ---- sticky control strip ---------------------------------------------------
  const sticky = H('div', 'capsule-sticky');
  main.appendChild(sticky);
  const periodChips = [];
  const mkPeriod = (label) => {
    const now = Date.now();
    if (label === 'THIS WEEK') return { from: weekStartMs(), to: now, label: 'this week' };
    if (label === 'LAST WEEK') { const ws = weekStartMs(); return { from: ws - 7 * 86400000, to: ws - 1, label: 'last week' }; }
    const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0);
    return { from: d.getTime(), to: now, label: 'this month' };
  };
  for (const lbl of ['THIS WEEK', 'LAST WEEK', 'THIS MONTH']) {
    const c = H('button', 'chip', lbl);
    c.addEventListener('click', () => setPeriod(mkPeriod(lbl), c));
    sticky.appendChild(c);
    periodChips.push(c);
  }
  const fromIn = H('input'); fromIn.type = 'date';
  const toIn = H('input'); toIn.type = 'date';
  fromIn.title = 'Custom period start'; toIn.title = 'Custom period end';
  const onCustom = () => {
    if (!fromIn.value || !toIn.value) return;
    const f = parseDayKey(fromIn.value), t = parseDayKey(toIn.value);
    if (f && t && f <= t) setPeriod({ from: f.getTime(), to: t.getTime() + 86399999, label: 'custom' }, null);
  };
  fromIn.addEventListener('change', onCustom);
  toIn.addEventListener('change', onCustom);
  sticky.append(fromIn, toIn);

  const storyKey = H('button', 'story-key');
  sticky.appendChild(storyKey);
  const printoutHost = H('div');
  main.appendChild(printoutHost);

  // story key state machine ------------------------------------------------------
  let armed = false, armTimer = 0, pending = null, popArmEsc = null;
  function keyLabel(txt, extra) {
    storyKey.innerHTML = `<svg width="14" height="14" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="10" cy="10" r="1.6" fill="currentColor"/></svg> ${txt}${extra || ''}`;
  }
  function disarm() {
    armed = false;
    clearTimeout(armTimer);
    storyKey.classList.remove('armed', 'error');
    keyLabel('TELL ME THE STORY');
    if (popArmEsc) { popArmEsc(); popArmEsc = null; }
  }
  function arm() {
    if (!vcp.period) { setPeriod(mkPeriod('THIS WEEK'), periodChips[0]); }
    armed = true;
    storyKey.classList.add('armed');
    storyKey.classList.remove('error');
    keyLabel('CONFIRM · TAKES UP TO 2 MIN');
    popArmEsc = escStack.push(() => disarm());
    clearTimeout(armTimer);
    armTimer = setTimeout(disarm, 5000);
  }
  function fire() {
    disarm();
    const p = vcp.period;
    if (!p) return;
    storyKey.classList.add('pending');
    const cancel = H('span', 'story-cancel', '✕');
    keyLabel('NARRATING…');
    storyKey.appendChild(cancel);
    const ctrl = new AbortController();
    pending = ctrl;
    cancel.addEventListener('click', (e) => { e.stopPropagation(); ctrl.abort(); });
    fetch('/api/story', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: p.from, to: p.to, label: p.label }),
      signal: ctrl.signal,
    }).then(async (res) => {
      const data = await res.json().catch(() => ({}));
      storyKey.classList.remove('pending');
      pending = null;
      if (!res.ok || data.error) {
        storyKey.classList.add('error');
        keyLabel(res.status === 504 ? 'NO RESPONSE — RETRY' : 'NARRATOR ERROR — RETRY');
        renderStoryError(data.error || `HTTP ${res.status}`, res.status === 504);
        return;
      }
      keyLabel('TELL ME THE STORY');
      vcp.lastStory = { story: data.story, cached: !!data.cached, period: { ...p } };
      renderPrintout(vcp.lastStory, !REDUCED && !data.cached);
    }).catch((err) => {
      storyKey.classList.remove('pending');
      pending = null;
      if (err.name === 'AbortError') { keyLabel('TELL ME THE STORY'); return; }
      storyKey.classList.add('error');
      keyLabel('NO RESPONSE — RETRY');
      renderStoryError(String(err.message || err), true);
    });
  }
  storyKey.addEventListener('click', () => {
    if (pending) return;
    if (armed) fire(); else arm();
  });
  keyLabel('TELL ME THE STORY');

  function renderStoryError(msg, timeout) {
    printoutHost.innerHTML = '';
    const box = H('div', 'errbox');
    const cliMissing = /not found|ENOENT/i.test(msg || '');
    box.textContent = cliMissing
      ? 'CLAUDE CLI NOT FOUND — the narrator needs the claude binary on PATH; data instruments unaffected.'
      : (timeout ? 'NO RESPONSE FROM THE NARRATOR — the line timed out after 120s.' : `THE NARRATOR FALTERED — ${msg}`);
    const retry = H('button', '', 'RETRY ▸');
    retry.addEventListener('click', () => { arm(); fire(); });
    if (!cliMissing) box.appendChild(retry);
    printoutHost.appendChild(box);
  }

  let typerTimer = 0;
  function renderPrintout(st, typewrite) {
    clearInterval(typerTimer);
    printoutHost.innerHTML = '';
    const p = H('div', 'printout');
    const pHead = H('div', 'printout-head');
    pHead.textContent = `CHART RECORDER · ${st.period.label.toUpperCase()} · ${dayKeyLocal(st.period.from)} → ${dayKeyLocal(st.period.to)}`;
    p.appendChild(pHead);
    if (st.cached) p.appendChild(H('div', 'stamp', 'CACHED'));
    const text = String(st.story || '').trim();
    const first = text.charAt(0);
    const rest = text.slice(1);
    const body = H('div', 'story-text');
    const drop = H('span', 'dropcap');
    drop.textContent = first;
    const span = H('span');
    body.append(drop, span);
    p.appendChild(body);
    const foot = H('div', 'printout-foot');
    if (st.cached) {
      const regen = H('button', '', 'FROM THE ARCHIVE · REGENERATE ⟳');
      regen.addEventListener('click', () => { vcp.period = { ...st.period }; arm(); });
      foot.appendChild(regen);
    }
    const viewCost = H('button', '', 'VIEW PERIOD IN COST ▸');
    viewCost.addEventListener('click', () => {
      vs.cost.range = { from: st.period.from, to: st.period.to };
      navigate('#/cost');
    });
    foot.appendChild(viewCost);
    p.appendChild(foot);
    printoutHost.appendChild(p);

    if (typewrite && rest.length) {
      const caret = H('span', 'caret');
      body.appendChild(caret);
      let i = 0;
      const finish = () => {
        clearInterval(typerTimer);
        span.textContent = rest;
        caret.remove();
        drop.classList.add('inked');
        p.removeEventListener('click', finish);
      };
      typerTimer = setInterval(() => {
        i += 1;
        span.textContent = rest.slice(0, i);
        if (i >= rest.length) finish();
      }, 18);
      p.addEventListener('click', finish);
    } else {
      span.textContent = rest;
      drop.classList.add('inked');
    }
  }
  if (vcp.lastStory) renderPrintout(vcp.lastStory, false);

  // ---- project filter chips ------------------------------------------------------
  const filterRow = H('div', 'filter-chips');
  main.appendChild(filterRow);
  api('/api/projects').then((d) => {
    const top = (d.projects || []).slice(0, 6);
    if (!top.length) return;
    filterRow.appendChild(H('span', 'label', 'FILTER:'));
    for (const pr of top) {
      const c = H('button', 'chip' + (vcp.project === pr.project ? ' active' : ''));
      c.textContent = (vcp.project === pr.project ? '✕ ' : '') + pr.project;
      c.addEventListener('click', () => {
        vcp.project = vcp.project === pr.project ? null : pr.project;
        renderCapsule(root, {});
      });
      filterRow.appendChild(c);
    }
  }).catch(() => {});

  // ---- the spool feed --------------------------------------------------------------
  const feed = H('div');
  main.appendChild(feed);
  const sentinel = H('div', 'loading', 'LOADING SPOOL');
  main.appendChild(sentinel);

  const F = {
    offset: 0, total: Infinity, loading: false, done: false,
    monthEls: new Map(),   // 'YYYY-MM' -> {section, folio, agg:{days:Set, sessions, tok, cost}}
    dayEls: new Map(),     // 'YYYY-MM-DD' -> {group, list, tot, agg}
    cards: new Map(),      // session id -> {card, s}
    lastDayKey: null,      // oldest day appended (walk pointer)
    newestDayKey: null,    // newest day seen (prepend boundary)
  };

  function folioText(agg) {
    return `${agg.days.size} DAYS ACTIVE · ${fmtNum(agg.sessions)} SESSIONS · ${fmtTokens(agg.tok)} TOK · ${fmtMoney(agg.cost)}`;
  }
  function dayTotText(agg) {
    return `${fmtNum(agg.sessions)} SESS · ${fmtMetricValue(state.metric === 'cost' ? agg.cost : agg.tok)} ${metricUnit()}`;
  }

  function ensureMonth(mKey, opts = {}) {
    let m = F.monthEls.get(mKey);
    if (m) return m;
    const section = H('div');
    section.dataset.month = mKey;
    const brk = H('div', 'month-break');
    brk.appendChild(H('div', 'mb-rule'));
    const row = H('div', 'mb-row');
    const [y, mo] = mKey.split('-');
    row.appendChild(H('span', 'mb-name', `${MONTH_NAMES[+mo - 1]} ${y}`));
    const folio = H('span', 'mb-folio', '');
    row.appendChild(folio);
    row.title = 'Click to set the period and arm the story key';
    row.addEventListener('click', () => {
      const f = new Date(+y, +mo - 1, 1).getTime();
      const t = new Date(+y, +mo, 0, 23, 59, 59, 999).getTime();
      setPeriod({ from: f, to: Math.min(t, Date.now()), label: `${MONTH_NAMES[+mo - 1].toLowerCase()} ${y}` }, null);
      arm();
      sticky.scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'start' });
    });
    brk.appendChild(row);
    section.appendChild(brk);
    if (opts.prepend && feed.firstChild) feed.insertBefore(section, feed.firstChild);
    else feed.appendChild(section);
    m = { section, folio, agg: { days: new Set(), sessions: 0, tok: 0, cost: 0 } };
    F.monthEls.set(mKey, m);
    return m;
  }

  function ensureDay(dKey, mEl, opts = {}) {
    let d = F.dayEls.get(dKey);
    if (d) return d;
    // quiet gap line between previous day group and this one
    if (F.lastDayKey && !opts.prepend) {
      const prev = parseDayKey(F.lastDayKey), curd = parseDayKey(dKey);
      const gap = Math.round((prev - curd) / 86400000) - 1;
      if (gap >= 3) mEl.section.appendChild(H('div', 'quiet-gap', `· · · ${gap} QUIET DAYS · · ·`));
    }
    const group = H('div', 'day-group');
    group.dataset.day = dKey;
    const node = H('span', 'day-node');
    const headEl = H('div', 'day-head');
    headEl.appendChild(H('span', 'dh-date', fmtDateLong(dKey)));
    const tot = H('span', 'dh-tot', '');
    headEl.appendChild(tot);
    headEl.addEventListener('click', () => openDay(dKey));
    const list = H('div');
    group.append(node, headEl, list);
    if (opts.prepend && mEl.section.children.length > 1) mEl.section.insertBefore(group, mEl.section.children[1]);
    else mEl.section.appendChild(group);
    d = { group, list, tot, agg: { sessions: 0, tok: 0, cost: 0 } };
    F.dayEls.set(dKey, d);
    if (!opts.prepend) F.lastDayKey = dKey;
    applyBracketTo(group);
    return d;
  }

  function addSession(s, opts = {}) {
    const dKey = dayKeyLocal(s.last_ts);
    const mKey = dKey.slice(0, 7);
    const mEl = ensureMonth(mKey, opts);
    const dEl = ensureDay(dKey, mEl, opts);
    if (!F.newestDayKey || dKey > F.newestDayKey) F.newestDayKey = dKey;
    const card = sessionCard(s, { fresh: opts.fresh });
    if (opts.prepend) dEl.list.insertBefore(card, dEl.list.firstChild);
    else dEl.list.appendChild(card);
    F.cards.set(s.id, { card, s });
    dEl.agg.sessions += 1; dEl.agg.tok += s.tokens || 0; dEl.agg.cost += s.cost || 0;
    dEl.tot.textContent = dayTotText(dEl.agg);
    mEl.agg.days.add(dKey); mEl.agg.sessions += 1; mEl.agg.tok += s.tokens || 0; mEl.agg.cost += s.cost || 0;
    mEl.folio.textContent = folioText(mEl.agg);
  }

  async function loadMore() {
    if (F.loading || F.done) return;
    F.loading = true;
    sentinel.style.display = '';
    try {
      const q = new URLSearchParams({ limit: '50', offset: String(F.offset) });
      if (vcp.project) q.set('project', vcp.project);
      const d = await api('/api/sessions?' + q);
      const rows = d.sessions || [];
      F.total = d.total ?? F.total;
      F.offset += rows.length;
      for (const s of rows) addSession(s);
      if (!rows.length || F.offset >= F.total) {
        F.done = true;
        sentinel.classList.remove('loading');
        sentinel.textContent = F.offset === 0
          ? (vcp.project ? 'NOTHING ON THE SPOOL — no sessions match this filter.' : 'NOTHING ON THE SPOOL — no sessions yet.')
          : '· · · END OF THE SPOOL · · ·';
        sentinel.className = 'quiet-gap';
        if (F.offset === 0 && vcp.project) {
          const clear = H('button', 'inspect-link', ' CLEAR FILTERS ▸');
          clear.addEventListener('click', () => { vcp.project = null; renderCapsule(root, {}); });
          sentinel.appendChild(clear);
        }
      }
      updateMinimapCurrent();
    } catch (e) {
      sentinel.className = 'errbox';
      sentinel.textContent = `SIGNAL LOST — ${String(e.message || e).slice(0, 60)} `;
      const retry = H('button', '', 'RETRY ▸');
      retry.addEventListener('click', () => { sentinel.className = 'loading'; sentinel.textContent = 'LOADING SPOOL'; F.loading = false; loadMore(); });
      sentinel.appendChild(retry);
      F.done = true; // stop the observer loop until retry
    }
    F.loading = false;
  }

  const io = new IntersectionObserver((entries) => {
    if (entries.some((en) => en.isIntersecting)) loadMore();
  }, { rootMargin: '600px' });
  io.observe(sentinel);

  // ---- period bracket --------------------------------------------------------------
  function applyBracketTo(group) {
    if (!vcp.period) return;
    const k = group.dataset.day;
    const from = dayKeyLocal(vcp.period.from), to = dayKeyLocal(vcp.period.to);
    group.classList.toggle('bracketed', k >= from && k <= to);
  }
  function applyBracketAll() {
    feed.querySelectorAll('.day-group').forEach((g) => {
      if (!vcp.period) { g.classList.remove('bracketed'); return; }
      applyBracketTo(g);
    });
  }
  function setPeriod(p, chip) {
    vcp.period = p;
    periodChips.forEach((c) => c.classList.toggle('active', c === chip));
    if (p.label === 'custom') { fromIn.value = dayKeyLocal(p.from); toIn.value = dayKeyLocal(p.to); }
    history.replaceState(null, '', `#/capsule?from=${dayKeyLocal(p.from)}&to=${dayKeyLocal(p.to)}`);
    applyBracketAll();
  }
  if (vcp.period) {
    applyBracketAll();
    if (vcp.period.label === 'custom') { fromIn.value = dayKeyLocal(vcp.period.from); toIn.value = dayKeyLocal(vcp.period.to); }
  }

  // ---- minimap ----------------------------------------------------------------------
  let mmEls = new Map();
  api('/api/heatmap').then((d) => {
    const months = new Map();
    for (const day of d.days || []) {
      const mk = day.date.slice(0, 7);
      months.set(mk, (months.get(mk) || 0) + (day.tokens || 0));
    }
    const keys = [...months.keys()].sort().reverse();
    const max = Math.max(1, ...months.values());
    for (const mk of keys) {
      const el = H('div', 'mm-month');
      const [y, mo] = mk.split('-');
      const tick = H('span', 'mm-tick');
      tick.style.width = Math.max(3, (months.get(mk) / max) * 36).toFixed(0) + 'px';
      el.append(tick, H('span', '', `${MONTH_NAMES[+mo - 1].slice(0, 3)} ${y.slice(2)}`));
      el.addEventListener('click', () => jumpToMonth(mk));
      minimap.appendChild(el);
      mmEls.set(mk, el);
    }
  }).catch(() => {});

  function updateMinimapCurrent() {
    let cur = null;
    const th = 140 * uiZoom(); // rects are viewport px; 140 is a layout-px offset
    for (const [mk, m] of F.monthEls) {
      const r = m.section.getBoundingClientRect();
      if (r.top <= th && r.bottom > th) { cur = mk; break; }
      if (r.top > th) { if (!cur) cur = mk; break; }
    }
    for (const [mk, el] of mmEls) el.classList.toggle('current', mk === cur);
  }
  const onScroll = () => { if (!onScroll._t) onScroll._t = setTimeout(() => { onScroll._t = 0; updateMinimapCurrent(); }, 150); };
  addEventListener('scroll', onScroll, { passive: true });

  async function jumpToMonth(mKey) {
    let guard = 0;
    while (!F.monthEls.has(mKey) && !F.done && guard++ < 40) await loadMore();
    const m = F.monthEls.get(mKey);
    if (m) m.section.scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'start' });
  }

  async function revealSession(id) {
    let guard = 0;
    while (!F.cards.has(id) && !F.done && guard++ < 10) await loadMore();
    const c = F.cards.get(id);
    if (c) {
      c.card.scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'center' });
      c.card.querySelector('.sc-head').click();
    }
  }

  // initial load then deep links
  loadMore().then(() => {
    if (ctx.month) jumpToMonth(ctx.month);
    if (ctx.session) revealSession(ctx.session);
  });

  const handle = {
    destroy() {
      io.disconnect();
      removeEventListener('scroll', onScroll);
      clearInterval(typerTimer);
      clearTimeout(armTimer);
      if (pending) pending.abort();
      if (popArmEsc) { popArmEsc(); popArmEsc = null; }
      root._cleanup = null;
      collapseSession();
    },
    refresh() {
      // gentle refresh: pull page 0, update existing today cards, prepend new sessions
      const q = new URLSearchParams({ limit: '50', offset: '0' });
      if (vcp.project) q.set('project', vcp.project);
      api('/api/sessions?' + q).then((d) => {
        const rows = (d.sessions || []).slice().reverse(); // oldest of the new first
        for (const s of rows) {
          const ex = F.cards.get(s.id);
          if (ex) {
            Object.assign(ex.s, s);
            if (ex.card._setRo) { ex.card._setRo(); }
          } else if (!F.newestDayKey || dayKeyLocal(s.last_ts) >= F.newestDayKey) {
            F.offset += 1;
            addSession(s, { prepend: true, fresh: true });
          }
        }
      }).catch(() => {});
    },
    onMetric() {
      for (const [, d] of F.dayEls) d.tot.textContent = dayTotText(d.agg);
      for (const [, c] of F.cards) if (c.card._setRo) c.card._setRo();
    },
  };
  root._cleanup = () => handle.destroy();
  return handle;
}

// ============================================================================
// PROJECT VIEW — drill-down route (#/project/<name>)
// ============================================================================

export function renderProject(root, ctx = {}) {
  const name = ctx.name;
  const vp = vs.project;
  if (root._cleanup) { root._cleanup(); root._cleanup = null; }
  root.innerHTML = '';
  const grid = H('div', 'grid');
  root.appendChild(grid);

  const mBench = module('PROJECT BENCH', 'span-12');
  grid.appendChild(mBench.el);
  const mTrace = module('DAILY TRACE · BY MODEL · CUMULATIVE OVERLAY', 'span-12');
  grid.appendChild(mTrace.el);
  const mPunch = module('WHEN THIS PROJECT GETS WORKED ON', 'span-6');
  const mMix = module('MODEL MIX IN-PROJECT', 'span-6');
  grid.append(mPunch.el, mMix.el);
  const mSpool = module('PROJECT SESSION SPOOL', 'span-12');
  grid.appendChild(mSpool.el);

  let tsRows = null, traceApi = null, mixApi = null;
  const loaded = []; // session rows for tool signature
  let spoolTotal = Infinity;

  // ---- bench header -----------------------------------------------------------
  let benchPaint = null;
  loadModule(mBench.body, () => api('/api/projects'), (d) => {
    const row = (d.projects || []).find((p) => p.project === name);
    const all = d.projects || [];
    mBench.body.innerHTML = '';
    const nameEl = H('div', 'bench-name');
    nameEl.textContent = name;
    mBench.body.appendChild(nameEl);
    if (!row) { mBench.body.appendChild(emptyBox('NOTHING ON THE SPOOL — unknown project.')); return; }
    const stats = H('div', 'bench-stats');
    mBench.body.appendChild(stats);
    benchPaint = () => {
      const totalAll = all.reduce((s, p) => s + mOf(p), 0) || 1;
      stats.innerHTML = '';
      const items = [
        ['TOKENS', fmtTokens(row.tokens) + ' tok'],
        ['$EQ · API-EQUIVALENT', fmtMoney(row.cost)],
        ['SESSIONS', fmtNum(row.sessions)],
        ['MESSAGES', fmtNum(row.messages)],
        ['SHARE OF GLOBAL', ((mOf(row) / totalAll) * 100).toFixed(1) + '%'],
        ['ACTIVE', `${dayKeyLocal(row.firstTs)} → ${dayKeyLocal(row.lastTs)}`],
      ];
      for (const [lbl, val] of items) {
        const cell = H('div', 'bench-stat');
        cell.appendChild(H('span', 'label', lbl));
        const v = H('span', 'readout-sm');
        v.textContent = val;
        cell.appendChild(v);
        stats.appendChild(cell);
      }
    };
    benchPaint();
  });

  // ---- daily trace -------------------------------------------------------------
  const rangeKeys = H('span');
  rangeKeys.style.display = 'inline-flex';
  rangeKeys.style.gap = '4px';
  for (const rk of ['30', '90', 'ALL']) {
    const k = H('button', 'key' + (vp.rangeKey === rk ? ' active' : ''), rk === 'ALL' ? 'ALL' : rk + 'D');
    k.dataset.rk = rk;
    k.addEventListener('click', () => {
      vp.rangeKey = rk;
      rangeKeys.querySelectorAll('.key').forEach((b) => b.classList.toggle('active', b.dataset.rk === rk));
      paintTrace();
    });
    rangeKeys.appendChild(k);
  }
  const soloChip = H('button', 'chip active');
  soloChip.style.display = 'none';
  soloChip.addEventListener('click', () => setSolo(null));
  mTrace.ctl.append(soloChip, rangeKeys);

  function setSolo(key) {
    vp.solo = key;
    soloChip.style.display = key ? '' : 'none';
    if (key) soloChip.textContent = `FILTER: ${key.replace(/^claude-/, '').toUpperCase()} ✕`;
    if (traceApi) traceApi.setSolo(key);
  }

  function traceData() {
    let from = 0;
    if (vp.rangeKey !== 'ALL') from = Date.now() - (+vp.rangeKey) * 86400000;
    const rows = tsRows.filter((r) => r.t >= from);
    const keyAgg = new Map();
    for (const r of rows) keyAgg.set(r.key, (keyAgg.get(r.key) || 0) + (r.cost || 0));
    const ranked = [...keyAgg.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]);
    const byT = new Map();
    for (const r of rows) {
      let d = byT.get(r.t);
      if (!d) { d = { t: r.t, map: new Map() }; byT.set(r.t, d); }
      const ch = channelOf(r.key);
      const cur = d.map.get(r.key) || { key: r.key, label: r.key.replace(/^claude-/, '').toUpperCase(), glyph: CH[ch].glyph, color: CH[ch].color, value: 0 };
      cur.value += state.metric === 'cost' ? (r.cost || 0) : rowTok(r);
      d.map.set(r.key, cur);
    }
    const data = [...byT.values()].sort((a, b) => a.t - b.t).map((d) => {
      const parts = ranked.filter((k) => d.map.has(k)).map((k) => d.map.get(k));
      return { t: d.t, parts, total: parts.reduce((s, p) => s + p.value, 0) };
    });
    let cum = 0;
    const overlay = data.map((d) => ({ t: d.t, v: (cum += d.total) }));
    return { data, overlay };
  }

  function paintTrace() {
    if (!tsRows) return;
    mTrace.body.innerHTML = '';
    const { data, overlay } = traceData();
    if (!data.length) { mTrace.body.appendChild(emptyBox('SIGNAL FLAT — no activity in this range.')); traceApi = null; return; }
    const host = H('div');
    mTrace.body.appendChild(host);
    traceApi = stackedBars(host, {
      data, overlay, height: 260,
      fmt: (v) => fmtMetricValue(v),
      onBar: (t) => openDay(dayKeyLocal(t)),
      onSeg: (key) => setSolo(vp.solo === key ? null : key),
    });
    // setSolo (not traceApi.setSolo) so the FILTER chip is restored too
    if (vp.solo) setSolo(vp.solo);
  }

  loadModule(mTrace.body, () => api(`/api/timeseries?bucket=day&by=model&project=${encodeURIComponent(name)}`), (d) => {
    tsRows = (d.rows || []).slice().sort((a, b) => a.t - b.t);
    paintTrace();
    paintMix();
  });

  // ---- punchcard ----------------------------------------------------------------
  loadModule(mPunch.body, () => api(`/api/punchcard?project=${encodeURIComponent(name)}`), (d) => {
    const host = H('div');
    mPunch.body.appendChild(host);
    punchcard(host, d, { compact: true });
    mPunch.body.appendChild(H('div', 'pace-sub', 'MEASURE ONLY'));
  });

  // ---- model mix + tool signature --------------------------------------------------
  const toolHost = H('div');
  function paintMix() {
    if (!tsRows) return;
    mMix.body.innerHTML = '';
    const agg = new Map();
    for (const r of tsRows) {
      const cur = agg.get(r.key) || { model: r.key, out: 0, tokens: 0, cost: 0 };
      cur.out += r.outputTokens || 0;
      cur.tokens += rowTok(r);
      cur.cost += r.cost || 0;
      agg.set(r.key, cur);
    }
    const models = [...agg.values()].sort((a, b) => b.cost - a.cost);
    if (!models.length) { mMix.body.appendChild(emptyBox('SIGNAL FLAT — instrument armed, awaiting tokens.')); return; }
    const host = H('div');
    mMix.body.appendChild(host);
    mixApi = mixBar(host, models.map((m) => {
      const ch = channelOf(m.model);
      return { key: m.model, label: m.model.replace(/^claude-/, '').toUpperCase(), glyph: CH[ch].glyph, color: CH[ch].color, value: m.out, extra: [['$EQ', fmtMoney(m.cost)]] };
    }), { fmt: fmtTokens, valLabel: 'OUT TOK' });
    const table = H('table', 'mono-table');
    table.innerHTML = '<thead><tr><th>MODEL</th><th>TOK</th><th>OUT</th><th>$EQ</th></tr></thead>';
    const tbody = H('tbody');
    for (const m of models) {
      const ch = channelOf(m.model);
      const tr = H('tr', 'clickable');
      tr.innerHTML = `<td><span class="glyph" style="color:${CH[ch].color}">${CH[ch].glyph}</span> ${esc(m.model.replace(/^claude-/, ''))}</td>` +
        `<td>${esc(fmtTokens(m.tokens))}</td><td>${esc(fmtTokens(m.out))}</td><td>${esc(fmtMoney(m.cost))}</td>`;
      tr.addEventListener('click', () => setSolo(vp.solo === m.model ? null : m.model));
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    table.style.marginTop = '12px';
    mMix.body.appendChild(table);
    mMix.body.appendChild(toolHost);
    paintTools();
  }

  function paintTools() {
    toolHost.innerHTML = '';
    if (!loaded.length) return;
    const agg = new Map();
    for (const s of loaded) {
      for (const [t, c] of Object.entries(parseJSONish(s.tools))) agg.set(t, (agg.get(t) || 0) + c);
    }
    const top = [...agg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    if (!top.length) return;
    toolHost.appendChild(H('div', 'label sc-section-title', 'TOOL SIGNATURE · TOP 10'));
    toolHost.style.marginTop = '16px';
    const host = H('div');
    toolHost.appendChild(host);
    traceBarList(host, top.map(([t, c]) => ({ name: t, value: c, vals: ['×' + fmtNum(c)] })), {});
    if (loaded.length < spoolTotal) toolHost.appendChild(H('div', 'pace-sub', 'FROM LOADED SESSIONS'));
  }

  // ---- session spool ------------------------------------------------------------------
  const spoolList = H('div');
  mSpool.body.appendChild(spoolList);
  const sentinel = H('div', 'loading', 'LOADING SPOOL');
  mSpool.body.appendChild(sentinel);
  const SP = { offset: 0, loading: false, done: false, lastDay: null };

  async function loadSpool() {
    if (SP.loading || SP.done) return;
    SP.loading = true;
    try {
      const d = await api(`/api/sessions?project=${encodeURIComponent(name)}&limit=50&offset=${SP.offset}`);
      const rows = d.sessions || [];
      spoolTotal = d.total ?? spoolTotal;
      SP.offset += rows.length;
      for (const s of rows) {
        const dk = dayKeyLocal(s.last_ts);
        if (dk !== SP.lastDay) {
          SP.lastDay = dk;
          const dh = H('div', 'day-head');
          dh.style.position = 'static';
          dh.appendChild(H('span', 'dh-date', fmtDateLong(dk)));
          dh.addEventListener('click', () => openDay(dk));
          spoolList.appendChild(dh);
        }
        loaded.push(s);
        spoolList.appendChild(sessionCard(s, { noProject: true }));
      }
      if (!rows.length || SP.offset >= spoolTotal) {
        SP.done = true;
        sentinel.className = 'quiet-gap';
        sentinel.textContent = SP.offset === 0 ? 'NOTHING ON THE SPOOL — no sessions for this project.' : '· · · END OF THE SPOOL · · ·';
      }
      paintTools();
    } catch (e) {
      sentinel.className = 'errbox';
      sentinel.textContent = 'SIGNAL LOST — could not load sessions.';
      SP.done = true;
    }
    SP.loading = false;
  }
  const io = new IntersectionObserver((entries) => { if (entries.some((en) => en.isIntersecting)) loadSpool(); }, { rootMargin: '500px' });
  io.observe(sentinel);
  loadSpool();

  const handle = {
    destroy() { io.disconnect(); root._cleanup = null; collapseSession(); },
    refresh() { return renderProject(root, { ...ctx, isRefresh: true }); },
    onMetric() {
      paintTrace();
      if (benchPaint) benchPaint();
      for (const c of mSpool.body.querySelectorAll('.sc')) if (c._setRo) c._setRo();
    },
  };
  root._cleanup = () => handle.destroy();
  return handle;
}

// ============================================================================
// DAY INSPECTOR — overlay drawer (#/day/YYYY-MM-DD)
// ============================================================================

export const dayInspector = {
  isOpen: false,
  date: null,
  _popEsc: null,
  _built: false,
  _els: {},
  _seq: 0,
  _updaters: [],

  _build() {
    if (this._built) return;
    this._built = true;
    const drawer = document.getElementById('drawer');
    drawer.innerHTML = '';
    const head = H('div', 'drawer-head');
    const top = H('div', 'dh-top');
    const prev = H('button', 'key', '◀');
    prev.title = 'Previous day (←)';
    const dateWrap = H('div', 'dh-date');
    const dow = H('span', 'label dh-dow', '');
    const dateEl = H('div', 'readout-lg', '');
    dateWrap.append(dow, dateEl);
    const next = H('button', 'key', '▶');
    next.title = 'Next day (→)';
    const close = H('button', 'key', '✕');
    close.title = 'Close (Esc)';
    top.append(prev, dateWrap, next, close);
    const totals = H('div', 'dh-totals', '');
    head.append(top, totals);
    const body = H('div', 'drawer-body');
    drawer.append(head, body);
    prev.addEventListener('click', () => this.walk(-1));
    next.addEventListener('click', () => this.walk(1));
    close.addEventListener('click', () => this.requestClose());
    document.getElementById('scrim').addEventListener('click', () => this.requestClose());
    this._els = { drawer, body, dateEl, dow, totals, next };
  },

  requestClose() {
    // hand back to the router: hash returns to the underlying view
    navigate(state.baseHash || '#/pulse');
  },

  walk(n) {
    if (!this.date) return;
    const d = parseDayKey(this.date);
    d.setDate(d.getDate() + n);
    const k = dayKeyLocal(d.getTime());
    if (k > todayKey()) return;
    location.hash = '#/day/' + k;
  },

  async open(dateKey) {
    // malformed deep link (#/day/garbage) — bail to the base view, never throw
    if (!parseDayKey(dateKey)) { this.requestClose(); return; }
    this._build();
    const { drawer, body, dateEl, dow, totals, next } = this._els;
    const scrim = document.getElementById('scrim');
    const wasOpen = this.isOpen;
    this.date = dateKey;
    const seq = ++this._seq;

    if (!wasOpen) {
      this.isOpen = true;
      drawer.hidden = false;
      scrim.hidden = false;
      document.body.classList.add('drawer-open');
      requestAnimationFrame(() => { drawer.classList.add('on'); scrim.classList.add('on'); });
      this._popEsc = escStack.push(() => this.requestClose());
      drawer.focus();
    } else {
      body.classList.add('fading');
    }

    const d = parseDayKey(dateKey);
    dow.textContent = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'][d.getDay()];
    dateEl.textContent = dateKey;
    next.disabled = dateKey >= todayKey();
    next.style.opacity = next.disabled ? 0.3 : 1;
    totals.textContent = '…';

    let data;
    try {
      data = await api('/api/day?date=' + dateKey);
    } catch (e) {
      if (seq !== this._seq) return;
      body.classList.remove('fading');
      body.innerHTML = '';
      body.appendChild(H('div', 'errbox', 'SIGNAL LOST — could not load this day.'));
      return;
    }
    if (seq !== this._seq) return;
    this._renderBody(data);
  },

  _renderBody(data) {
    const { body, totals } = this._els;
    this._updaters = [];
    body.classList.remove('fading');
    body.innerHTML = '';
    const t = data.totals || {};
    const paintTotals = () => {
      totals.innerHTML = `<b>${esc(fmtTokens(t.tokens || 0))}</b> tok · <b>${esc(fmtMoney(t.cost || 0))}</b> $EQ · ` +
        `<b>${esc(fmtNum(t.sessions || 0))}</b> sessions · <b>${esc(fmtNum(t.messages || 0))}</b> messages`;
    };
    paintTotals();

    const empty = !(t.messages > 0) && !(data.sessions || []).length;
    if (empty) {
      const e = H('div', 'empty');
      e.innerHTML = 'A QUIET DAY — no recorded activity on this date.<br>Walk the calendar with ◀ ▶.';
      e.style.marginTop = '48px';
      body.appendChild(e);
      return;
    }

    let stagger = 0;
    const staggerIn = (el) => {
      if (REDUCED || stagger >= 5) return;
      el.classList.add('stagger-in');
      el.style.animationDelay = (stagger * 40) + 'ms';
      stagger += 1;
    };

    // hourly oscillogram
    const mH = module('HOURLY OSCILLOGRAM', 'span-12');
    body.appendChild(mH.el);
    staggerIn(mH.el);
    const hHost = H('div');
    mH.body.appendChild(hHost);
    const hb = hourBars(hHost, data.hours || [], { metric: state.metric, height: 120 });
    this._updaters.push(() => hb.update(state.metric));

    // project split
    const mP = module('PROJECT SPLIT', 'span-12');
    body.appendChild(mP.el);
    staggerIn(mP.el);
    const paintProjects = () => {
      mP.body.innerHTML = '';
      const projs = (data.projects || []).slice().sort((a, b) => mOf(b) - mOf(a));
      if (!projs.length) { mP.body.appendChild(emptyBox('NO PROJECTS')); return; }
      traceBarList(mP.body, projs.map((p) => ({
        name: p.project, value: mOf(p),
        vals: [fmtMetricValue(mOf(p)), `${fmtNum(p.sessions)} sess`],
      })), {
        onClick: (n) => goProject(n),
        activeName: state.currentProject || null,
      });
    };
    paintProjects();
    this._updaters.push(paintProjects);

    // model split
    const mM = module('MODEL SPLIT', 'span-12');
    body.appendChild(mM.el);
    staggerIn(mM.el);
    const paintModels = () => {
      mM.body.innerHTML = '';
      const parts = channelParts(data.models || [], 'tokens');
      if (!parts.length) { mM.body.appendChild(emptyBox('NO MODELS')); return; }
      mixBar(mM.body, parts.map((p) => ({ ...p, value: mOf(p), extra: [['TOKENS', fmtTokens(p.tokens)], ['$EQ', fmtMoney(p.cost)]] })), {
        legend: true, fmt: (v) => fmtMetricValue(v), valLabel: state.metric === 'cost' ? '$EQ' : 'TOKENS',
      });
    };
    paintModels();
    this._updaters.push(paintModels);

    // sessions (dense shared card)
    const mS = module(`SESSIONS · ${fmtNum((data.sessions || []).length)}`, 'span-12');
    body.appendChild(mS.el);
    staggerIn(mS.el);
    for (const s of data.sessions || []) {
      mS.body.appendChild(sessionCard(s, { dense: true }));
    }
  },

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this._seq++;
    collapseSession();
    const drawer = document.getElementById('drawer');
    const scrim = document.getElementById('scrim');
    drawer.classList.add('closing');
    drawer.classList.remove('on');
    scrim.classList.remove('on');
    document.body.classList.remove('drawer-open');
    if (this._popEsc) { this._popEsc(); this._popEsc = null; }
    setTimeout(() => {
      if (!this.isOpen) { drawer.hidden = true; scrim.hidden = true; drawer.classList.remove('closing'); }
    }, 220);
  },

  refresh() { if (this.isOpen && this.date) this.open(this.date); },
  onMetric() { if (this.isOpen) for (const u of this._updaters) u(); },
};
