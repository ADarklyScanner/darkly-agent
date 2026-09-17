/**
 * leads-store.js — durable ReferralMarket lead storage, with a one-time
 * migration off the old location.
 *
 * Leads used to be read/written directly at $HOME/darkly-leads.json — a
 * path this project's own state.js exists specifically to avoid.
 * Railway's container filesystem is ephemeral outside a mounted volume,
 * so any lead saved there was one redeploy away from vanishing. Every
 * other piece of durable state in this codebase (trade log, autotrader
 * run archive, chat history) already goes through state.js, which
 * prefers a mounted /data volume and falls back to $HOME only when no
 * volume exists. This brings leads in line with that.
 *
 * Switching the read/write path outright would make every existing lead
 * look like it had silently vanished the moment a volume is mounted (the
 * durable store starts empty; the real data is still sitting at the old
 * $HOME path). migrateLegacyLeadsIfNeeded() runs once, copies the old
 * file over if the durable store has never been written to, and is a
 * no-op forever after — including on a machine that never had a legacy
 * file, or one that already migrated to an empty list on purpose.
 */

import fs from "node:fs";
import path from "node:path";
import { readState, writeState, stateDir } from "./state.js";

export const LEADS_FILE = "darkly-leads.json";

function legacyPath(home) {
  return path.join(home || process.env.HOME || ".", "darkly-leads.json");
}

/**
 * Copy the old $HOME-based leads file into the durable store, exactly
 * once. readState() returns its fallback (null here) ONLY when the file
 * doesn't exist yet — a durable store already written to, even as an
 * empty array, is left alone forever, so this can safely run on every
 * startup without ever clobbering newer data with a stale legacy copy.
 * `home` is injectable for tests; production calls it with no argument.
 */
export function migrateLegacyLeadsIfNeeded(home) {
  try {
    const alreadyHasDurableData = readState(LEADS_FILE, null) !== null;
    if (alreadyHasDurableData) {
      return { migrated: false, reason: "durable store already exists" };
    }

    const legacy = legacyPath(home);
    if (!fs.existsSync(legacy)) {
      return { migrated: false, reason: "no legacy file to migrate" };
    }

    const parsed = JSON.parse(fs.readFileSync(legacy, "utf8"));
    if (!Array.isArray(parsed)) {
      return { migrated: false, reason: "legacy file did not contain a JSON array" };
    }

    writeState(LEADS_FILE, parsed);
    return { migrated: true, count: parsed.length, from: legacy, to: stateDir() };
  } catch (e) {
    // A migration that can't be verified must not run — silently
    // overwriting a real (if oddly shaped) durable store would be worse
    // than leaving the legacy file alone for a human to look at.
    return { migrated: false, reason: `migration check failed: ${e.message}` };
  }
}

export function loadLeads() {
  return readState(LEADS_FILE, []);
}

export function saveLeads(leads) {
  writeState(LEADS_FILE, leads);
}
