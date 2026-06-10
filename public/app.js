// ============================================================================
// CLAUDIOGRAM — app.js
// Entry: global state, hash router, SSE client, header bezel + nav rail,
// shared formatting helpers. Vanilla ES modules, zero dependencies.
// ============================================================================

import { engine, odometer, tip } from './charts.js';
import {
  renderPulse, renderRhythm, renderCost, renderCapsule, renderProject,
  dayInspector, collapseSession,
} from './views.js';

// ---------------------------------------------------------------------------
// Global state & event bus
// ---------------------------------------------------------------------------

export const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

export const state = {
  metric: localStorage.getItem('cp-metric') === 'cost' ? 'cost' : 'tokens',
  baseHash: '#/pulse',      // last non-overlay route (drawer restores over this)
  currentViewId: null,
  currentProject: null,
  origin: null,             // {hash, scrollY, label} for project breadcrumb back
  pendingScroll: null,
  zoom: 1,                  // UI scale (CSS zoom on <html>), persisted
};

export const bus = {
  _m: new Map(),
  on(ev, fn) { (this._m.get(ev) || this._m.set(ev, new Set()).get(ev)).add(fn); },
  off(ev, fn) { const s = this._m.get(ev); if (s) s.delete(fn); },
  emit(ev, data) { const s = this._m.get(ev); if (s) for (const fn of [...s]) { try { fn(data); } catch (e) { console.error(e); } } },
};

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

export async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); if (j && j.error) msg = j.error; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return res.json();
}

let _summary = { data: null, at: 0, inflight: null };
export function getSummary(force) {
  const now = Date.now();
  if (!force && _summary.data && now - _summary.at < 15000) return Promise.resolve(_summary.data);
  if (_summary.inflight) return _summary.inflight;
  _summary.inflight = api('/api/summary').then((d) => {
    _summary = { data: d, at: Date.now(), inflight: null };
    return d;
  }).catch((e) => { _summary.inflight = null; throw e; });
  return _summary.inflight;
}

// ---------------------------------------------------------------------------
// Model channels + project ramp + pricing mirror (display math only)
// ---------------------------------------------------------------------------

export const CH = {
  fable: { color: '#FFB454', glyph: 'F', label: 'FABLE' },
  opus: { color: '#C792EA', glyph: 'O', label: 'OPUS' },
  sonnet: { color: '#4FC3E8', glyph: 'S', label: 'SONNET' },
  haiku: { color: '#93A99F', glyph: 'H', label: 'HAIKU' },
  other: { color: '#5F7066', glyph: '·', label: 'OTHER' },
};

export function channelOf(model) {
  const m = String(model || '').toLowerCase();
  if (m.includes('fable')) return 'fable';
  if (m.includes('opus')) return 'opus';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('haiku')) return 'haiku';
  return 'other';
}

export const PRJ_COLORS = ['#53FCA1', '#4FC3E8', '#FFB454', '#C792EA', '#8AE06A', '#5E8BFF', '#F2C94C'];

// Input rates (USD per 1M input tokens) — mirrors the contract pricing table.
// Used ONLY for client-side cache-savings display math; cost itself comes from the API.
const INPUT_RATES = [
  ['claude-opus-4-20250514', 15],
  ['claude-3-7-sonnet', 3], ['claude-3-5-sonnet', 3], ['claude-3-5-haiku', 0.8],
  ['claude-haiku-4-5', 1], ['claude-fable-5', 10],
  ['claude-opus-4-8', 5], ['claude-opus-4-7', 5], ['claude-opus-4-6', 5], ['claude-opus-4-5', 5],
  ['claude-opus-4-1', 15], ['claude-opus-4-2', 15], ['claude-opus-4-0', 15],
  ['claude-3-opus', 15], ['claude-3-sonnet', 3], ['claude-sonnet', 3], ['claude-3-haiku', 0.25],
].sort((a, b) => b[0].length - a[0].length);

export function inputRate(model) {
  const m = String(model || '');
  for (const [prefix, rate] of INPUT_RATES) if (m.startsWith(prefix)) return rate;
  return 5;
}

// ---------------------------------------------------------------------------
// Number / date formatting (local timezone everywhere)
// ---------------------------------------------------------------------------

