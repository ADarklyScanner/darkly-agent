/**
 * apps/lottery.js — the lottery analysis app, as a side app of this agent.
 *
 * Ported from the shipped Android app (the one titled "Make Informed
 * Decisions", whose contents are the full lottery analyzer rather than a
 * general decision tool). It reads draw history from the same backend the
 * app uses — https://www.drawanalytics.com/api/v1 — and computes the same
 * family of statistics locally:
 *
 *   GET /states
 *   GET /{state}/games
 *   GET /{state}/{game}/results?start_date=&limit=&offset=
 *
 * WHAT THE NUMBERS ARE, AND ARE NOT
 *
 * Everything here is descriptive statistics of draws that already
 * happened: how often each number came up, how long since it last did,
 * which pairs recur, how sums are distributed. Those are real facts about
 * the historical record and genuinely interesting to look at.
 *
 * They are not predictive, and this module says so in its own output
 * rather than leaving the caller to infer it. Draws are independent
 * events with fixed probabilities: a "cold" number is not due, a "hot"
 * number is not running, and no weighting of past frequencies changes the
 * chance of any future combination. The honest framing is the same one
 * this codebase applies to its trading backtests and its driving scores —
 * a description of one historical sample is not a forecast.
 *
 * That is stated plainly and once, in a `basis` field on every analysis,
 * so the agent relaying it cannot accidentally present frequency history
 * as an edge.
 */

import { registerApp } from "./registry.js";

export const API_BASE = "https://www.drawanalytics.com/api/v1";

let _fetchImpl = null;
/** Test seam: swap the transport without needing a live network. */
export function _setFetchForTests(fn) {
  _fetchImpl = fn;
}
function theFetch() {
  return _fetchImpl || globalThis.fetch;
}

const BASIS =
  "Descriptive statistics of past draws only. Lottery draws are independent with fixed odds: a number being 'cold' does not make it due, 'hot' does not make it likely, and no frequency weighting improves the chance of any combination. This describes history; it does not forecast.";

async function api(path, { timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await theFetch()(`${API_BASE}${path}`, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: controller.signal
    });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === "AbortError") throw new Error(`The lottery service timed out after ${timeoutMs}ms.`);
    throw new Error(`Could not reach the lottery service: ${e.message}`);
  }
  clearTimeout(timer);

  if (!res.ok) throw new Error(`The lottery service returned HTTP ${res.status}.`);

  let json;
  try {
    json = await res.json();
  } catch (e) {
    throw new Error("The lottery service returned malformed data.");
  }
  return json;
}

/** Slugify a state name the way the app's own stateKey() does. */
export function stateKey(state) {
  return String(state).trim().toLowerCase().replace(/\s+/g, "-");
}

export async function listStates() {
  const j = await api("/states");
  if (!Array.isArray(j.data)) throw new Error("The lottery service returned an unexpected shape for /states.");
  return j.data;
}

export async function listGames(state) {
  if (!state) throw new Error("`state` is required.");
  const j = await api(`/${encodeURIComponent(stateKey(state))}/games`);
  if (!Array.isArray(j.data)) throw new Error("The lottery service returned an unexpected shape for /games.");
  return j.data;
}

/**
 * Fetch draw results, following the backend's offset pagination.
 *
 * Bounded on purpose: `maxDraws` caps how much history is pulled so one
 * call cannot walk a century of draws, and a page that returns nothing
 * ends the loop rather than spinning.
 */
export async function fetchResults(state, game, { startDate = "1900-01-01", maxDraws = 500, pageSize = 100 } = {}) {
  if (!state || !game) throw new Error("`state` and `game` are both required.");

  const rows = [];
  const seen = new Set();
  let offset = 0;

  // Hard iteration ceiling in addition to every other exit condition.
  // This loop runs in the same process as the autotrader scheduler, so a
  // backend that misbehaves must cost a bounded number of requests, not
  // the whole service.
  const maxPages = Math.ceil(maxDraws / Math.max(1, pageSize)) + 5;

  for (let page_i = 0; page_i < maxPages && rows.length < maxDraws; page_i++) {
    const limit = Math.min(pageSize, maxDraws - rows.length);
    const j = await api(
      `/${encodeURIComponent(stateKey(state))}/${encodeURIComponent(game)}/results` +
        `?start_date=${encodeURIComponent(startDate)}&limit=${limit}&offset=${offset}`
    );
    const page = Array.isArray(j.data) ? j.data : [];
    if (page.length === 0) break;

    let addedThisPage = 0;
    for (const row of page) {
      const id = JSON.stringify([row.draw_date || row.date, row.numbers || row.winning_numbers]);
      if (seen.has(id)) continue;
      seen.add(id);
      rows.push(row);
      addedThisPage++;
    }

    // A full page that contributed nothing new means the cursor is not
    // advancing — a cached response, an ignored offset, or a backend
    // repeating itself. Without this the loop would request forever,
    // since `rows.length` can never reach maxDraws. Found by a test whose
    // stub ignored `limit`, which is exactly how a real API misbehaves.
    if (addedThisPage === 0) break;

    if (page.length < limit) break;
    offset += page.length;
  }

  return rows;
}

