/**
 * risk.js — position sizing and exposure control.
 *
 * A candid note on where improvement is actually available.
 *
 * The signal layer (strategy.js) uses public indicators on public data. Any
 * edge those once had is largely arbitraged away, and no amount of better
 * code changes that. What separates traders who survive from traders who
 * do not is mostly NOT signal quality — it is position sizing, exposure
 * control, and exit discipline. Those are arithmetic, not prediction, and
 * arithmetic can genuinely be done well or badly.
 *
 * So this module is where the real craft lives, and every function in it
 * implements something that working systematic traders treat as basic
 * hygiene:
 *
 *   - Size by risk, not by dollars. Two positions of $500 each carry
 *     wildly different risk if one stops out at -2% and the other at -15%.
 *     Professionals fix the LOSS and let the position size vary; amateurs
 *     fix the position size and let the loss vary.
 *   - Cap total portfolio heat. Six positions each risking 1% is a 6% day
 *     when correlations go to one, which is exactly when they do.
 *   - Refuse correlated duplicates. Holding NVDA, AMD and AVGO is one bet
 *     with three tickers on it.
 *   - Refuse illiquid and low-priced names, where the spread and the slip
 *     quietly exceed the edge being chased.
 *   - Trail stops so a winner cannot become a loser.
 *   - Do not fight the index. Long signals in a bear tape have a much
 *     worse base rate, and this is the single most reliably documented
 *     drawdown reducer in systematic trading.
 *
 * Pure functions only: no network, no state, no side effects.
 */

import { atr, sma } from "./strategy.js";

export const RISK_DEFAULTS = {
  // Fraction of equity risked per trade, as a percent. 0.5% is a common
  // professional default. Above ~2% a normal losing streak is ruinous.
  riskPerTradePercent: Number(process.env.RISK_PER_TRADE_PERCENT || 0.5),

  // Ceiling on the sum of all open risk. Reached, no new positions open.
  maxPortfolioHeatPercent: Number(process.env.MAX_PORTFOLIO_HEAT_PERCENT || 6),

  // Above this pairwise correlation, a candidate is treated as a duplicate
  // of something already held rather than as diversification.
  maxCorrelation: Number(process.env.MAX_CORRELATION || 0.85),

  // Liquidity floors. Below these, execution cost is the dominant term.
  minDollarVolume: Number(process.env.MIN_DOLLAR_VOLUME || 5_000_000),
  minPrice: Number(process.env.MIN_PRICE || 5),

  // Stop distance as a multiple of ATR, so stops scale with the
  // instrument's own volatility rather than an arbitrary percentage.
  atrStopMultiple: Number(process.env.ATR_STOP_MULTIPLE || 2.5),

  // Trailing stop multiple (chandelier exit).
  atrTrailMultiple: Number(process.env.ATR_TRAIL_MULTIPLE || 3),

  // Benchmark moving average for the market filter.
  benchmarkMaPeriod: Number(process.env.BENCHMARK_MA_PERIOD || 200),
  benchmarkSymbol: process.env.BENCHMARK_SYMBOL || "SPY"
};

/* ------------------------------------------------------------------ *
 * Position sizing
 * ------------------------------------------------------------------ */

/**
 * Size a position so that being stopped out costs a fixed fraction of
 * equity, then apply every hard cap and report which one bound the result.
 *
 * Returns shares AND notional. The caller can place either, but the
 * reported `actualRiskUsd` is what matters: after capping, the real risk
 * is usually below the target, and pretending otherwise is how portfolio
 * heat gets miscounted.
 */