function trimNum(x) {
  const s = x >= 100 ? String(Math.round(x)) : x.toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

export function fmtTokens(n) {
  n = +n || 0;
  const abs = Math.abs(n);
  if (abs >= 1e9) return trimNum(n / 1e9) + 'B';
  if (abs >= 1e6) return trimNum(n / 1e6) + 'M';
  if (abs >= 1000) return trimNum(n / 1000) + 'k';
  return String(Math.round(n));
}

export function fmtMoney(n) {
  n = +n || 0;
  if (Math.abs(n) >= 10000) return '$' + fmtTokens(n);
  if (Math.abs(n) >= 100) return '$' + Math.round(n).toLocaleString('en-US');
  return '$' + n.toFixed(2);
}

export function fmtNum(n) { return (+n || 0).toLocaleString('en-US'); }

export function fmtMetricValue(v, metric = state.metric) {
  return metric === 'cost' ? fmtMoney(v) : fmtTokens(v);
}
export function metricUnit(metric = state.metric) {
  return metric === 'cost' ? 'API-EQ' : 'tok';
}

export function dayKeyLocal(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function parseDayKey(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3]);
}
export function todayKey() { return dayKeyLocal(Date.now()); }

export function fmtTime(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
export function fmtClock(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}
export function fmtDur(ms) {
  ms = Math.max(0, +ms || 0);
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}
const DOW_SHORT = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
export function fmtDateLong(key) {
  const d = parseDayKey(key);
  return d ? `${DOW_SHORT[d.getDay()]} ${key}` : String(key);
}
export function monthLabel(mKey) {
  const [y, m] = String(mKey).split('-');
  const names = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];
  return `${names[+m - 1]} ${y}`;
}

// ---------------------------------------------------------------------------
// ESC stack — session accordion → drawer → route (LIFO)
// ---------------------------------------------------------------------------

export const escStack = {
  _stack: [],
  push(fn) {
    const entry = { fn };
    this._stack.push(entry);
    return () => { const i = this._stack.indexOf(entry); if (i >= 0) this._stack.splice(i, 1); };
  },
  pop() {
    const entry = this._stack[this._stack.length - 1];
    if (!entry) return false;
    entry.fn(); // handlers unregister themselves
    return true;
  },
};

// ---------------------------------------------------------------------------
// Navigation helpers
// ---------------------------------------------------------------------------

const VIEW_LABELS = { pulse: 'F1 PULSE', rhythm: 'F2 RHYTHM', cost: 'F3 COST', capsule: 'F4 CAPSULE', project: 'PROJECT' };

export function navigate(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

export function openDay(dateKey) {
  if (!location.hash.startsWith('#/day/')) state.baseHash = location.hash || '#/pulse';
  location.hash = '#/day/' + dateKey;
}

export function goProject(name) {
  if (state.currentViewId !== 'project') {
    state.origin = {
      hash: state.baseHash || '#/pulse',
      scrollY: scrollY,
      label: VIEW_LABELS[state.currentViewId] || 'F1 PULSE',
    };
  }
  location.hash = '#/project/' + encodeURIComponent(name);
}

export function goBack() {
  const o = state.origin;
  state.origin = null;
  state.pendingScroll = o ? o.scrollY : null;
  navigate(o ? o.hash : '#/pulse');
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const VIEWS = {
  pulse: renderPulse,
  rhythm: renderRhythm,
  cost: renderCost,
  capsule: renderCapsule,
  project: renderProject,
};

let currentHandle = null;
let currentKey = null; // viewId + params signature
let routeSeq = 0;

function parseHash() {
  const raw = location.hash || '#/pulse';
  const [pathPart, queryPart] = raw.replace(/^#\/?/, '').split('?');
  const segs = pathPart.split('/').filter(Boolean);
  const q = new URLSearchParams(queryPart || '');
  const id = segs[0] || 'pulse';
  if (id === 'day' && segs[1]) return { overlay: 'day', date: segs[1] };
  if (id === 'project' && segs[1]) return { view: 'project', name: decodeURIComponent(segs[1]) };
  if (id === 'session' && segs[1]) return { view: 'capsule', session: segs[1] };
  if (id === 'capsule') return { view: 'capsule', month: segs[1] || null, from: q.get('from'), to: q.get('to') };
  // 'project' without a name segment must not hit the generic fallback —
  // it would render a junk view querying ?project=undefined
  if (VIEWS[id] && id !== 'project') return { view: id };
  return { view: 'pulse' };
}

function setRail(activeId) {
  document.querySelectorAll('#rail .fkey[data-view]').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === activeId);
  });
  const prj = document.getElementById('prjKey');
  if (activeId === 'project' && state.currentProject) {
    prj.hidden = false;
    prj.classList.add('active');
    prj.querySelector('.prj-letter').textContent = (state.currentProject[0] || 'P').toUpperCase();
    prj.title = state.currentProject;
  } else {
    prj.hidden = true;
    prj.classList.remove('active');
  }
}

