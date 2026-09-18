/**
 * reno-engine.js — the Reno Uber Opportunity-Ranking and Shift-Optimization Engine.
 *
 * Ported from the user's own saved specification (three source documents:
 * UBER_ENGINE_MASTER_SPEC.txt, Reno_Uber_Algorithm_New_Chat_Master.md, and
 * Reno_Uber_Opportunity_Ranking_Engine.txt), which together describe a
 * deterministic, evidence-first forecasting system that ranks every one-hour
 * period in the coming Reno operational week by driver opportunity (not raw
 * rider demand), then turns that ranking into a legal, optimized 6-block
 * driving schedule.
 *
 * Canonical algorithm version: RENO_UBER_V1_CANONICAL_2026_09_02
 * Protected formula fingerprint (from the spec):
 *   cffe66bfad63b371beb9f07f450a15bf42fcaa4ef15c74380b8c8608dd5260f0
 *
 * WHERE THIS FILE IS EXACT VS. WHERE IT INTERPRETS:
 *
 * The spec explicitly marks some things "frozen" (the O_h formula, the
 * weekly-normalization formula, the base hour/day demand and supply tables,
 * the per-signal-family weight translations, the Reno traffic baseline, the
 * trip-throughput bands) — those are implemented verbatim below, each
 * tagged FROZEN in a comment with its section number from the spec.
 *
 * A few things the spec describes qualitatively/boundedly rather than as an
 * exact formula (the dynamic exact-Quest contribution's shape within its
 * stated [-0.10, +0.24] bound; block-extension "meaningful additional
 * opportunity"; Nevada rest-compliance shortening; day-off scoring; reason
 * generation) are implemented as reasonable, documented choices — each
 * tagged INTERPRETED below. Per the spec's own audit note ("if the engine
 * claims to consider it, it must actually change the calculation when the
 * evidence changes"), these are built to actually move the numbers, not to
 * be decorative.
 *
 * This module is pure computation: it takes evidence the caller supplies
 * (or none, which still produces a full baseline ranking) and returns a
 * ranking + schedule. It does not fetch evidence itself — live evidence
 * gathering (events, weather, airport feeds, traffic) is a separate concern
 * left to whatever calls this (a chat tool, a research pipeline), consistent
 * with the spec's own instruction not to fabricate evidence.
 */

// ======================================================================
// B1-B5. Frozen constants
// ======================================================================

export const ALGORITHM_VERSION = "RENO_UBER_V1_CANONICAL_2026_09_02";
export const FORMULA_FINGERPRINT =
  "cffe66bfad63b371beb9f07f450a15bf42fcaa4ef15c74380b8c8608dd5260f0";

// FROZEN (spec B1): supply-sensitivity exponent in O_h = ln(D_h) - beta_s*ln(S_h) + ...
const BETA_S = 0.72;

// FROZEN (spec B2): robust normalization constants.
const MAD_SCALE = 1.4826;
const SIGMOID_SLOPE = 1.1;

// FROZEN (spec B3): base hour-demand multipliers, hours 0..23.
const HOUR_DEMAND = [
  1.25, 1.18, 0.94, 0.57, 0.48, 0.61, 0.78, 0.95, 1.02, 0.94, 0.91, 0.95,
  1.0, 0.98, 1.0, 1.05, 1.14, 1.27, 1.25, 1.2, 1.24, 1.34, 1.48, 1.46
];

// FROZEN (spec B4): base day-demand multipliers. JS getDay(): 0=Sun..6=Sat.
const DAY_DEMAND_BY_JS_DAY = [0.99, 0.86, 0.84, 0.89, 1.0, 1.23, 1.34];

// FROZEN (spec B5): base hour-supply multipliers, hours 0..23.
const HOUR_SUPPLY = [
  0.9, 0.82, 0.72, 0.57, 0.52, 0.59, 0.72, 0.84, 0.92, 0.96, 0.98, 1.0,
  1.0, 1.0, 1.0, 1.02, 1.05, 1.08, 1.08, 1.05, 1.01, 0.98, 0.95, 0.92
];

// FROZEN (spec C17): safety caps on combined evidence transformations,
// applied to the multiplier (exp of the summed log), before it multiplies
// the base demand/supply value.
const DEMAND_MULT_MIN = 0.35;
const DEMAND_MULT_MAX = 2.0;
const SUPPLY_MULT_MIN = 0.55;
const SUPPLY_MULT_MAX = 1.7;

