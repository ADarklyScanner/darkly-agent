/**
 * universe.js — building and ranking the autotrader's trading universe.
 *
 * Replaces a fixed, hand-picked watchlist with the full set of currently
 * active, tradable U.S. equities. Eight hand-picked symbols can miss
 * everything happening outside them; scoring the whole tradable market
 * every cycle cannot.
 *
 * Two stages, for cost reasons - fetching full history for every
 * tradable U.S. equity every 15 minutes is neither fast nor necessary:
 *
 *  1. CHEAP PASS (this file): one bulk snapshot per symbol (latest
 *     trade, today's bar, previous close) across the entire eligible
 *     universe, ranked by a liquidity/momentum heuristic. This is what
 *     "bulk" buys - one round of lightweight requests over thousands of
 *     names instead of full history for each.
 *  2. DEEP PASS (unchanged, in autotrader.js): full historical bars -
 *     what scoreSymbol() and the ATR/chandelier/correlation checks in
 *     risk.js actually need - are fetched only for the finalists this
 *     cheap pass selects, plus anything already held. The scoring and
 *     risk pipeline itself does not change; only where its candidates
 *     come from does.
 *
 * Fails closed, on purpose: if the asset list or the bulk snapshot pass
 * cannot produce a usable universe, buildUniverse() reports that
 * plainly (ok:false, finalists:[]) rather than ever handing back a
 * fixed watchlist as a fallback. A silent fallback would look like a
 * working scan while actually trading a tiny, stale slice of the
 * market on stale logic - worse than doing nothing that cycle.
 */

import { getTradableAssets, getBulkSnapshots } from "./trading.js";

export const UNIVERSE_DEFAULTS = {
  // How many symbols survive the cheap pass to get full history and
  // real scoring. Bigger = more thorough and slower; smaller = faster
  // and narrower. Deep-pass cost scales with this, not with market size.
  finalistCount: Number(process.env.AUTO_TRADE_UNIVERSE_FINALISTS || 40),

  // Structural/liquidity floors applied during the cheap pass, before
  // anything reaches scoring. These intentionally echo risk.js's own
  // liquidity floor (RISK_DEFAULTS) rather than being independent
  // numbers to keep in sync by hand - a symbol cheap-pass would reject
  // here is one the deep pass's liquidityCheck() would reject anyway,
  // so filtering early just saves the wasted history fetch.
  minPrice: Number(process.env.AUTO_TRADE_UNIVERSE_MIN_PRICE || 3),
  minDollarVolume: Number(process.env.AUTO_TRADE_UNIVERSE_MIN_DOLLAR_VOLUME || 2000000),

  // Exchanges excluded before the snapshot pass even runs. OTC-listed
  // names are typically illiquid enough that the floors above would
  // reject nearly all of them anyway; excluding the exchange up front
  // just saves those wasted requests. Disclosed and counted
  // (excludedByExchange in the returned stats), never a silent cut.
  excludedExchanges: String(process.env.AUTO_TRADE_UNIVERSE_EXCLUDE_EXCHANGES || "OTC")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean),

  // Below this fraction of the eligible universe actually returning
  // snapshot data, the scan is treated as too incomplete to rank
  // honestly and buildUniverse() fails closed instead.
  minCoverageFraction: Number(process.env.AUTO_TRADE_UNIVERSE_MIN_COVERAGE || 0.5)
};

/**
 * The cheap-pass ranking heuristic. Deliberately simple: this only has
 * to be good enough to shortlist candidates for real scoring, not to
 * generate the trade decision itself. scoreSymbol() (strategy.js) and
 * every check in risk.js still run on the finalists exactly as before
 * and remain the actual authority on what gets bought.
 *
 * Dollar volume is log-scaled so mega caps don't blot out everything
 * else; the momentum term keeps this from being pure liquidity ranking.
 */
function cheapScore(snapshot) {
  const dollarVolume = snapshot.price * (snapshot.dayVolume || 0);
  const momentum = Number.isFinite(snapshot.changePercent) ? snapshot.changePercent : 0;
  return Math.log10(Math.max(dollarVolume, 1)) + momentum / 5;
}

/**
 * Build this cycle's trading universe: the full tradable market, cheaply
 * ranked down to a shortlist. Never throws - every failure mode is
 * reported in the return value so the caller can log it and fail closed
 * without a try/catch of its own.
 *
 * Returns { ok, finalists, ranked, stats, error }. `finalists` is a
 * plain array of symbols, always [] (never a fixed watchlist) when
 * ok is false.
 */
