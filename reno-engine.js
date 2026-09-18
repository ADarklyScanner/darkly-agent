/**
 * reno-engine.js — the Reno Uber Opportunity-Ranking and Shift-Optimization Engine.
 *
 * Ported from the user's own saved specification (UBER_ENGINE_MASTER_SPEC.txt,
 * Reno_Uber_Algorithm_New_Chat_Master.md, Reno_Uber_Opportunity_Ranking_Engine.txt),
 * a deterministic, evidence-first forecasting system that ranks every one-hour
 * period in the coming Reno operational week by driver opportunity (not raw rider
 * demand), then turns that ranking into a legal, optimized six-block schedule.
 *
 * Canonical algorithm version: RENO_UBER_V1_CANONICAL_2026_09_02
 * Protected formula fingerprint (from the spec):
 *   cffe66bfad63b371beb9f07f450a15bf42fcaa4ef15c74380b8c8608dd5260f0
 *
 * EXACT VS. INTERPRETED
 *
 * The spec marks a great deal of itself frozen or gives explicit numbers: the
 * O_h formula, the weekly normalization, the base hour/day demand and supply
 * tables, every per-signal-family evidence weight, the Reno traffic baseline,
 * the throughput bands, the 75th-percentile extension threshold, the two
 * rolling compliance caps, the score-to-income mapping, the platform-preference
 * thresholds, the horizon-confidence tables, and the 81.6 one-off cutoff.
 * Those are implemented verbatim and tagged FROZEN with their section.
 *
 * A small remainder is described qualitatively — the dynamic Quest curve's shape
 * inside its stated bound, how per-hour confidence is computed from evidence
 * support, and how a compliance repair chooses which block to shorten. Those are
 * tagged INTERPRETED. Per the spec's own audit standard ("if the engine claims
 * to consider it, it must actually change the calculation when the evidence
 * changes"), the interpreted pieces still move real numbers.
 *
 * This module is pure computation. It never fetches evidence: the spec's source
 * philosophy is explicitly FAIL CLOSED (section V) — a source that isn't
 * available is missing/neutral, never invented.
 */

// ======================================================================
// Frozen constants
// ======================================================================

export const ALGORITHM_VERSION = "RENO_UBER_V1_CANONICAL_2026_09_02";
export const FORMULA_FINGERPRINT =
  "cffe66bfad63b371beb9f07f450a15bf42fcaa4ef15c74380b8c8608dd5260f0";

const BETA_S = 0.72; // FROZEN (B1)
const MAD_SCALE = 1.4826; // FROZEN (B2)
const SIGMOID_SLOPE = 1.1; // FROZEN (B2)

// FROZEN (B3): base hour-demand multipliers, hours 0..23.
const HOUR_DEMAND = [
  1.25, 1.18, 0.94, 0.57, 0.48, 0.61, 0.78, 0.95, 1.02, 0.94, 0.91, 0.95,
  1.0, 0.98, 1.0, 1.05, 1.14, 1.27, 1.25, 1.2, 1.24, 1.34, 1.48, 1.46
];

// FROZEN (B4): base day-demand. JS getDay(): 0=Sun..6=Sat.
const DAY_DEMAND_BY_JS_DAY = [0.99, 0.86, 0.84, 0.89, 1.0, 1.23, 1.34];

// FROZEN (B5): base hour-supply multipliers, hours 0..23.
const HOUR_SUPPLY = [
  0.9, 0.82, 0.72, 0.57, 0.52, 0.59, 0.72, 0.84, 0.92, 0.96, 0.98, 1.0,
  1.0, 1.0, 1.0, 1.02, 1.05, 1.08, 1.08, 1.05, 1.01, 0.98, 0.95, 0.92
];

// FROZEN (C17): caps on combined evidence transformations.
const DEMAND_MULT_MIN = 0.35;
const DEMAND_MULT_MAX = 2.0;
const SUPPLY_MULT_MIN = 0.55;
const SUPPLY_MULT_MAX = 1.7;

// FROZEN (D): Reno weekday recurring traffic penalties.
const WEEKDAY_TRAFFIC_R = {
  amPeak: { startHour: 7, endHour: 9, penalty: 0.38 },
  pmPeak: { startHour: 16, endHour: 18, penalty: 0.42 },
  shoulderHours: [6, 9, 15, 18],
  shoulderPenalty: 0.12
};

// FROZEN (S): permanent one-off cutoff.
const ONE_OFF_SCORE_THRESHOLD = 81.6;

// FROZEN (Q): block structure.
const CORE_BLOCK_HOURS = 8;
const BLOCK_COUNT = 6;
const MAX_BLOCK_EXTENSION_HOURS = 2;

// FROZEN (Q1): extensions require the week's 75th-percentile score.
const EXTENSION_PERCENTILE = 75;