export function positionSize(input = {}) {
  const {
    equity,
    price,
    stopPrice,
    cash = Infinity,
    maxPositionUsd = Infinity,
    riskPerTradePercent = RISK_DEFAULTS.riskPerTradePercent,
    allowFractional = true
  } = input;

  const reasons = [];

  if (!Number.isFinite(equity) || equity <= 0) {
    return blockedSize("Equity is unknown or non-positive.");
  }
  if (!Number.isFinite(price) || price <= 0) {
    return blockedSize("Price is unknown or non-positive.");
  }
  if (!Number.isFinite(stopPrice) || stopPrice <= 0) {
    return blockedSize("No stop price, so risk per share is undefined.");
  }

  const riskPerShare = price - stopPrice;
  if (riskPerShare <= 0) {
    return blockedSize(
      `Stop (${stopPrice}) is not below entry (${price}); risk per share would be zero or negative.`
    );
  }

  const targetRiskUsd = equity * (riskPerTradePercent / 100);
  let shares = targetRiskUsd / riskPerShare;
  let boundBy = "risk";

  const notionalCapShares = maxPositionUsd / price;
  if (shares > notionalCapShares) {
    shares = notionalCapShares;
    boundBy = "maxPositionUsd";
    reasons.push(`Capped by the $${maxPositionUsd} per-position limit.`);
  }

  const cashCapShares = Math.max(0, cash - 1) / price;
  if (shares > cashCapShares) {
    shares = cashCapShares;
    boundBy = "cash";
    reasons.push("Capped by available cash.");
  }

  if (!allowFractional) shares = Math.floor(shares);

  shares = Number(shares.toFixed(6));

  const notional = Number((shares * price).toFixed(2));
  const actualRiskUsd = Number((shares * riskPerShare).toFixed(2));

  if (shares <= 0 || notional < 1) {
    return blockedSize("Sizing resolved to nothing tradable after caps.");
  }

  return {
    ok: true,
    shares,
    notional,
    riskPerShare: Number(riskPerShare.toFixed(4)),
    stopPercent: Number((((price - stopPrice) / price) * 100).toFixed(2)),
    targetRiskUsd: Number(targetRiskUsd.toFixed(2)),
    actualRiskUsd,
    riskPercentOfEquity: Number(((actualRiskUsd / equity) * 100).toFixed(3)),
    boundBy,
    notes: reasons
  };
}

function blockedSize(reason) {
  return {
    ok: false,
    shares: 0,
    notional: 0,
    actualRiskUsd: 0,
    reason,
    notes: [reason]
  };
}

/**
 * Stop price from ATR, so the stop sits outside the instrument's normal
 * noise instead of at a round percentage that has nothing to do with how
 * the thing actually moves.
 */
export function atrStop(bars, options = {}) {
  const {
    side = "buy",
    multiple = RISK_DEFAULTS.atrStopMultiple,
    fallbackPercent = 8
  } = options;

  if (!Array.isArray(bars) || bars.length === 0) return null;

  const price = Number(bars[bars.length - 1].c);
  if (!Number.isFinite(price) || price <= 0) return null;

  const a = atr(bars, 14);
  const distance = a ? a * multiple : price * (fallbackPercent / 100);

  const stop = side === "buy" ? price - distance : price + distance;
  if (stop <= 0) return null;

  return {
    stopPrice: Number(stop.toFixed(4)),
    distance: Number(distance.toFixed(4)),
    distancePercent: Number(((distance / price) * 100).toFixed(2)),
    basis: a ? `ATR(14) x ${multiple}` : `${fallbackPercent}% fallback (ATR unavailable)`,
    atr: a ? Number(a.toFixed(4)) : null
  };
}

/**
 * Chandelier exit: trail the stop from the highest high since entry, so a
 * winner is given room to run but cannot round-trip back into a loss.
 *
 * Returns the trailing stop and whether it is above the original stop
 * (the only case where it should replace it — a trailing stop must never
 * move down).
 */
export function chandelierStop(bars, options = {}) {
  const {
    multiple = RISK_DEFAULTS.atrTrailMultiple,
    lookback = 22,
    side = "buy",
    currentStop = null
  } = options;

  if (!Array.isArray(bars) || bars.length < 5) return null;

  const window = bars.slice(-Math.max(2, lookback));
  const a = atr(bars, 14);
  if (!a) return null;

  const highest = Math.max(...window.map((b) => Number(b.h)).filter(Number.isFinite));
  const lowest = Math.min(...window.map((b) => Number(b.l)).filter(Number.isFinite));

  const raw = side === "buy" ? highest - a * multiple : lowest + a * multiple;
  if (!Number.isFinite(raw) || raw <= 0) return null;

  const trailing = Number(raw.toFixed(4));

  // A trailing stop ratchets one way only. Letting it loosen would turn a
  // risk control into a rationalisation.
  let effective = trailing;
  let moved = true;

  if (currentStop !== null && Number.isFinite(currentStop)) {
    if (side === "buy") {
      effective = Math.max(trailing, currentStop);
      moved = effective > currentStop;
    } else {
      effective = Math.min(trailing, currentStop);
      moved = effective < currentStop;
    }
  }

  return {
    trailingStop: trailing,
    effectiveStop: Number(effective.toFixed(4)),
    moved,
    anchor: side === "buy" ? Number(highest.toFixed(4)) : Number(lowest.toFixed(4)),
    basis: `${side === "buy" ? "highest high" : "lowest low"} over ${window.length} bars, less ATR(14) x ${multiple}`
  };
}