// FROZEN (spec D): Reno weekday recurring traffic penalties. Explicitly
// scoped to weekdays in the spec ("recurring weekday traffic penalties");
// weekend rush-hour-shaped congestion, if any, must come through as
// explicit `traffic` evidence instead of this baseline.
const WEEKDAY_TRAFFIC_R = {
  amPeak: { startHour: 7, endHour: 9, penalty: 0.38 }, // 07:00-09:00
  pmPeak: { startHour: 16, endHour: 18, penalty: 0.42 }, // 16:00-18:00
  shoulderHours: [6, 9, 15, 18],
  shoulderPenalty: 0.12
};

// FROZEN (spec section 23 / E, restated as the permanent cutoff).
const ONE_OFF_SCORE_THRESHOLD = 81.6;

// FROZEN (spec section 20/21): core block length, and the compliance
// ceiling the spec names ("up to 16 cumulative hours of driver-mode /
// on-call exposure" within rolling 24-hour windows).
const CORE_BLOCK_HOURS = 8;
const BLOCK_COUNT = 6;
const MAX_ROLLING_24H_ON_DUTY_HOURS = 16; // INTERPRETED as a hard rolling cap; see section 6 below.
const MAX_BLOCK_EXTENSION_HOURS = 2; // blocks may grow from 8 to at most 10 hours.

// FROZEN (spec I): source-quality table, used only as a fallback when a
// piece of evidence doesn't carry its own confidence.
const SOURCE_QUALITY = {
  official: 1.0,
  organizer: 0.95,
  ticketing: 0.88,
  local_news: 0.85,
  secondary: 0.75,
  manual: 0.8,
  aggregator: 0.55,
  social: 0.3,
  unspecified: 0.7
};

// FROZEN (spec E1): natural trip-throughput baseline by time-of-day bucket.
function naturalTph(hour) {
  if (hour >= 19 || hour < 2) return 3.55; // 19:00-01:59
  if (hour >= 11 && hour < 16) return 3.05; // 11:00-15:59
  return 2.65;
}

// ======================================================================
// Operational week definition (spec section 2 / A)
// ======================================================================

const RENO_TZ = "America/Los_Angeles";

/** Reno-local wall-clock parts for a UTC instant, via Intl (no extra deps). */
function renoParts(date) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: RENO_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    weekday: "short"
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    weekday: parts.weekday
  };
}

/**
 * The next upcoming Reno-local 4:00 AM boundary at or after `from`
 * (spec section 2/A: operational days run 4AM->4AM; with no date given,
 * anchor to the next 4AM boundary, not the command time).
 */
export function nextOperationalBoundary(from = new Date()) {
  const { hour } = renoParts(from);
  // Walk forward hour by hour to the next local 4:00 AM. This avoids doing
  // our own DST arithmetic — Intl already knows Reno's offset for any date.
  const cursor = new Date(from);
  cursor.setUTCMinutes(0, 0, 0);
  for (let i = 0; i < 48; i++) {
    const p = renoParts(cursor);
    if (p.hour === 4) return cursor;
    cursor.setUTCHours(cursor.getUTCHours() + 1);
  }
  // Should be unreachable; fail safe rather than loop forever.
  return from;
}

/** Build the 168 hour-start Date objects for the operational week starting at `weekStart`. */
function buildHourGrid(weekStart) {
  const hours = [];
  for (let i = 0; i < 168; i++) {
    const d = new Date(weekStart);
    d.setUTCHours(d.getUTCHours() + i);
    hours.push(d);
  }
  return hours;
}

// ======================================================================
// C. Evidence translation (frozen per-family weights, section C1-C17)
// ======================================================================

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function effectiveConfidence(evidence) {
  if (Number.isFinite(evidence.confidence)) return clamp(evidence.confidence, 0, 1);
  if (evidence.sourceType && SOURCE_QUALITY[evidence.sourceType] != null) {
    return SOURCE_QUALITY[evidence.sourceType];
  }
  return SOURCE_QUALITY.unspecified;
}

/**
 * Deduplicate evidence records (spec J2): same family+label+source+value+
 * start+end counts once; among exact duplicates, keep the higher confidence.
 */
export function dedupeEvidence(records) {
  const byKey = new Map();
  for (const r of records) {
    const key = [r.family, r.label, r.source, r.value, r.start || "", r.end || ""].join("|");
    const existing = byKey.get(key);
    if (!existing || effectiveConfidence(r) > effectiveConfidence(existing)) {
      byKey.set(key, r);
    }
  }
  return [...byKey.values()];
}