// FROZEN (P): the two rolling compliance caps.
const MAX_ROLLING_24H_ONLINE_HOURS = 16;
const MAX_ROLLING_24H_SERVICE_HOURS = 12;
const SERVICE_FRACTION_MIN = 0.1;
const SERVICE_FRACTION_MAX = 1.0;
const DEFAULT_PASSENGER_MINUTES = 15; // FROZEN (L3): default Uber passenger duration until learned.
const PASSENGER_MINUTES_MIN = 5; // FROZEN (L3): usable forecast bounds.
const PASSENGER_MINUTES_MAX = 45;

// FROZEN (M): score-to-income mapping.
const UBER_NEUTRAL_HOURLY = 38;
const LYFT_NEUTRAL_MULTIPLIER = 0.92;
const DEFAULT_SCORE_SLOPE = 0.45;
const SCORE_SLOPE_MIN = 0.15;
const SCORE_SLOPE_MAX = 0.9;

// FROZEN (N1): platform-preference thresholds.
const LYFT_MIN_INCOME_SAMPLES = 3;
const LYFT_MIN_TPH_SAMPLES = 3;
const LYFT_PREFERRED_INCOME_EDGE = 0.08; // Lyft must beat Uber by ~8%.
const LYFT_MIN_RELATIVE_TPH = 0.9; // and hold ~90% of Uber's throughput.
const EITHER_PLATFORM_BAND = 0.06; // within ~6% => "Either platform".
const STAY_OFFLINE_SCORE = 20; // FROZEN (N1): score < 20 may say stay offline.

// FROZEN (I): source-quality scale, used when evidence carries no confidence.
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

// FROZEN (H): horizon confidence by forecast day (1-indexed).
const WEATHER_HORIZON_CONFIDENCE = [0.98, 0.95, 0.91, 0.86, 0.8, 0.74, 0.68];
const FLIGHT_HORIZON_CONFIDENCE = [0.97, 0.97, 0.97, 0.93, 0.93, 0.89, 0.89];

const WEATHER_FAMILIES = new Set(["weather", "safety_suppression"]);
const FLIGHT_FAMILIES = new Set(["airport", "flight_activity", "airport_queue"]);

// FROZEN (E1): natural trip-throughput baseline by time-of-day bucket.
function naturalTph(hour) {
  if (hour >= 19 || hour < 2) return 3.55;
  if (hour >= 11 && hour < 16) return 3.05;
  return 2.65;
}

const RENO_TZ = "America/Los_Angeles";

// ======================================================================
// Time helpers
// ======================================================================

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

/** The next upcoming Reno-local 4:00 AM boundary at or after `from` (spec 2/A). */
export function nextOperationalBoundary(from = new Date()) {
  const cursor = new Date(from);
  cursor.setUTCMinutes(0, 0, 0);
  for (let i = 0; i < 48; i++) {
    if (renoParts(cursor).hour === 4) return cursor;
    cursor.setUTCHours(cursor.getUTCHours() + 1);
  }
  return from;
}

function buildHourGrid(weekStart) {
  const hours = [];
  for (let i = 0; i < 168; i++) {
    const d = new Date(weekStart);
    d.setUTCHours(d.getUTCHours() + i);
    hours.push(d);
  }
  return hours;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// ======================================================================
// Evidence handling (C, H, I, J)
// ======================================================================

function baseConfidence(evidence) {
  if (Number.isFinite(evidence.confidence)) return clamp(evidence.confidence, 0, 1);
  if (evidence.sourceType && SOURCE_QUALITY[evidence.sourceType] != null) {
    return SOURCE_QUALITY[evidence.sourceType];
  }
  return SOURCE_QUALITY.unspecified;
}

/**
 * FROZEN (H): weather and flight evidence lose confidence with forecast
 * horizon. A day-7 weather claim is not as good as a day-1 one, and the
 * spec fixes both decay curves rather than leaving it to judgment.
 */
function effectiveConfidence(evidence, forecastDayIndex) {
  const base = baseConfidence(evidence);
  const day = clamp(forecastDayIndex, 0, 6);
  if (WEATHER_FAMILIES.has(evidence.family)) return base * WEATHER_HORIZON_CONFIDENCE[day];
  if (FLIGHT_FAMILIES.has(evidence.family)) return base * FLIGHT_HORIZON_CONFIDENCE[day];
  return base;
}

/** FROZEN (J2): duplicates collapse; the stronger confidence survives. */
export function dedupeEvidence(records) {
  const byKey = new Map();
  for (const r of records) {
    const key = [r.family, r.label, r.source, r.value, r.start || "", r.end || ""].join("|");
    const existing = byKey.get(key);
    if (!existing || baseConfidence(r) > baseConfidence(existing)) byKey.set(key, r);
  }
  return [...byKey.values()];
}

/**
 * INTERPRETED (J1): the spec requires evidence to carry an applicability
 * window and says unbounded evidence applies week-wide "only when this is
 * explicitly intended". That intent is implemented as an explicit
 * `fullWeek: true` flag, so a dangling record cannot silently contaminate
 * all 168 hours.
 */
function evidenceApplies(evidence, hourDate) {
  if (!evidence.start && !evidence.end) return Boolean(evidence.fullWeek);
  const t = hourDate.getTime();
  const start = evidence.start ? new Date(evidence.start).getTime() : -Infinity;
  const end = evidence.end ? new Date(evidence.end).getTime() : Infinity;
  return t >= start && t < end;
}

/** FROZEN (C1-C16): per-family translation into the component accumulator. */
function applyEvidence(acc, evidence, conf) {
  const raw = clamp(Number(evidence.value) || 0, -2, 2);
  const w = raw * conf;
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
      acc.unrecognized.push(evidence);
      return;
  }

  acc.applied.push({ evidence, w, confidence: conf });
}

