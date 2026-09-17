/**
 * state.js — where durable data lives.
 *
 * Railway containers have an ephemeral filesystem: everything written to
 * $HOME is destroyed on every deploy and every restart. The trade log and
 * the autotrader run history were being written there, which meant the
 * system's entire memory of what it had done was erased roughly as often
 * as the code changed. A system that cannot remember its own trades cannot
 * be evaluated, and anything that cannot be evaluated cannot be improved.
 *
 * So state goes on a mounted volume when one exists, and falls back to
 * $HOME when it does not — which is what happens on a phone, in tests,
 * and on any machine without the volume. The fallback is deliberately
 * silent in behaviour but loud in reporting: stateInfo() says exactly
 * where data is going and whether it will survive a restart, so "we have
 * six months of history" is never an assumption.
 */

import fs from "node:fs";
import path from "node:path";

const CANDIDATES = [
  process.env.DARKLY_STATE_DIR,
  "/data",
  process.env.HOME,
  "."
].filter(Boolean);

let resolved = null;

function isWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.darkly-write-probe-${process.pid}`);
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);
    return true;
  } catch (e) {
    return false;
  }
}

/** The directory durable state is written to. Resolved once per process. */
export function stateDir() {
  if (resolved) return resolved;
  for (const dir of CANDIDATES) {
    if (isWritable(dir)) {
      resolved = dir;
      return resolved;
    }
  }
  resolved = ".";
  return resolved;
}

/** Full path for a named state file. */
export function statePath(filename) {
  return path.join(stateDir(), filename);
}

/**
 * Whether state survives a restart, and why we think so. Reported in the
 * autotrader status so the durability of the record is never guesswork.
 */
export function stateInfo() {
  const dir = stateDir();
  const mounted = dir === "/data" || dir === process.env.DARKLY_STATE_DIR;

  return {
    directory: dir,
    durable: Boolean(mounted),
    note: mounted
      ? "State is on a mounted volume and survives deploys and restarts."
      : `State is on the container's ephemeral filesystem (${dir}). It will be lost on the next deploy or restart. Mount a volume and set DARKLY_STATE_DIR to keep history.`
  };
}

/** Read JSON state, returning `fallback` on absence or corruption. */
export function readState(filename, fallback) {
  try {
    const file = statePath(filename);
    if (!fs.existsSync(file)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch (e) {
    // A corrupt state file must never be able to start or stop trading by
    // accident. Callers get the fallback and carry on with their own
    // fail-closed logic.
    return fallback;
  }
}

/**
 * Write JSON state atomically: write a temp file in the same directory,
 * then rename over the target. A crash mid-write leaves the previous
 * good file intact rather than a truncated one that parses to null and
 * silently reads as "no trades today".
 */
export function writeState(filename, value) {
  try {
    const file = statePath(filename);
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Append-only archives
 * ------------------------------------------------------------------ *
 *
 * History belongs in a different shape from live state. A single JSON
 * array has to be parsed and rewritten in full on every append, so a log
 * that grows for a year turns each 15-minute run into a 90MB
 * read-modify-write. Disk is cheap and nobody minds the gigabyte; the cost
 * that actually bites is the rewrite.
 *
 * So history is appended one JSON object per line and never rewritten.
 * Appending is O(1) regardless of how much is already there, reading the
 * recent past seeks from the end rather than loading the whole file, and
 * nothing is ever discarded to make room.
 */

/** Append one record as a JSON line. Never rewrites what came before. */
export function appendLine(filename, record) {
  try {
    fs.appendFileSync(statePath(filename), JSON.stringify(record) + "\n");
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Read the last `n` records without loading the file.
 *
 * Seeks backwards in chunks from the end. The first line of any chunk that
 * does not start at byte zero may be a fragment — of a line or even of a
 * multi-byte character — so it is dropped rather than parsed, which is why
 * the loop reads one more line than it needs.
 */
export function tailLines(filename, n = 100) {
  const file = statePath(filename);

  let fd;
  try {
    if (!fs.existsSync(file)) return [];
    fd = fs.openSync(file, "r");
  } catch (e) {
    return [];
  }

  try {
    const size = fs.fstatSync(fd).size;
    if (size === 0) return [];

    const chunkSize = 64 * 1024;
    let pos = size;
    let buf = Buffer.alloc(0);
    let lines = [];

    while (pos > 0) {
      const readSize = Math.min(chunkSize, pos);
      pos -= readSize;

      const chunk = Buffer.alloc(readSize);
      fs.readSync(fd, chunk, 0, readSize, pos);
      buf = Buffer.concat([chunk, buf]);

      lines = buf.toString("utf8").split("\n").filter((l) => l.trim());

      // Not at the start of the file: the leading line may be a fragment.
      const usable = pos > 0 ? lines.length - 1 : lines.length;
      if (usable >= n) break;
    }

    if (pos > 0 && lines.length > 0) lines = lines.slice(1);

    return lines
      .slice(-n)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch (e) {
          return null;
        }
      })
      .filter(Boolean);
  } catch (e) {
    return [];
  } finally {
    try {
      fs.closeSync(fd);
    } catch (e) {
      /* already closed */
    }
  }
}

/** Size and rough record count of an archive, without reading it all. */
export function archiveInfo(filename) {
  try {
    const file = statePath(filename);
    if (!fs.existsSync(file)) {
      return { exists: false, bytes: 0, megabytes: 0, records: 0 };
    }

    const bytes = fs.statSync(file).size;
    const sample = tailLines(filename, 20);
    const avg =
      sample.length > 0
        ? sample.reduce((a, r) => a + JSON.stringify(r).length + 1, 0) / sample.length
        : 0;

    return {
      exists: true,
      bytes,
      megabytes: Number((bytes / 1024 / 1024).toFixed(2)),
      records: avg > 0 ? Math.round(bytes / avg) : 0,
      recordsAreEstimated: true
    };
  } catch (e) {
    return { exists: false, bytes: 0, megabytes: 0, records: 0 };
  }
}

/** Test seam: forget the resolved directory so a new one can be picked up. */
export function resetStateDir() {
  resolved = null;
}
