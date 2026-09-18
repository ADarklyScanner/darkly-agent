/**
 * Tests for the side-app registry and its apps — node apps.test.mjs
 *
 * Two things are load-bearing here.
 *
 * First, ISOLATION: side apps must not be able to reach into each other.
 * The whole reason for this structure is that a lottery analyzer has no
 * business inside a driving formula. The tests prove an app cannot see
 * another's signals and that one app failing does not take the rest down.
 *
 * Second, HONESTY about coincidence. The cross-app view exists because
 * two unrelated things can land on the same Tuesday. The tests pin that
 * it reports co-occurrence as co-occurrence: no ranking, no causal
 * language, no recommendation, and specifically no path by which a
 * low-earning day becomes a reason to spend money.
 */

import {
  registerApp,
  listApps,
  getApp,
  collectSignals,
  findCoincidences,
  dayKey,
  _resetRegistryForTests
} from "./apps/registry.js";
import {
  stateKey,
  normalizeDraws,
  frequency,
  gaps,
  shapeStats,
  pairStats,
  repeatStats,
  analyzeAll,
  listStates,
  listGames,
  fetchResults,
  lotterySignals,
  registerLotteryApp,
  _setFetchForTests
} from "./apps/lottery.js";
import { drivingSignals, registerDrivingApp } from "./apps/driving.js";

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

function throwsWith(label, fn, matcher) {
  try {
    fn();
    check(label, false, "did not throw");
  } catch (e) {
    check(label, matcher ? matcher.test(e.message) : true, e.message);
  }
}

async function rejectsWith(label, fn, matcher) {
  try {
    await fn();
    check(label, false, "did not reject");
  } catch (e) {
    check(label, matcher ? matcher.test(e.message) : true, e.message);
  }
}

/* ------------------------------------------------------------------ */

console.log("\nRegistry basics");

_resetRegistryForTests();

check("starts empty", listApps().length === 0);

registerApp({ id: "alpha", name: "Alpha", domain: "testing", description: "d" });
check("registers an app", listApps().length === 1 && listApps()[0].id === "alpha");
check("getApp finds it", getApp("alpha")?.name === "Alpha");
check("getApp returns null for unknown ids", getApp("nope") === null);
check("reports whether an app emits signals", listApps()[0].emitsSignals === false);

throwsWith("rejects a duplicate id", () => registerApp({ id: "alpha", name: "x", domain: "y" }), /already registered/);
throwsWith("requires an id slug", () => registerApp({ name: "x", domain: "y" }), /id/);
throwsWith("rejects a malformed id", () => registerApp({ id: "Not Valid!", name: "x", domain: "y" }), /slug/);
throwsWith("requires a name", () => registerApp({ id: "beta", domain: "y" }), /name/);
throwsWith("requires a domain", () => registerApp({ id: "beta", name: "x" }), /domain/);
throwsWith("rejects a non-function signals", () => registerApp({ id: "beta", name: "x", domain: "y", signals: 5 }), /not a function/);

console.log("\nDay keys");

check("normalizes an ISO timestamp to a Reno day", dayKey("2026-09-19T20:00:00-07:00") === "2026-09-19");
check("a UTC instant maps to the local Reno day",
  dayKey("2026-09-20T05:00:00Z") === "2026-09-19", dayKey("2026-09-20T05:00:00Z"));
check("accepts a Date", dayKey(new Date("2026-09-19T12:00:00-07:00")) === "2026-09-19");
check("an unparseable date returns null", dayKey("not a date") === null);

console.log("\nSignal collection and app isolation");

{
  _resetRegistryForTests();

  let alphaSawContext = null;
  registerApp({
    id: "alpha",
    name: "Alpha",
    domain: "a",
    signals: (ctx) => {
      alphaSawContext = ctx;
      return [{ date: "2026-09-22T12:00:00-07:00", kind: "a_thing", detail: "alpha detail" }];
    }
  });
  registerApp({
    id: "beta",
    name: "Beta",
    domain: "b",
    signals: () => [{ date: "2026-09-22T18:00:00-07:00", kind: "b_thing", detail: "beta detail" }]
  });

  const { signals, failures } = await collectSignals({ some: "context" });

  check("collects from every app", signals.length === 2);
  check("stamps each signal with its emitting app",
    signals.some((s) => s.app === "alpha") && signals.some((s) => s.app === "beta"));
  check("normalizes dates to day keys", signals.every((s) => /^\d{4}-\d{2}-\d{2}$/.test(s.date)));
  check("no failures on a clean run", failures.length === 0);

  // Isolation: an app sees the caller's context, never another app's output.
  check("an app receives only the shared context, not other apps' signals",
    alphaSawContext && alphaSawContext.some === "context" &&
      !("signals" in alphaSawContext) && !("beta" in alphaSawContext),
    JSON.stringify(Object.keys(alphaSawContext || {})));
}

