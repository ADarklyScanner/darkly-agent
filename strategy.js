/**
 * strategy.js — signal generation.
 *
 * Pure functions only: no network, no state, no side effects. Everything
 * here takes an array of price bars and returns numbers. That makes the
 * whole decision layer testable offline, which is the point — the part
 * that decides to spend money should be the part you can run assertions
 * against.
 *
 * A bar is { t, o, h, l, c, v } as Alpaca returns it, oldest first.
 *
 * IMPORTANT HONESTY NOTE, kept in the source on purpose:
 * These are conventional technical indicators. They are widely known,
 * which means any edge they ever had is largely arbitraged away. This
 * module is a transparent, measurable starting hypothesis — NOT a
 * profitable system. Judge it by the trade log, not by its output looking
 * confident.
 */

/* ------------------------------------------------------------------ *
 * Indicators
 * ------------------------------------------------------------------ */

export function sma(values, period) {
  if (!Array.isArray(values) || values.length < period || period <= 0) return null;
  const window = values.slice(-period);
  return window.reduce((a, b) => a + b, 0) / period;
}

export function ema(values, period) {
  if (!Array.isArray(values) || values.length < period || period <= 0) return null;
  const k = 2 / (period + 1);
  let acc = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) acc = values[i] * k + acc * (1 - k);
  return acc;
}

/** Wilder's RSI. Returns 0-100, or null when there isn't enough history. */
export function rsi(values, period = 14) {
  if (!Array.isArray(values) || values.length < period + 1) return null;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function macd(values, fast = 12, slow = 26, signalPeriod = 9) {
  if (!Array.isArray(values) || values.length < slow + signalPeriod) return null;

  const macdSeries = [];
  for (let i = slow; i <= values.length; i++) {
    const slice = values.slice(0, i);
    const f = ema(slice, fast);
    const s = ema(slice, slow);
    if (f === null || s === null) continue;
    macdSeries.push(f - s);
  }

  if (macdSeries.length < signalPeriod) return null;

  const line = macdSeries[macdSeries.length - 1];
  const signal = ema(macdSeries, signalPeriod);
  if (signal === null) return null;

  return { line, signal, histogram: line - signal };
}

/** Annualised volatility from daily closes, as a percentage. */
export function volatility(values, period = 20) {
  if (!Array.isArray(values) || values.length < period + 1) return null;

  const returns = [];
  for (let i = values.length - period; i < values.length; i++) {
    if (values[i - 1] === 0) continue;
    returns.push((values[i] - values[i - 1]) / values[i - 1]);
  }
  if (returns.length < 2) return null;

  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance =
    returns.reduce((acc, r) => acc + (r - mean) ** 2, 0) / (returns.length - 1);

  return Math.sqrt(variance) * Math.sqrt(252) * 100;
}

/** Least-squares slope of the last `period` closes, normalised to % per bar. */
export function trendSlope(values, period = 20) {
  if (!Array.isArray(values) || values.length < period) return null;

  const window = values.slice(-period);
  const n = window.length;
  const meanX = (n - 1) / 2;
  const meanY = window.reduce((a, b) => a + b, 0) / n;

  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - meanX) * (window[i] - meanY);
    den += (i - meanX) ** 2;
  }
  if (den === 0 || meanY === 0) return null;

  return ((num / den) / meanY) * 100;
}

/** Average True Range — used for stops, so they scale with the instrument. */
export function atr(bars, period = 14) {
  if (!Array.isArray(bars) || bars.length < period + 1) return null;

  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].h;
    const l = bars[i].l;
    const pc = bars[i - 1].c;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  if (trs.length < period) return null;

  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

/**
 * Wilder's ADX with directional indicators.
 *
 * ADX measures how strongly a market is trending without saying which way,
 * which is exactly what a regime classifier needs. It replaces the ad-hoc
 * "moving-average spread plus slope" heuristic this file used before —
 * that number worked, but it was invented here, which means its thresholds
 * were tuned against synthetic test data and nothing else. ADX is the
 * measure practitioners actually use, its conventional thresholds (below
 * 20 rangebound, above 25 trending) come from decades of use rather than
 * from my calibration loop, and it separates trend strength from trend
 * direction instead of conflating them.
 *
 * Returns { adx, plusDI, minusDI } or null.
 */
