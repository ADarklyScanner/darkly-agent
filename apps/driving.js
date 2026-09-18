/**
 * apps/driving.js — the Reno driver scheduler, exposed as a side app.
 *
 * The engine itself lives in reno-engine.js and is untouched by this
 * file. This is only the adapter that lets it take part in the cross-app
 * view: it turns a schedule run into dated signals.
 *
 * Which signals? The ones that are genuinely about a DAY rather than an
 * hour: the two recommended days off, and the days carrying a
 * recommended driving block. Those are the facts another app could
 * plausibly coincide with. Hour-level scores stay inside the engine,
 * because "this Tuesday 3 PM is a 41" is not a fact about a day and
 * would produce 168 signals of noise.
 */

import { registerApp, dayKey } from "./registry.js";
import { scheduleReno } from "../reno-engine.js";

export function drivingSignals(context = {}) {
  // The caller may pass an already-computed schedule so that asking for
  // the cross-app view does not silently recompute a 168-hour ranking.
  const schedule = context.schedule || scheduleReno(context.scheduleOptions || {});
  const timeZone = context.timeZone || "America/Los_Angeles";
  const signals = [];

  schedule.bestDaysOff.forEach((d, i) => {
    signals.push({
      date: d.date,
      kind: "low_opportunity_day",
      detail: `Ranked best day off #${i + 1} for driving this week (average opportunity score ${Math.round(d.avgScore * 10) / 10} of 100, relative to this week)`,
      value: Math.round(d.avgScore * 10) / 10
    });
  });

  const blockDays = new Set();
  for (const b of schedule.blocks) {
    const key = dayKey(b.startDate, timeZone);
    if (!key || blockDays.has(key)) continue;
    blockDays.add(key);
    signals.push({
      date: b.startDate,
      kind: "recommended_driving_block",
      detail: `A recommended ${b.hoursCount}-hour driving block starts this day (block #${b.rank} of ${schedule.blocks.length})`,
      value: b.extendedAvgScore
    });
  }

  return signals;
}

export function registerDrivingApp() {
  return registerApp({
    id: "driving",
    name: "Reno Driver Scheduler",
    domain: "Hour-by-hour Uber driving opportunity for the coming Reno week",
    description:
      "Ranks all 168 hours of the operational week by driver opportunity and produces six optimized driving blocks, two days off, and exceptional one-off hours.",
    signals: drivingSignals,
    meta: { algorithmVersion: "RENO_UBER_V1_CANONICAL_2026_09_02" }
  });
}