/* ------------------------------------------------------------------ *
 * Normalization
 * ------------------------------------------------------------------ */

/**
 * Backends disagree about field names, and a silent mis-read here would
 * produce statistics over the wrong numbers while looking perfectly
 * healthy. So each draw is normalized explicitly and anything
 * unparseable is dropped and counted rather than coerced.
 */
export function normalizeDraws(rows) {
  const draws = [];
  let skipped = 0;

  for (const row of rows || []) {
    const date = row.draw_date || row.date || row.drawDate || null;

    let numbers = row.numbers ?? row.winning_numbers ?? row.main_numbers ?? row.balls ?? null;
    if (typeof numbers === "string") numbers = numbers.split(/[\s,;-]+/);
    if (!Array.isArray(numbers)) {
      skipped++;
      continue;
    }

    const main = numbers.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0);
    if (main.length === 0) {
      skipped++;
      continue;
    }

    let bonusRaw = row.bonus ?? row.bonus_ball ?? row.powerball ?? row.mega_ball ?? row.special ?? null;
    if (Array.isArray(bonusRaw)) bonusRaw = bonusRaw[0];
    const bonus = Number.isInteger(Number(bonusRaw)) && Number(bonusRaw) > 0 ? Number(bonusRaw) : null;

    draws.push({ date, main, bonus });
  }

  // Newest first is how the app presents history.
  draws.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
  return { draws, skipped };
}

/* ------------------------------------------------------------------ *
 * Analytics
 * ------------------------------------------------------------------ */

function countFrequencies(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  return counts;
}

function sortedCounts(counts) {
  return [...counts.entries()]
    .map(([number, count]) => ({ number, count }))
    .sort((a, b) => b.count - a.count || a.number - b.number);
}

/** How often each number has appeared, plus the hottest and coldest. */
export function frequency(draws, { top = 10 } = {}) {
  const mainCounts = countFrequencies(draws.flatMap((d) => d.main));
  const bonusCounts = countFrequencies(draws.map((d) => d.bonus).filter((b) => b !== null));

  const main = sortedCounts(mainCounts);
  const bonus = sortedCounts(bonusCounts);

  return {
    drawsAnalyzed: draws.length,
    main,
    bonus: bonus.length ? bonus : undefined,
    hottest: main.slice(0, top),
    coldest: [...main].reverse().slice(0, top),
    basis: BASIS
  };
}

/**
 * Draws since each number last appeared.
 *
 * A number that has never appeared in the window is reported as such
 * rather than given a gap of 0 (which would read as "just drawn") or of
 * `draws.length` (which would read as a real observation). The
 * distinction matters because "never seen in 500 draws" and "seen 500
 * draws ago" are different facts.
 */
export function gaps(draws, { top = 10, maxNumber } = {}) {
  const lastSeen = new Map();
  draws.forEach((d, index) => {
    for (const n of d.main) {
      if (!lastSeen.has(n)) lastSeen.set(n, index); // draws are newest-first
    }
  });

  const highest = maxNumber || Math.max(0, ...draws.flatMap((d) => d.main));
  const entries = [];
  for (let n = 1; n <= highest; n++) {
    if (lastSeen.has(n)) entries.push({ number: n, drawsSince: lastSeen.get(n), neverSeen: false });
    else entries.push({ number: n, drawsSince: null, neverSeen: true });
  }

  const seen = entries.filter((e) => !e.neverSeen).sort((a, b) => b.drawsSince - a.drawsSince);
  const never = entries.filter((e) => e.neverSeen);

  return {
    drawsAnalyzed: draws.length,
    longestGaps: seen.slice(0, top),
    neverSeenInWindow: never.map((e) => e.number),
    all: entries,
    basis: BASIS,
    overdueWarning:
      "A long gap does not make a number due. Each draw is independent, so a number absent for 200 draws has exactly the same chance next time as one drawn yesterday."
  };
}

