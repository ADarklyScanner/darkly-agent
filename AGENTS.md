# AGENTS.md — darkly-agent

Read this before changing anything in this repo. It exists because the
external planning document this project has been using (the "Darkly Agent —
Canonical Full System Plan," written from outside this codebase) turned out
to assume gaps that don't exist here and miss adapters that are already
built. This file is the correction, scoped to what actually lives in *this*
repo, kept current by whichever agent touches the repo next.

**What this file is not:** a restatement of what each module already says
about itself. Every file here carries its own header comment explaining its
own design and its own honesty caveats (performance.js and backtest.js in
particular — read those before trusting a number either one produces).
Read the module directly for that. This file covers what a module's own
header can't: how the pieces relate, what's already been decided across
them, what's real vs. assumed, and what's next.

---

## 1. Scope — what "darkly-agent" is and isn't

This repo is the Railway/Termux-hosted core: chat agent, AutoTrader, Driver
Scheduler, Lottery, the ReferralMarket *data layer*, phone/device intake,
research tools, and APK analysis utilities. One Node process, one deploy,
one persistent volume (`state.js`).

It is **not** the whole Darkly ecosystem. These live elsewhere and are out
of scope for edits from here:

| System | Where it actually lives | How to reach it from a session |
|---|---|---|
| Darkly AI Factory | Hatchable | `mcp__Hatchable__*` tools, connected to that project |
| Darkly Scanner | Hatchable | same |
| Darkly Sports Tracker | Hatchable | same |
| Driver Referral Marketplace | Hatchable | same |
| ClearTrace | ChatGPT Sites | not editable via any connector currently available — projections only |
| ReferralMarket customer-facing site | ChatGPT Sites | same — the *data* (leads, prospects, engine config) is real and lives in this repo via `sheets.js`; the public-facing site facade does not |
| An older Reno Driver Engine build | Replit | no raw source export available through any connected tool; only ZIP/APK snapshots exist, in the user's own library archive |

The four Hatchable projects each carry their own `AGENTS.md` already — this
file doesn't duplicate those. If work ever spans a Hatchable project and
this repo in the same session, treat them as two separate change sets with
two separate verification steps, not one.

---

## 2. Principles already load-bearing in this code

Extracted from patterns repeated across multiple modules' own header
comments — stated once here so new code doesn't have to independently
rediscover them, and so a future change doesn't quietly break one:

- **Fail closed.** `autotrader.js`, `universe.js`: anything unverifiable
  stops the action rather than proceeding on an assumption. A silent
  fallback that *looks* like it worked is worse than a visible failure.
- **Observable before trusted.** New automated behavior defaults to
  reporting what it *would* do; it gets promoted to actually acting only
  once the log is convincing, not before.
- **Numbers carry their own honesty.** `performance.js`, `backtest.js`:
  every summary statistic travels with its sample size and a plain-English
  caveat. Nothing here extrapolates or annualizes. A small sample's
  dominant explanation is luck, and the code says so rather than a human
  having to remember it.
- **No silent fallbacks.** `llm-provider.js`: a fallback provider gets the
  *same* system prompt and tool contract, never a thinner substitute
  wearing the costume of uptime. `universe.js`: a failed scan reports
  failure, never a stale fixed watchlist dressed up as a live one.
- **This process holds live credentials — no code-execution surface, ever.**
  `calc.js`, `toolkit.js`, `web-read.js`'s SSRF guard: this Node process
  holds live Alpaca trading keys, Gmail credentials, Supabase keys, and
  Railway-internal networking. A general code sandbox or an unguarded
  fetch is a direct path from "a web page said something" to "money
  moved" or "mail got sent." Declined deliberately, repeatedly, on the
  record in-file — not an oversight to eventually fix.
- **Apps stay separate — see §4.** `apps/registry.js`: cross-domain
  reasoning is limited to dated signals and explicit coincidence, never
  shared state, never one app scoring or acting on another's data.
- **Identity locks stay hard-coded for anything customer-facing.**
  `mailer.js`'s `REQUIRED_GMAIL` lock on ReferralMarket outreach is not a
  config value on purpose — a lead should never be emailable from the
  wrong identity because of a settings mistake.
- **Protected algorithm constants don't move silently.** `reno-engine.js`'s
  `FROZEN` sections (e.g. `BETA_S = 0.72`) ship with `ALGORITHM_VERSION`
  and `FORMULA_FINGERPRINT`. A real change to the formula gets a new
  version, not a quiet edit to the old one.
- **Safety gates require explicit authorization to lift, from the user,
  not as a side effect of unrelated work.** The AutoTrader kill switch,
  `PROSPECT_AUTO_SEND=FALSE` / DRAFT_ONLY outreach, and any currently-paused
  scheduled worker all stay exactly as they are unless the user says
  otherwise. "Paused" is a state, not a bug.

---

## 3. Verified module map (corrects the external Canonical Plan)

This repo is considerably further along than the external plan document
gave it credit for. Specifics, not just the seven listed there:

- **AutoTrader** — not just `trading.js` (Alpaca API + guardrails). Also:
  `autotrader.js` (the actual scheduling loop, kill switch, signal_only
  default), `risk.js` (position sizing by risk not dollars, portfolio
  heat cap, correlation/liquidity/market-regime filters), `strategy.js`
  (pure signal generation, explicitly labeled "not a profitable system"),
  `backtest.js` (no-lookahead replay of the *exact* production rules),
  `performance.js` (calibration with honest sample-size gating),
  `universe.js` (whole-tradable-market scanning, not a fixed watchlist),
  `audit.js` (git-commit + config fingerprint per run, for reproducibility),
  `alerts.js` (throttled failure/trade alerting via `mailer.js`). The
  plan's §6/§42 undersell this by a wide margin.
- **Driver Scheduler** — `reno-engine.js` (the algorithm, versioned and
  fingerprinted — corrects an earlier claim in this project's own chat
  history that no version/hash was exposed) plus `apps/driving.js`, a
  real, already-working adapter into the cross-app signal system. The
  plan's `existing_needs_adapter` tag is stale.
- **Lottery** — `apps/lottery.js` is a complete, real implementation
  (frequency/gap/pair/repeat stats, real pick generation, honest
  "descriptive, not predictive" framing), also already adapted via
  `apps/registry.js`. Also stale as `existing_needs_adapter`.
- **ReferralMarket (data layer)** — `sheets.js` already implements
  `readBusinessProspects`, `readConnectorCandidateUniverse`,
  `readActiveMarket`, `readAllLeads`, `updateLeadStatus`,
  `readEngineConfig` against the real Sheet; `leads-store.js` gives it a
  durable local mirror; `mailer.js` sends outreach under a hard identity
  lock. The plan's "partial access, separate app" framing is out of date
  — the gap isn't access, it's that outreach automation is deliberately
  paused (DRAFT_ONLY), which is policy, not a missing capability. No
  `apps/referralmarket.js` adapter exists yet — see §5.
- **Cross-app signals** — `apps/registry.js`, live in production,
  registered apps: `driving`, `lottery`. Deliberately narrow: separate
  domains, dated signals only, no shared state, no cross-app scoring or
  control, and an explicit in-code guardrail that co-occurrence is never
  presented as a reason to spend money. **This session's decision: this
  is the pattern to extend, not replace** — see §4.
- **Research/tool substrate** — `sources.js` (quality-tiered source
  catalog + weather/geocoding, already producing evidence records),
  `web-read.js` (SSRF-guarded page fetch), `web-search.js` (multi-provider
  with honest fallback labeling), `toolkit.js`, `calc.js`, `gemini.js`
  (labeled, contained, deliberately-unreliable brainstorming),
  `llm-provider.js`. Between them these already cover a good chunk of the
  plan's §33 Research Layer ambition.
- **The 960/71 Factory registry gap** (the external plan's §3) is already
  reconciled *in code*, independently of any external archive:
  `toolkit.js`'s own header comment works through the same 71-entry
  split this session verified against the archived
  `darkly_actual_tools_bundle.zip` — 22 portable utilities ported here
  (minus 2 already covered by `calc.js`/`web-read.js`), 10 APK tools that
  need an Android SDK this container doesn't have, 2 code-execution tools
  declined for the same reason as `calc.js`, 14 Factory-internal-state
  tools that don't apply, 23 HTTP wrappers collapsed into one generic
  bridge. Two independent reconciliations landed on the same numbers —
  treat that as settled, not something to re-derive.
- **Device/sensor intake** — `device.js` (allowlisted actions only, read
  vs. write effect tiers, confirmation enforced *on the device* not the
  server) and `sensors.js` (freshness-windowed, bounded storage, no
  off-device transmission). Already implements the spirit of the plan's
  §39 permission tiers, for the one surface that has it.
- **Chat durability** (`chat-store.js`) and **state persistence**
  (`state.js`, confirmed backed by a real Railway volume) are both
  already solved.
- **Unresolved, not assumed:** the Factory registry tags `darkly_master_context`
  as `existing`. No such module exists in this repo. Whether it lives in
  a Hatchable project, was never built, or the registry tag is itself
  stale hasn't been checked — don't assume any of the three.

---

## 4. The chosen direction: extend, don't replace

The external plan describes a much richer cross-module layer than what's
built: a Master Context service, a Shared Evidence Object schema, temporal
truth tracking, a 5-level cross-module write-permission model, an
Opportunity Stack correlating money/time/attention across every engine.
`apps/registry.js` already does a narrower version of part of that, on
purpose, with an explicit design rationale against the richer version
(mixing domains that share no causal mechanism produces "confident
nonsense").

**Decided this session: extend the current narrow pattern rather than
build toward the fuller vision.** Concretely, that means:

- More engines get a thin `apps/*.js` adapter exposing `signals()`,
  exactly like `apps/driving.js` and `apps/lottery.js` — not a richer
  `get_config`/`set_config`/`record_outcome` interface.
- No shared mutable state between apps. No app reads another's evidence.
  No app's output becomes another's input.
- Coincidence stays observational. `findCoincidences()`'s framing
  (never a recommendation, never a "therefore") is not to be loosened.
- If this later turns out to be too narrow for something specific, that's
  a new decision to make explicitly — not a default to drift into by
  adding "just one" cross-app read.

**Explicitly not being built right now** (so a future session doesn't
start on these by default): a Master Context service; a Shared Evidence
Object schema; the plan's 5-level cross-module permission model; the
Opportunity Stack beyond what signal coincidence already gives it. The
external plan remains a reasonable reference for *those* ideas if the
decision above ever gets revisited — just not the current direction.

---

## 5. Concrete next steps, in order

Each is sized to be one session's work: implement, test, commit, hand off
for push, deploy, verify live — the same loop already used successfully
in this repo's history.

1. **`apps/referralmarket.js`** — a `registerApp` adapter mirroring
   `apps/driving.js`'s shape exactly. Signals from what `sheets.js`
   already reads: e.g. a prospect follow-up due, a new connector
   candidate discovered. No new data access needed — this is purely
   wiring already-real data into the existing signal system. Definition
   of done: registered at startup next to `registerDrivingApp()` /
   `registerLotteryApp()`, covered by tests the way `apps/lottery.js` is,
   shows up in `listApps()`.
2. **Per-app health, surfaced through `/health`.** Right now `/health`
   reports only the AutoTrader heartbeat (confirmed by reading the
   handler — `autoTraderHeartbeat()` plus alerting-configured, nothing
   else). Add an optional `health()` function to the same app shape
   `signals()` already uses (`apps/registry.js`), let Driver/Lottery/
   ReferralMarket implement it where it's meaningful (e.g., is the Reno
   spec loaded, is the Sheet reachable, is drawanalytics.com reachable),
   and roll it into `/health`'s response. Still no cross-app state —
   each app reports only on itself.
3. **Sports, if and when it's worth pulling in here.** Sports Intelligence
   today lives entirely in the separate Hatchable `Darkly_Sports_Tracker`
   project. Before writing an adapter for it, decide whether darkly-agent
   should fetch from it directly (new client code, a real dependency on
   that service's uptime) or whether Sports stays a Hatchable-side
   concern with its own signals surfaced separately. This is a decision
   to make explicitly, not to default into — flagged here rather than
   started.
4. Anything beyond this gets planned when it's next, not speculatively
   now — a plan that predicts five phases ahead of verified ground is how
   the previous one drifted from the code.

---

## 6. Before starting any of the above

Say so and get an explicit go-ahead per item — this file is the plan, not
standing authorization to start executing it.