// ======================================================================
// Throughput and Quest (E)
// ======================================================================

function throughputContribution(hour, learnedUberTph) {
  const natural = naturalTph(hour);
  const learned = Number.isFinite(learnedUberTph) ? learnedUberTph : 3.0;
  const expectedTph = 0.65 * natural + 0.35 * learned; // FROZEN (E1)

  let t; // FROZEN (E2): generic Quest utility bands.
  if (expectedTph >= 4.0 && expectedTph <= 5.0) t = 0.22;
  else if (expectedTph >= 3.2) t = 0.14;
  else if (expectedTph >= 2.7) t = 0.05;
  else if (expectedTph >= 2.2) t = -0.08;
  else t = -0.2;

  return { expectedTph, t };
}

/**
 * INTERPRETED (E3). The spec fixes the bound ([-0.10, +0.24]), the
 * impossible-chase cutoff (required pace > 5.25 trips/hour), and the shape
 * ("rise near a reachable valuable threshold, fall away when impossible or
 * already easy") but not an exact curve — unlike O_h/Z_h, which it freezes.
 * This implements that shape from the spec's own worked example: value per
 * remaining trip rises as the target nears ($120/50 = $2.40 average vs
 * $120/5 = $24 protected near completion), scaled by whether this hour's
 * throughput can realistically deliver the required pace.
 */
function dynamicQuestContribution(hourIndex, quest, expectedTphAtHour) {
  if (!quest) return 0;
  const { target, current, payout, deadlineHourIndex } = quest;
  if (!Number.isFinite(target) || !Number.isFinite(current) || !Number.isFinite(payout)) return 0;

  const remaining = target - current;
  if (remaining <= 0) return 0;
  if (!Number.isFinite(deadlineHourIndex) || hourIndex > deadlineHourIndex) return 0;

  const remainingHours = Math.max(1, deadlineHourIndex - hourIndex + 1);
  const requiredPace = remaining / remainingHours;
  if (requiredPace > 5.25) return 0; // FROZEN (E3): impossible-chase protection.

  const marginalValuePerTrip = payout / remaining;
  const referenceValuePerTrip = payout / Math.max(1, target);
  const urgency = clamp(marginalValuePerTrip / Math.max(0.01, referenceValuePerTrip) - 1, 0, 4) / 4;
  const feasibility = clamp(expectedTphAtHour / (requiredPace * 1.15), 0, 1);

  return clamp(-0.1 + 0.34 * urgency * feasibility, -0.1, 0.24); // FROZEN bound (E3)
}

// ======================================================================
// Per-hour opportunity (B1, C, D, E)
// ======================================================================

