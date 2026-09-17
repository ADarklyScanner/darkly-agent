/**
 * Tests for history-export.js — run with: node history-export.test.mjs
 *
 * This arithmetic decides what lands in your local backup. Getting it
 * wrong does not throw — it produces a file that looks fine and has a
 * hole in it, or unrelated bytes spliced onto the end. So the offset
 * cases are tested individually, including the ugly ones.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SCRATCH = path.join(os.tmpdir(), "darkly-export-test");
fs.rmSync(SCRATCH, { recursive: true, force: true });
fs.mkdirSync(SCRATCH, { recursive: true });
process.env.DARKLY_STATE_DIR = SCRATCH;

const { resolveExport, EXPORTABLE } = await import("./history-export.js");

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

const RUNS = path.join(SCRATCH, "darkly-runs.jsonl");
const write = (lines) => fs.writeFileSync(RUNS, lines.map((l) => JSON.stringify(l) + "\n").join(""));

/* ------------------------------------------------------------------ */

console.log("\nFile selection");

check("defaults to the run archive", resolveExport({}).name === "darkly-runs.jsonl");
check("named files resolve", resolveExport({ file: "trades" }).name === "darkly-trades.json");
check("unknown files are refused", resolveExport({ file: "passwd" }).ok === false);
check("refusal is a 400, not a 500", resolveExport({ file: "passwd" }).status === 400);
check("refusal lists what IS allowed",
  /runs, trades, state/.test(resolveExport({ file: "passwd" }).error),
  resolveExport({ file: "passwd" }).error);

// The allowlist is the whole access control here — a path must never be
// assembled from user input.
check("traversal cannot escape the allowlist",
  resolveExport({ file: "../../../../etc/passwd" }).ok === false);
check("absolute paths cannot escape it either",
  resolveExport({ file: "/etc/passwd" }).ok === false);

/* ------------------------------------------------------------------ */

console.log("\nMissing archive");

const missing = resolveExport({ file: "runs" });
check("a missing file is not an error", missing.ok === true);
check("missing reports zero bytes", missing.size === 0 && missing.newBytes === 0);
check("missing does not claim to exist", missing.exists === false);

/* ------------------------------------------------------------------ */

console.log("\nOffsets over an append-only archive");

write([{ i: 1 }, { i: 2 }, { i: 3 }]);
const size = fs.statSync(RUNS).size;

const whole = resolveExport({ file: "runs" });
check("no offset sends everything", whole.start === 0 && whole.newBytes === size, `${whole.newBytes} of ${size}`);

const firstLine = JSON.stringify({ i: 1 }).length + 1;
const partial = resolveExport({ file: "runs", offset: firstLine });
check("an offset sends only the remainder",
  partial.start === firstLine && partial.newBytes === size - firstLine,
  `start=${partial.start} new=${partial.newBytes}`);

// Verify the bytes actually line up: reading from the offset must yield
// whole records, never a fragment spliced onto the caller's copy.
const tail = fs.readFileSync(RUNS).subarray(partial.start).toString();
check("resuming from an offset yields whole records",
  tail.trim().split("\n").every((l) => { try { JSON.parse(l); return true; } catch { return false; } }),
  tail);
check("resumed content starts at the right record", JSON.parse(tail.trim().split("\n")[0]).i === 2);

const caughtUp = resolveExport({ file: "runs", offset: size });
check("an offset at EOF sends nothing", caughtUp.newBytes === 0);
check("an offset at EOF reports up to date", caughtUp.upToDate === true);

/* ------------------------------------------------------------------ */

console.log("\nOffsets that would corrupt a backup");

// The caller claims more bytes than exist. Continuing from their offset
// would splice unrelated bytes onto their file. Start over instead.
const stale = resolveExport({ file: "runs", offset: size + 5000 });
check("an offset past EOF restarts from zero", stale.start === 0, `start=${stale.start}`);
check("restarting is flagged, not silent", stale.restarted === true);
check("the restart explains what the caller must do",
  /replace your local copy/.test(stale.note || ""), stale.note);
check("a restart sends the whole file", stale.newBytes === size);

check("a negative offset is treated as zero", resolveExport({ file: "runs", offset: -50 }).start === 0);
check("a garbage offset is treated as zero", resolveExport({ file: "runs", offset: "banana" }).start === 0);
check("a fractional offset is floored",
  resolveExport({ file: "runs", offset: 10.9 }).start === 10);
check("a string offset still works", resolveExport({ file: "runs", offset: String(firstLine) }).start === firstLine);

/* ------------------------------------------------------------------ */

console.log("\nSnapshot files are never resumed");

fs.writeFileSync(path.join(SCRATCH, "darkly-trades.json"), JSON.stringify([{ a: 1 }, { b: 2 }]));

// Trades and state are rewritten in place, so byte offsets into them are
// meaningless — resuming would interleave an old tail with a new head.
const snap = resolveExport({ file: "trades", offset: 5 });
check("a snapshot ignores the offset", snap.start === 0, `start=${snap.start}`);
check("a snapshot is marked as not append-only", snap.appendOnly === false);
check("the archive IS marked append-only", resolveExport({ file: "runs" }).appendOnly === true);
check("every exportable file declares its mode",
  Object.values(EXPORTABLE).every((e) => typeof e.append === "boolean"));

/* ------------------------------------------------------------------ */

console.log("\nGrowth between calls");

// A run is appended after the caller asked how big the file was. The
// caller's next fetch must pick up everything, including what arrived
// in between — never skip it.
const before = fs.statSync(RUNS).size;
fs.appendFileSync(RUNS, JSON.stringify({ i: 4 }) + "\n");
const after = resolveExport({ file: "runs", offset: before });

check("records appended between calls are not skipped", after.newBytes > 0);
check("the new tail is exactly the new record",
  fs.readFileSync(RUNS).subarray(after.start).toString().trim() === JSON.stringify({ i: 4 }),
  fs.readFileSync(RUNS).subarray(after.start).toString());

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
