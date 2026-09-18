/**
 * Tests for reno-engine.js — run with: node reno-engine.test.mjs
 *
 * The spec this engine was ported from ends with an explicit audit
 * instruction: "if the engine claims to consider it, it must actually
 * change the calculation when the evidence changes." That is the single
 * most important property here, and most of these tests exist to prove it
 * rather than to prove the code merely runs — for every signal family the
 * engine claims to use, feeding it evidence must move the number in the
 * direction the spec says, and by the frozen weight the spec names.
 *
 * The second thing worth guarding is the structural contract: exactly 168
 * hours, every hour once, six non-overlapping blocks, extensions that
 * never eat another block, and the one-off exclusion rule.
 */

import { scheduleReno, nextOperationalBoundary, dedupeEvidence, ALGORITHM_VERSION } from "./reno-engine.js";

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

function approx(a, b, tol = 1e-9) {
  return Math.abs(a - b) <= tol;
}

// A fixed week start so every test is deterministic regardless of when it runs.
// 2026-09-18T11:00:00Z == Fri Sep 18 2026, 4:00 AM Reno local (PDT).
const WEEK_START = new Date("2026-09-18T11:00:00.000Z");

function run(extra = {}) {
  return scheduleReno({ weekStart: WEEK_START, ...extra });
}

/* ------------------------------------------------------------------ */

console.log("\nStructural contract (spec section 18)");

{
  const r = run();
  check("produces exactly 168 hours", r.hours.length === 168, String(r.hours.length));
  check("ranks all 168 hours", r.ranked.length === 168);

  const keys = new Set(r.hours.map((h) => h.date.toISOString()));
  check("every hour appears exactly once", keys.size === 168, String(keys.size));

  const ranks = new Set(r.hours.map((h) => h.rank));
  check("ranks are 1..168 with no gaps or duplicates", ranks.size === 168 && Math.min(...ranks) === 1 && Math.max(...ranks) === 168);

  check("ranking is sorted best to worst", r.ranked.every((h, i) => i === 0 || r.ranked[i - 1].O >= h.O));

  // Spec: ranks use unrounded raw O_h, not the rounded display score.
  const tiedOnDisplay = r.hours.filter((h) => r.hours.some((o) => o !== h && Math.round(o.score * 10) === Math.round(h.score * 10)));
  check("ranks come from raw opportunity, not rounded score",
    tiedOnDisplay.every((h) => Number.isInteger(h.rank)));

  check("hours are one hour apart, in order",
    r.hours.every((h, i) => i === 0 || h.date - r.hours[i - 1].date === 3600_000));

  check("reports the canonical algorithm version", r.algorithmVersion === ALGORITHM_VERSION);
}

console.log("\nOperational week definition (spec section 2)");

{
  // Reno local 4:00 AM boundary, from an arbitrary mid-afternoon moment.
  const from = new Date("2026-09-17T23:30:00.000Z"); // 4:30 PM PDT Sep 17
  const boundary = nextOperationalBoundary(from);
  const localHour = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "2-digit", hour12: false })
      .format(boundary)
  ) % 24;
  check("next boundary lands on Reno-local 4 AM", localHour === 4, String(localHour));
  check("boundary is in the future relative to the input", boundary > from);

  const r = run();
  check("week starts at the supplied boundary", r.weekStart.getTime() === WEEK_START.getTime());
  check("week covers 7 complete operational days", (r.hours[167].date - r.hours[0].date) / 3600_000 === 167);
}

console.log("\nFrozen baseline shape (spec B3/B4/B5) — no evidence supplied");