const JS_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function computeHour({ hourDate, hourIndex, evidenceForHour, learnedUberTph, quest }) {
  const { hour, weekday } = renoParts(hourDate);
  const jsDay = JS_DAYS.indexOf(weekday);
  const forecastDayIndex = Math.floor(hourIndex / 24);

  const baseDemand = HOUR_DEMAND[hour] * DAY_DEMAND_BY_JS_DAY[jsDay];
  const baseSupply = HOUR_SUPPLY[hour];

  const acc = { demandLog: 0, supplyLog: 0, Q: 0, T: 0, G: 0, R: 0, applied: [], unrecognized: [] };
  for (const ev of evidenceForHour) {
    applyEvidence(acc, ev, effectiveConfidence(ev, forecastDayIndex));
  }

  const demandMult = clamp(Math.exp(acc.demandLog), DEMAND_MULT_MIN, DEMAND_MULT_MAX);
  const supplyMult = clamp(Math.exp(acc.supplyLog), SUPPLY_MULT_MIN, SUPPLY_MULT_MAX);

  const D = Math.max(1e-6, baseDemand * demandMult);
  const S = Math.max(1e-6, baseSupply * supplyMult);

  // FROZEN (D): weekday-only recurring traffic baseline.
  let trafficR = 0;
  if (jsDay >= 1 && jsDay <= 5) {
    const { amPeak, pmPeak, shoulderHours, shoulderPenalty } = WEEKDAY_TRAFFIC_R;
    if (hour >= amPeak.startHour && hour < amPeak.endHour) trafficR += amPeak.penalty;
    if (hour >= pmPeak.startHour && hour < pmPeak.endHour) trafficR += pmPeak.penalty;
    if (shoulderHours.includes(hour)) trafficR += shoulderPenalty;
  }

  const { expectedTph, t: throughputBase } = throughputContribution(hour, learnedUberTph);
  const questT = dynamicQuestContribution(hourIndex, quest, expectedTph);

  // The spec lists "learned history" as its own reason family (T2). It is
  // real only insofar as the driver's learned trips/hour pulls the
  // throughput band away from where the generic default would have put it,
  // so it is measured as exactly that difference rather than reported as a
  // decorative zero. With no learned history the two are identical and the
  // family correctly contributes nothing.
  const throughputAtDefault = throughputContribution(hour, 3.0).t;
  const learnedHistoryDelta = throughputBase - throughputAtDefault;

  const Q = acc.Q;
  const T = acc.T + throughputBase + questT;
  const G = acc.G;
  const R = acc.R + trafficR;

  const O = Math.log(D) - BETA_S * Math.log(S) + Q + T + G - R;

  // FROZEN (T2): the reason families are component contributions measured
  // against the frozen baseline tables — not per-evidence-record deltas.
  //
  // These deliberately do NOT sum to O_h. They are DEVIATIONS from the
  // normal hour/day pattern, so the missing term is exactly the baseline
  // itself (ln(baseDemand) - 0.72*ln(baseSupply)). That is intentional and
  // matches the spec's family list, which has no "baseline" family: saying
  // "Saturday 11 PM is strong because Saturday 11 PM is normally strong"
  // explains nothing. The reasons answer "what makes THIS hour differ from
  // its own normal?", which is why a clean baseline hour legitimately shows
  // just one contributor (or none).
  const components = {
    "external demand": Math.log(D) - Math.log(baseDemand),
    "relative driver supply": -BETA_S * (Math.log(S) - Math.log(baseSupply)),
    "fare/trip quality": Q,
    "trip throughput / Quest": T - learnedHistoryDelta,
    "destination continuity": G,
    "traffic / operational friction": -R,
    "learned history": learnedHistoryDelta
  };

  return {
    hourIndex,
    date: hourDate,
    hour,
    weekday,
    forecastDayIndex,
    O,
    D,
    S,
    Q,
    T,
    G,
    R,
    baseDemand,
    baseSupply,
    expectedTph,
    components,
    applied: acc.applied,
    unrecognized: acc.unrecognized
  };
}

// ======================================================================
// Normalization (B2) and confidence (T1, U)
// ======================================================================

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = clamp(Math.ceil((p / 100) * sorted.length) - 1, 0, sorted.length - 1);
  return sorted[idx];
}

function stdev(values) {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length);
}

function normalize(hours) {
  const raw = hours.map((h) => h.O);
  const med = median(raw);
  const mad = median(raw.map((v) => Math.abs(v - med)));
  const scale = mad > 0 ? MAD_SCALE * mad : stdev(raw) || 1; // FROZEN (B2) fallback
  for (const h of hours) {
    h.z = (h.O - med) / scale;
    h.score = 100 / (1 + Math.exp(-SIGMOID_SLOPE * h.z));
  }
  return hours;
}

/**
 * INTERPRETED (T1/U): per-hour confidence, kept strictly separate from
 * score. The spec is explicit that a high-scoring hour with weak evidence
 * still ranks highly and that the uncertainty must be *visible* rather than
 * secretly lowering the rank — so this never touches O_h. With no evidence,
 * an hour rests entirely on the frozen baseline tables: real but generic,
 * hence Low. Evidence raises it toward the quality of the sources actually
 * backing that hour.
 */
function hourConfidence(hour) {
  if (hour.applied.length === 0) {
    return { value: 0.35, label: "Low", basis: "baseline tables only" };
  }
  const weights = hour.applied.map((a) => Math.abs(a.w));
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const weighted = totalWeight > 0
    ? hour.applied.reduce((s, a) => s + a.confidence * Math.abs(a.w), 0) / totalWeight
    : hour.applied.reduce((s, a) => s + a.confidence, 0) / hour.applied.length;

  // More corroborating records raise confidence toward the source quality,
  // but a single weak source can never reach "High".
  const corroboration = clamp(hour.applied.length / 3, 0, 1);
  const value = clamp(0.35 + (weighted - 0.35) * (0.55 + 0.45 * corroboration), 0, 1);
  const label = value >= 0.75 ? "High" : value >= 0.5 ? "Medium" : "Low";
  return { value, label, basis: `${hour.applied.length} evidence record(s)` };
}

