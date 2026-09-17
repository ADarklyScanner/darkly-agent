/**
 * Tests for strategy.js — run with: node strategy.test.mjs
 *
 * These exist because the decision layer is the part that spends money.
 * The first version of this file caught an inverted-signal bug that would
 * have made the system sell strength and buy weakness while reporting
 * confident, healthy-looking scores. Keep them passing.
 */

import {
  sma, ema, rsi, macd, volatility, trendSlope, atr, scoreSymbol
} from "./strategy.js";

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

/* Deterministic PRNG so runs are reproducible. */
function mulberry(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function series(n, drift, noise, seed) {
  const r = mulberry(seed);
  const out = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    p = p * (1 + drift + (r() - 0.5) * noise);
    out.push(p);
  }
  return out;
}

function bars(closes, seed = 9) {
  const r = mulberry(seed);
  return closes.map((c, i) => ({
    t: new Date(Date.UTC(2026, 0, (i % 28) + 1)).toISOString(),
    o: c,
    h: c * (1 + r() * 0.012),
    l: c * (1 - r() * 0.012),
    c,
    v: 1_000_000 * (0.6 + r())
  }));
}

/* ------------------------------------------------------------------ */

console.log("\nIndicators");

const rising = Array.from({ length: 60 }, (_, i) => 100 + i);
const falling = Array.from({ length: 60 }, (_, i) => 160 - i);
const flat = Array(60).fill(100);

check("sma basic", sma([1, 2, 3, 4, 5], 5) === 3);
check("sma insufficient history -> null", sma([1, 2], 5) === null);
check("sma rejects zero period", sma([1, 2, 3], 0) === null);
check("ema returns a number", typeof ema([1, 2, 3, 4, 5, 6], 3) === "number");

check("rsi all gains = 100", rsi(rising, 14) === 100);
check("rsi all losses ~ 0", rsi(falling, 14) < 0.001);
check("rsi flat = 50", rsi(flat, 14) === 50);
check("rsi insufficient history -> null", rsi([1, 2, 3], 14) === null);

check("macd positive on uptrend", macd(rising).line > 0);
check("macd negative on downtrend", macd(falling).line < 0);
check("macd insufficient history -> null", macd([1, 2, 3]) === null);

check("volatility flat = 0", volatility(flat) === 0);
check("volatility responds to noise", volatility(series(60, 0, 0.05, 11)) > 0);

check("trendSlope positive on uptrend", trendSlope(rising) > 0);
check("trendSlope negative on downtrend", trendSlope(falling) < 0);
check("trendSlope flat ~ 0", Math.abs(trendSlope(flat)) < 1e-9);

check("atr positive", atr(bars(rising), 14) > 0);
check("atr insufficient history -> null", atr(bars([1, 2, 3]), 14) === null);

/* ------------------------------------------------------------------ */

console.log("\nDirectional correctness");

const cases = {
  strongUp: scoreSymbol("UP", bars(series(80, 0.006, 0.010, 1))),
  mildUp: scoreSymbol("MUP", bars(series(80, 0.0015, 0.014, 2))),
  sideways: scoreSymbol("FLAT", bars(series(80, 0.0, 0.020, 3))),
  mildDown: scoreSymbol("MDN", bars(series(80, -0.0015, 0.014, 4))),
  strongDown: scoreSymbol("DOWN", bars(series(80, -0.006, 0.010, 5)))
};

for (const [k, s] of Object.entries(cases)) {
  console.log(
    `  ${k.padEnd(11)} regime=${String(s.indicators.marketRegime).padEnd(8)} score=${String(s.score).padStart(5)} conf=${String(s.confidence).padStart(3)} action=${s.action}`
  );
}

check("uptrend scores bullish", cases.strongUp.score > 55, `got ${cases.strongUp.score}`);
check("uptrend is not a sell", !/sell/.test(cases.strongUp.action));
check("downtrend scores bearish", cases.strongDown.score < 45, `got ${cases.strongDown.score}`);
check("downtrend is not a buy", !/buy/.test(cases.strongDown.action));
check("sideways does not trade", cases.sideways.action === "hold", `got ${cases.sideways.action}`);
check("strong trends detected as trending",
  cases.strongUp.indicators.marketRegime === "trending" &&
  cases.strongDown.indicators.marketRegime === "trending");
check("chop detected as ranging", cases.sideways.indicators.marketRegime === "ranging");

/* ------------------------------------------------------------------ */

console.log("\nFalling-knife protection");

// A sustained decline must never be read as a discount. This is the
// regression test for the real-world PSQL case: -46% while the model
// would happily have kept averaging in.
const knife = scoreSymbol("KNIFE", bars(series(80, -0.004, 0.012, 7)));
console.log(`  knife: regime=${knife.indicators.marketRegime} score=${knife.score} action=${knife.action} rsi=${knife.indicators.rsi14?.toFixed(1)}`);
check("sustained decline is never a buy", !/buy/.test(knife.action), `got ${knife.action}`);
check("sustained decline does not score bullish", knife.score <= 55, `got ${knife.score}`);

// Oversold inside a broken structure must have its fade suppressed.
const brokenDip = scoreSymbol("DIP", bars(series(80, -0.002, 0.030, 13)));
if (brokenDip.indicators.marketRegime === "ranging" && brokenDip.indicators.sma20 < brokenDip.indicators.sma50) {
  check("dip in a downtrend is not faded into a buy", !/buy/.test(brokenDip.action), `got ${brokenDip.action}`);
} else {
  check("dip case classified (informational)", true);
}

/* ------------------------------------------------------------------ */

console.log("\nInvariants");

const all = [...Object.values(cases), knife, brokenDip];
check("score always 0-100", all.every((s) => s.score >= 0 && s.score <= 100));
check("confidence always 0-100", all.every((s) => s.confidence >= 0 && s.confidence <= 100));
check("every signal carries a reason", all.every((s) => typeof s.reason === "string" && s.reason.length > 10));
check("hold is never marked tradable", all.every((s) => s.action !== "hold" || s.tradable === false));

const short = scoreSymbol("TINY", bars([1, 2, 3]));
check("insufficient history holds", short.action === "hold" && short.tradable === false);
check("insufficient history explains itself", /Insufficient history/.test(short.reason));

const buys = all.filter((s) => /buy/.test(s.action));
check("buy stops sit below entry", buys.every((s) => s.stopPrice < s.indicators.price));
check("buy targets sit above entry", buys.every((s) => s.targetPrice > s.indicators.price));

const sells = all.filter((s) => /sell/.test(s.action));
check("sell stops sit above entry", sells.every((s) => s.stopPrice > s.indicators.price));

/* ------------------------------------------------------------------ */

console.log("\nAggressiveness");

const b = bars(series(80, 0.004, 0.012, 21));
const cons = scoreSymbol("X", b, { aggressiveness: "conservative" });
const mod = scoreSymbol("X", b, { aggressiveness: "moderate" });
const agg = scoreSymbol("X", b, { aggressiveness: "aggressive" });

check("score is independent of aggressiveness", cons.score === mod.score && mod.score === agg.score);
check("aggressive never trades less than conservative", !(cons.tradable && !agg.tradable));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