/* ------------------------------------------------------------------ *
 * Exposure control
 * ------------------------------------------------------------------ */

/**
 * Total open risk across the portfolio, as a percent of equity.
 *
 * Risk per position is qty x (price - stop), floored at zero. Positions
 * with no known stop are counted at their FULL value, because an exit plan
 * that does not exist cannot be assumed to be cheap — counting them as
 * zero risk is the arithmetic that makes blown-up accounts look prudent
 * right up until they aren't.
 */
export function portfolioHeat(positions = [], equity, stopBySymbol = {}) {
  if (!Number.isFinite(equity) || equity <= 0) {
    return { ok: false, reason: "Equity unknown.", heatPercent: null };
  }

  let totalRisk = 0;
  const detail = [];
  let unprotected = 0;

  for (const p of positions) {
    const qty = Math.abs(Number(p.qty));
    const price = Number(p.currentPrice ?? p.current_price ?? p.marketValue / qty);
    const stop = Number(stopBySymbol[p.symbol]);

    if (!Number.isFinite(qty) || !Number.isFinite(price)) continue;

    let risk;
    let basis;

    if (Number.isFinite(stop) && stop > 0 && stop < price) {
      risk = qty * (price - stop);
      basis = "stop";
    } else {
      risk = qty * price;
      basis = "no stop — counted at full value";
      unprotected++;
    }

    totalRisk += risk;
    detail.push({
      symbol: p.symbol,
      risk: Number(risk.toFixed(2)),
      riskPercent: Number(((risk / equity) * 100).toFixed(3)),
      basis
    });
  }

  const heatPercent = Number(((totalRisk / equity) * 100).toFixed(3));

  return {
    ok: true,
    totalRiskUsd: Number(totalRisk.toFixed(2)),
    heatPercent,
    unprotectedPositions: unprotected,
    positions: detail.sort((a, b) => b.risk - a.risk)
  };
}

/** Simple returns from a bar series, aligned to timestamps. */
export function returnsFromBars(bars) {
  if (!Array.isArray(bars) || bars.length < 2) return [];
  const out = [];
  for (let i = 1; i < bars.length; i++) {
    const prev = Number(bars[i - 1].c);
    const cur = Number(bars[i].c);
    if (!Number.isFinite(prev) || !Number.isFinite(cur) || prev === 0) continue;
    out.push({ t: bars[i].t, r: (cur - prev) / prev });
  }
  return out;
}

/** Pearson correlation over the overlapping timestamps of two return series. */
export function correlation(seriesA, seriesB, minOverlap = 20) {
  if (!Array.isArray(seriesA) || !Array.isArray(seriesB)) return null;

  const byTime = new Map(seriesB.map((x) => [x.t, x.r]));
  const a = [];
  const b = [];

  for (const point of seriesA) {
    if (byTime.has(point.t)) {
      a.push(point.r);
      b.push(byTime.get(point.t));
    }
  }

  if (a.length < minOverlap) return null;

  const meanA = a.reduce((x, y) => x + y, 0) / a.length;
  const meanB = b.reduce((x, y) => x + y, 0) / b.length;

  let num = 0;
  let denA = 0;
  let denB = 0;

  for (let i = 0; i < a.length; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    num += da * db;
    denA += da * da;
    denB += db * db;
  }

  if (denA === 0 || denB === 0) return null;
  return Number((num / Math.sqrt(denA * denB)).toFixed(4));
}

/**
 * Is this candidate genuinely a new bet, or the same bet again?
 *
 * Returns the highest correlation against anything already held and
 * whether that breaches the threshold. Concentration usually arrives
 * disguised as diversification: five semiconductor names look like five
 * positions and behave like one.
 */