function setCrumb(show) {
  const crumb = document.getElementById('crumb');
  document.body.classList.toggle('has-crumb', !!show);
  crumb.hidden = !show;
  if (!show) { crumb.innerHTML = ''; return; }
  crumb.innerHTML = '';
  const back = document.createElement('button');
  back.textContent = `◀ ${state.origin ? state.origin.label : 'F1 PULSE'}`;
  back.addEventListener('click', goBack);
  const sep = document.createElement('span');
  sep.className = 'crumb-sep';
  sep.textContent = '/';
  const here = document.createElement('span');
  here.className = 'crumb-here';
  here.textContent = state.currentProject || '';
  crumb.append(back, sep, here);
}

function renderView(id, params = {}) {
  const seq = ++routeSeq;
  const root = document.getElementById('view');
  if (currentHandle && currentHandle.destroy) { try { currentHandle.destroy(); } catch (e) { console.error(e); } }
  collapseSession();
  tip.hide();
  state.currentViewId = id;
  state.currentProject = id === 'project' ? params.name : null;
  setRail(id);
  setCrumb(id === 'project');
  currentHandle = VIEWS[id](root, params) || null;
  if (seq !== routeSeq) return;
  if (state.pendingScroll != null) {
    const y = state.pendingScroll;
    state.pendingScroll = null;
    // async modules fill in after render — keep nudging until the target holds
    const start = performance.now();
    (function attempt() {
      if (seq !== routeSeq) return;
      scrollTo(0, y);
      if (Math.abs(scrollY - y) < 4 || performance.now() - start > 1500) return;
      requestAnimationFrame(attempt);
    })();
  } else if (!params.keepScroll) {
    scrollTo(0, 0);
  }
}

function route() {
  const p = parseHash();
  if (p.overlay === 'day') {
    if (!state.currentViewId) {
      // fresh load straight onto a day link — render the base view underneath
      const baseHash = state.baseHash && !state.baseHash.startsWith('#/day/') ? state.baseHash : '#/pulse';
      const baseId = (() => {
        const seg = baseHash.replace(/^#\//, '').split('/')[0];
        return VIEWS[seg] && seg !== 'project' ? seg : 'pulse';
      })();
      renderView(baseId, {});
      currentKey = JSON.stringify({ view: baseId });
      state.baseHash = '#/' + baseId;
    }
    dayInspector.open(p.date);
    return;
  }
  if (dayInspector.isOpen) dayInspector.close();

  const key = JSON.stringify(p);
  const hash = location.hash || '#/pulse';
  state.baseHash = hash;
  if (key === currentKey && p.view !== 'capsule') return; // no-op re-route
  if (key === currentKey && p.view === 'capsule' && !p.month && !p.session && !p.from) return;
  currentKey = key;
  renderView(p.view, p);
}

// ---------------------------------------------------------------------------
// SSE client — auto-reconnect, LED states, pulse/refresh dispatch
// ---------------------------------------------------------------------------

let es = null;
let sseRetries = 0;
let sseTimer = 0;

function setLed(stateName, title) {
  const led = document.getElementById('led');
  led.className = 'led led-' + stateName;
  led.title = title || {
    live: 'SSE CONNECTED — live pulse flowing',
    connecting: 'CONNECTING…',
    reconnecting: 'RECONNECTING — stand by',
    dead: 'LINK DEAD — click to force reconnect',
  }[stateName] || stateName.toUpperCase();
}

function connectSSE() {
  clearTimeout(sseTimer);
  if (es) { try { es.close(); } catch { /* ignore */ } }
  setLed('connecting');
  es = new EventSource('/api/events');
  es.onopen = () => { sseRetries = 0; setLed('live'); };
  es.onmessage = (e) => {
    let d;
    try { d = JSON.parse(e.data); } catch { return; }
    if (d.type === 'pulse') {
      engine.pulse(d);
      bumpToday(d);
      bus.emit('pulse', d);
    } else if (d.type === 'refresh') {
      scheduleRefresh();
    }
  };
  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED) {
      sseRetries += 1;
      if (sseRetries > 6) { setLed('dead'); return; }
      setLed('reconnecting');
      sseTimer = setTimeout(connectSSE, Math.min(15000, 800 * 2 ** sseRetries));
    } else {
      setLed('reconnecting');
    }
  };
}