/**
 * Whether an evidence record applies to a given hour-start Date.
 * INTERPRETED (spec J1): evidence needs an explicit start/end applicability
 * window; evidence with neither is only applied to every hour if it
 * explicitly opts in with `fullWeek: true` — this is what "explicitly
 * intended" (spec J1) is implemented as, so one dangling record can't
 * silently contaminate all 168 hours.
 */
function evidenceApplies(evidence, hourDate) {
  if (!evidence.start && !evidence.end) return Boolean(evidence.fullWeek);
  const t = hourDate.getTime();
  const start = evidence.start ? new Date(evidence.start).getTime() : -Infinity;
  const end = evidence.end ? new Date(evidence.end).getTime() : Infinity;
  return t >= start && t < end;
}

/**
 * Apply one evidence record's translation into the running per-hour
 * accumulator. FROZEN weights per spec section C1-C16; family names match
 * the spec's evidence `family` field.
 */
function applyEvidence(acc, evidence) {
  const raw = clamp(Number(evidence.value) || 0, -2, 2);
  const w = raw * effectiveConfidence(evidence);
  const wPos = Math.max(0, w);
  const wAbs = Math.abs(w);

  switch (evidence.family) {
    case "calendar":
    case "calendar_effect":
      acc.demandLog += 0.075 * w;
      break;

    case "event_demand":
      acc.demandLog += 0.18 * w;
      acc.supplyLog += 0.16 * wAbs;
      break;
    case "event_quality":
      acc.demandLog += 0.1 * w;
      acc.Q += 0.045 * w;
      acc.G += 0.035 * w;
      break;

    case "driver_supply":
      acc.supplyLog += 0.25 * w;
      break;
    case "driver_camping":
    case "staging":
      acc.supplyLog += 0.2 * wPos;
      acc.R += 0.11 * wPos;
      break;

    case "airport":
    case "flight_activity":
      acc.demandLog += 0.12 * w;
      acc.supplyLog += 0.1 * wAbs;
      acc.R += 0.06 * wPos;
      break;
    case "airport_queue":
      acc.R += 0.15 * wPos;
      acc.supplyLog += 0.08 * wPos;
      break;

    case "tourism":
    case "hotel_pressure":
      acc.demandLog += 0.09 * w;
      acc.Q += 0.025 * w;
      break;

    case "tahoe":
    case "regional_spillover":
      acc.demandLog += 0.07 * w;
      acc.G -= 0.07 * wPos;
      acc.T -= 0.09 * wPos;
      break;

    case "weather":
      acc.demandLog += 0.1 * w;
      break;
    case "safety_suppression":
      acc.demandLog -= 0.08 * wPos;
      acc.R += 0.28 * wPos;
      break;

    case "traffic":
      acc.R += 0.2 * wPos;
      break;

    case "transit":
    case "shuttle":
      acc.demandLog -= 0.12 * wPos;
      break;

    case "parking_scarcity":
      acc.demandLog += 0.055 * wPos;
      acc.R += 0.035 * wPos;
      break;
    case "free_parking":
      acc.demandLog -= 0.08 * wPos;
      break;
    case "pickup_friction":
    case "access_friction":
      acc.R += 0.15 * wPos;
      break;

    case "nightlife":
    case "casino":
      acc.demandLog += 0.085 * w;
      acc.Q += 0.035 * w;
      break;

    case "university":
    case "school_activity":
      acc.demandLog += 0.07 * w;
      break;

    case "fare_quality":
    case "trip_quality":
      acc.Q += 0.12 * w;
      break;
    case "tip_quality":
      acc.Q += 0.045 * w;
      break;
    case "wait_time":
      acc.R += 0.1 * wPos;
      break;
    case "deadhead":
      acc.R += 0.08 * wPos;
      acc.G -= 0.055 * wPos;
      break;

    case "short_trip_density":
      acc.T += 0.12 * w;
      break;
    case "long_trip_risk":
      acc.T -= 0.18 * wPos;
      acc.G -= 0.06 * wPos;
      break;
    case "trip_throughput":
      acc.T += 0.13 * w;
      break;

    case "geography":
    case "destination_continuity":
      acc.G += 0.1 * w;
      break;

    case "interaction_demand":
      acc.demandLog += 0.07 * w;
      break;
    case "interaction_quality":
      acc.Q += 0.05 * w;
      break;
    case "interaction_friction":
      acc.R += 0.08 * wPos;
      break;

    default:
      // Unknown family: recorded but deliberately inert. A typo in a
      // family name should not silently do nothing forever without a
      // trace — callers can inspect `unrecognizedEvidence` on the result.
      acc.unrecognized.push(evidence);
  }

  acc.contributions.push({ evidence, w });
}

