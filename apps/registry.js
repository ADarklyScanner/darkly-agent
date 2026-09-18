/**
 * apps/registry.js — how side apps plug into this agent.
 *
 * THE PROBLEM THIS SOLVES
 *
 * The agent is accumulating standalone apps that have nothing to do with
 * each other: a Reno driver scheduler, a lottery analyzer, and more to
 * come. The wrong move is to merge them — a lottery analyzer has no
 * business inside a driving-opportunity formula, and blending domains
 * that share no causal mechanism is how a system starts producing
 * confident nonsense.
 *
 * So apps stay SEPARATE. Each owns its own logic, its own tools and its
 * own vocabulary, and nothing reaches across into another's model.
 *
 * WHAT THEY DO SHARE: DATED SIGNALS
 *
 * Unrelated domains can still land on the same calendar day, and that
 * coincidence is occasionally worth knowing — "the day the scheduler
 * rates worst for driving happens to be a draw day for a game you
 * follow". That is a fact about timing, nothing more.
 *
 * A signal is therefore deliberately thin: a date, an emitting app, a
 * kind, and a human-readable detail. Apps cannot read each other's
 * signals, cannot influence each other's scoring, and cannot subscribe to
 * one another. findCoincidences() only groups them by day and says what
 * overlapped.
 *
 * WHAT THIS LAYER MUST NEVER DO
 *
 * Co-occurrence is not causation and is not advice. Two things happening
 * on a Tuesday tells you nothing about whether either is a good idea. The
 * coincidence report is worded as an observation and carries no
 * recommendation, no ranking and no "therefore". In particular a
 * low-earning day is never presented as a REASON to do anything that
 * costs money — that inference would be both unsupported and harmful,
 * and this layer is built so it cannot be drawn accidentally.
 */

const apps = new Map();

/**
 * Register a side app.
 *
 * @param {object} app
 * @param {string} app.id           stable slug, e.g. "lottery"
 * @param {string} app.name         display name
 * @param {string} app.domain       what it is about, in plain words
 * @param {string} app.description  one or two sentences
 * @param {Function} [app.signals]  async (context) => Signal[]
 * @param {object} [app.meta]       anything the app wants to expose
 */
export function registerApp(app) {
  if (!app || typeof app !== "object") throw new Error("An app must be an object.");
  if (!app.id || !/^[a-z][a-z0-9_-]*$/.test(app.id)) {
    throw new Error('An app needs an `id` slug matching /^[a-z][a-z0-9_-]*$/.');
  }
  if (!app.name) throw new Error(`App "${app.id}" needs a \`name\`.`);
  if (!app.domain) throw new Error(`App "${app.id}" needs a \`domain\` describing what it covers.`);
  if (app.signals !== undefined && typeof app.signals !== "function") {
    throw new Error(`App "${app.id}" has a \`signals\` that is not a function.`);
  }
  if (apps.has(app.id)) throw new Error(`App "${app.id}" is already registered.`);

  apps.set(app.id, app);
  return app;
}

export function listApps() {
  return [...apps.values()].map((a) => ({
    id: a.id,
    name: a.name,
    domain: a.domain,
    description: a.description || null,
    emitsSignals: typeof a.signals === "function",
    meta: a.meta || undefined
  }));
}

export function getApp(id) {
  return apps.get(id) || null;
}

/** Test seam: forget every registration. */
export function _resetRegistryForTests() {
  apps.clear();
}

/** Normalize to a YYYY-MM-DD day key in a given time zone. */
export function dayKey(value, timeZone = "America/Los_Angeles") {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function normalizeSignal(appId, raw, timeZone) {
  if (!raw || typeof raw !== "object") return null;
  const day = dayKey(raw.date, timeZone);
  if (!day) return null;
  return {
    app: appId,
    date: day,
    kind: String(raw.kind || "signal"),
    detail: raw.detail ? String(raw.detail) : null,
    value: raw.value !== undefined ? raw.value : undefined
  };
}

/**
 * Ask every registered app for its dated signals.
 *
 * One app throwing must not take the others down — these are independent
 * side apps, and a lottery API being unreachable is no reason to lose the
 * driving schedule. Failures are reported alongside the results rather
 * than swallowed, so a missing app is visible instead of looking like an
 * app with nothing to say.
 */
export async function collectSignals(context = {}) {
  const timeZone = context.timeZone || "America/Los_Angeles";
  const signals = [];
  const failures = [];

  for (const app of apps.values()) {
    if (typeof app.signals !== "function") continue;
    try {
      const produced = await app.signals(context);
      for (const raw of produced || []) {
        const s = normalizeSignal(app.id, raw, timeZone);
        if (s) signals.push(s);
      }
    } catch (e) {
      failures.push({ app: app.id, error: String(e.message || e) });
    }
  }

  signals.sort((a, b) => a.date.localeCompare(b.date) || a.app.localeCompare(b.app));
  return { signals, failures };
}

/**
 * Days on which two or more DIFFERENT apps both had something to say.
 *
 * Requiring different apps is the whole point: two signals from the same
 * app on one day is just that app being detailed, not a cross-domain
 * coincidence.
 */
export function findCoincidences(signals) {
  const byDay = new Map();
  for (const s of signals) {
    if (!byDay.has(s.date)) byDay.set(s.date, []);
    byDay.get(s.date).push(s);
  }

  const days = [];
  for (const [date, list] of byDay) {
    const distinctApps = new Set(list.map((s) => s.app));
    if (distinctApps.size < 2) continue;
    days.push({
      date,
      apps: [...distinctApps].sort(),
      signals: list.map((s) => ({ app: s.app, kind: s.kind, detail: s.detail, value: s.value }))
    });
  }

  days.sort((a, b) => a.date.localeCompare(b.date));

  return {
    coincidenceCount: days.length,
    days,
    meaning:
      "These are days when unrelated apps each happened to have something dated to them. Co-occurrence is not a relationship: nothing here implies one thing caused, predicts, or justifies the other, and none of it is a recommendation.",
    note:
      days.length === 0
        ? "No days where two different apps both had signals."
        : undefined
  };
}