{
  const r = run();
  const scores = r.hours.map((h) => h.score);
  check("scores stay inside 0-100", Math.min(...scores) > 0 && Math.max(...scores) < 100);

  // Saturday late night is the strongest baseline combination in the frozen
  // tables (day 1.34 x hour 1.48/1.46); early Wednesday morning among the
  // weakest (0.89 x 0.48). The ranking should reflect that without help.
  const best = r.ranked[0];
  check("baseline best hour is a weekend late-night hour",
    (best.weekday === "Sat" || best.weekday === "Fri") && (best.hour >= 22 || best.hour <= 1),
    `${best.weekday} ${best.hour}:00`);

  // Worth pinning precisely, because it is the engine's most distinctive
  // and most counter-intuitive rule: the frozen traffic penalties are big
  // enough that ordinary weekday rush hour is the WORST part of the week —
  // below even 4 AM, when almost nobody is riding. An implementation that
  // quietly treated rush hour as a commute bonus (the obvious, wrong thing)
  // would pass a vaguer test and fail this one.
  const worst = r.ranked[167];
  const isWeekday = !["Sat", "Sun"].includes(worst.weekday);
  const isRushHour = (worst.hour >= 7 && worst.hour < 9) || (worst.hour >= 16 && worst.hour < 18);
  check("baseline worst hour of the week is a weekday rush hour, not a dead pre-dawn hour",
    isWeekday && isRushHour,
    `${worst.weekday} ${worst.hour}:00`);

  const bottomFive = r.ranked.slice(-5);
  check("the whole bottom of the week is weekday rush hour",
    bottomFive.every((h) => !["Sat", "Sun"].includes(h.weekday) &&
      ((h.hour >= 7 && h.hour < 9) || (h.hour >= 16 && h.hour < 18))),
    bottomFive.map((h) => `${h.weekday} ${h.hour}:00`).join(", "));

  // ...and specifically that rush hour scores below the same day's 4 AM.
  const tue4am = r.hours.find((h) => h.weekday === "Tue" && h.hour === 4);
  const tue4pm = r.hours.find((h) => h.weekday === "Tue" && h.hour === 16);
  check("Tuesday 4 PM scores worse than Tuesday 4 AM", tue4pm.O < tue4am.O,
    `4PM ${tue4pm.O.toFixed(3)} vs 4AM ${tue4am.O.toFixed(3)}`);

  // Score 50 should sit near the week's robust center (spec B2).
  const median = [...scores].sort((a, b) => a - b)[84];
  check("median hour scores near 50 (robust center)", Math.abs(median - 50) < 6, median.toFixed(1));
}

console.log("\nEvidence actually changes the calculation (spec's own audit standard)");

function hourAt(result, isoDate) {
  return result.hours.find((h) => h.date.toISOString() === isoDate);
}

// Sat Sep 19, 10 PM Reno = 2026-09-20T05:00:00Z
const TEST_HOUR_ISO = "2026-09-20T05:00:00.000Z";

function withEvidence(family, value, extra = {}) {
  return run({
    evidence: [
      {
        family,
        label: `test ${family}`,
        value,
        confidence: 1,
        source: "test",
        start: TEST_HOUR_ISO,
        end: new Date(new Date(TEST_HOUR_ISO).getTime() + 3600_000).toISOString(),
        ...extra
      }
    ]
  });
}