export function adx(bars, period = 14) {
  if (!Array.isArray(bars) || bars.length < period * 2 + 1) return null;

  const plusDM = [];
  const minusDM = [];
  const trs = [];

  for (let i = 1; i < bars.length; i++) {
    const h = Number(bars[i].h);
    const l = Number(bars[i].l);
    const ph = Number(bars[i - 1].h);
    const pl = Number(bars[i - 1].l);
    const pc = Number(bars[i - 1].c);

    if (![h, l, ph, pl, pc].every(Number.isFinite)) return null;

    const up = h - ph;
    const down = pl - l;

    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }

  if (trs.length < period * 2) return null;

  // Wilder smoothing: seed with a sum, then decay.
  const smooth = (arr) => {
    const out = [];
    let acc = arr.slice(0, period).reduce((a, b) => a + b, 0);
    out.push(acc);
    for (let i = period; i < arr.length; i++) {
      acc = acc - acc / period + arr[i];
      out.push(acc);
    }
    return out;
  };

  const sTR = smooth(trs);
  const sPlus = smooth(plusDM);
  const sMinus = smooth(minusDM);

  const dxs = [];
  for (let i = 0; i < sTR.length; i++) {
    if (sTR[i] === 0) continue;
    const pdi = (sPlus[i] / sTR[i]) * 100;
    const mdi = (sMinus[i] / sTR[i]) * 100;
    const sum = pdi + mdi;
    if (sum === 0) continue;
    dxs.push((Math.abs(pdi - mdi) / sum) * 100);
  }

  if (dxs.length < period) return null;

  let adxValue = dxs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dxs.length; i++) {
    adxValue = (adxValue * (period - 1) + dxs[i]) / period;
  }

  const last = sTR.length - 1;
  const plusDI = sTR[last] ? (sPlus[last] / sTR[last]) * 100 : null;
  const minusDI = sTR[last] ? (sMinus[last] / sTR[last]) * 100 : null;

  return {
    adx: Number(adxValue.toFixed(2)),
    plusDI: plusDI === null ? null : Number(plusDI.toFixed(2)),
    minusDI: minusDI === null ? null : Number(minusDI.toFixed(2))
  };
}

/* ------------------------------------------------------------------ *
 * Scoring
 * ------------------------------------------------------------------ */

export const AGGRESSIVENESS = {
  conservative: { strongBuy: 75, buy: 62, sell: 38, strongSell: 25, minConfidence: 70 },
  moderate:     { strongBuy: 68, buy: 56, sell: 44, strongSell: 32, minConfidence: 55 },
  aggressive:   { strongBuy: 62, buy: 52, sell: 48, strongSell: 38, minConfidence: 40 }
};

/**
 * Turn bars into a scored signal.
 *
 * Score is 0-100 where 50 is neutral. Each component votes independently
 * and is weighted; components that cannot be computed are dropped and the
 * remaining weights renormalised, so a short history degrades gracefully
 * instead of silently scoring as neutral.
 */