/** FROZEN (U): live-source coverage states. */
function coverageState(hours) {
  const covered = hours.filter((h) => h.applied.length > 0).length;
  const share = covered / hours.length;
  if (share >= 0.6) return "STRONG";
  if (share >= 0.3) return "PARTIAL";
  if (share > 0) return "LIMITED";
  return "DEGRADED";
}

// ======================================================================
// Reason generation (T2)
// ======================================================================

/**
 * FROZEN (T2): reasons come from the actual largest component contributions,
 * in the spec's own format — e.g.
 *   "+0.143 trip throughput / Quest • -0.097 relative driver supply"
 * Top ~3 nontrivial contributors, never decorative.
 */
function formatReasons(hour) {
  const entries = Object.entries(hour.components)
    .filter(([, v]) => Math.abs(v) >= 0.001)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, 3);

  if (entries.length === 0) return "baseline hour/day pattern";

  return entries
    .map(([name, v]) => `${v >= 0 ? "+" : "-"}${Math.abs(v).toFixed(3)} ${name}`)
    .join(" • ");
}

// ======================================================================
// Compliance (P) — the two rolling caps
// ======================================================================

/**
 * FROZEN (P): service_fraction ~= expected trips/hour * learned average
 * passenger minutes / 60, clamped to [0.10, 1.00]. Used only for planning.
 */
function serviceFraction(expectedTph, passengerMinutes) {
  const mins = clamp(
    Number.isFinite(passengerMinutes) ? passengerMinutes : DEFAULT_PASSENGER_MINUTES,
    PASSENGER_MINUTES_MIN,
    PASSENGER_MINUTES_MAX
  );
  return clamp((expectedTph * mins) / 60, SERVICE_FRACTION_MIN, SERVICE_FRACTION_MAX);
}

/**
 * FROZEN (P): checks BOTH rolling caps across a set of planned spans —
 * 16 online hours and 12 estimated passenger-service hours in any rolling
 * 24-hour interval. Returns every violation found, so the caller can say
 * exactly what was wrong rather than just refusing.
 */
function rollingViolations(spans, hours, passengerMinutes) {
  const online = new Array(hours.length).fill(0);
  const service = new Array(hours.length).fill(0);
  for (const s of spans) {
    for (let i = s.start; i < s.end; i++) {
      online[i] = 1;
      service[i] = serviceFraction(hours[i].expectedTph, passengerMinutes);
    }
  }

  const violations = [];
  for (let w = 0; w + 24 <= hours.length; w++) {
    let onlineSum = 0;
    let serviceSum = 0;
    for (let i = w; i < w + 24; i++) {
      onlineSum += online[i];
      serviceSum += service[i];
    }
    if (onlineSum > MAX_ROLLING_24H_ONLINE_HOURS + 1e-9) {
      violations.push({ windowStart: w, type: "online", value: onlineSum, cap: MAX_ROLLING_24H_ONLINE_HOURS });
    }
    if (serviceSum > MAX_ROLLING_24H_SERVICE_HOURS + 1e-9) {
      violations.push({ windowStart: w, type: "service", value: serviceSum, cap: MAX_ROLLING_24H_SERVICE_HOURS });
    }
  }
  return violations;
}

/**
 * The minimum gap between two consecutive core-block starts that keeps any
 * 24-hour window inside both caps. Derived rather than assumed, because it
 * depends on the week's actual throughput: at a typical ~0.85 service
 * fraction, the 12-hour service cap binds well before the 16-hour online
 * cap, which is why two back-to-back 8-hour blocks in one day are not a
 * legal plan even though 8 + 8 = 16 looks like it fits.
 */
function requiredStartGap(hours, passengerMinutes) {
  const typicalService = serviceFraction(
    hours.reduce((s, h) => s + h.expectedTph, 0) / hours.length,
    passengerMinutes
  );
  const onlineAllowance = MAX_ROLLING_24H_ONLINE_HOURS - CORE_BLOCK_HOURS;
  const serviceAllowance = Math.floor(
    (MAX_ROLLING_24H_SERVICE_HOURS - CORE_BLOCK_HOURS * typicalService) / Math.max(0.01, typicalService)
  );
  const allowedOverlap = Math.max(0, Math.min(onlineAllowance, serviceAllowance));
  // A later block may overlap the earlier block's 24h window by at most
  // `allowedOverlap` hours.
  return Math.max(CORE_BLOCK_HOURS, 24 - allowedOverlap);
}

// ======================================================================
// Six-block joint optimizer (Q, Q1)
// ======================================================================

/**
 * FROZEN (Q): six 8-hour cores, optimized JOINTLY (never greedily), with
 * the rolling legal constraints part of core selection rather than applied
 * afterwards. The objective is the sum of DISPLAYED hourly scores, which is
 * what the spec specifies — not the raw opportunity values.
 *
 * DP over (hour index, blocks chosen, index of the previously taken start),
 * so the legal minimum separation can be enforced during selection.
 */