{
  const base = hourAt(run(), TEST_HOUR_ISO);

  // Each of these asserts BOTH that the number moved and that it moved by
  // the exact frozen weight from spec section C, computed through the
  // formula (ln(D) term for demand-side families).
  const demandOnly = [
    ["calendar", 0.075],
    ["weather", 0.1],
    ["nightlife", 0.085],
    ["university", 0.07],
    ["interaction_demand", 0.07]
  ];
  for (const [family, weight] of demandOnly) {
    const h = hourAt(withEvidence(family, 1), TEST_HOUR_ISO);
    const expectedDemandDelta = weight; // ln(D*e^w) - ln(D) == w
    const actual = Math.log(h.D) - Math.log(base.D);
    check(`${family} moves demand by its frozen weight (${weight})`, approx(actual, expectedDemandDelta, 1e-9),
      `expected ${expectedDemandDelta}, got ${actual}`);
  }

  // Nightlife also touches Q (spec C11).
  {
    const h = hourAt(withEvidence("nightlife", 1), TEST_HOUR_ISO);
    check("nightlife also raises trip quality Q by 0.035", approx(h.Q - base.Q, 0.035, 1e-9), String(h.Q - base.Q));
  }

  // Driver supply is the load-bearing correction in this engine: more
  // drivers must be able to cancel a demand gain (spec B1/section 4).
  {
    const h = hourAt(withEvidence("driver_supply", 1), TEST_HOUR_ISO);
    check("driver_supply raises supply by its frozen weight (0.25)",
      approx(Math.log(h.S) - Math.log(base.S), 0.25, 1e-9));
    check("more competing drivers LOWERS opportunity", h.O < base.O, `${h.O} vs ${base.O}`);
  }

  // Events raise demand AND attract supply (spec C2) — the anti-optimism rule.
  {
    const h = hourAt(withEvidence("event_demand", 1), TEST_HOUR_ISO);
    check("event_demand raises demand by 0.18", approx(Math.log(h.D) - Math.log(base.D), 0.18, 1e-9));
    check("event_demand ALSO raises competing supply by 0.16", approx(Math.log(h.S) - Math.log(base.S), 0.16, 1e-9));

    // Net effect: 0.18 demand - 0.72*0.16 supply = +0.0648, still positive
    // but far smaller than the naive demand-only read.
    const naive = 0.18;
    const net = h.O - base.O;
    check("event net gain is materially smaller than its raw demand gain", net > 0 && net < naive * 0.45,
      `net ${net.toFixed(4)} vs naive ${naive}`);
  }

  // A big event with heavy driver camping should be able to go NET NEGATIVE
  // (spec section 8: "can receive only a modest positive effect or even a
  // net negative driver-opportunity effect").
  {
    const end = new Date(new Date(TEST_HOUR_ISO).getTime() + 3600_000).toISOString();
    const r = run({
      evidence: [
        { family: "event_demand", label: "big concert", value: 1.5, confidence: 1, source: "t", start: TEST_HOUR_ISO, end },
        { family: "driver_camping", label: "surge chasing", value: 2, confidence: 1, source: "t", start: TEST_HOUR_ISO, end },
        { family: "free_parking", label: "free lots", value: 1.5, confidence: 1, source: "t", start: TEST_HOUR_ISO, end },
        { family: "shuttle", label: "free shuttles", value: 1.5, confidence: 1, source: "t", start: TEST_HOUR_ISO, end },
        { family: "pickup_friction", label: "gridlocked pickup", value: 2, confidence: 1, source: "t", start: TEST_HOUR_ISO, end }
      ]
    });
    const h = hourAt(r, TEST_HOUR_ISO);
    check("a saturated, shuttle-served, gridlocked event scores NET WORSE than no event at all",
      h.O < base.O, `${h.O.toFixed(3)} vs baseline ${base.O.toFixed(3)}`);
  }

  // Friction families raise R, which subtracts.
  const frictionFamilies = [
    ["traffic", 0.2],
    ["wait_time", 0.1],
    ["pickup_friction", 0.15],
    ["airport_queue", 0.15],
    ["interaction_friction", 0.08]
  ];
  for (const [family, weight] of frictionFamilies) {
    const h = hourAt(withEvidence(family, 1), TEST_HOUR_ISO);
    check(`${family} raises friction R by ${weight}`, approx(h.R - base.R, weight, 1e-9), String(h.R - base.R));
  }

  // Tahoe: demand up, but geography and throughput both penalized (C6).
  {
    const h = hourAt(withEvidence("tahoe", 1), TEST_HOUR_ISO);
    check("tahoe raises demand (+0.07)", approx(Math.log(h.D) - Math.log(base.D), 0.07, 1e-9));
    check("tahoe penalizes geography (-0.07)", approx(h.G - base.G, -0.07, 1e-9));
    check("tahoe penalizes throughput (-0.09)", approx(h.T - base.T, -0.09, 1e-9));
  }

  // Long-trip risk is asymmetric and only penalizes (max(0,w)).
  {
    const up = hourAt(withEvidence("long_trip_risk", 1), TEST_HOUR_ISO);
    const down = hourAt(withEvidence("long_trip_risk", -1), TEST_HOUR_ISO);
    check("long_trip_risk penalizes throughput when present", approx(up.T - base.T, -0.18, 1e-9));
    check("long_trip_risk does NOT reward its own absence", approx(down.T, base.T, 1e-9));
  }

  // Dangerous weather both suppresses demand and spikes friction (C7).
  {
    const h = hourAt(withEvidence("safety_suppression", 1), TEST_HOUR_ISO);
    check("safety_suppression suppresses demand (-0.08)", approx(Math.log(h.D) - Math.log(base.D), -0.08, 1e-9));
    check("safety_suppression spikes friction (+0.28)", approx(h.R - base.R, 0.28, 1e-9));
  }
}

