// lib/pricing.js — model pricing table + cost helpers (contract: "Pricing" section).
// USD per 1M tokens; longest-prefix match on the model string.

const TABLE = [
  ['claude-fable-5', 10, 50],
  ['claude-opus-4-8', 5, 25],
  ['claude-opus-4-7', 5, 25],
  ['claude-opus-4-6', 5, 25],
  ['claude-opus-4-5', 5, 25],
  ['claude-opus-4-1', 15, 75],
  ['claude-opus-4-2', 15, 75],
  ['claude-opus-4-0', 15, 75],
  ['claude-opus-4-20250514', 15, 75],
  ['claude-3-opus', 15, 75],
  ['claude-sonnet', 3, 15],
  ['claude-3-7-sonnet', 3, 15],
  ['claude-3-5-sonnet', 3, 15],
  ['claude-3-sonnet', 3, 15],
  ['claude-haiku-4-5', 1, 5],
  ['claude-3-5-haiku', 0.8, 4],
  ['claude-3-haiku', 0.25, 1.25],
  // Longest prefix wins:
].sort((a, b) => b[0].length - a[0].length);

const FALLBACK = { input: 5, output: 25 };

// Cache pricing relative to the model's INPUT rate.
export const CACHE_READ_MULT = 0.1;
export const CACHE_W5M_MULT = 1.25;
export const CACHE_W1H_MULT = 2;

/** Longest-prefix match → {input, output} USD per 1M tokens. */
export function rateFor(model) {
  if (typeof model === 'string') {
    for (const [prefix, input, output] of TABLE) {
      if (model.startsWith(prefix)) return { input, output };
    }
  }
  return FALLBACK;
}

// Transcript lines are untrusted input: coerce every count to a safe
// non-negative integer so strings/booleans/objects/NaN/negatives can never
// reach SQL binding or session aggregation arithmetic.
const count = (v) => {
  if (typeof v !== 'number' && typeof v !== 'string') return 0; // true → 1 is a JS trap
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.trunc(n), Number.MAX_SAFE_INTEGER) : 0;
};

/**
 * Normalize a raw JSONL `message.usage` object into flat token counts.
 * `cache_creation` breakdown may be missing on old lines — fall back to
 * `cache_creation_input_tokens` treated as 5m.
 */
export function normalizeUsage(u = {}) {
  const cc = u.cache_creation;
  let cacheW5m = 0;
  let cacheW1h = 0;
  if (cc && typeof cc === 'object') {
    cacheW5m = count(cc.ephemeral_5m_input_tokens);
    cacheW1h = count(cc.ephemeral_1h_input_tokens);
  }
  // A present-but-empty breakdown counts as missing — otherwise non-zero
  // top-level cache_creation_input_tokens would be silently dropped.
  if (cacheW5m + cacheW1h === 0) {
    cacheW5m = count(u.cache_creation_input_tokens);
  }
  return {
    input: count(u.input_tokens),
    output: count(u.output_tokens),
    cacheRead: count(u.cache_read_input_tokens),
    cacheW5m,
    cacheW1h,
  };
}

/** Cost in USD for already-normalized token counts. */
export function costForTokens(model, { input = 0, output = 0, cacheRead = 0, cacheW5m = 0, cacheW1h = 0 } = {}) {
  const r = rateFor(model);
  return (
    (input / 1e6) * r.input +
    (output / 1e6) * r.output +
    (cacheRead / 1e6) * r.input * CACHE_READ_MULT +
    (cacheW5m / 1e6) * r.input * CACHE_W5M_MULT +
    (cacheW1h / 1e6) * r.input * CACHE_W1H_MULT
  );
}

/** Cost in USD for a raw JSONL `message.usage` object. */
export function costFor(model, usage) {
  return costForTokens(model, normalizeUsage(usage));
}

/**
 * What the cache-read tokens would have cost uncached minus what they cost:
 * cacheRead × (1.0 − 0.1) × input rate.
 */
export function cacheSavings(model, cacheReadTokens) {
  const r = rateFor(model);
  return ((cacheReadTokens || 0) / 1e6) * r.input * (1 - CACHE_READ_MULT);
}
