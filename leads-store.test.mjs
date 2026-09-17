/**
 * Tests for leads-store.js — run with: node leads-store.test.mjs
 *
 * The failure mode this guards against isn't "leads don't save" (that's
 * obvious and would be caught immediately) — it's the quiet one: a
 * migration that runs on every startup and either (a) never fires when
 * it should, leaving real leads stranded at the old path forever, or
 * (b) fires MORE than once and clobbers newer durable data with a stale
 * legacy copy. Both look fine until the day they don't.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DARKLY_STATE_DIR = path.join(os.tmpdir(), `darkly-leadsstore-test-${process.pid}`);
const LEGACY_HOME = path.join(os.tmpdir(), `darkly-leadsstore-legacy-${process.pid}`);
fs.mkdirSync(LEGACY_HOME, { recursive: true });

const { loadLeads, saveLeads, migrateLegacyLeadsIfNeeded, LEADS_FILE } = await import("./leads-store.js");
// state.js memoizes its resolved directory once per process (see its own
// doc comment) — resetStateDir() is its test seam for picking a fresh
// one after changing DARKLY_STATE_DIR mid-file. Every "fresh store"
// section below needs this, not a re-import of leads-store.js, since
// leads-store.js does no memoization of its own; the caching lives in
// the state.js singleton it imports.
const { resetStateDir } = await import("./state.js");

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

function writeLegacyFile(content) {
  fs.writeFileSync(path.join(LEGACY_HOME, "darkly-leads.json"), content);
}

/* ------------------------------------------------------------------ */

console.log("\nloadLeads/saveLeads — basic durable round-trip");

check("loadLeads() with nothing saved yet returns an empty array", Array.isArray(loadLeads()) && loadLeads().length === 0);

{
  const leads = [{ id: "a1", name: "Acme Co" }, { id: "b2", name: "Beta LLC" }];
  saveLeads(leads);
  check("saveLeads then loadLeads round-trips exactly", JSON.stringify(loadLeads()) === JSON.stringify(leads));
}

console.log("\nmigrateLegacyLeadsIfNeeded — nothing to do");

{
  // Durable store already has data (from the section above), so a
  // legacy file appearing now must NOT overwrite it.
  writeLegacyFile(JSON.stringify([{ id: "legacy-should-not-appear" }]));
  const result = migrateLegacyLeadsIfNeeded(LEGACY_HOME);
  check("does not migrate when the durable store already has data", result.migrated === false);
  check("explains why", /already exists/i.test(result.reason), result.reason);
  check("existing durable leads are untouched", loadLeads().length === 2);
}

console.log("\nmigrateLegacyLeadsIfNeeded — the actual migration, on a fresh store");

{
  // Reset to a fresh durable store (simulating a machine that has never
  // written leads durably yet) by pointing at a new DARKLY_STATE_DIR and
  // forgetting state.js's memoized directory.
  process.env.DARKLY_STATE_DIR = path.join(os.tmpdir(), `darkly-leadsstore-test2-${process.pid}`);
  resetStateDir();

  check("fresh durable store has nothing yet", loadLeads().length === 0);

  const legacyLeads = [{ id: "x1", name: "Legacy Corp" }, { id: "x2", name: "Old Biz" }];
  writeLegacyFile(JSON.stringify(legacyLeads));

  const result = migrateLegacyLeadsIfNeeded(LEGACY_HOME);
  check("reports migrated:true", result.migrated === true, JSON.stringify(result));
  check("reports the correct count", result.count === 2, result.count);
  check("the durable store now has the migrated leads", JSON.stringify(loadLeads()) === JSON.stringify(legacyLeads));

  // Running it again must be a no-op, even though the legacy file is
  // still sitting right there — otherwise every restart would re-copy
  // stale data over whatever changed since.
  saveLeads([{ id: "x1", name: "Legacy Corp (updated)" }]);
  const second = migrateLegacyLeadsIfNeeded(LEGACY_HOME);
  check("a second migration attempt is a no-op", second.migrated === false);
  check("newer durable data survives the no-op migration attempt",
    loadLeads().length === 1 && loadLeads()[0].name === "Legacy Corp (updated)");
}

console.log("\nmigrateLegacyLeadsIfNeeded — edge cases");

{
  process.env.DARKLY_STATE_DIR = path.join(os.tmpdir(), `darkly-leadsstore-test3-${process.pid}`);
  resetStateDir();

  const emptyLegacyHome = path.join(os.tmpdir(), `darkly-leadsstore-nolegacy-${process.pid}`);
  fs.mkdirSync(emptyLegacyHome, { recursive: true });
  const result = migrateLegacyLeadsIfNeeded(emptyLegacyHome);
  check("no legacy file at all: does not migrate, does not throw", result.migrated === false);
  check("explains there was nothing to migrate", /no legacy file/i.test(result.reason), result.reason);
}

{
  process.env.DARKLY_STATE_DIR = path.join(os.tmpdir(), `darkly-leadsstore-test4-${process.pid}`);
  resetStateDir();

  const badHome = path.join(os.tmpdir(), `darkly-leadsstore-badjson-${process.pid}`);
  fs.mkdirSync(badHome, { recursive: true });
  fs.writeFileSync(path.join(badHome, "darkly-leads.json"), "{not valid json");

  const result = migrateLegacyLeadsIfNeeded(badHome);
  check("corrupt legacy JSON: does not migrate, does not throw", result.migrated === false);
  check("explains the failure rather than silently succeeding", typeof result.reason === "string" && result.reason.length > 0, result.reason);
}

{
  process.env.DARKLY_STATE_DIR = path.join(os.tmpdir(), `darkly-leadsstore-test5-${process.pid}`);
  resetStateDir();

  const nonArrayHome = path.join(os.tmpdir(), `darkly-leadsstore-nonarray-${process.pid}`);
  fs.mkdirSync(nonArrayHome, { recursive: true });
  fs.writeFileSync(path.join(nonArrayHome, "darkly-leads.json"), JSON.stringify({ not: "an array" }));

  const result = migrateLegacyLeadsIfNeeded(nonArrayHome);
  check("legacy file is valid JSON but not an array: does not migrate", result.migrated === false);
  check("durable store stays empty rather than getting a garbage shape", loadLeads().length === 0);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