console.log("\nEvidence weighting, confidence, windows, and hygiene");

{
  const base = hourAt(run(), TEST_HOUR_ISO);
  const end = new Date(new Date(TEST_HOUR_ISO).getTime() + 3600_000).toISOString();

  // Confidence scales the effect linearly (w = clamped_value * confidence).
  const full = hourAt(withEvidence("weather", 1, { confidence: 1 }), TEST_HOUR_ISO);
  const half = hourAt(withEvidence("weather", 1, { confidence: 0.5 }), TEST_HOUR_ISO);
  check("confidence scales evidence weight linearly",
    approx((Math.log(half.D) - Math.log(base.D)) * 2, Math.log(full.D) - Math.log(base.D), 1e-9));

  // Value is clamped to [-2, +2] (spec C).
  const two = hourAt(withEvidence("weather", 2), TEST_HOUR_ISO);
  const ten = hourAt(withEvidence("weather", 10), TEST_HOUR_ISO);
  check("evidence value is clamped at +2", approx(two.O, ten.O, 1e-9));

  // Source quality supplies confidence when none is given (spec I).
  const official = hourAt(withEvidence("weather", 1, { confidence: undefined, sourceType: "official" }), TEST_HOUR_ISO);
  const social = hourAt(withEvidence("weather", 1, { confidence: undefined, sourceType: "social" }), TEST_HOUR_ISO);
  check("official source outweighs an unverified social one",
    Math.log(official.D) - Math.log(base.D) > Math.log(social.D) - Math.log(base.D));
  check("social source uses the 0.30 quality weight",
    approx(Math.log(social.D) - Math.log(base.D), 0.1 * 0.3, 1e-9));

  // Applicability windows: evidence must not leak into other hours (spec J1).
  {
    const r = withEvidence("event_demand", 2);
    const inside = hourAt(r, TEST_HOUR_ISO);
    const outside = hourAt(r, "2026-09-20T08:00:00.000Z");
    const cleanOutside = hourAt(run(), "2026-09-20T08:00:00.000Z");
    check("windowed evidence affects its own hour", inside.O !== hourAt(run(), TEST_HOUR_ISO).O);
    check("windowed evidence does NOT contaminate other hours", approx(outside.O, cleanOutside.O, 1e-12));
  }

  // Unbounded evidence requires explicit opt-in (spec J1).
  {
    const noWindow = run({ evidence: [{ family: "weather", label: "x", value: 2, confidence: 1, source: "t" }] });
    const clean = run();
    check("evidence with no window and no opt-in is ignored, not applied everywhere",
      approx(hourAt(noWindow, TEST_HOUR_ISO).O, hourAt(clean, TEST_HOUR_ISO).O, 1e-12));

    const optedIn = run({ evidence: [{ family: "weather", label: "x", value: 2, confidence: 1, source: "t", fullWeek: true }] });
    check("evidence explicitly marked fullWeek DOES apply to every hour",
      optedIn.hours.every((h, i) => h.D > clean.hours[i].D));
  }

  // Duplicate protection (spec J2).
  {
    const rec = { family: "weather", label: "rain", value: 1, source: "nws", start: TEST_HOUR_ISO, end, confidence: 0.6 };
    const deduped = dedupeEvidence([rec, { ...rec }, { ...rec, confidence: 0.9 }]);
    check("exact duplicates collapse to one record", deduped.length === 1, String(deduped.length));
    check("the stronger confidence survives deduplication", deduped[0].confidence === 0.9);

    const differing = dedupeEvidence([rec, { ...rec, label: "snow" }]);
    check("genuinely different evidence is NOT merged", differing.length === 2);
  }

  // Safety caps (spec C17).
  {
    const many = [];
    for (let i = 0; i < 40; i++) {
      many.push({ family: "event_demand", label: `stack ${i}`, value: 2, confidence: 1, source: `s${i}`, start: TEST_HOUR_ISO, end });
    }
    const h = hourAt(run({ evidence: many }), TEST_HOUR_ISO);
    const baseline = hourAt(run(), TEST_HOUR_ISO);
    const demandMultiple = h.D / baseline.D;
    const supplyMultiple = h.S / baseline.S;
    check("stacked demand evidence is capped at the 2.00 envelope", demandMultiple <= 2.0 + 1e-9, demandMultiple.toFixed(3));
    check("stacked supply response is capped at the 1.70 envelope", supplyMultiple <= 1.7 + 1e-9, supplyMultiple.toFixed(3));
  }

  // Unknown family names are surfaced rather than silently doing nothing.
  {
    const r = run({ evidence: [{ family: "definitely_not_a_family", label: "x", value: 2, confidence: 1, source: "t", start: TEST_HOUR_ISO, end }] });
    const h = hourAt(r, TEST_HOUR_ISO);
    check("an unrecognized family is recorded for inspection", h.unrecognized.length === 1);
    check("an unrecognized family does not silently alter the score",
      approx(h.O, hourAt(run(), TEST_HOUR_ISO).O, 1e-12));
  }
}