export function scoreSymbol(symbol, bars, options = {}) {
  const aggressiveness = options.aggressiveness || "moderate";
  const thresholds = AGGRESSIVENESS[aggressiveness] || AGGRESSIVENESS.moderate;

  if (!Array.isArray(bars) || bars.length < 30) {
    return {
      symbol,
      action: "hold",
      score: 50,
      confidence: 0,
      reason: `Insufficient history (${bars ? bars.length : 0} bars, need 30+).`,
      indicators: {},
      tradable: false
    };
  }

  const closes = bars.map((b) => Number(b.c)).filter(Number.isFinite);
  const price = closes[closes.length - 1];
  const prevClose = closes[closes.length - 2];

  const ind = {
    price,
    sma20: sma(closes, 20),
    sma50: sma(closes, 50),
    rsi14: rsi(closes, 14),
    macd: macd(closes),
    volatility: volatility(closes),
    trendSlope: trendSlope(closes),
    atr14: atr(bars, 14),
    changePercent: prevClose ? ((price - prevClose) / prevClose) * 100 : null,
    volumeRatio: null
  };

  const vols = bars.map((b) => Number(b.v)).filter(Number.isFinite);
  const avgVol = sma(vols, Math.min(20, vols.length));
  if (avgVol) ind.volumeRatio = vols[vols.length - 1] / avgVol;

  // ---- Regime ----------------------------------------------------
  //
  // Trend-following and mean-reversion are opposite bets. Averaging them
  // is not a balanced strategy, it is an incoherent one: in a strong
  // trend the RSI term pins to its extreme and inverts the whole signal,
  // so the model sells strength and buys weakness while looking
  // confident. So the regime decides which logic applies, and the other
  // is demoted to a minor voice rather than an equal one.
  const maSpread =
    ind.sma20 !== null && ind.sma50 !== null
      ? ((ind.sma20 - ind.sma50) / ind.sma50) * 100
      : 0;

  const legacyStrength = Math.abs(maSpread) + Math.abs(ind.trendSlope ?? 0) * 2;
  ind.adx = adx(bars, 14);
  ind.trendStrength = Number(legacyStrength.toFixed(3));

  // ADX decides when it is available, on its conventional thresholds.
  // Between 20 and 25 the measure itself is saying "unclear", so the
  // older heuristic breaks the tie rather than a coin flip.
  let regime;
  if (ind.adx && Number.isFinite(ind.adx.adx)) {
    if (ind.adx.adx >= 25) regime = "trending";
    else if (ind.adx.adx <= 20) regime = "ranging";
    else regime = legacyStrength >= 3.5 ? "trending" : "ranging";
    ind.regimeBasis = `ADX ${ind.adx.adx}`;
  } else {
    regime = legacyStrength >= 3.5 ? "trending" : "ranging";
    ind.regimeBasis = "MA spread and slope (ADX unavailable)";
  }

  ind.marketRegime = regime;
  ind.atrPercent =
    ind.atr14 && price ? Number(((ind.atr14 / price) * 100).toFixed(3)) : null;

  const votes = [];
  const trending = regime === "trending";

  // Moving-average structure. Directional in both regimes, but it
  // carries far more weight when a trend is actually established.
  if (ind.sma20 !== null && ind.sma50 !== null) {
    votes.push({
      name: "ma_cross",
      weight: trending ? 0.35 : 0.15,
      value: clamp(50 + maSpread * 8, 0, 100)
    });
  }

  // RSI flips meaning with regime.
  //   ranging  -> fade extremes (oversold is bullish)
  //   trending -> confirm direction, with a penalty only at true
  //               exhaustion (>80 / <20), never a full reversal
  if (ind.rsi14 !== null) {
    let value;
    if (trending) {
      value = clamp(ind.rsi14, 0, 100);
      if (ind.rsi14 > 80) value = clamp(100 - (ind.rsi14 - 80) * 2.5, 50, 100);
      else if (ind.rsi14 < 20) value = clamp((20 - ind.rsi14) * 2.5, 0, 50);
    } else {
      value = clamp(100 - ind.rsi14, 0, 100);

      // Do not fade a dip when the longer-term structure is already
      // broken. "Oversold" in a downtrend is not a discount, it is a
      // falling knife, and buying it is how a -5% position becomes -45%.
      // The fade is capped at neutral rather than inverted: the signal
      // stops being a reason to buy, it does not become a reason to sell.
      if (maSpread < -1 && value > 50) {
        value = 50;
        ind.fadeSuppressed = "downtrend";
      } else if (maSpread > 1 && value < 50) {
        value = 50;
        ind.fadeSuppressed = "uptrend";
      }
    }
    votes.push({ name: trending ? "rsi_confirm" : "rsi_fade", weight: trending ? 0.15 : 0.40, value });
  }

  // MACD histogram: momentum, directional in both regimes.
  if (ind.macd) {
    const norm = price ? (ind.macd.histogram / price) * 100 : 0;
    votes.push({
      name: "macd",
      weight: trending ? 0.25 : 0.20,
      value: clamp(50 + norm * 60, 0, 100)
    });
  }

  // Slope of recent closes.
  if (ind.trendSlope !== null) {
    votes.push({
      name: "trend",
      weight: trending ? 0.25 : 0.15,
      value: clamp(50 + ind.trendSlope * 25, 0, 100)
    });
  }

  // Volume confirmation. A move on heavy volume reflects more
  // participation than the same move on thin volume. It only ever
  // confirms an existing move — it never generates direction on its own,
  // so a flat day votes neutral regardless of how heavy the tape was.
  if (ind.volumeRatio !== null && ind.changePercent !== null) {
    const conviction = clamp((ind.volumeRatio - 1) / 1.5, -0.5, 1);
    const direction = Math.sign(ind.changePercent);
    votes.push({
      name: "volume_confirm",
      weight: 0.1,
      value: clamp(50 + direction * conviction * 30, 0, 100)
    });
  }

  if (votes.length === 0) {
    return {
      symbol,
      action: "hold",
      score: 50,
      confidence: 0,
      reason: "No indicator could be computed.",
      indicators: ind,
      tradable: false
    };
  }

  const totalWeight = votes.reduce((a, v) => a + v.weight, 0);
  const score = votes.reduce((a, v) => a + v.value * v.weight, 0) / totalWeight;
  const coverageWeight = totalWeight;

  // Confidence: how much the components agree, scaled by how many of them
  // we actually had. Disagreement should read as uncertainty, not as a
  // neutral score presented confidently.
  const mean = votes.reduce((a, v) => a + v.value, 0) / votes.length;
  const spread =
    Math.sqrt(votes.reduce((a, v) => a + (v.value - mean) ** 2, 0) / votes.length);
  const agreement = clamp(100 - spread * 2.2, 0, 100);
  const coverage = clamp(coverageWeight * 100, 0, 100);
  const confidence = Math.round(clamp((agreement * 0.7 + coverage * 0.3), 0, 100));

  let action = "hold";
  if (score >= thresholds.strongBuy) action = "strong_buy";
  else if (score >= thresholds.buy) action = "buy";
  else if (score <= thresholds.strongSell) action = "strong_sell";
  else if (score <= thresholds.sell) action = "sell";

  // A signal the model isn't confident in is not a signal.
  const belowConfidence = confidence < thresholds.minConfidence;
  if (belowConfidence && action !== "hold") action = "hold";

  const stopDistance = ind.atr14 ? ind.atr14 * 2 : price * 0.05;
  const isBuy = action === "buy" || action === "strong_buy";

  return {
    symbol,
    action,
    score: Number(score.toFixed(1)),
    confidence,
    aggressiveness,
    tradable: action !== "hold",
    stopPrice: Number((isBuy ? price - stopDistance : price + stopDistance).toFixed(2)),
    targetPrice: Number((isBuy ? price + stopDistance * 2 : price - stopDistance * 2).toFixed(2)),
    rewardRiskRatio: 2,
    reason: buildReason(action, score, confidence, ind, belowConfidence, thresholds),
    components: votes.map((v) => ({ name: v.name, value: Number(v.value.toFixed(1)), weight: v.weight })),
    indicators: roundIndicators(ind)
  };
}