function selectCoreBlocks(hours, minGap) {
  const n = hours.length;
  const lastStart = n - CORE_BLOCK_HOURS;
  const windowScore = [];
  for (let s = 0; s <= lastStart; s++) {
    let sum = 0;
    for (let i = s; i < s + CORE_BLOCK_HOURS; i++) sum += hours[i].score;
    windowScore[s] = sum;
  }

  // best[k][s] = best total for choosing k more blocks, the first of which
  // starts at or after s. Computed backwards so ties resolve to the earlier
  // start (deterministic).
  const NEG = -Infinity;
  const best = Array.from({ length: BLOCK_COUNT + 1 }, () => new Array(lastStart + 2).fill(NEG));
  const pick = Array.from({ length: BLOCK_COUNT + 1 }, () => new Array(lastStart + 2).fill(-1));

  for (let s = 0; s <= lastStart + 1; s++) best[0][s] = 0;

  for (let k = 1; k <= BLOCK_COUNT; k++) {
    best[k][lastStart + 1] = NEG;
    for (let s = lastStart; s >= 0; s--) {
      // Option: skip this start.
      let bestVal = best[k][s + 1];
      let bestPick = -1;

      // Option: take a block starting here, then the next must start at
      // least `minGap` later.
      const nextIndex = Math.min(s + minGap, lastStart + 1);
      const rest = best[k - 1][nextIndex];
      if (rest !== NEG) {
        const val = windowScore[s] + rest;
        if (val > bestVal + 1e-12) {
          bestVal = val;
          bestPick = s;
        }
      }
      best[k][s] = bestVal;
      pick[k][s] = bestPick;
    }
  }

  const starts = [];
  let k = BLOCK_COUNT;
  let s = 0;
  while (k > 0 && s <= lastStart) {
    const chosen = pick[k][s];
    if (chosen < 0) {
      s += 1;
      continue;
    }
    starts.push(chosen);
    s = chosen + minGap;
    k -= 1;
  }
  return starts;
}

/**
 * FROZEN (Q1): extensions are eligible only when the adjacent hour is
 * independently strong — the week's 75th-percentile score — evaluated
 * strongest to weakest, accepted only if they neither overlap another
 * selected hour nor break either rolling constraint. A strong extension
 * rejected for compliance is reported, not silently dropped.
 */