{
  _resetRegistryForTests();
  registerApp({ id: "good", name: "Good", domain: "g", signals: () => [{ date: "2026-09-22", kind: "ok" }] });
  registerApp({
    id: "broken",
    name: "Broken",
    domain: "b",
    signals: () => {
      throw new Error("lottery service unreachable");
    }
  });

  const { signals, failures } = await collectSignals();
  check("one app failing does not lose the others", signals.length === 1 && signals[0].app === "good");
  check("the failure is reported, not swallowed",
    failures.length === 1 && failures[0].app === "broken" && /unreachable/.test(failures[0].error));
}

{
  _resetRegistryForTests();
  registerApp({ id: "messy", name: "Messy", domain: "m", signals: () => [
    { date: "2026-09-22", kind: "fine" },
    { date: "not a date", kind: "dropped" },
    null,
    { kind: "no date at all" }
  ]});
  const { signals } = await collectSignals();
  check("undated and unparseable signals are dropped rather than guessed at", signals.length === 1);
}

{
  _resetRegistryForTests();
  registerApp({ id: "quiet", name: "Quiet", domain: "q" }); // no signals function
  const { signals, failures } = await collectSignals();
  check("an app with no signals function is simply skipped", signals.length === 0 && failures.length === 0);
}

console.log("\nCoincidence detection");

{
  const signals = [
    { app: "driving", date: "2026-09-22", kind: "low_opportunity_day", detail: "worst day" },
    { app: "lottery", date: "2026-09-22", kind: "draw_day", detail: "Powerball" },
    { app: "driving", date: "2026-09-19", kind: "recommended_driving_block", detail: "block" }
  ];
  const r = findCoincidences(signals);

  check("finds the day two different apps overlap", r.coincidenceCount === 1 && r.days[0].date === "2026-09-22");
  check("names which apps overlapped", r.days[0].apps.join(",") === "driving,lottery");
  check("includes both signals", r.days[0].signals.length === 2);
  check("a day with only one app is not a coincidence", !r.days.some((d) => d.date === "2026-09-19"));
}

{
  // Two signals from the SAME app on one day is that app being detailed,
  // not a cross-domain coincidence.
  const r = findCoincidences([
    { app: "driving", date: "2026-09-22", kind: "a" },
    { app: "driving", date: "2026-09-22", kind: "b" }
  ]);
  check("two signals from one app do not count as a coincidence", r.coincidenceCount === 0);
  check("an empty result says so plainly", /No days where two different apps/.test(r.note));
}

{
  const r = findCoincidences([
    { app: "driving", date: "2026-09-22", kind: "low_opportunity_day" },
    { app: "lottery", date: "2026-09-22", kind: "draw_day_with_jackpot", value: "$800M" }
  ]);

  // The honesty requirements, pinned.
  check("the output explains that co-occurrence is not a relationship",
    /not a relationship/.test(r.meaning) || /not causation/i.test(r.meaning), r.meaning);
  check("it explicitly disclaims causation and prediction",
    /caused, predicts, or justifies/.test(r.meaning), r.meaning);
  check("it states plainly that none of it is a recommendation",
    /none of it is a recommendation/.test(r.meaning), r.meaning);

  // Nothing in the payload should rank, score or advise.
  const asText = JSON.stringify(r).toLowerCase();
  check("no scoring or ranking language leaks into the coincidence output",
    !/\bbest\b|\bworst\b|\bshould\b|\brecommend(?!ation)/.test(asText.replace(/not a recommendation/g, "")),
    asText.slice(0, 200));
  check("days are ordered by date, not by any notion of quality",
    findCoincidences([
      { app: "a", date: "2026-09-25", kind: "x" }, { app: "b", date: "2026-09-25", kind: "y" },
      { app: "a", date: "2026-09-20", kind: "x" }, { app: "b", date: "2026-09-20", kind: "y" }
    ]).days.map((d) => d.date).join(",") === "2026-09-20,2026-09-25");
}

console.log("\nLottery: API client");

