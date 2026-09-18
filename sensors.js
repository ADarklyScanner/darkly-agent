/**
 * sensors.js — readings pushed from the phone.
 *
 * The agent runs on a server, so it has no senses of its own. The phone
 * does: ambient sound level, location, light, motion, battery. This is the
 * intake for those — the phone POSTs readings, they are stored durably,
 * and the agent can then answer things that are otherwise unanswerable
 * from a datacenter, like whether somewhere is loud right now.
 *
 * DESIGN CONSTRAINTS
 *
 * Readings expire. A noise level from six hours ago says nothing about
 * where the phone is now, and the single worst failure here would be
 * presenting a stale reading as current — so every read reports the age
 * of what it found and refuses to call anything "current" past a
 * freshness window. Staleness is surfaced, never smoothed over.
 *
 * Storage is bounded. This is an append-heavy stream from a device that
 * may report every few seconds, so each sensor keeps a rolling window
 * rather than growing without limit, and it lives on the mounted volume
 * through state.js like every other durable thing here.
 *
 * PRIVACY
 *
 * Location traces are among the most sensitive data a person can hand
 * over. They stay on the user's own deployment, are never sent anywhere
 * by this module, and the rolling cap means the store is a recent window
 * rather than a permanent movement history. Anything that wants to change
 * that should be a deliberate decision, not a side effect of a default.
 */

import { readState, writeState } from "./state.js";

const SENSOR_FILE = "darkly-sensors.json";

/** Rolling window per sensor: enough for recent context, not a life log. */
export const MAX_READINGS_PER_SENSOR = 200;

/** How old a reading may be and still be described as current. */
export const FRESHNESS = {
  sound: 5 * 60 * 1000,
  location: 10 * 60 * 1000,
  light: 10 * 60 * 1000,
  motion: 5 * 60 * 1000,
  battery: 30 * 60 * 1000,
  default: 15 * 60 * 1000
};

export const KNOWN_SENSORS = ["sound", "location", "light", "motion", "battery", "steps", "pressure", "temperature"];

function load() {
  const raw = readState(SENSOR_FILE, {});
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}

function save(store) {
  return writeState(SENSOR_FILE, store);
}

/**
 * Record one reading.
 *
 * `at` is accepted from the device but clamped: a phone with a wrong
 * clock could otherwise insert a reading dated next week that would then
 * look permanently fresh. Unknown sensor names are accepted rather than
 * rejected — the phone may grow sensors this file has never heard of, and
 * refusing them would make adding one a server change.
 */
export function recordReading({ sensor, value, unit, at, meta } = {}) {
  if (!sensor || typeof sensor !== "string") throw new Error("`sensor` is required.");
  const name = sensor.trim().toLowerCase().replace(/[^a-z0-9_]/g, "");
  if (!name) throw new Error("`sensor` must be a simple name like sound, location or light.");
  if (value === undefined || value === null) throw new Error("`value` is required.");

  const now = Date.now();
  let timestamp = at ? new Date(at).getTime() : now;
  if (!Number.isFinite(timestamp)) timestamp = now;
  // A device clock ahead of the server would produce permanently "fresh"
  // readings, so the future is not allowed.
  if (timestamp > now) timestamp = now;

  const store = load();
  if (!Array.isArray(store[name])) store[name] = [];

  store[name].push({
    value,
    unit: unit || null,
    at: new Date(timestamp).toISOString(),
    meta: meta && typeof meta === "object" ? meta : undefined
  });

  store[name].sort((a, b) => new Date(a.at) - new Date(b.at));
  if (store[name].length > MAX_READINGS_PER_SENSOR) {
    store[name] = store[name].slice(-MAX_READINGS_PER_SENSOR);
  }

  const ok = save(store);
  return {
    ok,
    sensor: name,
    stored: store[name].length,
    known: KNOWN_SENSORS.includes(name),
    note: KNOWN_SENSORS.includes(name)
      ? undefined
      : `"${name}" is not a sensor this server knows by name, but it was stored anyway so the phone can add sensors without a server change.`
  };
}