function buildReason(action, score, confidence, ind, belowConfidence, thresholds) {
  const bits = [];

  if (ind.rsi14 !== null) {
    if (ind.rsi14 < 30) bits.push(`RSI ${ind.rsi14.toFixed(0)} (oversold)`);
    else if (ind.rsi14 > 70) bits.push(`RSI ${ind.rsi14.toFixed(0)} (overbought)`);
    else bits.push(`RSI ${ind.rsi14.toFixed(0)}`);
  }

  if (ind.sma20 !== null && ind.sma50 !== null) {
    bits.push(ind.sma20 > ind.sma50 ? "20d above 50d" : "20d below 50d");
  }

  if (ind.macd) {
    bits.push(ind.macd.histogram > 0 ? "MACD positive" : "MACD negative");
  }

  if (ind.volumeRatio !== null) {
    bits.push(`volume ${ind.volumeRatio.toFixed(1)}x avg`);
  }

  const regimeNote = ind.marketRegime === "trending"
    ? "Trending regime: following direction"
    : "Ranging regime: fading extremes";

  const base = `Score ${score.toFixed(1)}/100, confidence ${confidence}%. ${regimeNote}. ${bits.join(", ")}.`;

  if (belowConfidence) {
    return `${base} Held: confidence below the ${thresholds.minConfidence}% floor — indicators disagree.`;
  }

  return base;
}

function roundIndicators(ind) {
  const out = {};
  for (const [k, v] of Object.entries(ind)) {
    if (v === null || v === undefined) out[k] = null;
    else if (typeof v === "number") out[k] = Number(v.toFixed(4));
    else if (k === "macd" && v) {
      out.macd = {
        line: Number(v.line.toFixed(4)),
        signal: Number(v.signal.toFixed(4)),
        histogram: Number(v.histogram.toFixed(4))
      };
    } else out[k] = v;
  }
  return out;
}

function clamp(n, lo, hi) {
  return Math.min(Math.max(n, lo), hi);
}
