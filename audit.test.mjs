/**
 * Tests for audit.js — run with: node audit.test.mjs
 *
 * The failure mode this guards against: a config fingerprint that
 * changes for a reason that has nothing to do with the actual settings
 * (key order, an undefined vs. absent key), which would make "did the
 * settings change between these two runs" a false positive; and a
 * deployment info that guesses or half-fills a commit identity instead
 * of saying plainly that it doesn't know one.
 */

import { configFingerprint, deploymentInfo } from "./audit.js";

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

/* ------------------------------------------------------------------ */

console.log("\nconfigFingerprint — stability");

check("is deterministic across repeated calls",
  configFingerprint({ a: 1, b: 2 }) === configFingerprint({ a: 1, b: 2 }));

check("key order does not affect the fingerprint",
  configFingerprint({ a: 1, b: 2 }) === configFingerprint({ b: 2, a: 1 }));

check("nested key order does not affect the fingerprint",
  configFingerprint({ outer: { a: 1, b: 2 } }) === configFingerprint({ outer: { b: 2, a: 1 } }));

check("a present-but-undefined key fingerprints the same as an absent one",
  configFingerprint({ a: 1, b: undefined }) === configFingerprint({ a: 1 }));

check("returns a non-empty hex-looking string",
  /^[0-9a-f]{16}$/.test(configFingerprint({ a: 1 })), configFingerprint({ a: 1 }));

console.log("\nconfigFingerprint — sensitivity (it must actually detect changes)");

check("a different primitive value changes the fingerprint",
  configFingerprint({ a: 1 }) !== configFingerprint({ a: 2 }));

check("a different key name changes the fingerprint",
  configFingerprint({ a: 1 }) !== configFingerprint({ b: 1 }));

check("a different nested value changes the fingerprint",
  configFingerprint({ outer: { a: 1 } }) !== configFingerprint({ outer: { a: 2 } }));

check("array order DOES matter (arrays are ordered data, unlike object keys)",
  configFingerprint({ a: [1, 2, 3] }) !== configFingerprint({ a: [3, 2, 1] }));

{
  const base = {
    CONFIG: { mode: "signal_only", positionUsd: 500, aggressiveness: "moderate" },
    RISK_DEFAULTS: { maxHeatPercent: 20, benchmarkSymbol: "SPY" }
  };
  const tweaked = { ...base, CONFIG: { ...base.CONFIG, positionUsd: 750 } };
  check("a realistic multi-object config bag is distinguishable from a tweaked copy",
    configFingerprint(base) !== configFingerprint(tweaked));
}

console.log("\nconfigFingerprint — edge values");

check("handles null", typeof configFingerprint(null) === "string");
check("handles an empty object", typeof configFingerprint({}) === "string");
check("handles booleans and mixed types",
  configFingerprint({ a: true, b: "x", c: null, d: [1, "y", null] }).length === 16);
check("distinguishes null from the string 'null'",
  configFingerprint({ a: null }) !== configFingerprint({ a: "null" }));

/* ------------------------------------------------------------------ */

console.log("\ndeploymentInfo — unknown when Railway's git vars aren't set");

{
  const info = deploymentInfo({});
  check("known is false with no env vars at all", info.known === false);
  check("commitSha is null, not a guess", info.commitSha === null);
  check("explains why in a plain-English note", /not set/i.test(info.note), info.note);
  check("does not silently fill in other fields when the commit itself is unknown",
    info.branch === null && info.repo === null && info.commitMessage === null && info.author === null);
}

{
  const info = deploymentInfo({ RAILWAY_ENVIRONMENT_NAME: "production" });
  check("still reports environment even when commit is unknown", info.environment === "production");
  check("but stays known:false since that's not a commit identity", info.known === false);
}

console.log("\ndeploymentInfo — known, from injected Railway env vars");

{
  const env = {
    RAILWAY_GIT_COMMIT_SHA: "abcdef1234567890abcdef1234567890abcdef12",
    RAILWAY_GIT_BRANCH: "main",
    RAILWAY_GIT_REPO_NAME: "ADarklyScanner/darkly-agent",
    RAILWAY_GIT_COMMIT_MESSAGE: "Add a Sharpe ratio to the backtest report",
    RAILWAY_GIT_AUTHOR: "Johnny",
    RAILWAY_ENVIRONMENT_NAME: "production"
  };
  const info = deploymentInfo(env);

  check("known is true when RAILWAY_GIT_COMMIT_SHA is present", info.known === true);
  check("commitSha passes through exactly", info.commitSha === env.RAILWAY_GIT_COMMIT_SHA);
  check("commitShaShort is a 12-character prefix", info.commitShaShort === env.RAILWAY_GIT_COMMIT_SHA.slice(0, 12));
  check("branch/repo/message/author/environment all pass through",
    info.branch === "main" &&
    info.repo === "ADarklyScanner/darkly-agent" &&
    info.commitMessage === env.RAILWAY_GIT_COMMIT_MESSAGE &&
    info.author === "Johnny" &&
    info.environment === "production");
  check("note is null when the commit is known", info.note === null);
}

{
  // deploymentInfo must not reach into the real process.env by accident
  // when an env object is explicitly passed, even an empty one.
  const realSha = process.env.RAILWAY_GIT_COMMIT_SHA;
  process.env.RAILWAY_GIT_COMMIT_SHA = "should-not-leak-in";
  const info = deploymentInfo({});
  check("an injected empty env is used as-is, not merged with the real process.env",
    info.commitSha === null);
  if (realSha === undefined) delete process.env.RAILWAY_GIT_COMMIT_SHA;
  else process.env.RAILWAY_GIT_COMMIT_SHA = realSha;
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