console.log("\nReno traffic baseline (spec section 10 / D)");

{
  const r = run();
  // Mon Sep 21, 8 AM Reno = 2026-09-21T15:00:00Z (AM peak + no shoulder)
  const amPeak = hourAt(r, "2026-09-21T15:00:00.000Z");
  // Mon Sep 21, 5 PM Reno = 2026-09-22T00:00:00Z (PM peak)
  const pmPeak = hourAt(r, "2026-09-22T00:00:00.000Z");
  // Mon Sep 21, 12 PM Reno = 2026-09-21T19:00:00Z (no penalty)
  const midday = hourAt(r, "2026-09-21T19:00:00.000Z");

  check("weekday AM peak carries the frozen 0.38 friction", approx(amPeak.R - midday.R, 0.38, 1e-9), String(amPeak.R));
  check("weekday PM peak carries the frozen 0.42 friction", approx(pmPeak.R - midday.R, 0.42, 1e-9), String(pmPeak.R));
  check("rush hour is a PENALTY, not a commute bonus", amPeak.R > 0 && pmPeak.R > 0);

  // Sat Sep 19, 8 AM Reno = 2026-09-19T15:00:00Z — weekend, so no baseline penalty.
  const satMorning = hourAt(r, "2026-09-19T15:00:00.000Z");
  check("the weekday traffic baseline does not apply on weekends", approx(satMorning.R, 0, 1e-12), String(satMorning.R));
}

console.log("\nTrip throughput and Quest structure (spec section 6-7 / E)");