export function correlationCheck(candidateBars, heldBarsBySymbol = {}, options = {}) {
  const threshold = options.maxCorrelation ?? RISK_DEFAULTS.maxCorrelation;
  const candidate = returnsFromBars(candidateBars);

  if (candidate.length < 20) {
    return { ok: true, reason: "Not enough overlapping history to judge correlation.", maxCorrelation: null, against: null };
  }

  let worst = null;
  let against = null;

  for (const [symbol, bars] of Object.entries(heldBarsBySymbol)) {
    const c = correlation(candidate, returnsFromBars(bars));
    if (c === null) continue;
    if (worst === null || c > worst) {
      worst = c;
      against = symbol;
    }
  }

  if (worst === null) {
    return { ok: true, reason: "Nothing comparable held.", maxCorrelation: null, against: null };
  }

  return {
    ok: worst < threshold,
    maxCorrelation: worst,
    against,
    threshold,
    reason:
      worst < threshold
        ? `Most correlated holding is ${against} at ${worst}, under the ${threshold} ceiling.`
        : `Too similar to ${against} (correlation ${worst} vs a ${threshold} ceiling) — this is the same bet, not a new one.`
  };
}

/* ------------------------------------------------------------------ *
 * Tradability filters
 * ------------------------------------------------------------------ */

/**
 * Liquidity and price floors.
 *
 * Illiquid names are where backtests go to lie: the signal looks fine and
 * the fill is terrible. Dollar volume, not share volume, is the measure
 * that matters — a million shares of a $2 stock is not liquidity.
 */
export function liquidityCheck(bars, options = {}) {
  const minDollarVolume = options.minDollarVolume ?? RISK_DEFAULTS.minDollarVolume;
  const minPrice = options.minPrice ?? RISK_DEFAULTS.minPrice;

  if (!Array.isArray(bars) || bars.length < 5) {
    return { ok: false, reason: "Not enough history to assess liquidity.", avgDollarVolume: null };
  }

  const recent = bars.slice(-20);
  const dollarVolumes = recent
    .map((b) => Number(b.c) * Number(b.v))
    .filter(Number.isFinite);

  if (dollarVolumes.length === 0) {
    return { ok: false, reason: "No volume data.", avgDollarVolume: null };
  }

  const avgDollarVolume =
    dollarVolumes.reduce((a, b) => a + b, 0) / dollarVolumes.length;
  const price = Number(bars[bars.length - 1].c);

  const failures = [];
  if (price < minPrice) {
    failures.push(`price $${price.toFixed(2)} is below the $${minPrice} floor`);
  }
  if (avgDollarVolume < minDollarVolume) {
    failures.push(
      `average daily dollar volume $${Math.round(avgDollarVolume).toLocaleString()} is below the $${minDollarVolume.toLocaleString()} floor`
    );
  }

  return {
    ok: failures.length === 0,
    price,
    avgDollarVolume: Math.round(avgDollarVolume),
    minPrice,
    minDollarVolume,
    reason: failures.length ? `Rejected: ${failures.join("; ")}.` : "Liquid enough to trade."
  };
}

/**
 * The market filter: is the broad tape in an uptrend?
 *
 * Taking long signals when the index is below its long moving average has
 * a materially worse base rate, and skipping those periods is the most
 * consistently documented way to cut drawdown in systematic long
 * strategies. It costs some upside in V-shaped recoveries. That trade is
 * usually worth making, and it is stated here so the cost is a choice
 * rather than a surprise.
 */
export function marketFilter(benchmarkBars, options = {}) {
  const period = options.maPeriod ?? RISK_DEFAULTS.benchmarkMaPeriod;

  if (!Array.isArray(benchmarkBars) || benchmarkBars.length < period) {
    // Fail closed on the data, open on the decision: an unknown market
    // state should not silently become an assumed bull market, but neither
    // should a missing benchmark halt everything. Say so and let the
    // caller decide.
    return {
      ok: true,
      known: false,
      reason: `Benchmark history too short for a ${period}-day average (${benchmarkBars?.length ?? 0} bars). Market state unknown.`
    };
  }

  const closes = benchmarkBars.map((b) => Number(b.c)).filter(Number.isFinite);
  const ma = sma(closes, period);
  const price = closes[closes.length - 1];

  if (ma === null) {
    return { ok: true, known: false, reason: "Benchmark average could not be computed." };
  }

  const above = price > ma;
  const distancePercent = Number((((price - ma) / ma) * 100).toFixed(2));

  return {
    ok: above,
    known: true,
    price: Number(price.toFixed(2)),
    movingAverage: Number(ma.toFixed(2)),
    period,
    distancePercent,
    regime: above ? "risk_on" : "risk_off",
    reason: above
      ? `Benchmark is ${distancePercent}% above its ${period}-day average — long signals allowed.`
      : `Benchmark is ${distancePercent}% below its ${period}-day average — no new long positions. Exits are unaffected.`
  };
}