let refreshTimer = 0;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    getSummary(true).then(updateHeaderFromSummary).catch(() => {});
    if (currentHandle && currentHandle.refresh) {
      try {
        const nh = currentHandle.refresh();
        if (nh && nh.destroy) currentHandle = nh; // view re-rendered itself
      } catch (e) { console.error(e); }
    }
    if (dayInspector.isOpen) dayInspector.refresh();
    bus.emit('refresh');
  }, 1200);
}

// ---------------------------------------------------------------------------
// Header bezel: LED, dateline, mini-trace, today counter, metric latch
// ---------------------------------------------------------------------------

const hdrToday = { tokens: 0, cost: 0 };

function paintHeaderCounter() {
  const el = document.getElementById('hdrToday');
  const unit = document.getElementById('hdrTodayUnit');
  odometer(el, fmtMetricValue(state.metric === 'cost' ? hdrToday.cost : hdrToday.tokens));
  unit.textContent = metricUnit();
}

function bumpToday(ev) {
  hdrToday.tokens += (ev.in || 0) + (ev.out || 0);
  hdrToday.cost += ev.cost || 0;
  paintHeaderCounter();
}

function updateHeaderFromSummary(s) {
  hdrToday.tokens = s.today.tokens || 0;
  hdrToday.cost = s.today.cost || 0;
  paintHeaderCounter();
  const dl = document.getElementById('dateline');
  if (s.totals.firstTs) {
    const days = Math.max(1, Math.floor((Date.now() - s.totals.firstTs) / 86400000) + 1);
    dl.textContent = `DAY ${days} ON AIR`;
  } else {
    dl.textContent = 'AWAITING FIRST SIGNAL';
  }
}

function setMetric(metric) {
  if (state.metric === metric) return;
  state.metric = metric;
  localStorage.setItem('cp-metric', metric);
  document.getElementById('latch').setAttribute('aria-checked', metric === 'cost' ? 'true' : 'false');
  paintHeaderCounter();
  engine.requestStatic();
  bus.emit('metric', metric);
  if (currentHandle && currentHandle.onMetric) { try { currentHandle.onMetric(); } catch (e) { console.error(e); } }
  if (dayInspector.isOpen) dayInspector.onMetric();
}

function initHeader() {
  const latch = document.getElementById('latch');
  latch.setAttribute('aria-checked', state.metric === 'cost' ? 'true' : 'false');
  latch.addEventListener('click', () => setMetric(state.metric === 'cost' ? 'tokens' : 'cost'));
  latch.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); latch.click(); }
  });
  document.getElementById('led').addEventListener('click', () => { sseRetries = 0; connectSSE(); });
  document.getElementById('miniWrap').addEventListener('click', () => navigate('#/pulse'));
  paintHeaderCounter();
}

function initRail() {
  document.querySelectorAll('#rail .fkey[data-view]').forEach((b) => {
    b.addEventListener('click', () => navigate('#/' + b.dataset.view));
  });
}

// ---------------------------------------------------------------------------
// UI scale — CSS zoom on <html>, persisted; keyboard only (− / = step, 0 reset).
// Charts re-fit via 'cp-refit' (layout widths change while innerWidth doesn't,
// so the plain resize path won't catch it).
// ---------------------------------------------------------------------------

const ZOOM_MIN = 0.6, ZOOM_MAX = 1.4, ZOOM_STEP = 0.1;