export async function buildUniverse(options = {}) {
  const cfg = { ...UNIVERSE_DEFAULTS, ...options };

  const stats = {
    totalAssets: 0,
    excludedNotTradable: 0,
    excludedByExchange: 0,
    excludedByAssetClass: 0,
    eligibleForSnapshot: 0,
    snapshotCoverage: 0,
    failedData: 0,
    excludedByPriceFloor: 0,
    excludedByVolumeFloor: 0,
    passedFilters: 0,
    finalistCount: 0,
    scanErrors: [],
    reasons: []
  };

  let assets;
  try {
    assets = await getTradableAssets();
  } catch (e) {
    return {
      ok: false,
      finalists: [],
      ranked: [],
      stats,
      error: `Could not fetch the tradable asset list (${e.message}). Failing closed for this cycle rather than falling back to a fixed watchlist.`
    };
  }

  stats.totalAssets = assets.length;

  const eligible = [];
  for (const a of assets) {
    if (!a.tradable || a.status !== "active") {
      stats.excludedNotTradable++;
      continue;
    }
    if (a.assetClass && a.assetClass !== "us_equity") {
      stats.excludedByAssetClass++;
      continue;
    }
    if (cfg.excludedExchanges.includes(String(a.exchange || "").toUpperCase())) {
      stats.excludedByExchange++;
      continue;
    }
    eligible.push(a.symbol);
  }
  stats.eligibleForSnapshot = eligible.length;

  if (eligible.length === 0) {
    stats.reasons.push("No symbols survived structural eligibility filtering (tradable/active/asset class/exchange).");
    return {
      ok: false,
      finalists: [],
      ranked: [],
      stats,
      error: "No symbols survived structural eligibility filtering. Failing closed."
    };
  }

  const { snapshots, missing, errors } = await getBulkSnapshots(eligible, { feed: options.feed });
  stats.snapshotCoverage = Object.keys(snapshots).length;
  stats.failedData = missing.length;
  stats.scanErrors = errors;

  const coverageFraction = stats.eligibleForSnapshot > 0
    ? stats.snapshotCoverage / stats.eligibleForSnapshot
    : 0;

  if (coverageFraction < cfg.minCoverageFraction) {
    stats.reasons.push(
      `Bulk snapshot pass covered only ${(coverageFraction * 100).toFixed(1)}% of the eligible universe (${stats.snapshotCoverage}/${stats.eligibleForSnapshot}), below the ${(cfg.minCoverageFraction * 100).toFixed(0)}% minimum.`
    );
    return {
      ok: false,
      finalists: [],
      ranked: [],
      stats,
      error: `Bulk snapshot pass only covered ${(coverageFraction * 100).toFixed(1)}% of the eligible universe (${stats.snapshotCoverage}/${stats.eligibleForSnapshot}), below the ${(cfg.minCoverageFraction * 100).toFixed(0)}% minimum. Failing closed rather than ranking a badly incomplete scan.`
    };
  }

  const ranked = [];
  for (const [symbol, snap] of Object.entries(snapshots)) {
    if (!snap.price || snap.price < cfg.minPrice) {
      stats.excludedByPriceFloor++;
      continue;
    }
    const dollarVolume = snap.price * (snap.dayVolume || 0);
    if (dollarVolume < cfg.minDollarVolume) {
      stats.excludedByVolumeFloor++;
      continue;
    }
    ranked.push({
      symbol,
      score: Number(cheapScore(snap).toFixed(4)),
      price: snap.price,
      dollarVolume: Math.round(dollarVolume),
      changePercent: Number((snap.changePercent || 0).toFixed(2))
    });
  }

  ranked.sort((a, b) => b.score - a.score);
  stats.passedFilters = ranked.length;

  const finalists = ranked.slice(0, cfg.finalistCount).map((r) => r.symbol);
  stats.finalistCount = finalists.length;

  stats.reasons.push(
    `${stats.totalAssets} total assets -> ${stats.eligibleForSnapshot} eligible ` +
      `(excluded ${stats.excludedNotTradable} not tradable/active, ${stats.excludedByExchange} by exchange, ${stats.excludedByAssetClass} by asset class) -> ` +
      `${stats.snapshotCoverage} scanned, ${stats.failedData} failed to return data -> ` +
      `${stats.passedFilters} passed price/liquidity floors (excluded ${stats.excludedByPriceFloor} by price, ${stats.excludedByVolumeFloor} by dollar volume) -> ` +
      `top ${finalists.length} ranked by cheap score = this cycle's finalists.`
  );

  if (finalists.length === 0) {
    stats.reasons.push("Ranking produced zero finalists - nothing passed the price/liquidity floors this cycle. Not an error; some cycles the whole tape can be this thin.");
  }

  return { ok: true, finalists, ranked: ranked.slice(0, cfg.finalistCount), stats, error: null };
}