// ======================================================================
// E. Trip-throughput / permanent Quest structure
// ======================================================================

/** FROZEN (spec E1-E2): permanent trip-throughput contribution to T_h. */
function throughputContribution(hour, learnedUberTph) {
  const natural = naturalTph(hour);
  const learned = Number.isFinite(learnedUberTph) ? learnedUberTph : 3.0;
  const expectedTph = 0.65 * natural + 0.35 * learned;

  let t;
  if (expectedTph >= 4.0 && expectedTph <= 5.0) t = 0.22;
  else if (expectedTph >= 3.2) t = 0.14;
  else if (expectedTph >= 2.7) t = 0.05;
  else if (expectedTph >= 2.2) t = -0.08;
  else t = -0.2;

  return { expectedTph, t };
}

/**
 * INTERPRETED (spec E3): the dynamic exact-Quest layer. The spec fixes the
 * bound ([-0.10, +0.24]), the impossible-chase cutoff (5.25 trips/hour
 * required pace), and the qualitative shape ("rise near a reachable
 * valuable threshold, fall away when impossible or already easy") but not
 * an exact formula — unlike O_h/Z_h, which the spec calls frozen. This
 * implements that shape: the contribution scales with how much of the
 * remaining payout each hour's expected trips protect, relative to the
 * hour's own share of the trip-throughput bound above, then decays to
 * zero once the quest is already effectively secured (little marginal
 * value left) or abandons entirely once the required pace is infeasible.
 */
function dynamicQuestContribution(hourIndex, quest, expectedTphAtHour) {
  if (!quest) return 0;
  const { target, current, payout, deadlineHourIndex } = quest;
  if (!Number.isFinite(target) || !Number.isFinite(current) || !Number.isFinite(payout)) return 0;

  const remaining = target - current;
  if (remaining <= 0) return 0; // already complete: no marginal quest value left.
  if (!Number.isFinite(deadlineHourIndex) || hourIndex > deadlineHourIndex) return 0;

  const remainingHours = Math.max(1, deadlineHourIndex - hourIndex + 1);
  const requiredPace = remaining / remainingHours;

  if (requiredPace > 5.25) return 0; // impossible-chase protection.

  const marginalValuePerTrip = payout / remaining; // rises as `remaining` shrinks.
  const referenceValuePerTrip = payout / Math.max(1, target); // the "naive average" from spec section 7.
  const urgency = clamp(marginalValuePerTrip / Math.max(0.01, referenceValuePerTrip) - 1, 0, 4) / 4;

  // Feasibility: how comfortably this hour's expected throughput covers the
  // required pace. At or above ~1.15x required pace, treat as comfortably
  // reachable (full urgency applies); below required pace, taper toward 0.
  const feasibility = clamp(expectedTphAtHour / (requiredPace * 1.15), 0, 1);

  const contribution = -0.1 + 0.34 * urgency * feasibility;
  return clamp(contribution, -0.1, 0.24);
}

// ======================================================================
// Per-hour opportunity computation (B1, C, D, E)
// ======================================================================