function applyZoom(z, save = true) {
  z = Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z)) * 100) / 100;
  if (z === state.zoom && save) return;
  state.zoom = z;
  document.documentElement.style.zoom = z === 1 ? '' : String(z);
  document.documentElement.style.setProperty('--z', z);
  if (save) localStorage.setItem('cp-ui-zoom', String(z));
  dispatchEvent(new Event('cp-refit'));
}

function initZoom() {
  const saved = parseFloat(localStorage.getItem('cp-ui-zoom'));
  applyZoom(Number.isFinite(saved) ? saved : 1, false);
}

// ---------------------------------------------------------------------------
// Nav rail collapse — icons-only by default, expandable; persisted
// ---------------------------------------------------------------------------

function initRailToggle() {
  const btn = document.getElementById('railToggle');
  const apply = (expanded, save = true) => {
    document.body.classList.toggle('rail-x', expanded);
    btn.title = expanded ? 'Collapse panel' : 'Expand panel';
    btn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    if (save) localStorage.setItem('cp-rail-x', expanded ? '1' : '0');
    dispatchEvent(new Event('cp-refit')); // content width changed — re-fit charts
  };
  apply(localStorage.getItem('cp-rail-x') === '1', false);
  btn.addEventListener('click', () => apply(!document.body.classList.contains('rail-x')));
}

// ---------------------------------------------------------------------------
// Keyboard — 1-4 views, m latch, Esc layers, arrows in drawer
// ---------------------------------------------------------------------------

function initKeyboard() {
  addEventListener('keydown', (e) => {
    const tag = (e.target && e.target.tagName) || '';
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target && e.target.isContentEditable);
    if (e.key === 'Escape') {
      if (escStack.pop()) { e.preventDefault(); return; }
      if (state.currentViewId === 'project') { goBack(); e.preventDefault(); }
      return;
    }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key >= '1' && e.key <= '4') {
      navigate('#/' + ['pulse', 'rhythm', 'cost', 'capsule'][+e.key - 1]);
      e.preventDefault();
    } else if (e.key === 'm' || e.key === 'M') {
      setMetric(state.metric === 'cost' ? 'tokens' : 'cost');
      e.preventDefault();
    } else if (e.key === '-' || e.key === '_') {
      applyZoom(state.zoom - ZOOM_STEP);
      e.preventDefault();
    } else if (e.key === '=' || e.key === '+') {
      applyZoom(state.zoom + ZOOM_STEP);
      e.preventDefault();
    } else if (e.key === '0') {
      applyZoom(1);
      e.preventDefault();
    } else if (dayInspector.isOpen && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      dayInspector.walk(e.key === 'ArrowLeft' ? -1 : 1);
      e.preventDefault();
    }
  });
}

// ---------------------------------------------------------------------------
// Resize — re-fit canvases; re-render current view on real width changes
// ---------------------------------------------------------------------------

function initResize() {
  let lastW = innerWidth;
  let t = 0;
  const refreshView = () => {
    if (currentHandle && currentHandle.refresh) {
      try {
        const nh = currentHandle.refresh();
        if (nh && nh.destroy) currentHandle = nh;
      } catch (e) { console.error(e); }
    }
  };
  addEventListener('resize', () => {
    clearTimeout(t);
    t = setTimeout(() => {
      engine.resize();
      if (Math.abs(innerWidth - lastW) > 60) {
        lastW = innerWidth;
        refreshView();
      }
    }, 250);
  });
  addEventListener('cp-refit', () => {
    clearTimeout(t);
    t = setTimeout(() => {
      engine.resize();
      lastW = innerWidth;
      refreshView();
    }, 200);
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function boot() {
  initZoom();
  initRailToggle();
  initHeader();
  initRail();
  initKeyboard();
  initResize();
  connectSSE();

  // header mini-trace shares the hero engine & buffer — never a second loop
  const mini = document.getElementById('miniTrace');
  engine.attach(mini, { mini: true });

  api('/api/live')
    .then((d) => engine.seed(d.minutes || []))
    .catch(() => engine.seed([]));

  getSummary().then(updateHeaderFromSummary).catch(() => {
    document.getElementById('dateline').textContent = 'BACKEND UNREACHABLE';
  });

  addEventListener('hashchange', route);
  route();
}

boot();