check("slugifies state names", stateKey("New Hampshire") === "new-hampshire");
check("lowercases and trims", stateKey("  Nevada ") === "nevada");

{
  _setFetchForTests(async (url) => ({
    ok: true,
    status: 200,
    json: async () => ({ data: url.endsWith("/states") ? ["Nevada", "California"] : [] })
  }));
  check("lists states", (await listStates()).includes("California"));
}

{
  _setFetchForTests(async () => ({ ok: true, status: 200, json: async () => ({ data: ["powerball", "mega-millions"] }) }));
  check("lists games for a state", (await listGames("California")).includes("powerball"));
  await rejectsWith("requires a state", () => listGames(), /required/);
}

{
  _setFetchForTests(async () => ({ ok: false, status: 503, json: async () => ({}) }));
  await rejectsWith("an HTTP error is reported with its status", () => listStates(), /HTTP 503/);
}

{
  _setFetchForTests(async () => ({ ok: true, status: 200, json: async () => { throw new Error("bad json"); } }));
  await rejectsWith("malformed JSON is reported clearly", () => listStates(), /malformed/);
}

{
  _setFetchForTests(async () => { throw new Error("ENOTFOUND"); });
  await rejectsWith("a network failure is reported, not swallowed", () => listStates(), /Could not reach/);
}

{
  _setFetchForTests(async () => ({ ok: true, status: 200, json: async () => ({ notData: [] }) }));
  await rejectsWith("an unexpected response shape is caught", () => listStates(), /unexpected shape/);
}

{
  // Pagination: three pages, then a short page ends it.
  let calls = 0;
  _setFetchForTests(async (url) => {
    calls++;
    const offset = Number(new URL(url).searchParams.get("offset"));
    const rows = offset < 200
      ? Array.from({ length: 100 }, (_, i) => ({ draw_date: `2026-01-${String((offset + i) % 28 + 1).padStart(2, "0")}`, numbers: [offset + i + 1, 2, 3] }))
      : [{ draw_date: "2020-01-01", numbers: [9, 8, 7] }];
    return { ok: true, status: 200, json: async () => ({ data: rows }) };
  });

  const rows = await fetchResults("nevada", "powerball", { maxDraws: 500 });
  check("follows pagination across pages", calls === 3, `${calls} calls`);
  check("stops when a short page arrives", rows.length === 201, String(rows.length));
}

{
  // This stub deliberately ignores `limit` and returns the same full page
  // forever — exactly how a cached or broken backend behaves. Before the
  // no-progress guard existed, this hung the process indefinitely.
  let calls = 0;
  _setFetchForTests(async () => {
    calls++;
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: Array.from({ length: 100 }, () => ({ draw_date: "2026-01-01", numbers: [1, 2, 3] })) })
    };
  });
  const rows = await fetchResults("nevada", "powerball", { maxDraws: 50 });
  check("duplicate rows are collapsed", rows.length === 1, String(rows.length));
  // The first page legitimately contributes one new row; the guard fires
  // on the second, which is the first page that adds nothing.
  check("a page that adds nothing new stops the loop instead of spinning forever",
    calls === 2, `${calls} requests`);
}

{
  // A backend that always returns a full page of genuinely new rows must
  // still be bounded by maxDraws rather than running until it decides to stop.
  let calls = 0;
  _setFetchForTests(async (url) => {
    calls++;
    const offset = Number(new URL(url).searchParams.get("offset"));
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: Array.from({ length: 100 }, (_, i) => ({ draw_date: `2026-01-01`, numbers: [offset + i + 1, 2, 3] }))
      })
    };
  });
  const rows = await fetchResults("nevada", "powerball", { maxDraws: 250 });
  check("an endless backend is bounded by maxDraws", rows.length >= 250 && calls <= 8,
    `${rows.length} rows in ${calls} requests`);
}

{
  let seenLimit = null;
  _setFetchForTests(async (url) => {
    seenLimit = Number(new URL(url).searchParams.get("limit"));
    return { ok: true, status: 200, json: async () => ({ data: [] }) };
  });
  await fetchResults("nevada", "powerball", { maxDraws: 25 });
  check("maxDraws bounds the page size requested", seenLimit === 25, String(seenLimit));
}

_setFetchForTests(null);

console.log("\nLottery: draw normalization");

