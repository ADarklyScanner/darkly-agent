/**
 * Tests for performance.js — run with: node performance.test.mjs
 *
 * This module exists to stop the trade log being read optimistically, so
 * the tests are mostly about what it REFUSES to say: no invented entry
 * price for a sell that has no lot, no Infinity dressed up as a profit
 * factor, no zero standing in for a missing measurement, and no win rate
 * presentable without the sample size that produced it.
 *
 * Every fixture is hand-built and deterministic. The trade-log entries
 * below are the exact shape logTrade() writes in trading.js — including
 * the string-typed numbers, the accepted/blocked split, and the
 * dollar-sized market buy that autotrader.js actually places.
 */

import {
  pairTrades,
  rMultiples,
  withRMultiples,
  summarize,
  equityCurve,
  maxDrawdown,
  breakdown,
  confidenceCalibration,
  parseConfidence,
  parseRegime,
  keyBySymbol,
  keyByRegime,
  keyByConfidenceBucket,
  resolveExecution,
  MIN_RELIABLE_SAMPLE
} from "./performance.js";

let pass = 0;
let fail = 0;

function check(label, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ok   ${label}`);
  } else {
    fail++;
    console.log(`  FAIL ${label} ${detail}`);
  }
}

const near = (a, b, tol = 1e-6) =>
  typeof a === "number" && Number.isFinite(a) && Math.abs(a - b) <= tol;

/** Finds the first non-finite number anywhere in a structure. */
function findNaN(value, path = "$") {
  if (typeof value === "number") return Number.isFinite(value) ? null : path;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const r = findNaN(value[i], `${path}[${i}]`);
      if (r) return r;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      const r = findNaN(v, `${path}.${k}`);
      if (r) return r;
    }
    return null;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Fixtures — the real log shapes
 * ------------------------------------------------------------------ */

const day = (n) => new Date(Date.UTC(2026, 0, n)).toISOString();

/** An accepted limit order: the only shape whose price the log preserves. */
function accepted({ symbol, side, qty, price, at, rationale = null }) {
  return {
    action: "order",
    accepted: true,
    orderId: `${symbol}-${side}-${qty}-${at}`,
    order: {
      symbol,
      side,
      type: "limit",
      time_in_force: "day",
      qty: String(qty),
      limit_price: String(price)
    },
    rationale,
    guardrailContext: { tradesToday: 1, estimatedUsd: qty * price, dayPnl: 0 },
    submittedAt: at,
    mode: "PAPER"
  };
}

/** A guardrail-blocked order. Logged identically, but never executed. */
function blocked({ symbol, side, qty, price, at, rationale = null }) {
  return {
    action: "order",
    accepted: false,
    order: {
      symbol,
      side,
      type: "limit",
      time_in_force: "day",
      qty: String(qty),
      limit_price: String(price)
    },
    rationale,
    blockedBy: [`Daily trade limit reached (10/10).`],
    submittedAt: at
  };
}

const cancellation = (at) => ({
  action: "cancel",
  orderId: "cancelled-order",
  submittedAt: at,
  accepted: true
});

/** What autotrader.js really places: market buy sized in dollars. */
function notionalMarketBuy({ symbol, notional, at, rationale = null }) {
  return {
    action: "order",
    accepted: true,
    orderId: `${symbol}-notional-${at}`,
    order: {
      symbol,
      side: "buy",
      type: "market",
      time_in_force: "day",
      notional: String(notional)
    },
    rationale,
    guardrailContext: { tradesToday: 1, estimatedUsd: notional, dayPnl: 0 },
    submittedAt: at,
    mode: "PAPER"
  };
}

/** A hand-made round-trip, for the statistics tests. */
function trade({ symbol = "SYN", pnlPercent, entry = 100, qty = 10, n = 1, rationale = null }) {
  const exit = entry * (1 + pnlPercent / 100);
  return {
    symbol,
    entryAt: day(n),
    exitAt: day(n + 2),
    entryPrice: entry,
    exitPrice: exit,
    qty,
    pnl: (exit - entry) * qty,
    pnlPercent,
    holdingDays: 2,
    entryRationale: rationale,
    exitRationale: null
  };
}

const rationaleFor = (confidence, regime = "Trending") =>
  `[autotrader moderate] Score 64.2/100, confidence ${confidence}%. ${regime} regime: following direction. RSI 58, 20d above 50d, MACD positive.`;

/* ------------------------------------------------------------------ */

console.log("\nFIFO pairing across interleaved symbols");

const interleaved = [
  accepted({ symbol: "AAPL", side: "buy", qty: 10, price: 100, at: day(1), rationale: rationaleFor(71) }),
  accepted({ symbol: "MSFT", side: "buy", qty: 5, price: 200, at: day(2), rationale: rationaleFor(58, "Ranging") }),
  accepted({ symbol: "AAPL", side: "buy", qty: 10, price: 120, at: day(3), rationale: rationaleFor(83) }),
  blocked({ symbol: "NVDA", side: "buy", qty: 10, price: 300, at: day(3), rationale: rationaleFor(90) }),
  accepted({ symbol: "AAPL", side: "sell", qty: 10, price: 130, at: day(4) }),
  cancellation(day(4)),
  accepted({ symbol: "MSFT", side: "sell", qty: 5, price: 180, at: day(5) }),
  accepted({ symbol: "AAPL", side: "sell", qty: 10, price: 110, at: day(6) })
];

const paired = pairTrades(interleaved);

check("three round-trips closed", paired.closed.length === 3, `got ${paired.closed.length}`);
check("nothing left open", paired.open.length === 0, `got ${paired.open.length}`);
check("no unmatched sells", paired.unmatched.length === 0);

check(
  "first AAPL sell closes the OLDEST AAPL lot (100, not 120)",
  paired.closed[0].symbol === "AAPL" && paired.closed[0].entryPrice === 100,
  `got ${paired.closed[0].symbol} @ ${paired.closed[0].entryPrice}`
);
check("second AAPL sell closes the 120 lot", paired.closed[2].entryPrice === 120,
  `got ${paired.closed[2].entryPrice}`);
check("MSFT is paired against MSFT, not AAPL",
  paired.closed[1].symbol === "MSFT" && paired.closed[1].entryPrice === 200);

check("winning trade P&L", near(paired.closed[0].pnl, 300), `got ${paired.closed[0].pnl}`);
check("winning trade percent", near(paired.closed[0].pnlPercent, 30), `got ${paired.closed[0].pnlPercent}`);
check("holding days from the timestamps", near(paired.closed[0].holdingDays, 3),
  `got ${paired.closed[0].holdingDays}`);
check("losing trade P&L", near(paired.closed[1].pnl, -100), `got ${paired.closed[1].pnl}`);
check("third trade percent", near(paired.closed[2].pnlPercent, -8.333333, 1e-5),
  `got ${paired.closed[2].pnlPercent}`);

check("entry rationale is carried onto the round-trip",
  /confidence 71%/.test(paired.closed[0].entryRationale || ""), paired.closed[0].entryRationale);

check("blocked order is skipped, not traded", paired.counts.blocked === 1, `got ${paired.counts.blocked}`);
check("cancellation is skipped", paired.counts.cancelled === 1, `got ${paired.counts.cancelled}`);
check("no NVDA anywhere (it was blocked)",
  !JSON.stringify(paired.closed.concat(paired.open)).includes("NVDA"));
check("accepted orders counted", paired.counts.accepted === 6, `got ${paired.counts.accepted}`);
check("every closed trade is marked approximate (no fills are logged)",
  paired.closed.every((t) => t.approximate === true));

// getTradeLog() hands entries back newest-first, so the order of the input
// must not be able to change the pairing.
const reversed = pairTrades(interleaved.slice().reverse());
check("newest-first input pairs identically",
  JSON.stringify(reversed.closed) === JSON.stringify(paired.closed));

/* ------------------------------------------------------------------ */

console.log("\nPartial exits");

const partialOpen = pairTrades([
  accepted({ symbol: "NVDA", side: "buy", qty: 10, price: 50, at: day(1) }),
  accepted({ symbol: "NVDA", side: "sell", qty: 4, price: 60, at: day(2) })
]);

check("partial sell closes only the sold quantity",
  partialOpen.closed.length === 1 && partialOpen.closed[0].qty === 4,
  `got qty ${partialOpen.closed[0] && partialOpen.closed[0].qty}`);
check("partial sell P&L covers 4 shares only", near(partialOpen.closed[0].pnl, 40),
  `got ${partialOpen.closed[0].pnl}`);
check("the rest of the lot stays open",
  partialOpen.open.length === 1 && partialOpen.open[0].qty === 6,
  `got ${JSON.stringify(partialOpen.open)}`);
check("the open remainder keeps its original entry price",
  partialOpen.open[0].entryPrice === 50);

const partialClosed = pairTrades([
  accepted({ symbol: "NVDA", side: "buy", qty: 10, price: 50, at: day(1) }),
  accepted({ symbol: "NVDA", side: "sell", qty: 4, price: 60, at: day(2) }),
  accepted({ symbol: "NVDA", side: "sell", qty: 6, price: 40, at: day(5) })
]);

check("draining the lot produces two round-trips", partialClosed.closed.length === 2);
check("both halves share the same entry price",
  partialClosed.closed.every((t) => t.entryPrice === 50));
check("second half P&L", near(partialClosed.closed[1].pnl, -60), `got ${partialClosed.closed[1].pnl}`);
check("quantities sum back to the original lot",
  near(partialClosed.closed.reduce((a, t) => a + t.qty, 0), 10));
check("nothing left open once drained", partialClosed.open.length === 0);

/* ------------------------------------------------------------------ */

console.log("\nOversized sells are unmatched, never invented");

const oversized = pairTrades([
  accepted({ symbol: "TSLA", side: "buy", qty: 5, price: 100, at: day(1) }),
  accepted({ symbol: "TSLA", side: "sell", qty: 8, price: 110, at: day(2) })
]);

check("only the tracked quantity is closed",
  oversized.closed.length === 1 && oversized.closed[0].qty === 5,
  `got ${JSON.stringify(oversized.closed.map((t) => t.qty))}`);
check("closed P&L covers 5 shares, not 8", near(oversized.closed[0].pnl, 50),
  `got ${oversized.closed[0].pnl}`);
check("the excess is recorded as unmatched", oversized.unmatched.length === 1);
check("unmatched carries the leftover quantity", near(oversized.unmatched[0].qty, 3),
  `got ${oversized.unmatched[0].qty}`);
check("unmatched has no invented entry price",
  !("entryPrice" in oversized.unmatched[0]) && oversized.unmatched[0].price === 110);
check("unmatched explains itself", /no entry price was invented/.test(oversized.unmatched[0].reason));
check("unmatched surfaces in missing", oversized.missing.some((m) => /no matching lot/.test(m)));
check("no phantom open position is created", oversized.open.length === 0);

const shortSale = pairTrades([
  accepted({ symbol: "GOOGL", side: "sell", qty: 3, price: 100, at: day(1) })
]);
check("a sell with no prior buy closes nothing", shortSale.closed.length === 0);
check("a sell with no prior buy is entirely unmatched",
  shortSale.unmatched.length === 1 && shortSale.unmatched[0].qty === 3);
check("a sell with no prior buy creates no short lot", shortSale.open.length === 0);

/* ------------------------------------------------------------------ */

console.log("\nOrders the log cannot price");

const dollarSized = pairTrades([
  notionalMarketBuy({ symbol: "AMZN", notional: 500, at: day(1), rationale: rationaleFor(66) }),
  accepted({ symbol: "AMZN", side: "sell", qty: 3, price: 180, at: day(4) })
]);

check("a dollar-sized market buy cannot be turned into a lot",
  dollarSized.unpriced.length === 1, `got ${dollarSized.unpriced.length}`);
check("it names both things the log is missing",
  dollarSized.unpriced[0].missing.length === 2,
  JSON.stringify(dollarSized.unpriced[0].missing));
check("no quantity is guessed from the dollar amount",
  dollarSized.closed.length === 0 && dollarSized.open.length === 0);
check("its sell is unmatched rather than paired with a guess",
  dollarSized.unmatched.length === 1 && dollarSized.unmatched[0].qty === 3);
check("missing explains the notional problem",
  dollarSized.missing.some((m) => /sized in dollars/.test(m)));

// A share-sized MARKET order records no price, but the guardrail priced it
// off a live quote to check the position ceiling, and that number survives
// as guardrailContext.estimatedUsd. It is a pre-trade quote, not a fill.
function marketOrderWithEstimate({ symbol, side, qty, quote, at }) {
  return {
    action: "order",
    accepted: true,
    orderId: `${symbol}-${side}-mkt-${at}`,
    order: { symbol, side, type: "market", time_in_force: "day", qty: String(qty) },
    rationale: null,
    guardrailContext: { tradesToday: 1, estimatedUsd: qty * quote, dayPnl: 0 },
    submittedAt: at,
    mode: "PAPER"
  };
}

const fromEstimate = resolveExecution(
  marketOrderWithEstimate({ symbol: "COST", side: "buy", qty: 4, quote: 80, at: day(1) })
);
check("a market order's price is recovered from the guardrail quote estimate",
  fromEstimate.price === 80 && fromEstimate.priceSource === "guardrail_quote_estimate",
  JSON.stringify(fromEstimate));
check("a quote-derived price is still flagged approximate", fromEstimate.approximate === true);

const estimatePaired = pairTrades([
  marketOrderWithEstimate({ symbol: "COST", side: "buy", qty: 4, quote: 80, at: day(1) }),
  marketOrderWithEstimate({ symbol: "COST", side: "sell", qty: 4, quote: 90, at: day(3) })
]);
check("market orders with a quote estimate pair into a round-trip",
  estimatePaired.closed.length === 1 && near(estimatePaired.closed[0].pnl, 40),
  JSON.stringify(estimatePaired.closed));
check("the quote-derived round-trip is labelled with its price sources",
  estimatePaired.closed[0].entryPriceSource === "guardrail_quote_estimate" &&
  estimatePaired.closed[0].approximate === true);
check("inferred prices are disclosed in missing",
  estimatePaired.missing.some((m) => /No fill data was supplied/.test(m)),
  JSON.stringify(estimatePaired.missing));

// When the quote lookup failed, estimateOrderValue returns null and the
// guardrail blocks — but a sell logged with a null estimate must not be
// turned into a price of zero.
const nullEstimate = resolveExecution({
  action: "order",
  accepted: true,
  orderId: "n1",
  order: { symbol: "COST", side: "sell", type: "market", time_in_force: "day", qty: "3" },
  guardrailContext: { tradesToday: 1, estimatedUsd: null, dayPnl: 0 },
  submittedAt: day(2)
});
check("a null guardrail estimate yields no price, not zero",
  nullEstimate.price === null && nullEstimate.qty === 3, JSON.stringify(nullEstimate));

const exec = resolveExecution(
  accepted({ symbol: "AAPL", side: "buy", qty: 4, price: 25, at: day(1) })
);
check("string-typed qty/limit_price are coerced to numbers",
  exec.qty === 4 && exec.price === 25, JSON.stringify(exec));
check("an inferred price is labelled with its source",
  exec.priceSource === "order_limit_price" && exec.approximate === true);

const withFills = pairTrades(
  [
    accepted({ symbol: "AAPL", side: "buy", qty: 10, price: 100, at: day(1) }),
    accepted({ symbol: "AAPL", side: "sell", qty: 10, price: 130, at: day(4) })
  ],
  {
    fillsByOrderId: {
      [`AAPL-buy-10-${day(1)}`]: { price: 101, qty: 10 },
      [`AAPL-sell-10-${day(4)}`]: { price: 129, qty: 10 }
    }
  }
);
check("supplied fills override the inferred prices",
  withFills.closed[0].entryPrice === 101 && withFills.closed[0].exitPrice === 129);
check("a filled round-trip is not marked approximate",
  withFills.closed[0].approximate === false);

/* ------------------------------------------------------------------ */

console.log("\nSummary arithmetic");

const mixed = [
  trade({ symbol: "A", pnlPercent: 10, n: 1 }),
  trade({ symbol: "A", pnlPercent: -5, n: 4 }),
  trade({ symbol: "B", pnlPercent: 10, n: 7 }),
  trade({ symbol: "B", pnlPercent: -5, n: 10 })
];

const s = summarize(mixed);
check("count", s.count === 4);
check("wins/losses split", s.wins === 2 && s.losses === 2);
check("win rate is a fraction", near(s.winRate, 0.5), `got ${s.winRate}`);
check("avg win percent", near(s.avgWinPercent, 10), `got ${s.avgWinPercent}`);
check("avg loss percent stays negative", near(s.avgLossPercent, -5), `got ${s.avgLossPercent}`);
check("profit factor = gross profit / gross loss", near(s.profitFactor, 2), `got ${s.profitFactor}`);
check("expectancy = winRate*avgWin + (1-winRate)*avgLoss",
  near(s.expectancyPercent, 2.5, 1e-4), `got ${s.expectancyPercent}`);
check("total P&L", near(s.totalPnl, 100), `got ${s.totalPnl}`);
check("avg holding days", near(s.avgHoldingDays, 2), `got ${s.avgHoldingDays}`);
check("best trade ranked by percent", near(s.bestTrade.pnlPercent, 10), JSON.stringify(s.bestTrade));
check("worst trade ranked by percent", near(s.worstTrade.pnlPercent, -5), JSON.stringify(s.worstTrade));
check("summary carries a sample size", s.sampleSize === 4);
check("nothing in the summary is NaN or Infinity", findNaN(s) === null, String(findNaN(s)));

/* ------------------------------------------------------------------ */

console.log("\nProfit factor with no losses is undefined, not infinite");

const allWinners = summarize([
  trade({ pnlPercent: 10, n: 1 }),
  trade({ pnlPercent: 20, n: 4 }),
  trade({ pnlPercent: 5, n: 7 })
]);

check("three-for-three is still reported as a 100% win rate", near(allWinners.winRate, 1));
check("profit factor is null, not Infinity", allWinners.profitFactor === null,
  `got ${allWinners.profitFactor}`);
check("profit factor is not a number at all", typeof allWinners.profitFactor !== "number");
check("the undefined denominator is explained",
  allWinners.missing.some((m) => /no losing trade/.test(m)),
  JSON.stringify(allWinners.missing));
check("a 100% win rate cannot be quoted without its caveat",
  typeof allWinners.caveat === "string" && /luck/.test(allWinners.caveat),
  allWinners.caveat);
check("three trades are never reliable", allWinners.reliable === false);
check("no Infinity leaks anywhere", findNaN(allWinners) === null, String(findNaN(allWinners)));

/* ------------------------------------------------------------------ */

console.log(`\nThe ${MIN_RELIABLE_SAMPLE}-trade reliability boundary`);

const many = (n) =>
  Array.from({ length: n }, (_, i) =>
    trade({ symbol: "R", pnlPercent: i % 2 === 0 ? 10 : -5, n: (i % 20) + 1 })
  );

const at29 = summarize(many(MIN_RELIABLE_SAMPLE - 1));
const at30 = summarize(many(MIN_RELIABLE_SAMPLE));
const at31 = summarize(many(MIN_RELIABLE_SAMPLE + 1));

check(`${MIN_RELIABLE_SAMPLE - 1} trades: reliable === false`, at29.reliable === false);
check(`${MIN_RELIABLE_SAMPLE} trades: reliable === true`, at30.reliable === true);
check(`${MIN_RELIABLE_SAMPLE + 1} trades: still reliable`, at31.reliable === true);
check("sample size is reported at the boundary", at30.sampleSize === MIN_RELIABLE_SAMPLE);
check("below the floor the caveat says the result is probably luck",
  /luck/.test(at29.caveat), at29.caveat);
check("at the floor the caveat still refuses to claim an edge",
  /NOT the point at which they prove an edge/.test(at30.caveat), at30.caveat);
check("no summary ever annualises or projects",
  !/annual|per year|projected|expected return/i.test(
    JSON.stringify([at29, at30, s, allWinners])
  ));

/* ------------------------------------------------------------------ */

console.log("\nEquity curve and max drawdown");

const ddTrades = [100, -300, 50, -200, 400].map((pnl, i) => ({
  symbol: "DD",
  entryAt: day(i + 1),
  exitAt: day(i + 2),
  entryPrice: 100,
  exitPrice: 100 + pnl / 10,
  qty: 10,
  pnl,
  pnlPercent: pnl / 10,
  holdingDays: 1
}));

const curve = equityCurve(ddTrades, 1000);
check("curve starts at the starting equity", curve[0].equity === 1000);
check("curve has one point per trade plus the start",
  curve.length === ddTrades.length + 1, `got ${curve.length}`);
check("curve is cumulative",
  curve.map((p) => p.equity).join(",") === "1000,1100,800,850,650,1050",
  curve.map((p) => p.equity).join(","));

const dd = maxDrawdown(curve);
check("peak found", dd.peak === 1100, `got ${dd.peak}`);
check("trough found", dd.trough === 650, `got ${dd.trough}`);
check("drawdown is peak-to-trough", dd.drawdown === 450, `got ${dd.drawdown}`);
check("drawdown percent is relative to the peak",
  near(dd.drawdownPercent, 40.909091, 1e-5), `got ${dd.drawdownPercent}`);
check("drawdown indices point at the right trades",
  dd.peakIndex === 1 && dd.troughIndex === 4, `${dd.peakIndex}/${dd.troughIndex}`);
check("drawdown is caveated as a lower bound",
  /lower bound/.test(dd.caveat), dd.caveat);

const rising = maxDrawdown([1000, 1100, 1200, 1300]);
check("a curve that never falls has zero drawdown", rising.drawdown === 0);
check("zero drawdown is explained rather than celebrated",
  /has not happened yet/.test(rising.caveat), rising.caveat);

check("maxDrawdown accepts a plain array of numbers",
  maxDrawdown([100, 50]).drawdown === 50);

/* ------------------------------------------------------------------ */

console.log("\nEmpty input returns zeros and caveats, never NaN");

const empty = summarize([]);
check("empty summary does not throw", true);
check("count is 0", empty.count === 0);
check("wins/losses are 0", empty.wins === 0 && empty.losses === 0);
check("total P&L is 0", empty.totalPnl === 0);
check("win rate is null, not 0 (0 would read as a measured 0%)", empty.winRate === null);
check("profit factor is null", empty.profitFactor === null);
check("expectancy is null", empty.expectancyPercent === null);
check("avg holding days is null", empty.avgHoldingDays === null);
check("best/worst are null", empty.bestTrade === null && empty.worstTrade === null);
check("avgR is null and coverage is 0", empty.avgR === null && empty.rCoverage === 0);
check("empty summary is not reliable", empty.reliable === false);
check("empty summary says an absence is not a result",
  /not a zero result/.test(empty.caveat), empty.caveat);
check("empty summary lists what is missing", empty.missing.length > 0);
check("no NaN in an empty summary", findNaN(empty) === null, String(findNaN(empty)));

const emptyPairs = pairTrades([]);
check("empty log pairs to nothing",
  emptyPairs.closed.length === 0 && emptyPairs.open.length === 0 &&
  emptyPairs.unmatched.length === 0 && emptyPairs.unpriced.length === 0);
check("empty log counts are zeros", emptyPairs.counts.entries === 0 && emptyPairs.counts.paired === 0);

const emptyCurve = equityCurve([], 0);
check("empty equity curve is just the starting point", emptyCurve.length === 1);

const emptyDd = maxDrawdown([]);
check("drawdown of nothing is null, not 0", emptyDd.drawdown === null && emptyDd.peak === null);
check("drawdown of nothing says so", /not a drawdown of zero/.test(emptyDd.caveat));

const emptyBreakdown = breakdown([], keyBySymbol);
check("empty breakdown has no groups", emptyBreakdown.groups.length === 0);

const emptyCal = confidenceCalibration([]);
check("empty calibration is unavailable, not zeroed", emptyCal.available === false);

for (const [name, value] of Object.entries({
  emptyPairs, emptyCurve, emptyDd, emptyBreakdown, emptyCal,
  pairsOnGarbage: pairTrades([null, {}, { action: "order" }, 7])
})) {
  check(`${name}: no NaN or Infinity`, findNaN(value) === null, String(findNaN(value)));
}

check("nonsense input does not throw and is counted as unusable",
  pairTrades([null, {}, 7]).counts.other === 3);
check("undefined input is tolerated", summarize(undefined).count === 0);

/* ------------------------------------------------------------------ */

console.log("\nR multiples");

const rTrades = [
  { symbol: "AAPL", entryAt: day(1), exitAt: day(4), entryPrice: 100, exitPrice: 110, qty: 10, pnl: 100, pnlPercent: 10, holdingDays: 3 },
  { symbol: "MSFT", entryAt: day(2), exitAt: day(6), entryPrice: 200, exitPrice: 190, qty: 5, pnl: -50, pnlPercent: -5, holdingDays: 4 }
];

const rFromFn = rMultiples(rTrades, {
  stopPriceBySymbolAt: (symbol) => (symbol === "AAPL" ? 95 : null)
});
check("R from a known stop", near(rFromFn.results[0].r, 2), `got ${rFromFn.results[0].r}`);
check("risked amount per share recorded", rFromFn.results[0].riskPerShare === 5);
check("unknown stop yields null, not a guess", rFromFn.results[1].r === null);
check("unknown stop explains itself",
  /stop price unknown/.test(rFromFn.results[1].missing[0] || ""), JSON.stringify(rFromFn.results[1].missing));
check("coverage reflects the gap", near(rFromFn.coverage, 0.5), `got ${rFromFn.coverage}`);
check("avgR covers only the trades that had a stop", near(rFromFn.avgR, 2), `got ${rFromFn.avgR}`);
check("the gap is reported in missing", rFromFn.missing.some((m) => /excluded from avgR/.test(m)));

const rFromMap = rMultiples(rTrades, { stopPriceBySymbolAt: { AAPL: 95, MSFT: 180 } });
check("map lookup works", near(rFromMap.results[0].r, 2) && near(rFromMap.results[1].r, -0.5),
  JSON.stringify(rFromMap.results.map((x) => x.r)));
check("full coverage is 1", rFromMap.coverage === 1);

const rFromHistory = rMultiples(rTrades, {
  stopPriceBySymbolAt: {
    AAPL: [
      { at: day(1), stopPrice: 95 },
      { at: day(9), stopPrice: 108 } // known only after the entry: hindsight
    ]
  }
});
check("a stop recorded after entry is not used as the risk taken",
  near(rFromHistory.results[0].r, 2), `got ${rFromHistory.results[0].r}`);

const badStop = rMultiples(
  [{ symbol: "X", entryAt: day(1), exitAt: day(2), entryPrice: 100, exitPrice: 110 }],
  { stopPriceBySymbolAt: { X: 100 } }
);
check("a zero-risk stop gives null R rather than division by zero",
  badStop.results[0].r === null && findNaN(badStop) === null);
check("zero-risk stop is explained", /zero or negative/.test(badStop.results[0].missing[0] || ""));

check("no stops at all means avgR null and coverage 0",
  rMultiples(rTrades, {}).avgR === null && rMultiples(rTrades, {}).coverage === 0);

const rSummary = summarize(rTrades, { stopPriceBySymbolAt: { AAPL: 95 } });
check("summary surfaces avgR", near(rSummary.avgR, 2), `got ${rSummary.avgR}`);
check("summary surfaces rCoverage", near(rSummary.rCoverage, 0.5), `got ${rSummary.rCoverage}`);
check("partial R coverage is disclosed in missing",
  rSummary.missing.some((m) => /avgR covers/.test(m)), JSON.stringify(rSummary.missing));
check("a summary with no R data says so",
  summarize(rTrades).avgR === null &&
  summarize(rTrades).missing.some((m) => /no trade has a known original stop/.test(m)));

/* ------------------------------------------------------------------ */

console.log("\nBreakdown");

const grouped = [
  trade({ symbol: "AAPL", pnlPercent: 10, n: 1, rationale: rationaleFor(71, "Trending") }),
  trade({ symbol: "AAPL", pnlPercent: -5, n: 4, rationale: rationaleFor(74, "Trending") }),
  trade({ symbol: "AAPL", pnlPercent: 20, n: 7, rationale: rationaleFor(52, "Ranging") }),
  trade({ symbol: "MSFT", pnlPercent: -10, n: 2, rationale: rationaleFor(45, "Ranging") }),
  trade({ symbol: "MSFT", pnlPercent: 5, n: 5, rationale: rationaleFor(88, "Trending") })
];

const bySymbol = breakdown(grouped, keyBySymbol);
check("groups by symbol", bySymbol.groupCount === 2, `got ${bySymbol.groupCount}`);
check("largest group first", bySymbol.groups[0].key === "AAPL" && bySymbol.groups[0].count === 3);
check("each group carries its own sample size",
  bySymbol.groups.every((g) => g.summary.sampleSize === g.count));
check("each group carries its own reliable flag",
  bySymbol.groups.every((g) => g.summary.reliable === false));
check("each group carries its own caveat",
  bySymbol.groups.every((g) => typeof g.summary.caveat === "string" && g.summary.caveat.length > 40));
check("the breakdown warns that slicing selects for luck",
  /luck/.test(bySymbol.caveat), bySymbol.caveat);
check("no group being reliable is reported",
  bySymbol.missing.some((m) => /no group reaches/.test(m)));

const byRegime = breakdown(grouped, keyByRegime);
check("groups by regime parsed from the rationale", byRegime.groupCount === 2,
  JSON.stringify(byRegime.groups.map((g) => g.key)));
check("regime keys are the real regimes",
  byRegime.groups.map((g) => g.key).sort().join(",") === "ranging,trending");

const byConfidence = breakdown(grouped, keyByConfidenceBucket);
check("groups by confidence bucket",
  byConfidence.groups.map((g) => g.key).sort().join(",") === "40-49,50-59,70-79,80-89",
  JSON.stringify(byConfidence.groups.map((g) => g.key)));

const withUnkeyed = breakdown(grouped.concat([trade({ symbol: null, pnlPercent: 1, n: 3 })]), keyBySymbol);
check("trades with no key go to ungrouped, not an invented bucket",
  withUnkeyed.ungrouped === 1 && withUnkeyed.groupCount === 2);
check("ungrouped trades are disclosed",
  withUnkeyed.missing.some((m) => /no group/.test(m)));
check("breakdown accepts a property name as the key",
  breakdown(grouped, "symbol").groupCount === 2);
check("no NaN in a breakdown", findNaN(bySymbol) === null, String(findNaN(bySymbol)));

/* ------------------------------------------------------------------ */

console.log("\nConfidence calibration");

const cal = confidenceCalibration(grouped);
check("calibration is available when rationales carry confidence", cal.available === true);
check("all five trades parsed", cal.parsed === 5 && cal.coverage === 1, `parsed ${cal.parsed}`);
check("buckets are ordered low to high",
  cal.buckets.map((b) => b.bucket).join(",") === "40-49,50-59,70-79,80-89",
  cal.buckets.map((b) => b.bucket).join(","));
check("a bucket reports the actual win rate",
  near(cal.buckets.find((b) => b.bucket === "70-79").winRate, 0.5),
  JSON.stringify(cal.buckets.find((b) => b.bucket === "70-79")));
check("the 40-49 bucket lost", near(cal.buckets.find((b) => b.bucket === "40-49").winRate, 0));
check("every bucket carries a sample size and reliability flag",
  cal.buckets.every((b) => typeof b.sampleSize === "number" && b.reliable === false));
check("calibration as a whole is not reliable here", cal.reliable === false);
check("the caveat says a monotonic result would still be chance",
  /consistent with pure chance/.test(cal.caveat), cal.caveat);
check("the note explains what calibration needs", /each bucket/i.test(cal.note), cal.note);
check("no NaN in calibration", findNaN(cal) === null, String(findNaN(cal)));

const noConfidence = confidenceCalibration([
  trade({ pnlPercent: 10, n: 1 }),
  trade({ pnlPercent: -5, n: 3 })
]);
check("no confidence data returns an empty result", noConfidence.available === false);
check("empty result has no buckets", noConfidence.buckets.length === 0);
check("empty result still counts the trades it saw", noConfidence.total === 2 && noConfidence.parsed === 0);
check("empty result says the data is absent, not that confidence is useless",
  /absence of data/.test(noConfidence.caveat), noConfidence.caveat);
check("empty result names what is missing",
  noConfidence.missing.some((m) => /does not contain one/.test(m)));

const partialConfidence = confidenceCalibration([
  trade({ pnlPercent: 10, n: 1, rationale: rationaleFor(71) }),
  trade({ pnlPercent: -5, n: 3 })
]);
check("partial confidence coverage is reported",
  partialConfidence.parsed === 1 && near(partialConfidence.coverage, 0.5));
check("trades with no confidence are not given a default",
  partialConfidence.missing.some((m) => /rather than assigned a default/.test(m)));

check("confidence parsed from the autotrader rationale format",
  parseConfidence({ entryRationale: rationaleFor(83) }) === 83);
check("an explicit numeric confidence wins",
  parseConfidence({ confidence: 42, entryRationale: rationaleFor(83) }) === 42);
check("a rationale with no confidence returns null",
  parseConfidence({ entryRationale: "manual trade, felt right" }) === null);
check("an out-of-range confidence is rejected",
  parseConfidence({ entryRationale: "confidence 400%" }) === null);
check("regime parsed from the rationale",
  parseRegime({ entryRationale: rationaleFor(60, "Ranging") }) === "ranging");
check("no regime in the text returns null", parseRegime({ entryRationale: "bought it" }) === null);

/* ------------------------------------------------------------------ */

console.log("\nPurity: nothing mutates its input");

function unchanged(label, input, fn) {
  const before = JSON.stringify(input);
  fn(input);
  check(`${label} does not mutate its input`, JSON.stringify(input) === before);
}

unchanged("pairTrades", interleaved.slice(), (x) => pairTrades(x));
unchanged("summarize", mixed.slice(), (x) => summarize(x));
unchanged("summarize (with stops)", rTrades.slice(), (x) =>
  summarize(x, { stopPriceBySymbolAt: { AAPL: 95 } }));
unchanged("rMultiples", rTrades.slice(), (x) =>
  rMultiples(x, { stopPriceBySymbolAt: { AAPL: 95, MSFT: 180 } }));
unchanged("withRMultiples", rTrades.slice(), (x) =>
  withRMultiples(x, { stopPriceBySymbolAt: { AAPL: 95 } }));
unchanged("equityCurve", ddTrades.slice(), (x) => equityCurve(x, 1000));
unchanged("maxDrawdown", equityCurve(ddTrades, 1000), (x) => maxDrawdown(x));
unchanged("breakdown", grouped.slice(), (x) => breakdown(x, keyBySymbol));
unchanged("confidenceCalibration", grouped.slice(), (x) => confidenceCalibration(x));

// withRMultiples must copy rather than annotate in place.
const rInput = rTrades.map((t) => ({ ...t }));
const annotated = withRMultiples(rInput, { stopPriceBySymbolAt: { AAPL: 95 } });
check("withRMultiples returns new objects", annotated[0] !== rInput[0]);
check("withRMultiples leaves the originals without an r field",
  rInput.every((t) => !("r" in t)));
check("withRMultiples attaches r to the copies", near(annotated[0].r, 2));

// The paired output must not alias the log entries either.
const aliasProbe = pairTrades(interleaved);
aliasProbe.closed[0].pnl = 999999;
check("mutating the result cannot reach back into the trade log",
  interleaved[0].order.qty === "10" && pairTrades(interleaved).closed[0].pnl === 300);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
