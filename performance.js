/**
 * performance.js — turning the stored trade log into an honest scorecard.
 *
 * READ THIS BEFORE READING ANY NUMBER THIS MODULE PRODUCES.
 *
 * Measuring past trades does not establish predictive skill. A win rate, a
 * profit factor and an expectancy are descriptions of a sample that has
 * already happened. None of them is evidence that the next trade is more
 * likely to win, and none of them survives being quoted without its sample
 * size attached. With a small sample the dominant explanation for ANY
 * result here — good or bad — is luck. Three winning trades in a row is a
 * 100% win rate and also the single most ordinary thing a coin can do.
 * Thirty closed trades is the point at which these statistics stop being
 * pure noise; it is not the point at which they become proof of an edge.
 *
 * So, deliberately:
 *   - every summary carries `sampleSize`, a `reliable` boolean and a
 *     plain-English `caveat`, and those travel WITH the numbers rather
 *     than sitting in a footnote somebody can drop;
 *   - nothing here extrapolates, annualises or projects — there is no
 *     "expected annual return" and there will not be one;
 *   - where the log does not record something, the answer is null and the
 *     reason is named in `missing`, never a zero or a default that reads
 *     like a measurement.
 *
 * Everything is pure: no network, no filesystem, no clock, no mutation of
 * the caller's arrays or objects. Data comes in as arguments.
 *
 * ------------------------------------------------------------------
 * The data this reads, as it is actually written (trading.js / autotrader.js)
 * ------------------------------------------------------------------
 *
 * A trade-log entry, from logTrade():
 *
 *   accepted order   { action:"order", accepted:true, orderId, order,
 *                      rationale, guardrailContext:{tradesToday,
 *                      estimatedUsd, dayPnl}, submittedAt, mode }
 *   blocked order    { action:"order", accepted:false, order, rationale,
 *                      blockedBy:[string], submittedAt }
 *   cancellation     { action:"cancel", orderId, submittedAt, accepted:true }
 *
 * `order` is the Alpaca REQUEST body, with every number stored as a STRING:
 *   { symbol, side:"buy"|"sell", type, time_in_force,
 *     qty?, notional?, limit_price?, stop_price? }
 *
 * Three consequences drive the whole design of this file:
 *
 *  1. THE FILL IS NEVER RECORDED. The log stores what was asked for, not
 *     what happened. There is no filled price, no filled quantity, no fill
 *     time — only `submittedAt`. So a price has to be inferred from the
 *     request (a limit price, or the pre-trade quote implied by
 *     guardrailContext.estimatedUsd / qty), and every such price is labelled
 *     with its source and marked `approximate`. Callers who have Alpaca's
 *     order history can pass real fills in and get exact answers.
 *
 *  2. AUTOTRADER BUYS CARRY NO SHARE COUNT. runOnce() sizes entries in
 *     dollars (`notional`) and exits in shares (`qty`), so the common case
 *     is a buy with neither a price nor a quantity. Those entries cannot be
 *     turned into a lot and are returned in `unpriced` — not guessed at.
 *
 *  3. THE STOP PRICE LIVES SOMEWHERE ELSE. scoreSymbol() computes a stop,
 *     but a market order never writes `stop_price`, so the stop survives
 *     only in the autotrader run record (run.decisions[].signal.stopPrice).
 *     That is why rMultiples() takes the stop lookup as an argument instead
 *     of pretending to find it in the log.
 *
 * Ordering note: `submittedAt` is the only ordering key available, and
 * getTradeLog() hands entries back NEWEST-FIRST. pairTrades() therefore
 * sorts chronologically itself rather than trusting the caller's order.
 */

/* ------------------------------------------------------------------ *
 * The sample-size floor
 *
 * 30 is the conventional "enough to stop being noise" number. It is a
 * floor, not a finish line: at 30 trades a 60% win rate still has a
 * confidence interval wide enough to include 40%.
 * ------------------------------------------------------------------ */

