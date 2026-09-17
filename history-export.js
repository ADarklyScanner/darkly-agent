/**
 * history-export.js — decide what an export request should return.
 *
 * The run archive lives on a mounted volume that nothing outside the
 * container can reach, so getting a copy onto hardware you own needs the
 * process itself to hand it over. The transfer is a byte-range read, which
 * works because the archive is append-only: bytes already written never
 * change, so "everything after what I already have" is always correct and
 * always cheap.
 *
 * The decision is separated from the streaming so it can be tested. The
 * arithmetic here is what stands between an incremental backup and a
 * corrupted one, and it was not worth leaving inline in a route handler
 * that no test can reach.
 */

import fs from "node:fs";
import { statePath } from "./state.js";

/** Only these files are exportable. Anything else is refused by name. */
export const EXPORTABLE = {
  runs: { file: "darkly-runs.jsonl", append: true },
  trades: { file: "darkly-trades.json", append: false },
  state: { file: "darkly-autotrader.json", append: false }
};

/**
 * Work out what to send for an export request.
 *
 * Returns a plain descriptor; the caller streams it. Never throws — a
 * failure here should produce a refusal the client can read, not a 500
 * that looks like the agent is down.
 */
export function resolveExport(query = {}) {
  const key = String(query.file || "runs");
  const entry = EXPORTABLE[key];

  if (!entry) {
    return {
      ok: false,
      status: 400,
      error: `Unknown file '${key}'. Use one of: ${Object.keys(EXPORTABLE).join(", ")}.`
    };
  }

  const path = statePath(entry.file);

  let size = 0;
  let exists = false;
  try {
    exists = fs.existsSync(path);
    if (exists) size = fs.statSync(path).size;
  } catch (e) {
    return { ok: false, status: 500, error: `Could not read ${entry.file}: ${e.message}` };
  }

  // A negative or non-numeric offset means "from the beginning" rather
  // than an error: a backup script that loses track should be able to
  // recover by asking again, not by failing.
  const raw = Number(query.offset);
  const requested = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;

  // An offset past the end of the file means the caller has bytes we do
  // not. That happens when the volume was replaced or the file was
  // rebuilt, and continuing from their offset would silently splice
  // unrelated bytes onto their copy. Start over instead, and say so.
  const stale = requested > size;
  const start = entry.append && !stale ? Math.min(requested, size) : 0;

  return {
    ok: true,
    status: 200,
    key,
    name: entry.file,
    path,
    exists,
    appendOnly: entry.append,
    size,
    start,
    newBytes: Math.max(0, size - start),
    upToDate: exists && start >= size,
    restarted: stale,
    note: stale
      ? "The requested offset is beyond the end of the file, so the archive was replaced or rebuilt. Sending it from the beginning; replace your local copy rather than appending to it."
      : null
  };
}
