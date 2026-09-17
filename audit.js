/**
 * audit.js — knowing exactly which CODE and which CONFIG produced a given
 * run, after the fact.
 *
 * The run archive (autotrader.js's append-only darkly-runs.jsonl, via
 * state.js) already records every decision a run made and why. What it
 * did not record was WHICH VERSION of the rules made that decision — if
 * AUTO_TRADE_AGGRESSIVENESS or a risk parameter changes next week, a run
 * from last month has no way to say "this was made under different
 * settings." Two independent things can change the rules a run follows:
 *
 *   - the CODE (strategy.js, risk.js, autotrader.js) — tracked here by
 *     the deployed git commit, read from the RAILWAY_GIT_* variables
 *     Railway injects automatically now that the service is connected
 *     directly to the GitHub repo (see server.js's deploy history —
 *     connect-service-source, done specifically so every deploy has a
 *     git paper trail). Locally, in tests, or on a service that predates
 *     that connection, none of these are set, and deploymentInfo() says
 *     so plainly rather than guessing a commit or inventing "unknown".
 *   - the CONFIG (env-var-driven knobs: aggressiveness, position sizing,
 *     stop/target percents, risk defaults) — tracked by configFingerprint,
 *     a stable hash of the actual objects in effect, so two runs can be
 *     compared for "were these the same settings" without diffing every
 *     field by hand, and without storing the full config object on every
 *     single archived run.
 *
 * Both are pure/deterministic and take their inputs as arguments — no env
 * var is read deep inside a hash function a test can't control.
 */

import { createHash } from "node:crypto";

/**
 * JSON.stringify with object keys sorted, so the same config produces the
 * same fingerprint regardless of property insertion order. Deliberately
 * not a general-purpose serializer — just enough to fingerprint plain
 * config objects (nested objects/arrays/primitives), which is all this
 * codebase's CONFIG/RISK_DEFAULTS/AGGRESSIVENESS objects are.
 */
function stableStringify(value) {
  if (value === undefined) return "null"; // matches JSON.stringify's handling of undefined inside an array
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;

  // Keys whose value is undefined are dropped, same as JSON.stringify
  // does for plain objects — a key that's present-but-undefined and a
  // key that's simply absent should fingerprint identically.
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

/**
 * A stable fingerprint for a config object (or a bag of several, e.g.
 * { CONFIG, RISK_DEFAULTS, AGGRESSIVENESS }). Same values -> same
 * fingerprint, whatever order the keys were built in. Not a security
 * hash — just a short, comparable stand-in so "did the settings change
 * between these two runs" is a string comparison instead of a manual
 * field-by-field diff.
 */
export function configFingerprint(config) {
  const json = stableStringify(config);
  return createHash("sha256").update(json).digest("hex").slice(0, 16);
}

/**
 * Which deployed commit is actually running, read from the variables
 * Railway sets automatically for a GitHub-connected service — NOT read
 * from a `git` invocation, since the running container has no .git
 * directory or git binary to rely on. `env` is injectable so this stays
 * testable without mutating process.env.
 *
 * Returns a clearly `known: false` shape rather than scattering nulls
 * through an otherwise-normal-looking object when those variables are
 * absent (a local run, a test, or a service deployed before this session
 * connected it to GitHub via connect-service-source).
 */
export function deploymentInfo(env = process.env) {
  const commitSha = env.RAILWAY_GIT_COMMIT_SHA || null;

  if (!commitSha) {
    return {
      known: false,
      commitSha: null,
      commitShaShort: null,
      branch: null,
      repo: null,
      commitMessage: null,
      author: null,
      environment: env.RAILWAY_ENVIRONMENT_NAME || null,
      note:
        "RAILWAY_GIT_COMMIT_SHA is not set. This is a local/test run, or a Railway service not (yet) connected to a GitHub repo — either way, this run cannot be tied to a specific commit."
    };
  }

  return {
    known: true,
    commitSha,
    commitShaShort: commitSha.slice(0, 12),
    branch: env.RAILWAY_GIT_BRANCH || null,
    repo: env.RAILWAY_GIT_REPO_NAME || null,
    commitMessage: env.RAILWAY_GIT_COMMIT_MESSAGE || null,
    author: env.RAILWAY_GIT_AUTHOR || null,
    environment: env.RAILWAY_ENVIRONMENT_NAME || null,
    note: null
  };
}