export const MIN_RELIABLE_SAMPLE = 30;

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round(n, dp = 4) {
  if (n === null || n === undefined || !Number.isFinite(n)) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function ts(v) {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

function mean(values) {
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/* ------------------------------------------------------------------ *
 * Reading an execution out of an order request
 * ------------------------------------------------------------------ */

/**
 * Work out what price and quantity an accepted trade-log entry represents.
 *
 * Returns { price, qty, priceSource, qtySource, approximate, missing }.
 * price/qty are null when the log simply does not contain the information;
 * that is the correct answer and the caller must not paper over it.
 *
 * `fillsByOrderId` is the escape hatch: { [orderId]: {price, qty, at} },
 * built by the caller from Alpaca's own order history. When supplied it
 * wins over everything inferred, and `approximate` goes false.
 */
export function resolveExecution(entry, fillsByOrderId = null) {
  const order = (entry && entry.order) || {};
  const fill =
    fillsByOrderId && entry && entry.orderId ? fillsByOrderId[entry.orderId] : null;

  const orderQty = num(order.qty);
  const notional = num(order.notional);
  const limitPrice = num(order.limit_price);
  const estimatedUsd =
    entry && entry.guardrailContext ? num(entry.guardrailContext.estimatedUsd) : null;

  const fillPrice = fill ? num(fill.price ?? fill.filledAvgPrice) : null;
  const fillQty = fill ? num(fill.qty ?? fill.filledQty) : null;

  let price = null;
  let priceSource = null;

  if (fillPrice !== null && fillPrice > 0) {
    price = fillPrice;
    priceSource = "fill";
  } else if (limitPrice !== null && limitPrice > 0) {
    // A limit price is the worst price accepted, not the price obtained.
    price = limitPrice;
    priceSource = "order_limit_price";
  } else if (
    estimatedUsd !== null &&
    estimatedUsd > 0 &&
    orderQty !== null &&
    orderQty > 0 &&
    notional === null
  ) {
    // estimateOrderValue() priced this off a live quote at submission, so
    // dividing the share count back out recovers that quote. It is a
    // pre-trade quote, not a fill.
    price = estimatedUsd / orderQty;
    priceSource = "guardrail_quote_estimate";
  }

  let qty = null;
  let qtySource = null;

  if (fillQty !== null && fillQty > 0) {
    qty = fillQty;
    qtySource = "fill";
  } else if (orderQty !== null && orderQty > 0) {
    qty = orderQty;
    qtySource = "order_qty";
  } else if (notional !== null && notional > 0 && price !== null && price > 0) {
    qty = notional / price;
    qtySource = "notional_divided_by_price";
  }

  const missing = [];
  if (price === null) {
    missing.push(
      "execution price — the trade log stores the order request, never the fill"
    );
  }
  if (qty === null) {
    missing.push(
      "share quantity — the order was sized in dollars (notional) and no price was recorded to convert it"
    );
  }

  return {
    symbol: String(order.symbol || "").toUpperCase() || null,
    side: String(order.side || "").toLowerCase() || null,
    at: (entry && entry.submittedAt) || (fill && fill.at) || null,
    price,
    qty,
    priceSource,
    qtySource,
    approximate: priceSource !== "fill" || qtySource !== "fill",
    missing
  };
}

/* ------------------------------------------------------------------ *
 * 1. FIFO pairing
 * ------------------------------------------------------------------ */

/**
 * Walk the log chronologically and match sells against buys per symbol,
 * first lot in / first lot out.
 *
 * pairTrades(tradeLog, { fillsByOrderId }) ->
 *   {
 *     closed:    [ round-trip ],
 *     open:      [ lot still held ],
 *     unmatched: [ sell quantity with no lot to close ],
 *     unpriced:  [ accepted order the log cannot price or size ],
 *     counts, missing
 *   }
 *
 * A round-trip is
 *   { symbol, entryAt, exitAt, entryPrice, exitPrice, qty, pnl, pnlPercent,
 *     holdingDays, entryRationale, exitRationale, entryOrderId, exitOrderId,
 *     entryPriceSource, exitPriceSource, approximate }
 *
 * Blocked orders, cancellations and anything that is not an accepted order
 * are skipped — they are decisions, not executions — but they are counted
 * so the caller can see how much of the log was set aside.
 *
 * A sell larger than the tracked lots does NOT invent a lot to close
 * against. The part that matches is closed; the remainder is reported in
 * `unmatched`. Likewise there is no short-side inventory: a sell with no
 * prior buy is entirely unmatched.
 */
export function pairTrades(tradeLog, options = {}) {
  const fills = options.fillsByOrderId || null;
  const entries = Array.isArray(tradeLog) ? tradeLog.slice() : [];

  const counts = {
    entries: entries.length,
    accepted: 0,
    blocked: 0,
    cancelled: 0,
    other: 0,
    unpriced: 0,
    paired: 0
  };

  const usable = [];

  entries.forEach((entry, index) => {
    if (!entry || typeof entry !== "object") {
      counts.other++;
      return;
    }
    if (entry.action === "cancel") {
      counts.cancelled++;
      return;
    }
    if (entry.action !== "order") {
      counts.other++;
      return;
    }
    if (entry.accepted !== true) {
      // Guardrail-blocked orders are a normal outcome and are logged with
      // the same shape as accepted ones. They never executed, so they can
      // never appear in a P&L.
      counts.blocked++;
      return;
    }
    counts.accepted++;
    usable.push({ entry, index });
  });

  // Defensive chronological sort: getTradeLog() returns newest-first, and
  // submittedAt is the only ordering key the log has. Original index is the
  // tie-break, which is the best available for same-millisecond entries.
  usable.sort((a, b) => {
    const ta = ts(a.entry.submittedAt);
    const tb = ts(b.entry.submittedAt);
    const va = ta === null ? Number.MAX_SAFE_INTEGER : ta;
    const vb = tb === null ? Number.MAX_SAFE_INTEGER : tb;
    if (va !== vb) return va - vb;
    return a.index - b.index;
  });

  const lots = new Map(); // symbol -> [ lot, ... ] oldest first
  const closed = [];
  const unmatched = [];
  const unpriced = [];
  let approximateCount = 0;

  for (const { entry } of usable) {
    const exec = resolveExecution(entry, fills);

    if (!exec.symbol || (exec.side !== "buy" && exec.side !== "sell")) {
      unpriced.push({
        orderId: entry.orderId || null,
        symbol: exec.symbol,
        side: exec.side,
        at: exec.at,
        rationale: entry.rationale || null,
        reason: "entry has no usable symbol/side",
        missing: ["symbol", "side"].filter((f) => !exec[f])
      });
      counts.unpriced++;
      continue;
    }

    if (exec.price === null || exec.qty === null) {
      unpriced.push({
        orderId: entry.orderId || null,
        symbol: exec.symbol,
        side: exec.side,
        at: exec.at,
        rationale: entry.rationale || null,
        reason:
          "the log does not record enough to turn this order into a position",
        missing: exec.missing
      });
      counts.unpriced++;
      continue;
    }

    if (exec.approximate) approximateCount++;

    if (exec.side === "buy") {
      if (!lots.has(exec.symbol)) lots.set(exec.symbol, []);
      lots.get(exec.symbol).push({
        symbol: exec.symbol,
        at: exec.at,
        price: exec.price,
        qty: exec.qty,
        rationale: entry.rationale || null,
        orderId: entry.orderId || null,
        priceSource: exec.priceSource,
        approximate: exec.approximate
      });
      continue;
    }

    // sell
    let remaining = exec.qty;
    const queue = lots.get(exec.symbol) || [];

    while (remaining > 1e-9 && queue.length > 0) {
      const lot = queue[0];
      const take = Math.min(remaining, lot.qty);

      const entryT = ts(lot.at);
      const exitT = ts(exec.at);
      const pnl = (exec.price - lot.price) * take;

      closed.push({
        symbol: exec.symbol,
        entryAt: lot.at,
        exitAt: exec.at,
        entryPrice: round(lot.price, 6),
        exitPrice: round(exec.price, 6),
        qty: round(take, 6),
        pnl: round(pnl, 6),
        pnlPercent: lot.price ? round(((exec.price - lot.price) / lot.price) * 100, 6) : null,
        holdingDays:
          entryT !== null && exitT !== null ? round((exitT - entryT) / 86400000, 6) : null,
        entryRationale: lot.rationale,
        exitRationale: entry.rationale || null,
        entryOrderId: lot.orderId,
        exitOrderId: entry.orderId || null,
        entryPriceSource: lot.priceSource,
        exitPriceSource: exec.priceSource,
        approximate: Boolean(lot.approximate || exec.approximate)
      });

      counts.paired++;
      remaining -= take;
      lot.qty -= take;
      if (lot.qty <= 1e-9) queue.shift();
    }

    if (remaining > 1e-9) {
      // More sold than we ever tracked buying. The honest record is "this
      // quantity has no matching lot", not a fabricated entry price.
      unmatched.push({
        symbol: exec.symbol,
        at: exec.at,
        qty: round(remaining, 6),
        price: round(exec.price, 6),
        orderId: entry.orderId || null,
        rationale: entry.rationale || null,
        reason:
          "sell quantity exceeds the lots this log accounts for (position opened before the log began, opened outside this agent, or an unpriced notional buy) — no entry price was invented for it"
      });
    }
  }

  const open = [];
  for (const queue of lots.values()) {
    for (const lot of queue) {
      open.push({
        symbol: lot.symbol,
        entryAt: lot.at,
        entryPrice: round(lot.price, 6),
        qty: round(lot.qty, 6),
        entryRationale: lot.rationale,
        entryOrderId: lot.orderId,
        entryPriceSource: lot.priceSource,
        approximate: lot.approximate
      });
    }
  }

  const missing = [];
  if (counts.unpriced > 0) {
    missing.push(
      `${counts.unpriced} accepted order(s) could not be paired: the trade log records no fill price or share count for them. Autotrader buys are sized in dollars (notional) and placed at market, so neither number exists in the log.`
    );
  }
  if (unmatched.length > 0) {
    missing.push(
      `${unmatched.length} sell(s) had no matching lot, so their result is unknown and is excluded from every statistic below.`
    );
  }
  if (approximateCount > 0 && !fills) {
    missing.push(
      "No fill data was supplied, so prices here are inferred from the order request (limit price, or the pre-trade quote behind guardrailContext.estimatedUsd). Real slippage is not visible."
    );
  }

  return { closed, open, unmatched, unpriced, counts, missing };
}

/* ------------------------------------------------------------------ *
 * 2. R multiples
 * ------------------------------------------------------------------ */

function lookupStop(lookup, trade) {
  if (!lookup || !trade) return null;

  if (typeof lookup === "function") {
    return num(lookup(trade.symbol, trade.entryAt, trade));
  }
  if (typeof lookup !== "object") return null;

  const keyed =
    lookup[`${trade.symbol}@${trade.entryAt}`] ??
    lookup[`${trade.symbol}|${trade.entryAt}`] ??
    lookup[trade.symbol];

  if (keyed === null || keyed === undefined) return null;

  if (Array.isArray(keyed)) {
    // [{ at, stopPrice }, ...] — e.g. flattened from autotrader run records.
    // Only a stop that was already known at entry counts; a later one is
    // hindsight, not the risk that was actually taken.
    const entryT = ts(trade.entryAt);
    let best = null;
    for (const row of keyed) {
      if (!row) continue;
      const sp = num(row.stopPrice ?? row.stop_price ?? row.price);
      if (sp === null) continue;
      const rowT = ts(row.at ?? row.startedAt ?? row.submittedAt);
      if (entryT !== null && rowT !== null && rowT > entryT) continue;
      if (best === null || (rowT ?? -Infinity) >= (best.t ?? -Infinity)) {
        best = { t: rowT, sp };
      }
    }
    return best ? best.sp : null;
  }

  if (typeof keyed === "object") {
    return num(keyed.stopPrice ?? keyed.stop_price ?? keyed.price);
  }

  return num(keyed);
}

/**
 * Express each closed trade as a multiple of what was risked on it.
 *
 * rMultiples(closedTrades, { stopPriceBySymbolAt }) ->
 *   { results, count, withStop, coverage, avgR, missing }
 *
 * `stopPriceBySymbolAt` may be a function (symbol, entryAt, trade) => price,
 * a map of symbol -> price, symbol -> {stopPrice}, symbol -> [{at, stopPrice}],
 * or a map keyed "SYMBOL@entryAt". It has to be supplied because the trade
 * log does not contain it: a market order never writes stop_price, so the
 * stop the signal chose survives only in the autotrader run record.
 *
 * Where the stop is unknown, r is null. It is not replaced with an assumed
 * stop distance, and those trades are excluded from avgR rather than
 * quietly averaged in — which is why `coverage` is reported alongside it.
 */
export function rMultiples(closedTrades, options = {}) {
  const trades = Array.isArray(closedTrades) ? closedTrades : [];
  const lookup = options.stopPriceBySymbolAt;

  const results = trades.map((t) => {
    const base = {
      symbol: t && t.symbol ? t.symbol : null,
      entryAt: t ? t.entryAt ?? null : null,
      exitAt: t ? t.exitAt ?? null : null,
      pnlPercent: t ? (t.pnlPercent ?? null) : null,
      stopPrice: null,
      riskPerShare: null,
      r: null,
      missing: []
    };

    if (!t) {
      base.missing.push("trade record is empty");
      return base;
    }

    const entryPrice = num(t.entryPrice);
    const exitPrice = num(t.exitPrice);
    if (entryPrice === null || exitPrice === null) {
      base.missing.push("entry or exit price is missing from the round-trip");
      return base;
    }

    const stopPrice = lookupStop(lookup, t);
    if (stopPrice === null) {
      base.missing.push(
        "original stop price unknown — the trade log does not store the stop for a market order, so it has to come from the autotrader run record"
      );
      return base;
    }

    base.stopPrice = round(stopPrice, 6);

    const risk = entryPrice - stopPrice;
    if (!(risk > 0)) {
      base.missing.push(
        "stop price is at or above the entry price, so the amount risked per share is zero or negative and an R multiple is undefined"
      );
      return base;
    }

    base.riskPerShare = round(risk, 6);
    base.r = round((exitPrice - entryPrice) / risk, 6);
    return base;
  });

  const withR = results.filter((x) => x.r !== null);
  const missing = [];

  if (trades.length === 0) {
    missing.push("no closed trades to express in R");
  } else if (withR.length === 0) {
    missing.push(
      "no closed trade had a known stop price, so no result here can be expressed in R"
    );
  } else if (withR.length < trades.length) {
    missing.push(
      `${trades.length - withR.length} of ${trades.length} closed trade(s) had no known stop price and are excluded from avgR`
    );
  }

  return {
    results,
    count: trades.length,
    withStop: withR.length,
    coverage: trades.length ? round(withR.length / trades.length, 6) : 0,
    avgR: withR.length ? round(mean(withR.map((x) => x.r)), 6) : null,
    missing
  };
}

/**
 * Copies of the closed trades with { stopPrice, riskPerShare, r } attached,
 * so summarize()/breakdown() can report R without recomputing it. The input
 * objects are not touched.
 */
export function withRMultiples(closedTrades, options = {}) {
  const trades = Array.isArray(closedTrades) ? closedTrades : [];
  const { results } = rMultiples(trades, options);
  return trades.map((t, i) => ({
    ...t,
    stopPrice: results[i].stopPrice,
    riskPerShare: results[i].riskPerShare,
    r: results[i].r
  }));
}

/* ------------------------------------------------------------------ *
 * 3. Summary
 * ------------------------------------------------------------------ */

function caveatFor(count) {
  if (count === 0) {
    return "No closed round-trips, so there is nothing to measure. Zero trades is not a zero result — it is an absence of evidence, and no claim about performance can be made from it.";
  }
  if (count < 5) {
    return `Based on ${count} closed trade(s). This is anecdote, not measurement: at this size a 100% win rate is the single most ordinary thing luck produces, and none of these numbers distinguishes a working system from a coin. Do not size positions on them and do not quote them without this sentence.`;
  }
  if (count < MIN_RELIABLE_SAMPLE) {
    return `Based on ${count} closed trades, below the ${MIN_RELIABLE_SAMPLE}-trade floor where these statistics stop being noise. The most likely explanation for this result — good or bad — is still luck. Treat it as a hypothesis about the system, not a measurement of it.`;
  }
  return `Based on ${count} closed trades, which clears the conventional ${MIN_RELIABLE_SAMPLE}-trade floor. That floor is the point at which the numbers stop being pure noise, NOT the point at which they prove an edge: at this size the confidence interval around a win rate is still tens of percentage points wide, and the sample may simply reflect one market regime. Nothing here forecasts future trades.`;
}

/**
 * summarize(closedTrades, { stopPriceBySymbolAt }) ->
 *   { count, sampleSize, reliable, caveat, wins, losses, breakEven, winRate,
 *     avgWinPercent, avgLossPercent, profitFactor, expectancyPercent,
 *     avgHoldingDays, bestTrade, worstTrade, totalPnl, avgR, rCoverage,
 *     missing }
 *
 * Conventions, stated because they change the numbers:
 *   - win = pnl > 0, loss = pnl < 0, break-even = pnl === 0. Break-evens
 *     count in the denominator of winRate but in neither average.
 *   - winRate is a fraction (0..1), null when there are no trades. It is
 *     not 0, because 0 would read as "measured a 0% win rate".
 *   - profitFactor is gross profit / gross loss, and is null when there is
 *     no loss to divide by. Infinity is not a performance figure.
 *   - best/worst are ranked by pnlPercent, so position size does not decide
 *     which trade looks best.
 */
export function summarize(closedTrades, options = {}) {
  const raw = Array.isArray(closedTrades) ? closedTrades : [];
  const trades = options.stopPriceBySymbolAt
    ? withRMultiples(raw, options)
    : raw;

  const count = trades.length;
  const missing = [];

  const base = {
    count,
    sampleSize: count,
    reliable: count >= MIN_RELIABLE_SAMPLE,
    caveat: caveatFor(count),
    wins: 0,
    losses: 0,
    breakEven: 0,
    winRate: null,
    avgWinPercent: null,
    avgLossPercent: null,
    profitFactor: null,
    expectancyPercent: null,
    avgHoldingDays: null,
    bestTrade: null,
    worstTrade: null,
    totalPnl: 0,
    avgR: null,
    rCoverage: 0,
    missing
  };

  if (count === 0) {
    missing.push("no closed trades in this sample");
    return base;
  }

  const winners = [];
  const losers = [];
  const evens = [];
  let totalPnl = 0;
  let pnlUnknown = 0;

  for (const t of trades) {
    const pnl = num(t && t.pnl);
    if (pnl === null) {
      pnlUnknown++;
      continue;
    }
    totalPnl += pnl;
    if (pnl > 0) winners.push(t);
    else if (pnl < 0) losers.push(t);
    else evens.push(t);
  }

  const scored = winners.length + losers.length + evens.length;
  if (pnlUnknown > 0) {
    missing.push(
      `${pnlUnknown} of ${count} trade(s) carry no P&L and are excluded from every ratio below`
    );
  }

  base.wins = winners.length;
  base.losses = losers.length;
  base.breakEven = evens.length;
  base.totalPnl = round(totalPnl, 6);
  base.winRate = scored > 0 ? round(winners.length / scored, 6) : null;

  const winPercents = winners.map((t) => num(t.pnlPercent)).filter((n) => n !== null);
  const lossPercents = losers.map((t) => num(t.pnlPercent)).filter((n) => n !== null);

  base.avgWinPercent = winPercents.length ? round(mean(winPercents), 6) : null;
  base.avgLossPercent = lossPercents.length ? round(mean(lossPercents), 6) : null;

  // Profit factor. No losses means no denominator — that is "undefined",
  // not "infinitely good", and a run of winners is exactly when a system
  // most wants to be described as infinitely good.
  const grossProfit = winners.reduce((a, t) => a + (num(t.pnl) || 0), 0);
  const grossLoss = Math.abs(losers.reduce((a, t) => a + (num(t.pnl) || 0), 0));

  if (scored === 0) {
    base.profitFactor = null;
    missing.push("no trade had a usable P&L, so profit factor is undefined");
  } else if (grossLoss === 0) {
    base.profitFactor = null;
    missing.push(
      "profit factor is undefined: this sample contains no losing trade, so there is nothing to divide by. That is a fact about the sample's size, not evidence of a system that does not lose."
    );
  } else {
    base.profitFactor = round(grossProfit / grossLoss, 6);
  }

  // Expectancy in percentage terms: winRate*avgWin + (1-winRate)*avgLoss.
  // With no losers the (1-winRate) population is break-evens, whose
  // pnlPercent is exactly 0 by construction (exit === entry), so using 0
  // there is arithmetic rather than an assumed default.
  if (base.winRate !== null && base.avgWinPercent !== null) {
    const avgLoss = base.avgLossPercent === null ? 0 : base.avgLossPercent;
    base.expectancyPercent = round(
      base.winRate * base.avgWinPercent + (1 - base.winRate) * avgLoss,
      6
    );
  } else if (base.winRate !== null && base.avgLossPercent !== null) {
    base.expectancyPercent = round((1 - base.winRate) * base.avgLossPercent, 6);
  } else {
    base.expectancyPercent = null;
    missing.push("expectancy is undefined: no trade carried a percentage result");
  }

  const holdings = trades.map((t) => num(t && t.holdingDays)).filter((n) => n !== null);
  base.avgHoldingDays = holdings.length ? round(mean(holdings), 6) : null;
  if (holdings.length === 0) {
    missing.push("no trade carried usable entry/exit timestamps, so holding time is unknown");
  } else if (holdings.length < count) {
    missing.push(
      `holding time is known for ${holdings.length} of ${count} trade(s); the average covers only those`
    );
  }

  const ranked = trades
    .filter((t) => num(t && t.pnlPercent) !== null)
    .slice()
    .sort((a, b) => num(b.pnlPercent) - num(a.pnlPercent));

  const describe = (t) =>
    t
      ? {
          symbol: t.symbol ?? null,
          entryAt: t.entryAt ?? null,
          exitAt: t.exitAt ?? null,
          pnl: num(t.pnl),
          pnlPercent: num(t.pnlPercent)
        }
      : null;

  base.bestTrade = ranked.length ? describe(ranked[0]) : null;
  base.worstTrade = ranked.length ? describe(ranked[ranked.length - 1]) : null;

  const rs = trades.map((t) => num(t && t.r)).filter((n) => n !== null);
  base.avgR = rs.length ? round(mean(rs), 6) : null;
  base.rCoverage = count ? round(rs.length / count, 6) : 0;

  if (rs.length === 0) {
    missing.push(
      "no trade has a known original stop price, so risk-adjusted results (R) cannot be computed for any of them"
    );
  } else if (rs.length < count) {
    missing.push(
      `avgR covers ${rs.length} of ${count} trade(s); the rest had no recorded stop and were left out rather than assigned a guessed one`
    );
  }

  return base;
}

/* ------------------------------------------------------------------ *
 * 4. Equity curve and drawdown
 * ------------------------------------------------------------------ */

/**
 * Cumulative REALISED equity after each closed trade. Open positions are
 * not marked to market here — this curve is what the closed trades did,
 * nothing else.
 *
 * The first point is the starting equity itself (index 0, no trade), so a
 * drawdown measured from the opening balance is visible instead of being
 * silently anchored to the first trade's result.
 */
export function equityCurve(closedTrades, startingEquity = 0) {
  const start = num(startingEquity) ?? 0;
  const trades = (Array.isArray(closedTrades) ? closedTrades.slice() : []).sort((a, b) => {
    const ta = ts(a && a.exitAt);
    const tb = ts(b && b.exitAt);
    const va = ta === null ? Number.MAX_SAFE_INTEGER : ta;
    const vb = tb === null ? Number.MAX_SAFE_INTEGER : tb;
    return va - vb;
  });

  const curve = [
    {
      index: 0,
      at: null,
      symbol: null,
      pnl: 0,
      cumulativePnl: 0,
      equity: round(start, 6)
    }
  ];

  let cumulative = 0;
  trades.forEach((t, i) => {
    const pnl = num(t && t.pnl) ?? 0;
    cumulative += pnl;
    curve.push({
      index: i + 1,
      at: (t && t.exitAt) ?? null,
      symbol: (t && t.symbol) ?? null,
      pnl: round(pnl, 6),
      cumulativePnl: round(cumulative, 6),
      equity: round(start + cumulative, 6)
    });
  });

  return curve;
}

/**
 * Largest peak-to-trough fall in an equity curve.
 * Accepts the output of equityCurve(), or a plain array of numbers.
 *
 * -> { peak, trough, drawdown, drawdownPercent, peakAt, troughAt,
 *      peakIndex, troughIndex, sampleSize, caveat, missing }
 */
export function maxDrawdown(curve) {
  const points = (Array.isArray(curve) ? curve : []).map((p, i) =>
    typeof p === "number"
      ? { index: i, at: null, equity: p }
      : {
          index: p && p.index !== undefined ? p.index : i,
          at: (p && p.at) ?? null,
          equity: num(p && p.equity)
        }
  );

  const usable = points.filter((p) => p.equity !== null);
  const missing = [];

  if (usable.length === 0) {
    missing.push("no equity points, so no drawdown can be computed");
    return {
      peak: null,
      trough: null,
      drawdown: null,
      drawdownPercent: null,
      peakAt: null,
      troughAt: null,
      peakIndex: null,
      troughIndex: null,
      sampleSize: 0,
      caveat:
        "No equity curve to measure. An absent drawdown is not a drawdown of zero.",
      missing
    };
  }

  let peak = usable[0];
  let best = null; // largest fall found so far

  for (const p of usable) {
    if (p.equity > peak.equity) peak = p;
    const fall = peak.equity - p.equity;
    if (fall > 0 && (best === null || fall > best.drawdown)) {
      best = { peak, trough: p, drawdown: fall };
    }
  }

  if (best === null) {
    return {
      peak: round(peak.equity, 6),
      trough: round(peak.equity, 6),
      drawdown: 0,
      drawdownPercent: 0,
      peakAt: peak.at,
      troughAt: peak.at,
      peakIndex: peak.index,
      troughIndex: peak.index,
      sampleSize: usable.length,
      caveat:
        "This curve never fell below a previous high. That is a property of this short, already-finished sample; the maximum drawdown of a live system is always the one that has not happened yet.",
      missing
    };
  }

  const drawdownPercent =
    best.peak.equity > 0 ? (best.drawdown / best.peak.equity) * 100 : null;

  if (drawdownPercent === null) {
    missing.push(
      "drawdown percent is undefined because the peak equity was zero or negative"
    );
  }

  return {
    peak: round(best.peak.equity, 6),
    trough: round(best.trough.equity, 6),
    drawdown: round(best.drawdown, 6),
    drawdownPercent: round(drawdownPercent, 6),
    peakAt: best.peak.at,
    troughAt: best.trough.at,
    peakIndex: best.peak.index,
    troughIndex: best.trough.index,
    sampleSize: usable.length,
    caveat:
      "The worst drawdown observed so far is a lower bound on the worst drawdown possible, and the shorter the sample the looser that bound. It is never a limit on future losses.",
    missing
  };
}

/* ------------------------------------------------------------------ *
 * 5. Breakdown
 * ------------------------------------------------------------------ */

/** Key helpers for the usual views. Each returns null when unknowable. */
export function keyBySymbol(trade) {
  return trade && trade.symbol ? String(trade.symbol) : null;
}

export function keyByRegime(trade) {
  return parseRegime(trade);
}

/** Ten-wide confidence buckets; the top one is 90-100 so 100 has a home. */
function confidenceBucket(confidence) {
  const low = Math.min(90, Math.floor(confidence / 10) * 10);
  const high = low === 90 ? 100 : low + 9;
  return { key: `${low}-${high}`, low, high };
}

export function keyByConfidenceBucket(trade) {
  const c = parseConfidence(trade);
  if (c === null) return null;
  return confidenceBucket(c).key;
}

/**
 * breakdown(closedTrades, keyFn) -> { groups, groupCount, ungrouped, caveat, missing }
 *
 * keyFn may be a function (trade) => key, or a property name. Trades whose
 * key cannot be determined are counted in `ungrouped` rather than swept
 * into an "unknown" bucket that would look like a real category.
 *
 * Each group carries a full summarize() result, so every group brings its
 * own sample size, reliable flag and caveat with it. That matters more
 * here than anywhere else: slicing a small sample makes every slice
 * smaller, and the best-looking group in a breakdown is usually the
 * luckiest rather than the best.
 */
export function breakdown(closedTrades, keyFn, options = {}) {
  const trades = Array.isArray(closedTrades) ? closedTrades : [];
  const resolve =
    typeof keyFn === "function"
      ? keyFn
      : typeof keyFn === "string"
        ? (t) => (t ? t[keyFn] : null)
        : keyBySymbol;

  const buckets = new Map();
  let ungrouped = 0;

  for (const t of trades) {
    let key = null;
    try {
      key = resolve(t);
    } catch (e) {
      key = null;
    }
    if (key === null || key === undefined || key === "") {
      ungrouped++;
      continue;
    }
    const k = String(key);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(t);
  }

  const groups = Array.from(buckets.entries())
    .map(([key, members]) => ({
      key,
      count: members.length,
      summary: summarize(members, options)
    }))
    .sort((a, b) => (b.count - a.count) || a.key.localeCompare(b.key));

  const missing = [];
  if (ungrouped > 0) {
    missing.push(
      `${ungrouped} trade(s) had no value for this key and are in no group; they are counted here rather than filed under a made-up bucket`
    );
  }
  if (groups.length && groups.every((g) => !g.summary.reliable)) {
    missing.push(
      `no group reaches ${MIN_RELIABLE_SAMPLE} closed trades, so no group's numbers can be compared against another's`
    );
  }

  return {
    groups,
    groupCount: groups.length,
    ungrouped,
    total: trades.length,
    caveat: `Splitting ${trades.length} trade(s) across ${groups.length} group(s) makes every group smaller than the whole, and the whole was already small. Ranking these groups selects for luck: the highest win rate here is most likely the group that happened to get the kindest few trades, not the one the system is best at.`,
    missing
  };
}

/* ------------------------------------------------------------------ *
 * 6. Confidence calibration
 * ------------------------------------------------------------------ */

/**
 * The confidence the signal claimed at entry.
 *
 * scoreSymbol() puts it in the reason string ("...confidence 71%...") and
 * autotrader passes that through as the order rationale, prefixed with
 * "[autotrader <aggressiveness>] ". The trade log stores the rationale as
 * free text and nothing parses it, so this is where the number has to come
 * from — unless a caller has already attached a numeric `confidence`.
 */
export function parseConfidence(trade) {
  if (!trade) return null;

  const explicit = num(trade.confidence);
  if (explicit !== null && explicit >= 0 && explicit <= 100) return explicit;

  const text = trade.entryRationale || trade.rationale || null;
  if (typeof text !== "string") return null;

  const m = text.match(/confidence\s*[:=]?\s*(\d{1,3}(?:\.\d+)?)\s*%/i);
  if (!m) return null;

  const v = Number(m[1]);
  if (!Number.isFinite(v) || v < 0 || v > 100) return null;
  return v;
}

/** The regime the signal claimed at entry, from the same rationale string. */
export function parseRegime(trade) {
  if (!trade) return null;
  if (typeof trade.regime === "string" && trade.regime) return trade.regime.toLowerCase();

  const text = trade.entryRationale || trade.rationale || null;
  if (typeof text !== "string") return null;

  const m = text.match(/\b(trending|ranging)\s+regime\b/i);
  return m ? m[1].toLowerCase() : null;
}

/**
 * confidenceCalibration(closedTrades) ->
 *   { available, total, parsed, coverage, buckets, reliable, caveat,
 *     note, missing }
 *
 * Buckets trades by the confidence stated at entry and reports what
 * actually happened in each. The point is to expose whether that stated
 * confidence corresponds to anything: it is produced by an indicator
 * formula (component agreement times coverage), and has never been checked
 * against outcomes. A well-calibrated 70% bucket would win about 70% of
 * the time. Nothing here asserts that it does.
 *
 * Returns an empty result — not zeros — when no trade carries a confidence.
 */
export function confidenceCalibration(closedTrades) {
  const trades = Array.isArray(closedTrades) ? closedTrades : [];
  const total = trades.length;

  const withConfidence = [];
  for (const t of trades) {
    const c = parseConfidence(t);
    if (c !== null) withConfidence.push({ trade: t, confidence: c });
  }

  const parsed = withConfidence.length;
  const missing = [];
  const note =
    "Calibration is a claim about frequencies, so it needs many trades in EACH bucket before a difference between buckets means anything. Below the " +
    `${MIN_RELIABLE_SAMPLE}-trade floor a bucket's win rate is a coin-flip result with a label on it.`;

  if (parsed === 0) {
    missing.push(
      total === 0
        ? "no closed trades to calibrate"
        : "no closed trade carries a confidence value: the rationale stored with these orders does not contain one, and nothing else in the trade log records what the signal claimed"
    );
    return {
      available: false,
      total,
      parsed: 0,
      coverage: 0,
      buckets: [],
      reliable: false,
      caveat:
        "No stated-confidence data, so there is nothing to calibrate. This is an absence of data, not a finding that confidence is uninformative.",
      note,
      missing
    };
  }

  if (parsed < total) {
    missing.push(
      `confidence was recoverable for ${parsed} of ${total} trade(s); the rest are excluded rather than assigned a default confidence`
    );
  }

  const byBucket = new Map();
  for (const row of withConfidence) {
    const { key, low, high } = confidenceBucket(row.confidence);
    if (!byBucket.has(key)) byBucket.set(key, { low, high, rows: [] });
    byBucket.get(key).rows.push(row);
  }

  const buckets = Array.from(byBucket.entries())
    .map(([bucket, info]) => {
      const members = info.rows.map((r) => r.trade);
      const summary = summarize(members);
      const confidences = info.rows.map((r) => r.confidence);
      return {
        bucket,
        low: info.low,
        high: info.high,
        count: members.length,
        sampleSize: members.length,
        wins: summary.wins,
        losses: summary.losses,
        winRate: summary.winRate,
        statedConfidenceAvg: round(mean(confidences), 6),
        avgPnlPercent: (() => {
          const ps = members.map((t) => num(t && t.pnlPercent)).filter((n) => n !== null);
          return ps.length ? round(mean(ps), 6) : null;
        })(),
        reliable: summary.reliable,
        caveat: summary.caveat
      };
    })
    .sort((a, b) => a.low - b.low);

  const reliable = buckets.length > 0 && buckets.every((b) => b.reliable);

  return {
    available: true,
    total,
    parsed,
    coverage: total ? round(parsed / total, 6) : 0,
    buckets,
    reliable,
    caveat: reliable
      ? `Every bucket holds at least ${MIN_RELIABLE_SAMPLE} trades, which is the minimum for the comparison to be worth looking at — not a guarantee that the ordering between buckets is real.`
      : `At least one bucket holds fewer than ${MIN_RELIABLE_SAMPLE} trades. Any relationship between stated confidence and actual win rate shown here is consistent with pure chance, including a perfectly monotonic one.`,
    note,
    missing
  };
}