function computeHour({ hourDate, hourIndex, evidenceByHour, learnedUberTph, quest }) {
  const { hour, weekday } = renoParts(hourDate);
  const jsDay = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekday);

  const baseDemand = HOUR_DEMAND[hour] * DAY_DEMAND_BY_JS_DAY[jsDay];
  const baseSupply = HOUR_SUPPLY[hour];

  const acc = { demandLog: 0, supplyLog: 0, Q: 0, T: 0, G: 0, R: 0, contributions: [], unrecognized: [] };
  for (const ev of evidenceByHour) applyEvidence(acc, ev);

  const demandMult = clamp(Math.exp(acc.demandLog), DEMAND_MULT_MIN, DEMAND_MULT_MAX);
  const supplyMult = clamp(Math.exp(acc.supplyLog), SUPPLY_MULT_MIN, SUPPLY_MULT_MAX);

  const D = Math.max(1e-6, baseDemand * demandMult);
  const S = Math.max(1e-6, baseSupply * supplyMult);

  // FROZEN (spec D): weekday-only recurring traffic baseline.
  let trafficR = 0;
  const isWeekday = jsDay >= 1 && jsDay <= 5;
  if (isWeekday) {
    const { amPeak, pmPeak, shoulderHours, shoulderPenalty } = WEEKDAY_TRAFFIC_R;
    if (hour >= amPeak.startHour && hour < amPeak.endHour) trafficR += amPeak.penalty;
    if (hour >= pmPeak.startHour && hour < pmPeak.endHour) trafficR += pmPeak.penalty;
    if (shoulderHours.includes(hour)) trafficR += shoulderPenalty;
  }

  const { expectedTph, t: throughputBase } = throughputContribution(hour, learnedUberTph);
  const questT = dynamicQuestContribution(hourIndex, quest, expectedTph);

  const Q = acc.Q;
  const T = acc.T + throughputBase + questT;
  const G = acc.G;
  const R = acc.R + trafficR;

  const O = Math.log(D) - BETA_S * Math.log(S) + Q + T + G - R;

  return {
    hourIndex,
    date: hourDate,
    hour,
    weekday,
    O,
    D,
    S,
    Q,
    T,
    G,
    R,
    expectedTph,
    contributions: acc.contributions,
    unrecognized: acc.unrecognized
  };
}

// ======================================================================
// Normalization (spec B2 / section 17, frozen)
// ======================================================================

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