/** Odd/even and high/low splits, and the distribution of draw sums. */
export function shapeStats(draws) {
  if (draws.length === 0) return { drawsAnalyzed: 0, basis: BASIS };

  const highest = Math.max(...draws.flatMap((d) => d.main));
  const midpoint = highest / 2;

  const oddEven = new Map();
  const highLow = new Map();
  const sums = [];
  let consecutivePairs = 0;
  let drawsWithConsecutive = 0;

  for (const d of draws) {
    const odd = d.main.filter((n) => n % 2 === 1).length;
    const key = `${odd} odd / ${d.main.length - odd} even`;
    oddEven.set(key, (oddEven.get(key) || 0) + 1);

    const high = d.main.filter((n) => n > midpoint).length;
    const hkey = `${high} high / ${d.main.length - high} low`;
    highLow.set(hkey, (highLow.get(hkey) || 0) + 1);

    sums.push(d.main.reduce((a, b) => a + b, 0));

    const sorted = [...d.main].sort((a, b) => a - b);
    let hasConsecutive = false;
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] === sorted[i - 1] + 1) {
        consecutivePairs++;
        hasConsecutive = true;
      }
    }
    if (hasConsecutive) drawsWithConsecutive++;
  }

  sums.sort((a, b) => a - b);
  const mean = sums.reduce((a, b) => a + b, 0) / sums.length;

  return {
    drawsAnalyzed: draws.length,
    oddEven: [...oddEven.entries()].map(([split, count]) => ({ split, count })).sort((a, b) => b.count - a.count),
    highLow: [...highLow.entries()].map(([split, count]) => ({ split, count })).sort((a, b) => b.count - a.count),
    sum: {
      min: sums[0],
      max: sums[sums.length - 1],
      mean: Number(mean.toFixed(2)),
      median: sums[Math.floor(sums.length / 2)]
    },
    consecutive: {
      drawsContainingConsecutivePair: drawsWithConsecutive,
      shareOfDraws: Number((drawsWithConsecutive / draws.length).toFixed(4)),
      totalConsecutivePairs: consecutivePairs
    },
    basis: BASIS
  };
}

/** The number pairs that have co-occurred most often. */
export function pairStats(draws, { top = 15 } = {}) {
  const counts = new Map();
  for (const d of draws) {
    const sorted = [...new Set(d.main)].sort((a, b) => a - b);
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const key = `${sorted[i]}-${sorted[j]}`;
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    }
  }

  const pairs = [...counts.entries()]
    .map(([pair, count]) => ({ pair, count }))
    .sort((a, b) => b.count - a.count || a.pair.localeCompare(b.pair))
    .slice(0, top);

  return {
    drawsAnalyzed: draws.length,
    topPairs: pairs,
    basis: BASIS,
    note:
      "With this many possible pairs, some will lead the table by chance alone. A pair appearing most often in a sample is not evidence that it recurs."
  };
}

/** How often numbers repeat from the immediately previous draw. */
export function repeatStats(draws) {
  if (draws.length < 2) return { drawsAnalyzed: draws.length, basis: BASIS, note: "Needs at least two draws." };

  let comparisons = 0;
  let totalRepeats = 0;
  let drawsWithRepeat = 0;

  // Draws are newest-first, so draw[i] follows draw[i+1] chronologically.
  for (let i = 0; i < draws.length - 1; i++) {
    const current = new Set(draws[i].main);
    const previous = new Set(draws[i + 1].main);
    let repeats = 0;
    for (const n of current) if (previous.has(n)) repeats++;
    comparisons++;
    totalRepeats += repeats;
    if (repeats > 0) drawsWithRepeat++;
  }

  return {
    drawsAnalyzed: draws.length,
    comparisons,
    drawsWithAtLeastOneRepeat: drawsWithRepeat,
    shareWithRepeat: Number((drawsWithRepeat / comparisons).toFixed(4)),
    averageRepeatsPerDraw: Number((totalRepeats / comparisons).toFixed(3)),
    basis: BASIS
  };
}

/** Everything at once, for one game. */
export function analyzeAll(draws, options = {}) {
  return {
    frequency: frequency(draws, options),
    gaps: gaps(draws, options),
    shape: shapeStats(draws),
    pairs: pairStats(draws, options),
    repeats: repeatStats(draws),
    basis: BASIS
  };
}

/* ------------------------------------------------------------------ *
 * Registration
 * ------------------------------------------------------------------ */

/**
 * Signals this app contributes to the cross-app view.
 *
 * Only facts with a date: draw days for games the caller says they
 * follow, and a jackpot figure when the CALLER supplies a researched one.
 * This app does not invent jackpot amounts — the backend it reads exposes
 * draw history, not prize pools, so a jackpot number must come from the
 * agent actually looking it up. Missing is reported as missing.
 */
export function lotterySignals(context = {}) {
  const watch = Array.isArray(context.lotteryWatch) ? context.lotteryWatch : [];
  const signals = [];

  for (const w of watch) {
    if (!w || !w.date) continue;
    signals.push({
      date: w.date,
      kind: w.jackpot ? "draw_day_with_jackpot" : "draw_day",
      detail: [w.game, w.state ? `(${w.state})` : null, w.jackpot ? `advertised jackpot ${w.jackpot}` : null]
        .filter(Boolean)
        .join(" "),
      value: w.jackpot || undefined
    });
  }

  return signals;
}

export function registerLotteryApp() {
  return registerApp({
    id: "lottery",
    name: "Lottery Analysis",
    domain: "Historical lottery draw statistics by state and game",
    description:
      "Reads draw history from drawanalytics.com and computes frequency, gaps, pair, shape and repeat statistics. Descriptive only — it does not predict draws.",
    signals: lotterySignals,
    meta: { apiBase: API_BASE, basis: BASIS }
  });
}