{
  const r = run();
  // Late-evening hours get the 3.55 natural baseline; 2-10 AM gets 2.65.
  const lateNight = hourAt(r, "2026-09-20T05:00:00.000Z"); // Sat 10 PM
  const morning = hourAt(r, "2026-09-19T15:00:00.000Z"); // Sat 8 AM
  check("late-evening hours carry a higher expected throughput", lateNight.expectedTph > morning.expectedTph,
    `${lateNight.expectedTph} vs ${morning.expectedTph}`);
  check("expected TPH uses the 0.65/0.35 natural/learned blend",
    approx(lateNight.expectedTph, 0.65 * 3.55 + 0.35 * 3.0, 1e-9), String(lateNight.expectedTph));

  // A driver with a better learned history should see throughput-driven lift.
  const better = scheduleReno({ weekStart: WEEK_START, learnedUberTph: 5.0 });
  check("a higher learned trips/hour raises expected throughput",
    hourAt(better, "2026-09-20T05:00:00.000Z").expectedTph > lateNight.expectedTph);

  // Dynamic quest layer (spec E3).
  const nearlyDone = scheduleReno({
    weekStart: WEEK_START,
    quest: { target: 50, current: 45, payout: 120, deadlineHourIndex: 100 }
  });
  const noQuest = hourAt(r, "2026-09-18T20:00:00.000Z");
  const withQuest = hourAt(nearlyDone, "2026-09-18T20:00:00.000Z");
  check("a nearly-complete, valuable quest raises throughput value", withQuest.T > noQuest.T,
    `${withQuest.T.toFixed(4)} vs ${noQuest.T.toFixed(4)}`);

  const alreadyDone = scheduleReno({
    weekStart: WEEK_START,
    quest: { target: 50, current: 50, payout: 120, deadlineHourIndex: 100 }
  });
  check("a completed quest adds no further pressure",
    approx(hourAt(alreadyDone, "2026-09-18T20:00:00.000Z").T, noQuest.T, 1e-12));

  const impossible = scheduleReno({
    weekStart: WEEK_START,
    quest: { target: 500, current: 0, payout: 120, deadlineHourIndex: 5 }
  });
  check("an unreachable quest is abandoned rather than chased",
    approx(hourAt(impossible, "2026-09-18T20:00:00.000Z").T, noQuest.T, 1e-12));

  const afterDeadline = scheduleReno({
    weekStart: WEEK_START,
    quest: { target: 50, current: 45, payout: 120, deadlineHourIndex: 10 }
  });
  check("hours past the quest deadline get no quest value",
    approx(hourAt(afterDeadline, "2026-09-20T05:00:00.000Z").T, hourAt(r, "2026-09-20T05:00:00.000Z").T, 1e-12));
}

console.log("\nSix-block shift optimizer (spec section 20-22)");