function stdev(values, mean) {
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function normalize(hours) {
  const raw = hours.map((h) => h.O);
  const med = median(raw);
  const mad = median(raw.map((v) => Math.abs(v - med)));
  const scale = mad > 0 ? MAD_SCALE * mad : stdev(raw, raw.reduce((a, b) => a + b, 0) / raw.length) || 1;

  for (const h of hours) {
    h.z = (h.O - med) / scale;
    h.score = 100 / (1 + Math.exp(-SIGMOID_SLOPE * h.z));
  }
  return hours;
}

// ======================================================================
// Reason generation (spec section 19) — INTERPRETED via marginal contribution
// ======================================================================

const REASON_LABELS = {
  event_demand: "event demand",
  event_quality: "event quality",
  driver_supply: "driver oversupply",
  driver_camping: "driver camping/staging",
  staging: "driver staging",
  airport: "airport activity",
  flight_activity: "flight activity",
  airport_queue: "airport queueing",
  tourism: "tourism pressure",
  hotel_pressure: "hotel pressure",
  tahoe: "Tahoe spillover",
  regional_spillover: "regional spillover",
  weather: "weather",
  safety_suppression: "unsafe weather",
  traffic: "traffic",
  transit: "transit/shuttle alternative",
  shuttle: "shuttle alternative",
  parking_scarcity: "parking scarcity",
  free_parking: "free parking",
  pickup_friction: "pickup friction",
  access_friction: "access friction",
  nightlife: "nightlife",
  casino: "casino activity",
  university: "university activity",
  school_activity: "school activity",
  fare_quality: "fare quality",
  trip_quality: "trip quality",
  tip_quality: "tip potential",
  wait_time: "rider wait",
  deadhead: "deadhead risk",
  short_trip_density: "short-trip density",
  long_trip_risk: "long-trip risk",
  trip_throughput: "trip throughput",
  geography: "destination continuity",
  destination_continuity: "destination continuity",
  interaction_demand: "combined-effect demand",
  interaction_quality: "combined-effect quality",
  interaction_friction: "combined-effect friction"
};

/**
 * Primary Reasons for one hour, via marginal contribution (spec section 19):
 * neutralize one evidence record at a time, recompute, and report whichever
 * records moved the score the most — rather than attaching a generic label.
 */
function primaryReasons(hourResult, evidenceByHour, context) {
  if (hourResult.contributions.length === 0) {
    return hourResult.T + hourResult.Q + hourResult.G - hourResult.R !== 0
      ? "Baseline hour/day pattern and trip-throughput expectation"
      : "Baseline hour/day pattern";
  }

  const impacts = hourResult.contributions.map(({ evidence, w }) => {
    const without = evidenceByHour.filter((e) => e !== evidence);
    const recomputed = computeHour({
      hourDate: hourResult.date,
      hourIndex: hourResult.hourIndex,
      evidenceByHour: without,
      learnedUberTph: context.learnedUberTph,
      quest: context.quest
    });
    return { evidence, delta: hourResult.O - recomputed.O, w };
  });

  impacts.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  return impacts
    .slice(0, 3)
    .filter((i) => Math.abs(i.delta) > 0.001)
    .map((i) => {
      const label = REASON_LABELS[i.evidence.family] || i.evidence.family;
      const sign = i.delta >= 0 ? "+" : "-";
      return `${sign} ${label}${i.evidence.note ? ` (${i.evidence.note})` : ""}`;
    })
    .join(" · ") || "Baseline hour/day pattern";
}

// ======================================================================
// Six-block joint optimizer (spec section 20-22)
// ======================================================================

/**
 * Selects the 6 non-overlapping 8-hour core blocks that jointly maximize
 * total raw opportunity, via DP over "first i hours, k blocks chosen"
 * (spec section 20: "The optimization is joint... not simply pick the
 * best block, then greedily pick the next").
 */
function selectCoreBlocks(hours, blockCount = BLOCK_COUNT, blockLen = CORE_BLOCK_HOURS) {
  const n = hours.length;
  const windowSum = new Array(n - blockLen + 1).fill(0);
  for (let start = 0; start <= n - blockLen; start++) {
    let sum = 0;
    for (let i = start; i < start + blockLen; i++) sum += hours[i].O;
    windowSum[start] = sum;
  }

  // dp[i][k] = best total using windows starting strictly before hour i,
  // having chosen k of them. choice[i][k] = true if a window starting at
  // i - blockLen was taken to reach this state optimally.
  const NEG_INF = -Infinity;
  const dp = Array.from({ length: n + 1 }, () => new Array(blockCount + 1).fill(NEG_INF));
  const take = Array.from({ length: n + 1 }, () => new Array(blockCount + 1).fill(false));
  for (let k = 0; k <= blockCount; k++) dp[0][k] = k === 0 ? 0 : NEG_INF;

  for (let i = 1; i <= n; i++) {
    for (let k = 0; k <= blockCount; k++) {
      // Option 1: hour i-1 is not the start of a newly-taken window here —
      // carry forward the best state from i-1.
      let best = dp[i - 1][k];
      let took = false;

      // Option 2: a window ending exactly at i (i.e. starting at i-blockLen)
      // is taken, provided that start index is valid.
      const start = i - blockLen;
      if (start >= 0 && k >= 1 && dp[start][k - 1] !== NEG_INF) {
        const candidate = dp[start][k - 1] + windowSum[start];
        if (candidate > best) {
          best = candidate;
          took = true;
        }
      }
      dp[i][k] = best;
      take[i][k] = took;
    }
  }

  // Backtrack to find which starts were chosen.
  const starts = [];
  let i = n;
  let k = blockCount;
  while (i > 0 && k > 0) {
    if (take[i][k]) {
      starts.push(i - blockLen);
      i -= blockLen;
      k -= 1;
    } else {
      i -= 1;
    }
  }
  starts.sort((a, b) => a - b);
  return starts;
}

/**
 * INTERPRETED (spec section 20): extend a core block into an adjacent hour
 * when doing so adds meaningful opportunity. Implemented as: the adjacent
 * hour's own raw opportunity must be at or above the block's current
 * per-hour average (so it pulls the average up or holds it, never dilutes
 * it) — checked one hour at a time, on whichever side is stronger first,
 * up to MAX_BLOCK_EXTENSION_HOURS, and never crossing into another chosen
 * block's territory.
 */
function extendBlock(hours, start, end, occupied) {
  let s = start;
  let e = end; // exclusive
  let extended = 0;

  while (extended < MAX_BLOCK_EXTENSION_HOURS) {
    const blockHours = hours.slice(s, e);
    const avg = blockHours.reduce((sum, h) => sum + h.O, 0) / blockHours.length;

    const canExtendBefore = s > 0 && !occupied.has(s - 1) && hours[s - 1].O >= avg;
    const canExtendAfter = e < hours.length && !occupied.has(e) && hours[e].O >= avg;

    if (!canExtendBefore && !canExtendAfter) break;

    if (canExtendBefore && (!canExtendAfter || hours[s - 1].O >= hours[e].O)) {
      s -= 1;
    } else {
      e += 1;
    }
    extended += 1;
  }

  return { start: s, end: e };
}

// ======================================================================
// D. Nevada driving-time / rest compliance (spec section 21) — INTERPRETED
// ======================================================================

/**
 * The spec names a real constraint category ("Nevada cumulative on-call /
 * transportation-service limits... up to 16 cumulative hours... within
 * rolling 24-hour windows... required off-duty resets") without giving an
 * exact statute-grade algorithm, and explicitly says this is not legal
 * advice territory to guess at casually. This implements a conservative,
 * clearly-labeled approximation: for any two blocks whose spans fall
 * within the same rolling 24-hour window, their combined on-duty hours
 * must not exceed MAX_ROLLING_24H_ON_DUTY_HOURS. When a proposed extension
 * would violate that, the extension is dropped (the block reverts toward
 * its unextended core) rather than silently exceeding the cap.
 *
 * This is a scheduling guardrail, not certified legal/compliance advice —
 * callers relying on this for real driving-hour compliance should verify
 * against the actual current Nevada/Uber rules.
 */
function enforceRestCompliance(blocks, hours) {
  const notes = [];

  function hoursOf(block) {
    return block.end - block.start;
  }
  function overlapsWithin24h(a, b) {
    const aStart = hours[a.start].date.getTime();
    const bStart = hours[b.start].date.getTime();
    return Math.abs(aStart - bStart) < 24 * 60 * 60 * 1000;
  }

  for (let i = 0; i < blocks.length; i++) {
    for (let j = 0; j < blocks.length; j++) {
      if (i === j) continue;
      const a = blocks[i];
      const b = blocks[j];
      if (!overlapsWithin24h(a, b)) continue;
      if (hoursOf(a) + hoursOf(b) > MAX_ROLLING_24H_ON_DUTY_HOURS) {
        // Shrink whichever of the pair has the lower total opportunity's
        // extension first, one hour at a time, until compliant.
        const shrinkTarget = totalO(hours, a) <= totalO(hours, b) ? a : b;
        const originalEnd = shrinkTarget.end;
        const originalStart = shrinkTarget.start;
        while (hoursOf(a) + hoursOf(b) > MAX_ROLLING_24H_ON_DUTY_HOURS && hoursOf(shrinkTarget) > CORE_BLOCK_HOURS) {
          if (shrinkTarget.end - shrinkTarget.coreEnd > 0) shrinkTarget.end -= 1;
          else if (shrinkTarget.coreStart - shrinkTarget.start > 0) shrinkTarget.start += 1;
          else break;
        }
        if (shrinkTarget.start !== originalStart || shrinkTarget.end !== originalEnd) {
          notes.push(
            `Block ${shrinkTarget.label} shortened from its extended length to stay within the ` +
              `${MAX_ROLLING_24H_ON_DUTY_HOURS}-hour rolling on-duty guardrail near an adjacent block.`
          );
        }
      }
    }
  }
  return notes;
}

function totalO(hours, block) {
  let sum = 0;
  for (let i = block.start; i < block.end; i++) sum += hours[i].O;
  return sum;
}

// ======================================================================
// Top-level entry point
// ======================================================================

/**
 * Run a full 168-hour Reno Uber opportunity ranking and shift schedule.
 *
 * @param {object} options
 * @param {Date} [options.weekStart] - defaults to the next Reno 4AM boundary.
 * @param {Array} [options.evidence] - evidence records: {family, label,
 *   value (-2..2), confidence (0..1, optional), source, sourceType, note,
 *   start, end, fullWeek}.
 * @param {number} [options.learnedUberTph] - learned trips/hour, defaults to 3.0.
 * @param {object} [options.quest] - {target, current, payout, deadlineHourIndex}.
 */
export function scheduleReno(options = {}) {
  const weekStart = options.weekStart || nextOperationalBoundary();
  const evidence = dedupeEvidence(options.evidence || []);
  const learnedUberTph = options.learnedUberTph;
  const quest = options.quest || null;

  const hourDates = buildHourGrid(weekStart);
  const evidenceByHourIndex = hourDates.map((d) => evidence.filter((e) => evidenceApplies(e, d)));

  const hours = hourDates.map((hourDate, hourIndex) =>
    computeHour({ hourDate, hourIndex, evidenceByHour: evidenceByHourIndex[hourIndex], learnedUberTph, quest })
  );

  normalize(hours);

  // Rank using unrounded raw O_h (spec section 17).
  const ranked = [...hours].sort((a, b) => b.O - a.O);
  ranked.forEach((h, i) => (h.rank = i + 1));

  for (const h of hours) {
    h.reasons = primaryReasons(h, evidenceByHourIndex[h.hourIndex], { learnedUberTph, quest });
  }

  // Validation (spec section 18).
  if (hours.length !== 168) throw new Error(`Expected 168 hours, got ${hours.length}`);
  const seenKeys = new Set();
  for (const h of hours) {
    const key = h.date.toISOString();
    if (seenKeys.has(key)) throw new Error(`Duplicate hour detected: ${key}`);
    seenKeys.add(key);
  }

  // Six-block optimizer.
  const starts = selectCoreBlocks(hours);
  const occupied = new Set();
  for (const s of starts) for (let i = s; i < s + CORE_BLOCK_HOURS; i++) occupied.add(i);

  const blocks = starts.map((start, idx) => {
    const coreEnd = start + CORE_BLOCK_HOURS;
    const { start: extStart, end: extEnd } = extendBlock(hours, start, coreEnd, occupied);
    for (let i = extStart; i < extEnd; i++) occupied.add(i);
    return {
      label: `#${idx + 1}`,
      coreStart: start,
      coreEnd,
      start: extStart,
      end: extEnd
    };
  });

  const complianceNotes = enforceRestCompliance(blocks, hours);

  const formattedBlocks = blocks
    .slice()
    .sort((a, b) => totalO(hours, b) - totalO(hours, a))
    .map((b, idx) => {
      const coreHours = hours.slice(b.coreStart, b.coreEnd);
      const extendedHours = hours.slice(b.start, b.end);
      const coreTotal = coreHours.reduce((s, h) => s + h.score, 0);
      const extendedTotal = extendedHours.reduce((s, h) => s + h.score, 0);
      const extendedAvg = extendedTotal / extendedHours.length;
      return {
        rank: idx + 1,
        startDate: hours[b.start].date,
        endDate: hours[b.end - 1].date,
        coreStartDate: hours[b.coreStart].date,
        coreEndDate: hours[b.coreEnd - 1].date,
        hoursCount: b.end - b.start,
        coreTotalScore: Math.round(coreTotal),
        extendedTotalScore: Math.round(extendedTotal),
        extendedAvgScore: Math.round(extendedAvg * 10) / 10,
        hasExtension: b.end - b.start > CORE_BLOCK_HOURS,
        eligibleForOneOffExclusion: idx < 4 // spec 23: top 4 blocks exclude one-offs.
      };
    });

  // Days off (spec section 24) — INTERPRETED: rank each of the 7 complete
  // operational days by total raw opportunity across its 24 hours; the two
  // lowest are the recommended days off.
  const days = [];
  for (let d = 0; d < 7; d++) {
    const dayHours = hours.slice(d * 24, d * 24 + 24);
    days.push({
      dayIndex: d,
      date: dayHours[0].date,
      totalO: dayHours.reduce((s, h) => s + h.O, 0),
      avgScore: dayHours.reduce((s, h) => s + h.score, 0) / 24
    });
  }
  const daysSorted = [...days].sort((a, b) => a.totalO - b.totalO);
  const bestDaysOff = daysSorted.slice(0, 2);

  // One-off / bonus hours (spec section 23). "TOP FOUR recommended blocks"
  // means the four strongest by opportunity, not the four earliest — so
  // rank by total opportunity before taking the exclusion set. Blocks five
  // and six may still contribute one-off hours.
  const blocksByStrength = [...blocks].sort((a, b) => totalO(hours, b) - totalO(hours, a));
  const topFourOccupied = new Set();
  for (const b of blocksByStrength.slice(0, 4)) for (let i = b.start; i < b.end; i++) topFourOccupied.add(i);

  const oneOffs = hours
    .filter((h) => h.score >= ONE_OFF_SCORE_THRESHOLD && !topFourOccupied.has(h.hourIndex))
    .sort((a, b) => a.hourIndex - b.hourIndex);

  return {
    algorithmVersion: ALGORITHM_VERSION,
    formulaFingerprint: FORMULA_FINGERPRINT,
    weekStart,
    hours,
    ranked,
    blocks: formattedBlocks,
    complianceNotes,
    bestDaysOff,
    oneOffHours: oneOffs.length
      ? oneOffs.map((h) => ({ date: h.date, hour: h.hour, score: Math.round(h.score * 10) / 10, reasons: h.reasons }))
      : [],
    oneOffMessage: oneOffs.length ? null : "No exceptional one-off hours this week."
  };
}