{
  const { draws, skipped } = normalizeDraws([
    { draw_date: "2026-09-19", numbers: [5, 12, 23, 34, 45], powerball: 7 },
    { date: "2026-09-16", winning_numbers: "3 14 25 36 47", bonus: 2 },
    { draw_date: "2026-09-12", numbers: ["1", "2", "3"], mega_ball: "9" },
    { draw_date: "2026-09-10", numbers: "nonsense" },
    { draw_date: "2026-09-09" }
  ]);

  check("reads the common field name", draws.some((d) => d.main.join(",") === "5,12,23,34,45"));
  check("reads alternate field names", draws.some((d) => d.main.join(",") === "3,14,25,36,47"));
  check("parses a space-separated string of numbers", draws.some((d) => d.bonus === 2));
  check("coerces numeric strings", draws.some((d) => d.main.join(",") === "1,2,3" && d.bonus === 9));
  check("reads the bonus under any of its names", draws.filter((d) => d.bonus !== null).length === 3);
  check("unparseable rows are skipped, not coerced into zeros", skipped === 2, String(skipped));
  check("draws come back newest first", draws[0].date === "2026-09-19", draws[0].date);
}

console.log("\nLottery: analytics");

// A deliberately lopsided history so every statistic has something real
// to find rather than returning a flat distribution.
const HISTORY = normalizeDraws([
  { draw_date: "2026-09-19", numbers: [1, 2, 3, 40, 41], bonus: 5 },
  { draw_date: "2026-09-17", numbers: [1, 2, 10, 20, 30], bonus: 5 },
  { draw_date: "2026-09-15", numbers: [1, 2, 11, 21, 31], bonus: 6 },
  { draw_date: "2026-09-13", numbers: [1, 9, 12, 22, 32], bonus: 5 },
  { draw_date: "2026-09-11", numbers: [4, 8, 13, 23, 33], bonus: 7 }
]).draws;

{
  const f = frequency(HISTORY, { top: 3 });
  check("counts across all draws", f.drawsAnalyzed === 5);
  check("1 is the hottest number", f.hottest[0].number === 1 && f.hottest[0].count === 4, JSON.stringify(f.hottest[0]));
  check("2 is next", f.hottest[1].number === 2 && f.hottest[1].count === 3);
  check("bonus balls are counted separately", f.bonus.find((b) => b.number === 5).count === 3);
  check("coldest lists the least frequent", f.coldest.every((c) => c.count === 1));

  // The honesty requirement.
  check("frequency carries the descriptive-only basis", /does not forecast/.test(f.basis));
  check("the basis says cold numbers are not due", /does not make it due/.test(f.basis));
}

{
  const g = gaps(HISTORY, { top: 5, maxNumber: 45 });
  check("a number in the newest draw has a gap of 0", g.all.find((e) => e.number === 1).drawsSince === 0);
  check("a number last seen 4 draws back reports 4", g.all.find((e) => e.number === 8).drawsSince === 4, JSON.stringify(g.all.find((e) => e.number === 8)));

  // The distinction that matters: never-seen is not the same as long-gap.
  const never = g.all.find((e) => e.number === 44);
  check("a number never drawn is flagged, not given a fake gap", never.neverSeen === true && never.drawsSince === null);
  check("never-seen numbers are listed separately", g.neverSeenInWindow.includes(44));
  check("longest gaps only include numbers actually seen", g.longestGaps.every((e) => e.neverSeen === false));
  check("it warns that a long gap does not make a number due", /does not make a number due/.test(g.overdueWarning));
  check("it explains independence concretely", /same chance/.test(g.overdueWarning));
}

{
  const s = shapeStats(HISTORY);
  check("computes odd/even splits", s.oddEven.length > 0 && /odd/.test(s.oddEven[0].split));
  check("computes high/low splits", s.highLow.length > 0);
  check("computes sum statistics", s.sum.min <= s.sum.median && s.sum.median <= s.sum.max);
  check("sum mean is a real average", s.sum.mean > 0);
  check("detects consecutive pairs", s.consecutive.totalConsecutivePairs >= 2, JSON.stringify(s.consecutive));
  check("reports the share of draws containing a consecutive pair",
    s.consecutive.shareOfDraws > 0 && s.consecutive.shareOfDraws <= 1);
  check("empty history does not throw", shapeStats([]).drawsAnalyzed === 0);
}

{
  const p = pairStats(HISTORY, { top: 5 });
  check("finds the most common pair", p.topPairs[0].pair === "1-2" && p.topPairs[0].count === 3, JSON.stringify(p.topPairs[0]));
  check("it warns that a leading pair may be chance", /chance alone/.test(p.note));
}