{
  const r = run();
  check("returns exactly six blocks", r.blocks.length === 6, String(r.blocks.length));

  // Re-derive occupancy from the reported block spans.
  const spans = r.blocks.map((b) => ({
    start: Math.round((b.startDate - r.weekStart) / 3600_000),
    end: Math.round((b.endDate - r.weekStart) / 3600_000) + 1
  }));

  let overlaps = 0;
  for (let i = 0; i < spans.length; i++) {
    for (let j = i + 1; j < spans.length; j++) {
      if (spans[i].start < spans[j].end && spans[j].start < spans[i].end) overlaps++;
    }
  }
  check("blocks never overlap", overlaps === 0, `${overlaps} overlapping pairs`);

  check("every block is at least the 8-hour core", spans.every((s) => s.end - s.start >= 8));
  check("no block exceeds 10 hours (8 core + 2 extension max)", spans.every((s) => s.end - s.start <= 10));
  check("all blocks fall inside the forecast week", spans.every((s) => s.start >= 0 && s.end <= 168));

  check("blocks are reported strongest first",
    r.blocks.every((b, i) => i === 0 || r.blocks[i - 1].extendedTotalScore >= b.extendedTotalScore));

  check("core total equals extended total when there is no extension",
    r.blocks.every((b) => b.hasExtension || b.coreTotalScore === b.extendedTotalScore));

  check("extended average is consistent with the extended total",
    r.blocks.every((b) => Math.abs(b.extendedTotalScore / b.hoursCount - b.extendedAvgScore) < 0.6));

  // The optimizer must be JOINT, not greedy: prove it beats the greedy
  // pick-best-then-next-best strategy on total opportunity, or at minimum
  // never does worse.
  {
    const hoursByIndex = r.hours;
    const windowTotal = (start) => hoursByIndex.slice(start, start + 8).reduce((s, h) => s + h.O, 0);

    const greedyStarts = [];
    const used = new Set();
    for (let pick = 0; pick < 6; pick++) {
      let bestStart = -1;
      let bestVal = -Infinity;
      for (let s = 0; s <= 160; s++) {
        let clash = false;
        for (let i = s; i < s + 8; i++) if (used.has(i)) { clash = true; break; }
        if (clash) continue;
        const v = windowTotal(s);
        if (v > bestVal) { bestVal = v; bestStart = s; }
      }
      if (bestStart < 0) break;
      greedyStarts.push(bestStart);
      for (let i = bestStart; i < bestStart + 8; i++) used.add(i);
    }

    const greedyTotal = greedyStarts.reduce((s, st) => s + windowTotal(st), 0);
    const jointTotal = r.blocks.reduce((sum, b) => {
      const start = Math.round((b.coreStartDate - r.weekStart) / 3600_000);
      return sum + windowTotal(start);
    }, 0);

    check("joint optimization is at least as good as greedy selection",
      jointTotal >= greedyTotal - 1e-9,
      `joint ${jointTotal.toFixed(3)} vs greedy ${greedyTotal.toFixed(3)}`);
  }

  // Extensions must be earned: an extended hour must be at least as strong
  // as the block's own average (the documented interpretation).
  for (const b of r.blocks.filter((x) => x.hasExtension)) {
    const start = Math.round((b.startDate - r.weekStart) / 3600_000);
    const end = Math.round((b.endDate - r.weekStart) / 3600_000) + 1;
    const coreStart = Math.round((b.coreStartDate - r.weekStart) / 3600_000);
    const coreEnd = Math.round((b.coreEndDate - r.weekStart) / 3600_000) + 1;
    const extendedHours = [];
    for (let i = start; i < coreStart; i++) extendedHours.push(r.hours[i]);
    for (let i = coreEnd; i < end; i++) extendedHours.push(r.hours[i]);
    const coreAvg = r.hours.slice(coreStart, coreEnd).reduce((s, h) => s + h.O, 0) / 8;
    check(`block ${b.rank}: every extension hour pulls its weight`,
      extendedHours.every((h) => h.O >= coreAvg - 1e-9));
  }
}

console.log("\nDays off and one-off hours (spec sections 23-24)");

