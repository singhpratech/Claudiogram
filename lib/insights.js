// lib/insights.js — headless `claude -p` story generation + caching.
// Shells out to the user's Claude Code subscription; caches in the insights table.

import os from 'node:os';
import { execFile } from 'node:child_process';
import * as db from './db.js';

const TIMEOUT_MS = 120000;
const MAX_BUFFER = 10 * 1024 * 1024;

/**
 * Compact stats digest for a period: totals, top 5 projects, top 8 sessions
 * (first_prompt + tokens), punchcard peak hours, model mix.
 */
export function buildDigest(from, to) {
  const totals = db.rangeTotals(from, to);
  const pc = db.punchcard({ from, to });
  const peakHours = pc.hours
    .map((tokens, hour) => ({ hour, tokens }))
    .filter((h) => h.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 3);
  const peakDays = pc.days
    .map((tokens, i) => ({ day: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][i], tokens }))
    .filter((d) => d.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 3);

  return {
    period: { from: from ?? null, to: to ?? null },
    totals: {
      tokens: totals.tokens,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      cacheReadTokens: totals.cacheReadTokens,
      cacheWriteTokens: totals.cacheWriteTokens,
      apiEquivalentCostUSD: Number(totals.cost.toFixed(2)),
      cacheSavingsUSD: Number(totals.cacheSavings.toFixed(2)),
      sessions: totals.sessions,
      projects: totals.projects,
      messages: totals.messages,
      activeDays: totals.activeDays,
      firstTs: totals.firstTs,
      lastTs: totals.lastTs,
    },
    topProjects: db.topProjects(from, to, 5).map((p) => ({
      project: p.project,
      tokens: p.tokens,
      costUSD: Number(p.cost.toFixed(2)),
      sessions: p.sessions,
    })),
    topSessions: db.topSessions(from, to, 8).map((s) => ({
      project: s.project,
      firstPrompt: s.first_prompt,
      tokens: s.tokens,
      startedAt: s.first_ts ? new Date(s.first_ts).toISOString() : null,
    })),
    rhythm: { peakHoursLocal: peakHours, peakDays },
    modelMix: db.modelMix(from, to).map((m) => ({
      model: m.model,
      msgs: m.msgs,
      outputTokens: m.outputTokens,
      costUSD: Number(m.cost.toFixed(2)),
    })),
  };
}

/** Run `claude -p <prompt>` headlessly. Resolves to the story text. */
export function generateStory(digest, label) {
  const prompt =
    `You are narrating a developer's Claude Code usage history for the period "${label}". ` +
    `Write a vivid, warm, specific ~250-word story of this period: what they built, ` +
    `when they grinded, notable bursts, cache wins. Use the data; do not invent. ` +
    `End with one playful insight.\nDATA:\n${JSON.stringify(digest)}`;

  return new Promise((resolve, reject) => {
    execFile(
      'claude',
      ['-p', prompt],
      { timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER, cwd: os.tmpdir() },
      (err, stdout) => {
        if (err) {
          if (err.code === 'ENOENT') {
            const e = new Error('claude CLI not found');
            e.code = 'ENOENT';
            return reject(e);
          }
          if (err.killed || err.signal === 'SIGTERM') {
            const e = new Error('story generation timed out');
            e.code = 'TIMEOUT';
            return reject(e);
          }
          return reject(new Error(`claude -p failed: ${err.message}`));
        }
        const story = String(stdout).trim();
        if (!story) return reject(new Error('claude -p returned empty output'));
        resolve(story);
      },
    );
  });
}

/**
 * Story for a period, cached in the insights table keyed by `label:from:to`.
 * Returns { story, cached }.
 */
export async function getStory({ from, to, label = 'period' } = {}) {
  const key = `${label}:${from ?? ''}:${to ?? ''}`;
  const hit = db.insightGet(key);
  if (hit && hit.story) return { story: hit.story, cached: true };

  const digest = buildDigest(from, to);
  const story = await generateStory(digest, label);
  db.insightSet(key, story);
  return { story, cached: false };
}