function applyExtensions(blocks, hours, passengerMinutes) {
  const threshold = percentile(hours.map((h) => h.score), EXTENSION_PERCENTILE);
  const notes = [];

  const occupied = new Set();
  for (const b of blocks) for (let i = b.start; i < b.end; i++) occupied.add(i);

  // Every eligible adjacent hour across all blocks, strongest first.
  const candidates = [];
  for (const b of blocks) {
    for (const side of ["before", "after"]) {
      const idx = side === "before" ? b.start - 1 : b.end;
      if (idx < 0 || idx >= hours.length) continue;
      candidates.push({ block: b, side, idx, score: hours[idx].score });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.idx - b.idx);

  for (const c of candidates) {
    if (c.score < threshold) continue; // not independently strong.
    if (occupied.has(c.idx)) continue; // would overlap another selected hour.
    if (c.block.end - c.block.start >= CORE_BLOCK_HOURS + MAX_BLOCK_EXTENSION_HOURS) continue;
    // The candidate must still be adjacent after earlier extensions moved edges.
    if (c.side === "before" && c.idx !== c.block.start - 1) continue;
    if (c.side === "after" && c.idx !== c.block.end) continue;

    const trial = blocks.map((b) =>
      b === c.block
        ? { start: c.side === "before" ? b.start - 1 : b.start, end: c.side === "after" ? b.end + 1 : b.end }
        : { start: b.start, end: b.end }
    );

    const violations = rollingViolations(trial, hours, passengerMinutes);
    if (violations.length > 0) {
      notes.push(
        `A strong adjacent hour (${hours[c.idx].weekday} ${hours[c.idx].hour}:00, score ` +
          `${hours[c.idx].score.toFixed(1)}) was NOT added to block ${c.block.label}: it would exceed the ` +
          `rolling ${violations[0].type === "service" ? "passenger-service" : "online"} limit ` +
          `(${violations[0].value.toFixed(1)} vs ${violations[0].cap} hours in a 24-hour window).`
      );
      continue;
    }

    if (c.side === "before") c.block.start -= 1;
    else c.block.end += 1;
    occupied.add(c.idx);
  }

  return { notes, threshold };
}

// ======================================================================
// Score-to-income (M) and platform recommendation (N)
// ======================================================================

/**
 * FROZEN (M): expected $/hr = neutral * [1 + slope * ((score - 50) / 50)].
 * The spec is emphatic that this downstream mapping must NOT change the
 * 168-hour ranking, so it is computed strictly after ranking, from the
 * score, and never feeds back into O_h.
 */
export function expectedHourly(score, options = {}) {
  const slope = clamp(
    Number.isFinite(options.slope) ? options.slope : DEFAULT_SCORE_SLOPE,
    SCORE_SLOPE_MIN,
    SCORE_SLOPE_MAX
  );
  const uberNeutral = Number.isFinite(options.uberNeutralHourly) ? options.uberNeutralHourly : UBER_NEUTRAL_HOURLY;
  const lyftNeutral = Number.isFinite(options.lyftNeutralHourly)
    ? options.lyftNeutralHourly
    : uberNeutral * LYFT_NEUTRAL_MULTIPLIER;

  const factor = 1 + slope * ((score - 50) / 50);
  return {
    uber: Math.max(0, uberNeutral * factor),
    lyft: Math.max(0, lyftNeutral * factor),
    slope
  };
}

/**
 * FROZEN (N1): the four platform states and their thresholds. Uber stays
 * primary by default; Lyft can only become preferred with real Lyft history
 * (3+ income samples AND 3+ throughput samples), an ~8% hourly edge, and at
 * least ~90% of Uber's throughput. Within ~6% it is "Either platform".
 * Score < 20 may say "Stay offline".
 */
export function platformRecommendation(score, income, lyftHistory = {}) {
  if (score < STAY_OFFLINE_SCORE) return "Stay offline";

  const incomeSamples = Number(lyftHistory.incomeSamples) || 0;
  const tphSamples = Number(lyftHistory.tphSamples) || 0;
  const hasHistory = incomeSamples >= LYFT_MIN_INCOME_SAMPLES && tphSamples >= LYFT_MIN_TPH_SAMPLES;

  if (!hasHistory) return "Uber primary — Lyft fallback";

  const lyftHourly = Number.isFinite(lyftHistory.expectedHourly) ? lyftHistory.expectedHourly : income.lyft;
  const relativeTph = Number.isFinite(lyftHistory.relativeTph) ? lyftHistory.relativeTph : 1;
  const edge = (lyftHourly - income.uber) / Math.max(0.01, income.uber);

  if (edge >= LYFT_PREFERRED_INCOME_EDGE && relativeTph >= LYFT_MIN_RELATIVE_TPH) {
    return "Lyft preferred — Uber backup";
  }
  if (Math.abs(edge) <= EITHER_PLATFORM_BAND) return "Either platform";
  return "Uber primary — Lyft fallback";
}

// ======================================================================
// Top-level entry point
// ======================================================================

/**
 * Run a full 168-hour Reno Uber opportunity ranking and shift schedule.
 *
 * @param {object} options
 * @param {Date}   [options.weekStart]        defaults to the next Reno 4AM boundary
 * @param {Array}  [options.evidence]         evidence records (see applyEvidence families)
 * @param {number} [options.learnedUberTph]   learned trips/hour, default 3.0
 * @param {number} [options.passengerMinutes] learned average passenger minutes, default 15
 * @param {object} [options.quest]            {target, current, payout, deadlineHourIndex}
 * @param {object} [options.income]           {slope, uberNeutralHourly, lyftNeutralHourly}
 * @param {object} [options.lyftHistory]      {incomeSamples, tphSamples, expectedHourly, relativeTph}
 */
export function scheduleReno(options = {}) {
  const weekStart = options.weekStart || nextOperationalBoundary();
  const evidence = dedupeEvidence(options.evidence || []);
  const { learnedUberTph, passengerMinutes, quest = null, income = {}, lyftHistory = {} } = options;

  const hourDates = buildHourGrid(weekStart);
  const evidenceByHour = hourDates.map((d) => evidence.filter((e) => evidenceApplies(e, d)));

  const hours = hourDates.map((hourDate, hourIndex) =>
    computeHour({ hourDate, hourIndex, evidenceForHour: evidenceByHour[hourIndex], learnedUberTph, quest })
  );

  normalize(hours);

  // FROZEN (T1): sorted by unrounded raw opportunity, with a deterministic
  // chronological tie-break when raw values are exactly tied — without this,
  // an evidence-free week (where many hours tie exactly) would not be
  // reproducible, which the spec requires in section Y.
  const ranked = [...hours].sort((a, b) => b.O - a.O || a.hourIndex - b.hourIndex);
  ranked.forEach((h, i) => (h.rank = i + 1));

  for (const h of hours) {
    h.reasons = formatReasons(h);
    const c = hourConfidence(h);
    h.confidence = c.value;
    h.confidenceLabel = c.label;
    h.confidenceBasis = c.basis;
    h.income = expectedHourly(h.score, income); // FROZEN (M): after ranking, never feeds back.
    h.platform = platformRecommendation(h.score, h.income, lyftHistory); // FROZEN (N1)
    h.serviceFraction = serviceFraction(h.expectedTph, passengerMinutes); // FROZEN (P)
  }

  // Validation (T1).
  if (hours.length !== 168) throw new Error(`Expected 168 hours, got ${hours.length}`);
  const seen = new Set();
  for (const h of hours) {
    const key = h.date.toISOString();
    if (seen.has(key)) throw new Error(`Duplicate hour detected: ${key}`);
    seen.add(key);
  }

  // Six-block optimizer with compliance inside selection (Q).
  const minGap = requiredStartGap(hours, passengerMinutes);
  const starts = selectCoreBlocks(hours, minGap);
  const blocks = starts.map((start, idx) => ({
    label: `#${idx + 1}`,
    coreStart: start,
    coreEnd: start + CORE_BLOCK_HOURS,
    start,
    end: start + CORE_BLOCK_HOURS
  }));

  const { notes: extensionNotes, threshold: extensionThreshold } = applyExtensions(blocks, hours, passengerMinutes);

  // Final honest validation of the delivered plan.
  const residual = rollingViolations(blocks, hours, passengerMinutes);
  const complianceNotes = [...extensionNotes];
  for (const v of residual) {
    complianceNotes.push(
      `Planned schedule exceeds the rolling ${v.type === "service" ? "passenger-service" : "online"} guardrail ` +
        `(${v.value.toFixed(1)} vs ${v.cap} hours) in the 24 hours from ` +
        `${hours[v.windowStart].weekday} ${hours[v.windowStart].hour}:00.`
    );
  }

  const blockTotal = (b) => hours.slice(b.start, b.end).reduce((s, h) => s + h.score, 0);
  const formattedBlocks = [...blocks]
    .sort((a, b) => blockTotal(b) - blockTotal(a) || a.start - b.start)
    .map((b, idx) => {
      const coreTotal = hours.slice(b.coreStart, b.coreEnd).reduce((s, h) => s + h.score, 0);
      const extendedTotal = blockTotal(b);
      const count = b.end - b.start;
      return {
        rank: idx + 1,
        startDate: hours[b.start].date,
        endDate: hours[b.end - 1].date,
        coreStartDate: hours[b.coreStart].date,
        coreEndDate: hours[b.coreEnd - 1].date,
        hoursCount: count,
        coreTotalScore: Math.round(coreTotal * 10) / 10,
        extendedTotalScore: Math.round(extendedTotal * 10) / 10,
        extendedAvgScore: Math.round((extendedTotal / count) * 10) / 10,
        hasExtension: count > CORE_BLOCK_HOURS,
        startIndex: b.start,
        endIndex: b.end
      };
    });

  // FROZEN (R): days off are ranked by summed hourly SCORES across each
  // complete operational day, not by nightlife alone.
  const days = [];
  for (let d = 0; d < 7; d++) {
    const dayHours = hours.slice(d * 24, d * 24 + 24);
    const totalScore = dayHours.reduce((s, h) => s + h.score, 0);
    days.push({
      dayIndex: d,
      date: dayHours[0].date,
      totalScore,
      avgScore: totalScore / 24
    });
  }
  const daysSorted = [...days].sort((a, b) => a.totalScore - b.totalScore || a.dayIndex - b.dayIndex);
  const bestDaysOff = daysSorted.slice(0, 2);

  // FROZEN (S): one-off hours, excluding the top four blocks by strength.
  const topFour = new Set();
  for (const b of formattedBlocks.slice(0, 4)) {
    for (let i = b.startIndex; i < b.endIndex; i++) topFour.add(i);
  }
  const oneOffs = hours
    .filter((h) => h.score >= ONE_OFF_SCORE_THRESHOLD && !topFour.has(h.hourIndex))
    .sort((a, b) => b.score - a.score || a.hourIndex - b.hourIndex);

  return {
    algorithmVersion: ALGORITHM_VERSION,
    formulaFingerprint: FORMULA_FINGERPRINT,
    weekStart,
    hours,
    ranked,
    blocks: formattedBlocks,
    totalRecommendedHours: formattedBlocks.reduce((s, b) => s + b.hoursCount, 0),
    extensionThreshold: Math.round(extensionThreshold * 10) / 10,
    minStartGapHours: minGap,
    complianceNotes,
    complianceCaveat:
      "Rolling online/passenger-service checks are a conservative planning guardrail approximating Nevada/Uber limits. Actual legal and platform counters always override these estimates.",
    coverage: coverageState(hours),
    bestDaysOff,
    oneOffHours: oneOffs.map((h) => ({
      date: h.date,
      hour: h.hour,
      score: Math.round(h.score * 10) / 10,
      reasons: h.reasons
    })),
    oneOffMessage: oneOffs.length ? null : "No exceptional one-off hours this week."
  };
}