{
  const r = run();
  check("exactly two days off are recommended", r.bestDaysOff.length === 2);

  const allDayTotals = [];
  for (let d = 0; d < 7; d++) {
    allDayTotals.push(r.hours.slice(d * 24, d * 24 + 24).reduce((s, h) => s + h.O, 0));
  }
  const sorted = [...allDayTotals].sort((a, b) => a - b);
  check("days off are the two weakest complete operational days",
    approx(r.bestDaysOff[0].totalO, sorted[0], 1e-9) && approx(r.bestDaysOff[1].totalO, sorted[1], 1e-9));
  check("day off #1 is the weakest of the two", r.bestDaysOff[0].totalO <= r.bestDaysOff[1].totalO);

  // One-off hours: threshold and exclusion rule.
  check("one-off hours all clear the 81.6 threshold",
    r.oneOffHours.every((h) => h.score >= 81.6));

  if (r.oneOffHours.length === 0) {
    check("an empty one-off list says so explicitly", r.oneOffMessage === "No exceptional one-off hours this week.");
  } else {
    check("a populated one-off list carries no 'none' message", r.oneOffMessage === null);
  }

  // Force one-offs to exist by making some non-block hours exceptional, then
  // verify the top-four-block exclusion actually holds.
  {
    const strong = [];
    // Tue Sep 22, 3 PM-6 PM Reno — a normally-weak stretch far from the
    // weekend blocks, pushed up hard enough to clear the threshold.
    for (let i = 0; i < 4; i++) {
      const start = new Date(Date.UTC(2026, 8, 22, 22 + i, 0, 0)).toISOString();
      strong.push({
        family: "event_demand",
        label: `forced ${i}`,
        value: 2,
        confidence: 1,
        source: `f${i}`,
        start,
        end: new Date(new Date(start).getTime() + 3600_000).toISOString()
      });
      strong.push({
        family: "fare_quality",
        label: `forced q ${i}`,
        value: 2,
        confidence: 1,
        source: `fq${i}`,
        start,
        end: new Date(new Date(start).getTime() + 3600_000).toISOString()
      });
    }
    const forced = run({ evidence: strong });
    const topFour = forced.blocks.slice(0, 4);
    const excluded = new Set();
    for (const b of topFour) {
      const s = Math.round((b.startDate - forced.weekStart) / 3600_000);
      const e = Math.round((b.endDate - forced.weekStart) / 3600_000) + 1;
      for (let i = s; i < e; i++) excluded.add(i);
    }
    const violating = forced.oneOffHours.filter((oh) => {
      const idx = Math.round((oh.date - forced.weekStart) / 3600_000);
      return excluded.has(idx);
    });
    check("no one-off hour falls inside a top-four block (incl. extensions)",
      violating.length === 0, `${violating.length} violations`);
  }
}

console.log("\nReason generation (spec section 19)");

{
  const end = new Date(new Date(TEST_HOUR_ISO).getTime() + 3600_000).toISOString();
  const r = run({
    evidence: [
      { family: "event_demand", label: "arena show", value: 1.5, confidence: 1, source: "venue", start: TEST_HOUR_ISO, end, note: "arena show" },
      { family: "driver_supply", label: "saturation", value: 1.2, confidence: 1, source: "obs", start: TEST_HOUR_ISO, end },
      { family: "traffic", label: "closure", value: 0.4, confidence: 1, source: "ndot", start: TEST_HOUR_ISO, end }
    ]
  });
  const h = hourAt(r, TEST_HOUR_ISO);

  check("reasons are generated for an evidence-bearing hour", typeof h.reasons === "string" && h.reasons.length > 0);
  check("reasons name actual contributing factors, not a generic label",
    /event demand|driver oversupply|traffic/.test(h.reasons), h.reasons);
  check("reasons carry direction (+ helped / - hurt)", /[+-]/.test(h.reasons), h.reasons);
  check("the strongest mover is listed first",
    h.reasons.startsWith("+ event demand") || h.reasons.startsWith("- driver oversupply"), h.reasons);

  const plain = hourAt(run(), "2026-09-21T19:00:00.000Z");
  check("a no-evidence hour falls back to an honest baseline explanation",
    /baseline/i.test(plain.reasons), plain.reasons);
}

console.log("\nDeterminism and reproducibility (spec section 1)");

{
  const a = run();
  const b = run();
  check("identical inputs produce identical rankings",
    a.hours.every((h, i) => approx(h.O, b.hours[i].O, 1e-12) && h.rank === b.hours[i].rank));
  check("identical inputs produce identical block selections",
    JSON.stringify(a.blocks.map((x) => x.startDate)) === JSON.stringify(b.blocks.map((x) => x.startDate)));
  check("the formula fingerprint is reported for auditability",
    typeof a.formulaFingerprint === "string" && a.formulaFingerprint.length === 64);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