function ageOf(reading, now = Date.now()) {
  return now - new Date(reading.at).getTime();
}

function describeAge(ms) {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s} seconds ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} minutes ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hours ago`;
  return `${Math.round(h / 24)} days ago`;
}

/**
 * The most recent reading for a sensor, with its age stated plainly.
 *
 * `fresh` is the field that matters: an hour-old sound level is a real
 * measurement of a place the phone may have left, and calling it current
 * would be the kind of quiet wrongness that leads somewhere bad.
 */
export function latest(sensor, now = Date.now()) {
  const name = String(sensor || "").trim().toLowerCase();
  const store = load();
  const list = store[name];
  if (!Array.isArray(list) || list.length === 0) {
    return { sensor: name, found: false, note: `No ${name} readings have been received. The phone has not sent any, or is not configured to.` };
  }

  const reading = list[list.length - 1];
  const age = ageOf(reading, now);
  const limit = FRESHNESS[name] ?? FRESHNESS.default;

  return {
    sensor: name,
    found: true,
    value: reading.value,
    unit: reading.unit,
    at: reading.at,
    ageMs: age,
    age: describeAge(age),
    fresh: age <= limit,
    freshnessWindow: describeAge(limit),
    meta: reading.meta,
    note: age <= limit
      ? undefined
      : `This reading is ${describeAge(age)}, past the ${describeAge(limit)} window for ${name}. Treat it as the last known value, not as the situation now.`
  };
}

/** A summary across all sensors, oldest-first per sensor. */
export function summary(now = Date.now()) {
  const store = load();
  const sensors = Object.keys(store).sort();

  return {
    sensorCount: sensors.length,
    sensors: sensors.map((name) => {
      const list = store[name];
      const last = list[list.length - 1];
      const age = ageOf(last, now);
      const limit = FRESHNESS[name] ?? FRESHNESS.default;
      return {
        sensor: name,
        readings: list.length,
        latestValue: last.value,
        unit: last.unit,
        at: last.at,
        age: describeAge(age),
        fresh: age <= limit
      };
    }),
    note: sensors.length === 0
      ? "No sensor readings have ever been received. The phone needs to POST to /sensor-reading for any of this to exist."
      : undefined
  };
}

/** Recent readings for one sensor, newest last. */
export function history(sensor, limit = 50) {
  const name = String(sensor || "").trim().toLowerCase();
  const store = load();
  const list = Array.isArray(store[name]) ? store[name] : [];
  const n = Math.max(1, Math.min(MAX_READINGS_PER_SENSOR, Number(limit) || 50));
  return { sensor: name, count: list.length, readings: list.slice(-n) };
}

/**
 * Interpret a sound reading against common reference points.
 *
 * Deliberately conservative about what it claims: phone microphones are
 * not calibrated instruments, absolute dB from one is approximate, and
 * the honest use is comparison ("louder than earlier") rather than a
 * precise figure. Saying so is better than handing back a number that
 * looks like a measurement from a sound meter.
 */
export function interpretSound(db) {
  const v = Number(db);
  if (!Number.isFinite(v)) return null;

  let comparison;
  if (v < 30) comparison = "very quiet, like a library";
  else if (v < 45) comparison = "quiet, like a calm room";
  else if (v < 60) comparison = "moderate, like conversation";
  else if (v < 75) comparison = "busy, like a restaurant or street traffic";
  else if (v < 90) comparison = "loud, like a bar or heavy traffic";
  else comparison = "very loud, like a club or live music";

  return {
    approximateDb: Math.round(v),
    comparison,
    caveat:
      "Phone microphones are uncalibrated, so treat this as a rough level and a basis for comparison over time rather than an exact decibel measurement."
  };
}

/** Test seam: wipe the store. */
export function _clearSensorsForTests() {
  save({});
}