{
  const r = repeatStats(HISTORY);
  check("compares each draw to the previous one", r.comparisons === 4);
  check("counts draws sharing a number with the previous draw", r.drawsWithAtLeastOneRepeat === 3, String(r.drawsWithAtLeastOneRepeat));
  check("averages repeats per draw", r.averageRepeatsPerDraw > 0);
  check("a single draw cannot be compared", /at least two/.test(repeatStats([HISTORY[0]]).note));
}

{
  const all = analyzeAll(HISTORY, { top: 3 });
  check("analyzeAll bundles every analysis",
    all.frequency && all.gaps && all.shape && all.pairs && all.repeats);
  check("the bundle carries the basis once at the top", /does not forecast/.test(all.basis));
}

console.log("\nApp signals");

{
  check("lottery emits nothing without a watch list", lotterySignals({}).length === 0);

  const withWatch = lotterySignals({
    lotteryWatch: [
      { date: "2026-09-22", game: "Powerball", state: "California" },
      { date: "2026-09-23", game: "Mega Millions", state: "Nevada", jackpot: "$800M" }
    ]
  });
  check("emits a draw-day signal per watched draw", withWatch.length === 2);
  check("marks a watched draw that has a jackpot figure",
    withWatch[1].kind === "draw_day_with_jackpot" && withWatch[1].value === "$800M");
  check("includes the game and state in the detail", /Powerball/.test(withWatch[0].detail) && /California/.test(withWatch[0].detail));

  // The app must not invent a prize pool it has no source for.
  check("no jackpot is fabricated when none was supplied",
    withWatch[0].kind === "draw_day" && withWatch[0].value === undefined);
}

{
  const WEEK_START = new Date("2026-09-18T11:00:00.000Z");
  const signals = drivingSignals({ scheduleOptions: { weekStart: WEEK_START } });

  check("driving emits its two days off", signals.filter((s) => s.kind === "low_opportunity_day").length === 2);
  check("driving emits a signal per block day", signals.some((s) => s.kind === "recommended_driving_block"));
  check("it does not emit one signal per hour", signals.length < 12, String(signals.length));
  check("days off carry their average score as detail",
    /average opportunity score/.test(signals.find((s) => s.kind === "low_opportunity_day").detail));
  check("the detail says the score is relative to the week",
    /relative to this week/.test(signals.find((s) => s.kind === "low_opportunity_day").detail));

  // Passing a precomputed schedule must not recompute.
  const precomputed = drivingSignals({ schedule: { bestDaysOff: [], blocks: [] } });
  check("a supplied schedule is used as-is", precomputed.length === 0);
}

console.log("\nEnd to end: the driving + lottery coincidence");

{
  _resetRegistryForTests();
  registerDrivingApp();
  registerLotteryApp();

  check("both apps register", listApps().length === 2);
  check("each declares its own domain",
    listApps().find((a) => a.id === "lottery").domain !== listApps().find((a) => a.id === "driving").domain);

  const WEEK_START = new Date("2026-09-18T11:00:00.000Z");
  // The scheduler independently rates Mon 9/21 and Tue 9/22 as the two
  // weakest days of this week, so a draw on the 22nd is a real overlap.
  const { signals, failures } = await collectSignals({
    scheduleOptions: { weekStart: WEEK_START },
    lotteryWatch: [{ date: "2026-09-22T20:00:00-07:00", game: "Powerball", state: "California", jackpot: "$800M" }]
  });

  check("collection succeeds for both apps", failures.length === 0, JSON.stringify(failures));
  check("signals come from both apps",
    new Set(signals.map((s) => s.app)).size === 2, JSON.stringify([...new Set(signals.map((s) => s.app))]));

  const co = findCoincidences(signals);
  const tuesday = co.days.find((d) => d.date === "2026-09-22");
  check("the overlap on the weak driving day is found", Boolean(tuesday), JSON.stringify(co.days.map((d) => d.date)));
  check("it names both apps", tuesday && tuesday.apps.join(",") === "driving,lottery");
  check("it carries the driving fact", tuesday && tuesday.signals.some((s) => s.kind === "low_opportunity_day"));
  check("it carries the lottery fact", tuesday && tuesday.signals.some((s) => s.kind === "draw_day_with_jackpot"));

  // The crucial one: this must remain an observation.
  check("the report still refuses to draw a conclusion from the overlap",
    /none of it is a recommendation/.test(co.meaning) && /justifies/.test(co.meaning), co.meaning);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
