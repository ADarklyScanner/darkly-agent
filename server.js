import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import {
  readAllLeads,
  readActiveMarket,
  readEngineConfig,
  readBusinessProspects,
  readConnectorCandidateUniverse,
  readBusinessCandidateUniverse,
  pickDailyQueue,
  updateLeadStatus,
  DAILY_LIMIT
} from "./sheets.js";
import {
  getAccount,
  getPositions,
  getOrders,
  placeOrder,
  cancelOrder,
  getMarketData,
  getQuote,
  getTradeLog,
  getBars,
  getAssetInfo,
  reconcileFills,
  tradeLogInfo,
  isLiveEndpoint,
  LIMITS as TRADING_LIMITS
} from "./trading.js";
import {
  runOnce as autoTradeRunOnce,
  startScheduler as startAutoTrader,
  getStatus as autoTraderStatus,
  getRuns as autoTraderRuns,
  getStops as autoTraderStops,
  getHistoryInfo as autoTraderHistoryInfo,
  getHeartbeat as autoTraderHeartbeat,
  getAlertStatus as autoTraderAlertStatus,
  getCurrentConfigDetails as autoTraderConfigDetails,
  setKillSwitch,
  CONFIG as AUTOTRADER_CONFIG
} from "./autotrader.js";
import { stateInfo } from "./state.js";
import { resolveExport } from "./history-export.js";
import {
  pairTrades,
  summarize,
  equityCurve,
  maxDrawdown,
  breakdown,
  confidenceCalibration,
  keyBySymbol,
  keyByRegime,
  keyByConfidenceBucket
} from "./performance.js";
import { backtest as runBacktest, runWindows as runBacktestWindows, BACKTEST_DEFAULTS } from "./backtest.js";
import { scheduleReno, nextOperationalBoundary, ALGORITHM_VERSION as RENO_VERSION } from "./reno-engine.js";
import { fetchPage } from "./web-read.js";
import { webSearch, searchStatus, availableProviders } from "./web-search.js";
import { evaluate as calcEvaluate, describe as calcDescribe } from "./calc.js";
import {
  base64Encode, base64Decode, sha256 as tkSha256, chunk as tkChunk, deduplicate as tkDedupe,
  parseDelimited, jsonPath as tkJsonPath, inferSchema as tkInferSchema, regexExtract as tkRegex,
  normalizeText as tkNormalize, compareText as tkCompare, analyzeSource as tkAnalyzeSource,
  analyzePrivacy as tkPrivacy, inspectOpenApi as tkOpenApi, readJsonApi as tkJsonApi,
  inspectNpmPackage as tkNpm, inspectGithubRepo as tkGithub, checkJavaScript as tkCheckJs
} from "./toolkit.js";
import { RISK_DEFAULTS } from "./risk.js";
import { isQuotaOrRateLimitError, fallbackConfigured, callFallbackModel } from "./llm-provider.js";
import { geminiConfigured, callGemini } from "./gemini.js";
import { getHistory as getPersistentHistory, saveHistory as savePersistentHistory, resetHistory as resetPersistentHistory } from "./chat-store.js";
import { loadLeads, saveLeads, migrateLegacyLeadsIfNeeded } from "./leads-store.js";

const PORT = process.env.PORT || 3000;

/* ------------------------------------------------------------------ *
 * Chat slots: one persistent main thread, four disposable side ones.
 *
 * "chat" is the single durable conversation (chat-store.js — survives a
 * restart/redeploy). "2" through "5" are deliberately NOT persisted: a
 * plain in-memory Map, gone the moment the process restarts. That's the
 * point — they're for quick brainstorming/theory-crafting that doesn't
 * deserve, or want, the weight of being remembered forever. Any session
 * id outside this fixed set of five falls back to "chat" rather than
 * silently creating an unbounded set of new sessions.
 * ------------------------------------------------------------------ */

const CHAT_SLOTS = ["chat", "2", "3", "4", "5"];
const EPHEMERAL_SLOTS = new Set(["2", "3", "4", "5"]);
const EPHEMERAL_MAX_MESSAGES = 40; // matches chat-store.js's cap on the persistent slot

const ephemeralSessions = new Map();

function resolveSlot(raw) {
  return CHAT_SLOTS.includes(raw) ? raw : "chat";
}

function historyForSlot(slot) {
  if (EPHEMERAL_SLOTS.has(slot)) {
    if (!ephemeralSessions.has(slot)) ephemeralSessions.set(slot, []);
    return ephemeralSessions.get(slot);
  }
  return getPersistentHistory("chat");
}

function saveHistoryForSlot(slot) {
  if (EPHEMERAL_SLOTS.has(slot)) {
    const h = ephemeralSessions.get(slot) || [];
    if (h.length > EPHEMERAL_MAX_MESSAGES) h.splice(0, h.length - EPHEMERAL_MAX_MESSAGES);
    return;
  }
  savePersistentHistory("chat");
}

function resetHistoryForSlot(slot) {
  if (EPHEMERAL_SLOTS.has(slot)) {
    ephemeralSessions.set(slot, []);
    return;
  }
  resetPersistentHistory("chat");
}

// One-time, one-way move off the old $HOME/darkly-leads.json path (wiped
// on every Railway restart/redeploy) onto the same durable /data-backed
// store everything else in this codebase already uses. A no-op on every
// run after the first real one — see leads-store.js.
{
  const migration = migrateLegacyLeadsIfNeeded();
  if (migration.migrated) {
    console.log(`[leads] migrated ${migration.count} lead(s) from ${migration.from} to the durable store (${migration.to}).`);
  }
}

function upsertLead(lead) {
  const leads = loadLeads();
  const idx = leads.findIndex(l => l.id === lead.id);
  if (idx >= 0) leads[idx] = lead; else leads.push(lead);
  saveLeads(leads);
}

function getLeadById(id) {
  return loadLeads().find(l => l.id === id);
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are Darkly Agent, the private operations assistant for Referral Market.

When the user pastes a connector lead row, process it fully:
1. Identify the lead and connector roles
2. Classify tier: GREEN / YELLOW / ORANGE / RED
3. Recommend: CHASE NOW / ASK PERMISSION FIRST / HOLD / DO NOT CHASE
4. Why it matters
5. What you verified vs inferred
6. Exact numbered steps
7. Complete copy/paste outreach email
8. Response scripts for common replies
9. Follow-up schedule with exact dates
10. Exact sheet log entry
11. One-line NEXT ACTION

At the very end output this exact block so the system can save the lead:
LEAD_DATA_JSON:{"id":"<channel_id>","name":"<lead_name>","market":"<market>","status":"New","tier":"<TIER>","contact":"<email_or_phone>","nextFollowUp":"<YYYY-MM-DD>","outreachEmail":{"subject":"<subject>","body":"<body>"},"log":[]}

Commands:
LIST LEADS - show all tracked leads by status
FOLLOW UP <id> - generate follow-up for that lead
LOG <id> <outcome> - acknowledge logging outcome

You have live tool access to the ReferralMarket master Google Sheet. Use those tools whenever the user asks about the sheet, markets, channels, leads, policy state, actionability, or current ReferralMarket data. Never claim you lack Sheet access when a relevant tool is available.

Engine Config is the authoritative source for ReferralMarket operating policy. Before giving operational advice about lifecycle, saturation, switching, discovery eligibility, outreach, drafts, sending, policy gates, Gmail, maintenance, thresholds, or market rotation, read the relevant Engine Config values with get_engine_config. Do not invent thresholds or rules. Do not treat descriptive market notes or Saturation State as overriding the canonical Discovery Phase. Never recommend promotional sending when PROSPECT_EMAIL_MODE is DRAFT_ONLY or PROSPECT_AUTO_SEND is FALSE.

Be direct, human, specific. No corporate padding.

CREATIVE BRAINSTORMING. brainstorm_wild_ideas calls a different, deliberately less reliable model, chosen specifically for divergent, sometimes-wrong output — that is the point of the tool, not a defect. Only reach for it when the user explicitly wants brainstorming, wild ideas, or something to react against, never for anything factual. When you relay its output, keep it visibly labeled as unverified brainstorm material from a different model — never edit it into your own voice as though you vouched for it, and never let anything it says migrate into a factual claim, a lead recommendation, or a trading decision elsewhere in the conversation.

--- TRADING MODULE ---

You also manage a stock portfolio through Alpaca. Tools: get_account, get_positions, get_orders, get_quote, get_market_data, place_order, cancel_order, get_trade_log, get_performance, run_backtest, get_asset_info.

DESCRIBE ONLY WHAT EXISTS. When asked how you decide, what you check, or what you can do, describe exactly the tools, filters and guardrails listed here — nothing more. Do not invent analysis that is not performed. There is still NO halted-stock detection, NO sector classification, NO earnings-calendar awareness, NO options or margin logic, NO short selling, and NO machine learning of any kind. The free-text rationale you pass with a manual order is stored for audit; nothing scores it. If asked about a capability that does not exist, say plainly that it does not exist rather than describing how it would work.

AUTOTRADER. There is a scheduled autotrader (autotrader.js). Read its real state with get_autotrader_status before describing it — never assume its mode or its settings. Modes: off, signal_only (full analysis, decisions recorded, NO orders placed — the default), and execute. There is a persistent kill switch that survives restarts.

What the autotrader actually does each run, in order: reconciles previous orders against the broker to learn what actually filled; verifies the market is open using the broker's clock; reads live account and position state; fetches daily bars for the watchlist, everything held, and the benchmark; scores each symbol; updates a trailing stop for every open position; decides exits; then decides entries.

Signal model: moving-average structure, RSI, MACD, trend slope and volume confirmation, weighted differently depending on whether ADX classifies the market as trending or ranging, with a confidence floor below which it holds regardless of score. In a ranging market an oversold reading is NOT treated as a buy when the moving-average structure is already broken — that rule exists specifically so it does not buy falling knives.

Entry filters run in this order for every candidate: (1) structural tradability with Alpaca (not a halt check — see below), (2) liquidity/price floor, (3) correlation against what's already held, (4) an ATR-based stop can be computed, (5) risk-based position sizing, (6) portfolio heat has room. A rejection at any stage is recorded with which stage rejected it.

Risk controls, all enforced in code (risk.js): positions are sized so that being stopped out costs a fixed fraction of equity, which means position size follows from stop distance rather than being a fixed dollar amount; stops are set from ATR so they scale with each instrument's own volatility; stops trail upward with price and never loosen; total portfolio heat is capped, and positions with no known stop are counted at FULL value when measuring it; candidates too correlated with something already held are rejected as the same bet rather than diversification; illiquid and sub-minimum-price names are rejected on average dollar volume; and no new long is opened while the benchmark is below its long moving average, though exits always continue to run.

Be accurate about what all this is. The risk controls are real and are the part most likely to matter. The signal model is conventional public-domain indicators on public data: no proven edge, no proprietary data, no live track record. Better risk management improves survival and consistency; it does not create predictive power, and you never imply it does.

PERFORMANCE. Use get_performance for any question about how the LIVE trading is actually going. Never estimate from the trade log yourself. Every figure it returns carries a sample size and a reliability flag, and below 30 closed trades results are indistinguishable from luck — when you report a number from it, report that caveat in the same breath. If it returns zero closed trades, say exactly that: zero closed trades is not a zero result, it means nothing has completed a round-trip yet. Never annualize, extrapolate or project.

BACKTESTING. Use run_backtest for any question about how the strategy WOULD HAVE done historically, or before recommending any change to the strategy or its parameters. It replays the exact same code (strategy.js + risk.js) against historical daily bars, filling decisions only at the next bar's open (no lookahead), and returns a scored report plus an 'honesty' field you must read and weigh in with — a backtest is a description of one historical sample, not a predictor, and a strategy that never beat simple buy-and-hold on its own benchmark is not a strategy worth trading. Always report the benchmark comparison ('beatBuyAndHold') alongside any return number — a strategy that made money but underperformed just holding the index has not demonstrated anything the market didn't hand out for free. Below the reliability floor, say so, same as get_performance. The report's 'sharpe' field is a risk-adjusted return computed ONLY from this backtest's own day-by-day equity — this is the one place annualizing is honest, because a backtest has an actual, complete daily calendar behind it, unlike the live trade log's sparse, irregular fills; still report it as a property of this one historical replay, never as a forecast, and lean on its own 'reliable'/'caveat' fields exactly as you would performance's. Use the 'windows' option when someone wants to know if a result holds up outside one period, and report a mixed or negative result exactly as plainly as a positive one — this tool exists to find out whether the strategy is worth running, not to justify running it.

RESEARCH. You have three tools for finding things out: web_search (live search), read_web_page (fetch and read any public page, no API key needed), and calculate (exact arithmetic). Use them rather than answering from memory whenever the answer depends on the present — events, weather, closures, prices, whether something still exists, anything with a date on it. Your training data is old and this agent runs for months at a time; "I think X is happening" is not good enough when you can go and look.

How to research well here: search to find candidate sources, then READ them. A search snippet is not a source — it is a claim that a page might contain something. Never state a specific date, time, number, or fact from a snippet alone; open the page first. Prefer official and primary sources over aggregators: a venue's own calendar beats a listings site, the National Weather Service beats a weather blog, a city or DOT page beats a news summary of it. When sources disagree, say so rather than silently picking one. When you cannot find something, say you could not find it — do not fill the gap with a plausible guess, and do not present an absence of evidence as evidence of absence.

If web_search reports that no provider is configured, tell the user plainly and name the variable that would fix it, then carry on with read_web_page if you already know a relevant URL. Do not pretend to have searched.

Use calculate for any arithmetic that matters. Doing it in your head is how a wrong number reaches the user looking exactly as confident as a right one.

DATA AND CODE UTILITIES. parse_data turns messy input into structure (CSV/TSV with proper quoted-field handling, JSON path lookups, schema inference, regex extraction). transform_text normalizes, compares two versions, deduplicates, chunks, base64s and hashes. inspect_code checks JavaScript syntax without running it, scans source for risky constructs, scans text or objects for personal data and credentials, and reads OpenAPI documents. inspect_package looks up real npm and GitHub metadata. fetch_json_api calls JSON endpoints, with headers when an API needs a key.

Use these instead of doing the work by eye. Reading a CSV by eye misparses any row with a comma inside a quoted field; eyeballing whether two configs differ misses the one line that changed. Two honesty rules: the risk scan is a pattern match, not a security audit, so never report "no findings" as "this code is safe"; and the privacy scan deliberately masks what it finds, so do not try to reconstruct or repeat a detected credential back to the user — tell them what kind of thing was found and where.

RENO DRIVER SCHEDULING. run_reno_schedule runs the user's own Reno Uber Opportunity-Ranking and Shift-Optimization Engine (RENO_UBER_V1_CANONICAL_2026_09_02), ported verbatim from their saved specification. Call it for "start the Uber schedule", "start Uber's schedule", "when should I drive", "best hours to drive this week", and close equivalents. What it does: ranks all 168 one-hour periods of the coming Reno operational week (days run 4AM->4AM Reno local) by DRIVER OPPORTUNITY — demand minus competing-driver supply, plus trip quality, throughput and destination continuity, minus traffic/queue/deadhead friction — then returns six jointly-optimized non-overlapping 8-hour blocks, two recommended days off, and any one-off hours scoring 81.6+.

Researching a week for it: the engine's evidence records map directly onto what you can go and find. Check the venue and university calendars, the casino and events listings, and Visit Reno Tahoe for event_demand and event_quality; the National Weather Service for weather and safety_suppression; Nevada 511/NDOT for traffic and closures; RNO for airport and flight_activity; RTC and event pages for transit, shuttle, free_parking and parking_scarcity. Set each record's sourceType honestly — official (1.00) for a government, airport, DOT or venue's own page, organizer (0.95), ticketing (0.88), local_news (0.85), secondary (0.75), aggregator (0.55), social (0.30) — because that number becomes the record's weight, and inflating it is indistinguishable from making the evidence up. Give every record a real start/end window covering the hours it actually applies to; an event at 8 PM Saturday is evidence about Saturday evening, not about the week. And search deliberately for NEGATIVE evidence too — free parking, free shuttles, park-and-ride, weak ticket sales, a cancellation, obvious driver oversupply — because the engine is specifically built so those can overturn a demand-positive story, and a research pass that only looks for reasons an hour is good will systematically mislead it.

The engine is evidence-first but does NOT gather evidence itself, and this is the single most important thing to get right when using it. With no evidence it returns a pure baseline ranking from the frozen hour/day tables: a real, useful answer about normal Reno patterns, but one that knows nothing about this week's actual concerts, weather, flights, or road closures. If you have genuinely researched the forecast week, pass what you found as evidence records with real sources and time windows so it actually moves the numbers. NEVER invent evidence to make the output look better-informed — a fabricated event or weather value silently corrupts the entire ranking, and the engine is explicitly designed to treat missing evidence as neutral rather than to guess. Always tell the user which case they got: baseline-only, or evidence-backed and from what sources.

Each ranked hour also carries a confidence label, a platform recommendation, and an expected hourly figure, and each has its own honesty rule. Confidence is deliberately SEPARATE from score: a top-scoring hour backed by nothing but the baseline tables is "Low" confidence and you should say so rather than letting a high score imply certainty. The platform line defaults to "Uber primary — Lyft fallback" and only changes with real Lyft history; do not present it as a live comparison of the two apps unless the user has actually supplied Lyft data. The expected $/hr is a downstream calibration of the relative score against a neutral-week level ($38/hr Uber baseline) — it is NOT a prediction of what the user will earn that hour, and must never be reported as one. The coverage field (STRONG/PARTIAL/LIMITED/DEGRADED) says how much of the week was genuinely backed by sources; DEGRADED means baseline only.

Honesty rules for its output: the 0-100 score is a RELATIVE opportunity score for that specific week (50 is roughly the week's center) — it is not dollars per hour, not a probability of getting a ride, not a surge forecast, and not a guarantee. A top-ranked hour can still underperform. The engine deliberately does NOT treat rush hour as a commute bonus and does NOT treat big events as automatically good (driver oversupply, staging, shuttles, free parking and gridlocked pickups can make a busy-looking hour a bad one) — if the user is surprised by a ranking, explain the actual factor that moved it rather than softening the result. The driving-time and rest checks are a conservative scheduling guardrail approximating Nevada/Uber limits, NOT certified legal compliance: say so whenever compliance affects a block, and never tell the user a schedule is legal — tell them to verify against their real counters.

Price sources, and the difference matters:
- get_quote is Alpaca's LIVE price feed and covers any symbol. It is authoritative.
- get_market_data is a stored snapshot of the tracked universe and is currently weeks stale. Never price, size, or justify a trade from it. When you cite it, state its dataAsOf date.
- get_account, get_positions and get_orders are live from the broker.

Rules for trading:
- Always read live state (get_account / get_positions) before advising or acting. Never reason from remembered numbers.
- Get a live quote before proposing or sizing any trade.
- Before placing an order, state the reasoning: what the position is, why now, what the risk is. Pass that reasoning in the order's rationale field so it is recorded.
- Five account-level guardrails are enforced in code on EVERY buy order, manual or automated: max trades per day, cooldown between trades, max daily loss, max position size (an order whose dollar value cannot be determined is blocked outright rather than allowed through uncapped), and asset tradability (a buy in a symbol Alpaca reports as inactive/untradable is blocked; a lookup failure blocks too, rather than assuming the name is fine). Sells are exempt from the tradability check specifically so an existing position can always be exited even in a name Alpaca has since disabled. Alpaca also independently blocks trading on a restricted account. If an order is blocked, report exactly what blocked it and do not work around it by splitting the order, retrying, or restructuring it to slip under a limit.
- Use get_asset_info if the user asks whether a specific symbol can be traded on Alpaca. Be precise about what it checks: structural tradability (delisted, inactive, unsupported) — it does NOT detect an in-progress intraday trading halt, which needs real-time trade data this account tier does not have. Never call an untradable result a "halt" or a tradable result "not halted" — say only what was actually checked.
- The risk filters in risk.js — sizing, heat, correlation, liquidity, market regime — apply to AUTOTRADER entries. They do not automatically gate an order you place by hand at the user's request. Say so if it matters to the answer; do not imply a manual order was vetted by checks that did not run on it.
- Sizing: never propose a position that would exceed the configured max position size. If the user's per-position cap is small relative to their equity, that cap — not the risk model — is what determines size, and you say so plainly rather than describing sizing as risk-based when it is actually cap-bound.
- Describe outcomes in terms of probability and risk, never certainty. Do not promise, imply, or project guaranteed returns, profit, or "can't lose" setups. Past performance and backtests do not predict future results, and you say so when it matters.
- You are not a licensed financial advisor. For anything touching taxes, retirement accounts, or large real-money decisions, say that plainly.
- Know which mode you are in. PAPER is simulated money. LIVE is real. If the account reports LIVE, say so explicitly in any message where you propose or place an order.`;

const CLAUDE_TOOLS = [
  {
    name: "get_active_market",
    description: "Read the current active ReferralMarket market directly from the live master Google Sheet.",
    input_schema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: "get_engine_config",
    description: "Read authoritative ReferralMarket runtime policy directly from the live Engine Config tab. Use this before making claims about discovery lifecycle, switching, outreach permissions, Gmail behavior, policy gates, thresholds, saturation, drafts, sending, maintenance, or other engine rules.",
    input_schema: {
      type: "object",
      properties: {
        keys: {
          type: "array",
          items: { type: "string" },
          description: "Optional Engine Config parameter names to retrieve. Omit to read the full current configuration."
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "search_channels",
    description: "Search ReferralMarket's canonical Channels rows in the live master Google Sheet. Use this for questions about connector channels, markets, policy states, actionability, scores, referral-system matches, or specific leads.",
    input_schema: {
      type: "object",
      properties: {
        market: {
          type: "string",
          description: "Optional market name or partial market name."
        },
        query: {
          type: "string",
          description: "Optional text to match anywhere in a channel row."
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description: "Maximum rows to return. Default 25."
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "get_account",
    description: "Read the live Alpaca trading account: equity, cash, buying power, day P&L, and whether the account is in PAPER or LIVE mode. Call this before advising on or placing any trade.",
    input_schema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: "get_positions",
    description: "Read all currently open positions in the Alpaca account, with entry price, current price, market value and unrealized P&L.",
    input_schema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: "get_orders",
    description: "Read recent orders from the Alpaca account, including status and fill information.",
    input_schema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["open", "closed", "all"],
          description: "Which orders to return. Default 'all'."
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description: "Maximum orders to return. Default 25."
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "get_quote",
    description: "Get LIVE prices from Alpaca for any symbol, including symbols not in the AutoTradeFlux universe. Returns last trade price, day open/high/low/volume, previous close and change. This is the authoritative price source — use it for anything current, and always before sizing or proposing a trade.",
    input_schema: {
      type: "object",
      properties: {
        symbols: {
          type: "array",
          items: { type: "string" },
          description: "Ticker symbols to quote, e.g. ['AAPL','NVDA']."
        }
      },
      required: ["symbols"],
      additionalProperties: false
    }
  },
  {
    name: "get_market_data",
    description: "Read the AutoTradeFlux market table: a stored HISTORICAL SNAPSHOT of the tracked universe (price, prev close, day high/low, volume, market cap, sector), plus price history when symbols are given. Returns every row by default. This table is not a live feed and is currently stale — the response carries dataAsOf, ageHours and a stale flag. Use it for universe/sector/history questions; use get_quote for current prices.",
    input_schema: {
      type: "object",
      properties: {
        symbols: {
          type: "array",
          items: { type: "string" },
          description: "Optional ticker symbols. Omit to return the entire tracked universe. Supplying symbols also returns their price history."
        },
        limit: {
          type: "integer",
          minimum: 1,
          description: "Optional cap on rows returned. Omit to return everything."
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "place_order",
    description: "Submit an order to Alpaca. Guardrails (daily trade count, cooldown, max position size, daily loss ceiling) are enforced before submission; a blocked order returns the reasons and places nothing. Always supply a rationale.",
    input_schema: {
      type: "object",
      properties: {
        symbol: {
          type: "string",
          description: "Ticker symbol, e.g. 'AAPL'."
        },
        side: {
          type: "string",
          enum: ["buy", "sell"],
          description: "Order side."
        },
        type: {
          type: "string",
          enum: ["market", "limit", "stop", "stop_limit"],
          description: "Order type. Default 'market'."
        },
        qty: {
          type: "number",
          description: "Number of shares. Supply either qty or notional, not both."
        },
        notional: {
          type: "number",
          description: "Dollar amount to trade. Supply either qty or notional, not both."
        },
        limitPrice: {
          type: "number",
          description: "Required for limit and stop_limit orders."
        },
        stopPrice: {
          type: "number",
          description: "Required for stop and stop_limit orders."
        },
        timeInForce: {
          type: "string",
          enum: ["day", "gtc", "ioc", "fok"],
          description: "Time in force. Default 'day'."
        },
        rationale: {
          type: "string",
          description: "Why this trade is being placed. Recorded with the order for later review."
        }
      },
      required: ["symbol", "side"],
      additionalProperties: false
    }
  },
  {
    name: "cancel_order",
    description: "Cancel a still-open Alpaca order by its order ID.",
    input_schema: {
      type: "object",
      properties: {
        orderId: {
          type: "string",
          description: "The Alpaca order ID to cancel."
        }
      },
      required: ["orderId"],
      additionalProperties: false
    }
  },
  {
    name: "get_autotrader_status",
    description: "Read the autotrader's current configuration and state: mode (off / signal_only / execute), whether the scheduler is running, its interval, universe, sizing, stop-loss and take-profit settings, the kill switch, and when it last ran.",
    input_schema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: "get_autotrader_runs",
    description: "Read the autotrader's run history: for each run, the signals it computed, the decisions it reached, its reasons, whether it executed or was in signal_only mode, and anything that blocked it. This is the record to judge the strategy by.",
    input_schema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          description: "How many recent runs to return. Default 5."
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "run_autotrader_now",
    description: "Run one autotrader cycle immediately instead of waiting for the schedule. Honours the configured mode, so in signal_only it analyses and records without placing orders. Use force to analyse while the market is closed (it still will not trade outside hours unless the mode is execute and the market is open).",
    input_schema: {
      type: "object",
      properties: {
        force: {
          type: "boolean",
          description: "Run even if the market is closed or the mode is off. Useful for inspecting what it would decide."
        },
        mode: {
          type: "string",
          enum: ["signal_only", "execute"],
          description: "Override the configured mode for this single run. Omit to use the configured mode."
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "set_autotrader_kill_switch",
    description: "Engage or disengage the autotrader kill switch. While engaged, no scheduled or manual run will place any order. It persists across restarts.",
    input_schema: {
      type: "object",
      properties: {
        engaged: {
          type: "boolean",
          description: "true halts all autotrading; false resumes it."
        },
        reason: {
          type: "string",
          description: "Why it is being engaged, recorded with the switch."
        }
      },
      required: ["engaged"],
      additionalProperties: false
    }
  },
  {
    name: "get_trade_log",
    description: "Read this agent's own record of orders it submitted or had blocked, including the rationale given at the time and any guardrail that stopped it.",
    input_schema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description: "Maximum entries to return. Default 25."
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "get_performance",
    description:
      "Score the system's own closed trades: win rate, expectancy, profit factor, average R, max drawdown, and breakdowns by symbol, market regime and stated confidence. Every figure carries a sample size and a reliability flag — below 30 closed trades the results are noise and the tool says so. Use this for any question about how well the trading is going. Returns zero trades, honestly, when nothing has closed yet.",
    input_schema: {
      type: "object",
      properties: {
        reconcile: {
          type: "boolean",
          description:
            "Ask the broker what submitted orders actually filled at before scoring. Default true. Without it, recent trades may be missing their fills and be excluded."
        },
        groupBy: {
          type: "string",
          enum: ["symbol", "regime", "confidence"],
          description: "Optional breakdown dimension."
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "run_backtest",
    description:
      "Replay the exact strategy and risk rules (strategy.js + risk.js, the same code the live autotrader runs) against historical daily bars. This is a simulation, not a prediction — read the returned 'honesty' field before saying anything about the result. No lookahead: decisions made from a day's close are only ever filled at the next day's open. Fetches its own historical bars; costs one or more real market-data calls, so don't call this on every message, only when the user is actually asking about backtested or historical strategy performance. Pass `windows` to run the identical unmodified rules across several independent date ranges instead of one (closer to genuine out-of-sample checking than a single period).",
    input_schema: {
      type: "object",
      properties: {
        universe: {
          type: "array",
          items: { type: "string" },
          description: "Symbols to trade in the simulation. Defaults to the autotrader's configured watchlist."
        },
        lookbackTradingDays: {
          type: "integer",
          minimum: 260,
          maximum: 1500,
          description: "How many trading days of history to fetch before slicing into the warmup + test period. Default 500 (~2 years). More costs more data calls and a longer warmup eats into the usable test period."
        },
        aggressiveness: {
          type: "string",
          enum: ["conservative", "moderate", "aggressive"],
          description: "Defaults to the autotrader's currently configured aggressiveness."
        },
        startingEquity: {
          type: "number",
          description: "Simulated starting cash. Default 100000. Purely a scaling factor for dollar figures — percentages are unaffected."
        },
        windows: {
          type: "array",
          items: {
            type: "object",
            properties: {
              label: { type: "string" },
              start: { type: "string", description: "YYYY-MM-DD" },
              end: { type: "string", description: "YYYY-MM-DD" }
            },
            required: ["label", "start", "end"]
          },
          description: "Optional: run the same rules across several disjoint date ranges (e.g. different years) instead of one continuous backtest, and compare them."
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "get_asset_info",
    description: "Check whether a symbol is structurally tradable on Alpaca (not delisted, not disabled). This is NOT live halt detection — it cannot see an in-progress intraday trading halt, only whether Alpaca supports trading the name at all.",
    input_schema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Ticker symbol, e.g. AAPL." }
      },
      required: ["symbol"],
      additionalProperties: false
    }
  },
  {
    name: "brainstorm_wild_ideas",
    description:
      "Get raw, UNVERIFIED idea generation from a different model (Gemini), used deliberately for its high rate of confident wrongness — that unreliability is what makes it a useful divergent-thinking tool, not a bug to route around. ONLY call this when the user explicitly wants brainstorming, wild ideas, alternate angles, or something to react against creatively. NEVER call it for anything where correctness matters: no research questions, no facts, no financial or trading reasoning, no ReferralMarket operations. Its output must always be relayed clearly labeled as unverified Gemini brainstorm material — never blended into your own answer as if you or it verified it.",
    input_schema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "What to brainstorm about. Be specific about the kind of ideas wanted (e.g. 'wild, unconventional' vs 'practical but unusual')."
        }
      },
      required: ["prompt"],
      additionalProperties: false
    }
  },
  {
    name: "run_reno_schedule",
    description:
      "Run the Reno Uber Opportunity-Ranking and Shift-Optimization Engine (algorithm version " +
      "RENO_UBER_V1_CANONICAL_2026_09_02). Ranks all 168 one-hour periods of the coming Reno operational " +
      "week (days run 4AM->4AM Reno local) by DRIVER OPPORTUNITY — not raw rider demand — then returns six " +
      "jointly-optimized non-overlapping 8-hour driving blocks (extendable to 9-10h when an adjacent hour is " +
      "independently strong), the two weakest days as recommended days off, and any exceptional one-off hours " +
      "scoring 81.6+. Call this for 'start the Uber schedule', 'start Uber's schedule', 'when should I drive', " +
      "'best hours to drive', and close equivalents. " +
      "EVIDENCE: the engine is evidence-first but does NOT fetch evidence itself. With no evidence it returns a " +
      "pure baseline ranking from the frozen hour/day demand and supply tables — still useful, but it knows " +
      "nothing about this specific week's events, weather, flights, or road closures. If you have researched " +
      "real, sourced facts about the forecast week, pass them as evidence records so they actually move the " +
      "numbers. Never invent evidence: a fabricated event or weather value silently corrupts the ranking, and " +
      "missing evidence is treated as neutral by design. " +
      "HONESTY: the 0-100 score is a RELATIVE weekly opportunity score, not dollars/hour, not a probability, " +
      "and not a guarantee. Say so rather than implying predicted earnings.",
    input_schema: {
      type: "object",
      properties: {
        evidence: {
          type: "array",
          description:
            "Researched evidence records for specific hours. Each must be traceable to a real source. Omit entirely if you have not researched this week.",
          items: {
            type: "object",
            properties: {
              family: {
                type: "string",
                description:
                  "Signal family. One of: calendar, event_demand, event_quality, driver_supply, driver_camping, staging, airport, flight_activity, airport_queue, tourism, hotel_pressure, tahoe, regional_spillover, weather, safety_suppression, traffic, transit, shuttle, parking_scarcity, free_parking, pickup_friction, access_friction, nightlife, casino, university, school_activity, fare_quality, trip_quality, tip_quality, wait_time, deadhead, short_trip_density, long_trip_risk, trip_throughput, geography, destination_continuity, interaction_demand, interaction_quality, interaction_friction."
              },
              label: { type: "string", description: "Short human label, e.g. 'Lawlor Events Center concert'." },
              value: {
                type: "number",
                description:
                  "Strength, -2 to +2, clamped. Positive means more of that thing (more demand, more supply, more friction). Use modest values (0.3-1.0) unless the evidence is strong and specific."
              },
              confidence: { type: "number", description: "0-1. Omit to derive it from sourceType instead." },
              sourceType: {
                type: "string",
                description:
                  "official (1.00) | organizer (0.95) | ticketing (0.88) | local_news (0.85) | secondary (0.75) | manual (0.80) | aggregator (0.55) | social (0.30) | unspecified (0.70)"
              },
              source: { type: "string", description: "Where this came from — a URL or publication name." },
              note: { type: "string", description: "Very short reason text, surfaced in the hour's Primary Reasons." },
              start: { type: "string", description: "ISO timestamp the evidence starts applying (inclusive)." },
              end: { type: "string", description: "ISO timestamp the evidence stops applying (exclusive)." },
              fullWeek: {
                type: "boolean",
                description:
                  "Set true ONLY for genuinely week-wide evidence with no start/end. Without a window or this flag, the record is deliberately ignored so it cannot contaminate all 168 hours."
              }
            },
            required: ["family", "label", "value"],
            additionalProperties: false
          }
        },
        weekStart: {
          type: "string",
          description:
            "ISO timestamp of the operational week start. Omit to use the next upcoming Reno 4:00 AM boundary, which is the default behavior."
        },
        learnedUberTph: {
          type: "number",
          description: "The driver's learned actual trips/hour, if known. Defaults to 3.0."
        },
        quest: {
          type: "object",
          description: "Exact Uber quest details, if the user supplied them. Never infer a payout from weekly earnings.",
          properties: {
            target: { type: "number", description: "Trips required." },
            current: { type: "number", description: "Trips completed so far." },
            payout: { type: "number", description: "Dollar payout on completion." },
            deadlineHourIndex: { type: "number", description: "Hour index 0-167 within the forecast week when the quest expires." }
          },
          required: ["target", "current", "payout", "deadlineHourIndex"],
          additionalProperties: false
        },
        topHours: {
          type: "number",
          description: "How many of the 168 ranked hours to return in full detail. Defaults to 24. The full ranking is always available in the Driver tab of the console."
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "web_search",
    description:
      "Search the live web. Use this whenever a question depends on what is true right now rather than on what you already know: upcoming events, current weather, road closures, news, prices, whether a business still exists, or anything dated. " +
      "Returns real ranked results with URLs. IMPORTANT: search results are snippets, not sources — read the actual page with read_web_page before relying on any specific fact, number, date or claim. " +
      "If this deployment has no search provider configured the result says so plainly, including which environment variable would enable it; relay that to the user instead of guessing at an answer. " +
      "One provider (Gemini grounding) returns a model-written summary rather than retrieved results; when that happens the result is clearly marked kind:'model_summarized' and carries a caveat — treat its summary as leads to verify, never as a source to cite.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query. Be specific; include place names and dates where they matter." },
        count: { type: "number", description: "How many results to return (1-20, default 8)." },
        provider: {
          type: "string",
          description: "Force a specific provider: brave, tavily, serper, google_cse, or gemini. Omit to use the best configured one."
        }
      },
      required: ["query"],
      additionalProperties: false
    }
  },
  {
    name: "read_web_page",
    description:
      "Fetch a public web page and read its actual contents as text. This needs no API key and works even when web_search is unavailable, as long as you know the URL. " +
      "Use it to verify anything a search snippet claimed, to read an events calendar, a weather forecast page, an official announcement, or a docs page. " +
      "Automatically extracts schema.org event data when a page publishes it (venues, universities and tourism sites usually do), which is far more reliable than reading event times out of prose. " +
      "Only public internet addresses can be fetched: private networks, localhost and cloud-metadata addresses are refused by design, and that refusal is not a bug to work around.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute http(s) URL of the page to read." },
        maxChars: { type: "number", description: "Cap on returned characters (default and maximum 60000)." },
        includeLinks: { type: "boolean", description: "Also return the page's outbound links — useful for finding an events subpage." }
      },
      required: ["url"],
      additionalProperties: false
    }
  },
  {
    name: "calculate",
    description:
      "Evaluate arithmetic exactly, or summarize a list of numbers. Use this for ANY non-trivial number work — earnings per hour, percentage changes, position sizing, averaging a series — rather than computing in your head, where small errors are easy and invisible. " +
      "Supports + - * / % ^, parentheses, and functions like sqrt, ln, log, min, max, sum, avg, round, abs, pow, hypot. " +
      "Supply `values` instead of `expression` to get count, sum, mean, median, min, max, quartiles and both sample and population standard deviation. " +
      "This is a calculator, not a code sandbox: it evaluates mathematical expressions only and cannot run code, read files, or reach the network.",
    input_schema: {
      type: "object",
      properties: {
        expression: { type: "string", description: "A mathematical expression, e.g. '(1143.93 - 259) / 22.75'." },
        values: {
          type: "array",
          items: { type: "number" },
          description: "A list of numbers to summarize statistically. Use instead of `expression`."
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "parse_data",
    description:
      "Turn messy text into structured data. Handles CSV/TSV (quoted fields, embedded commas and newlines, doubled quotes), JSON path lookups, JSON schema inference, and regex extraction. " +
      "Use `csv` for spreadsheet exports or pasted tables, `json_path` to pull one value out of a large API response, `json_schema` to understand the shape of an unfamiliar payload, and `regex` to pull repeated patterns out of prose or scraped page text.",
    input_schema: {
      type: "object",
      properties: {
        mode: { type: "string", description: "One of: csv, json_path, json_schema, regex." },
        text: { type: "string", description: "Input text for csv and regex modes." },
        data: { description: "Input data (object or JSON string) for json_path and json_schema modes." },
        path: { type: "string", description: "json_path mode: a dotted/bracket path like 'user.tags[0]' or '$.count'." },
        pattern: { type: "string", description: "regex mode: the pattern. Nested quantifiers like (a+)+ are refused as unsafe." },
        flags: { type: "string", description: "regex mode: flags; g is always applied." },
        limit: { type: "number", description: "regex mode: max matches (default 100)." },
        delimiter: { type: "string", description: "csv mode: force a delimiter. Omit to auto-detect." },
        headers: { type: "boolean", description: "csv mode: treat the first row as headers (default true)." }
      },
      required: ["mode"],
      additionalProperties: false
    }
  },
  {
    name: "transform_text",
    description:
      "Text utilities: normalize (unicode form, whitespace, case, punctuation), compare two versions to see what changed, deduplicate a list, split text or a list into chunks, base64 encode/decode, or SHA-256 hash. " +
      "compare is useful for 'did this page or config change since last time', and dedupe for cleaning up lead or result lists.",
    input_schema: {
      type: "object",
      properties: {
        mode: { type: "string", description: "One of: normalize, compare, dedupe, chunk, base64_encode, base64_decode, sha256." },
        text: { type: "string", description: "Input text for normalize, chunk, base64_encode, sha256." },
        before: { type: "string", description: "compare mode: the earlier version." },
        after: { type: "string", description: "compare mode: the later version." },
        items: { type: "array", description: "dedupe mode: the list to deduplicate." },
        key: { type: "string", description: "dedupe mode: dedupe objects by this field instead of whole-value identity." },
        data: { description: "chunk mode: a string or array. base64_decode mode: the base64 string." },
        size: { type: "number", description: "chunk mode: chunk size." },
        overlap: { type: "number", description: "chunk mode: overlap between chunks; must be smaller than size." },
        lower: { type: "boolean", description: "normalize mode: lowercase the result." },
        stripPunctuation: { type: "boolean", description: "normalize mode: replace punctuation with spaces." },
        form: { type: "string", description: "normalize mode: unicode form NFC/NFD/NFKC/NFKD (default NFC)." }
      },
      required: ["mode"],
      additionalProperties: false
    }
  },
  {
    name: "inspect_code",
    description:
      "Static inspection of code and payloads. `syntax` runs a parse-only check on JavaScript (it does NOT execute it). `risks` scans source for well-known dangerous constructs — eval, child_process, disabled TLS verification, hardcoded credentials, innerHTML, SQL string concatenation. `privacy` scans text or an object for things that look like personal data or credentials, reporting matches masked rather than echoing them. `openapi` enumerates an OpenAPI document's operations, parameters and security schemes. " +
      "None of these execute anything, and `risks` is a pattern scan rather than a security audit — report it that way.",
    input_schema: {
      type: "object",
      properties: {
        mode: { type: "string", description: "One of: syntax, risks, privacy, openapi." },
        code: { type: "string", description: "Source code for syntax and risks modes." },
        module: { type: "boolean", description: "syntax mode: treat as an ES module (default true) or CommonJS." },
        language: { type: "string", description: "risks mode: language label, for the report." },
        text: { type: "string", description: "privacy mode: text to scan." },
        data: { description: "privacy mode: an object whose keys should be scanned. openapi mode: the document." }
      },
      required: ["mode"],
      additionalProperties: false
    }
  },
  {
    name: "inspect_package",
    description:
      "Look up metadata about a software package or repository: `npm` reads the public npm registry (latest version, license, dependencies, last publish, deprecation), `github` reads a public GitHub repo (stars, language, license, default branch, last push, archived status). " +
      "Use this before recommending or adopting a dependency, rather than relying on what you remember about it.",
    input_schema: {
      type: "object",
      properties: {
        source: { type: "string", description: "Either 'npm' or 'github'." },
        name: { type: "string", description: "npm: the package name, e.g. 'nodemailer' or '@scope/pkg'." },
        repo: { type: "string", description: "github: 'owner/name', e.g. 'ADarklyScanner/darkly-agent'." }
      },
      required: ["source"],
      additionalProperties: false
    }
  },
  {
    name: "fetch_json_api",
    description:
      "Fetch a URL and parse the response as JSON, with optional request headers (for APIs that need a key). Use this for machine-readable endpoints — a weather API, a flight feed, an events JSON endpoint — where read_web_page's text extraction would be the wrong shape. " +
      "Only public internet addresses are reachable; private, internal and cloud-metadata addresses are refused by design, and that refusal still applies when headers are supplied.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute http(s) URL returning JSON." },
        headers: { type: "object", description: "Optional request headers, e.g. an API key header." },
        timeoutMs: { type: "number", description: "Timeout in milliseconds (1000-60000, default 15000)." }
      },
      required: ["url"],
      additionalProperties: false
    }
  }
];

async function executeClaudeTool(name, input = {}) {
  if (name === "get_active_market") {
    try {
      return await readActiveMarket();
    } catch (e) {
      return {
        activeMarket: null,
        status: "NO_MARKET_LOCK",
        message: "No single active market is currently required. Search and analysis may continue across the live databases."
      };
    }
  }

  if (name === "get_engine_config") {
    return await readEngineConfig(input.keys || []);
  }


  if (name === "search_channels") {
    const all = await readAllLeads();

    const market = String(input.market || "").trim().toLowerCase();
    const query = String(input.query || "").trim().toLowerCase();
    const limit = Math.min(Math.max(Number(input.limit) || 25, 1), 100);

    let rows = all;

    if (market) {
      rows = rows.filter(row =>
        String(row.Market || "").toLowerCase().includes(market)
      );
    }

    if (query) {
      rows = rows.filter(row =>
        Object.values(row).some(value =>
          String(value ?? "").toLowerCase().includes(query)
        )
      );
    }

    return {
      totalMatches: rows.length,
      returned: Math.min(rows.length, limit),
      rows: rows.slice(0, limit)
    };
  }

  if (name === "get_account") {
    return await getAccount();
  }

  if (name === "get_positions") {
    const positions = await getPositions();
    return { count: positions.length, positions };
  }

  if (name === "get_orders") {
    const orders = await getOrders(input);
    return { count: orders.length, orders };
  }

  if (name === "get_market_data") {
    return await getMarketData(input);
  }

  if (name === "get_quote") {
    return await getQuote(input);
  }

  if (name === "place_order") {
    return await placeOrder(input);
  }

  if (name === "cancel_order") {
    return await cancelOrder(input);
  }

  if (name === "get_autotrader_status") {
    return autoTraderStatus();
  }

  if (name === "get_autotrader_runs") {
    const limit = Math.min(Math.max(Number(input.limit) || 5, 1), 50);
    const runs = autoTraderRuns(limit);
    return { count: runs.length, runs };
  }

  if (name === "run_autotrader_now") {
    return await autoTradeRunOnce({
      force: Boolean(input.force),
      mode: input.mode
    });
  }

  if (name === "set_autotrader_kill_switch") {
    return setKillSwitch(Boolean(input.engaged), input.reason || null);
  }

  if (name === "get_trade_log") {
    const limit = Math.min(Math.max(Number(input.limit) || 25, 1), 100);
    const entries = getTradeLog(limit);
    return {
      count: entries.length,
      limits: TRADING_LIMITS,
      storage: tradeLogInfo(),
      entries
    };
  }

  if (name === "get_performance") {
    let reconciled = null;
    if (input.reconcile !== false) {
      try {
        reconciled = await reconcileFills({ limit: 60 });
      } catch (e) {
        reconciled = { error: String(e.message || e) };
      }
    }

    // The whole log, oldest first — pairing needs the full history, not a
    // recent window.
    const log = getTradeLog(100000).slice().reverse();

    // Stops live in the autotrader's own state, not in the trade log, so
    // R multiples are only available where a stop was recorded with the
    // decision. Anything else reports null rather than a guess.
    const stops = autoTraderStops();
    const stopPriceBySymbolAt = Object.fromEntries(
      Object.entries(stops).map(([symbol, s]) => [symbol, s.stopPrice])
    );

    const paired = pairTrades(log);
    const summary = summarize(paired.closed, { stopPriceBySymbolAt });
    const curve = equityCurve(paired.closed, 0);

    const groupers = {
      symbol: keyBySymbol,
      regime: keyByRegime,
      confidence: keyByConfidenceBucket
    };

    return {
      storage: tradeLogInfo(),
      reconciled,
      logEntries: log.length,
      closedTrades: paired.closed.length,
      openLots: paired.open.length,
      unmatched: paired.unmatched,
      unpriced: paired.unpriced,
      summary,
      drawdown: maxDrawdown(curve),
      calibration: confidenceCalibration(paired.closed),
      breakdown: input.groupBy
        ? breakdown(paired.closed, groupers[input.groupBy], { stopPriceBySymbolAt })
        : null,
      honesty:
        "Past results do not establish skill. Below 30 closed trades the dominant explanation for any figure here is luck, and the reliability flag says so explicitly. Report the caveat whenever you report the number."
    };
  }

  if (name === "run_backtest") {
    const universe = Array.isArray(input.universe) && input.universe.length
      ? input.universe.map((s) => String(s).toUpperCase())
      : AUTOTRADER_CONFIG.universe;
    const benchmarkSymbol = RISK_DEFAULTS.benchmarkSymbol;
    const aggressiveness = input.aggressiveness || AUTOTRADER_CONFIG.aggressiveness;
    const startingEquity = Number.isFinite(Number(input.startingEquity)) ? Number(input.startingEquity) : 100000;
    const limit = Math.min(Math.max(Number(input.lookbackTradingDays) || 500, 260), 1500);

    let barsBySymbol;
    try {
      barsBySymbol = await getBars({
        symbols: Array.from(new Set([...universe, benchmarkSymbol])),
        timeframe: "1Day",
        limit
      });
    } catch (e) {
      return { ok: false, error: `Could not fetch historical bars: ${e.message}` };
    }

    const backtestOptions = { universe, benchmarkSymbol, aggressiveness, startingEquity };

    // Trim what goes back to the model: a full equity curve and every
    // closed trade would burn the context window on every call. The
    // summary statistics carry the substance; a small sample of trades
    // is enough to ground a specific question about one of them.
    const slim = (report) => {
      if (!report.ok) return report;
      const trades = report.closedTrades;
      return {
        ok: true,
        period: report.period,
        universe: report.universe,
        benchmarkSymbol: report.benchmarkSymbol,
        params: report.params,
        startingEquity: report.startingEquity,
        finalEquity: report.finalEquity,
        strategyReturnPercent: report.strategyReturnPercent,
        benchmark: report.benchmark,
        beatBuyAndHold: report.beatBuyAndHold,
        performance: report.performance,
        drawdown: report.drawdown,
        sharpe: report.sharpe,
        tradeCounts: report.tradeCounts,
        openAtEnd: report.openAtEnd,
        sampleClosedTrades: {
          note: `Showing up to 10 of ${trades.length} closed trades (first 5, last 5). Use the 'performance' summary above for aggregate figures.`,
          trades: trades.length <= 10 ? trades : [...trades.slice(0, 5), ...trades.slice(-5)]
        },
        warnings: report.warnings,
        honesty: report.honesty
      };
    };

    if (Array.isArray(input.windows) && input.windows.length > 0) {
      const result = runBacktestWindows(barsBySymbol, input.windows, backtestOptions);
      return {
        windowCount: result.windowCount,
        usableCount: result.usableCount,
        consistency: result.consistency,
        honesty: result.honesty,
        windows: result.windows.map((w) => ({ label: w.label, start: w.start, end: w.end, report: slim(w.report) }))
      };
    }

    const report = runBacktest(barsBySymbol, backtestOptions);
    return slim(report);
  }

  if (name === "get_asset_info") {
    try {
      return await getAssetInfo(input.symbol);
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  }

  if (name === "brainstorm_wild_ideas") {
    if (!geminiConfigured()) {
      return {
        ok: false,
        error: "GEMINI_API_KEY is not set on this deployment, so wild-idea brainstorming isn't available right now."
      };
    }
    try {
      const result = await callGemini(input.prompt);
      return {
        ok: true,
        source: "gemini (deliberately unverified — treat as raw brainstorm material, not fact or advice)",
        model: result.model,
        ideas: result.text
      };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  }

  if (name === "run_reno_schedule") {
    try {
      const result = scheduleReno({
        weekStart: input.weekStart ? new Date(input.weekStart) : undefined,
        evidence: input.evidence || [],
        learnedUberTph: input.learnedUberTph,
        quest: input.quest || null
      });
      lastRenoSchedule = result;

      const topHours = Math.max(1, Math.min(168, Number(input.topHours) || 24));
      const fmt = (d) =>
        new Intl.DateTimeFormat("en-US", {
          timeZone: "America/Los_Angeles",
          weekday: "short",
          month: "short",
          day: "numeric",
          hour: "numeric",
          hour12: true
        }).format(d);

      // Trimmed for the model's context: the full 168 rows live in the
      // Driver tab and in GET /reno-schedule, not in every tool result.
      const unrecognized = result.hours.flatMap((h) => h.unrecognized.map((u) => u.family));

      return {
        ok: true,
        algorithmVersion: result.algorithmVersion,
        weekStart: fmt(result.weekStart),
        scoreMeaning:
          "0-100 is a RELATIVE opportunity score for this specific week (50 is roughly the week's center). It is not dollars/hour, not a probability, and not a guarantee.",
        evidenceUsed: (input.evidence || []).length,
        evidenceNote:
          (input.evidence || []).length === 0
            ? "No evidence supplied: this is the pure baseline ranking from the frozen hour/day tables. It knows nothing about this week's actual events, weather, flights, or road closures."
            : "Evidence supplied by the caller was applied within its stated time windows.",
        unrecognizedEvidenceFamilies: unrecognized.length ? [...new Set(unrecognized)] : undefined,
        coverage: result.coverage,
        coverageMeaning:
          "How much of the week was actually backed by live sources: STRONG / PARTIAL / LIMITED / DEGRADED. DEGRADED means baseline only.",
        rankedHours: result.ranked.slice(0, topHours).map((h) => ({
          rank: h.rank,
          when: fmt(h.date),
          score: Math.round(h.score * 10) / 10,
          confidence: h.confidenceLabel,
          platform: h.platform,
          expectedUberHourly: Math.round(h.income.uber * 100) / 100,
          expectedLyftHourly: Math.round(h.income.lyft * 100) / 100,
          expectedTripsPerHour: Math.round(h.expectedTph * 100) / 100,
          reasons: h.reasons
        })),
        incomeCaveat:
          "expectedUberHourly/expectedLyftHourly are a downstream calibration of the relative score, NOT a prediction of what the user will earn. Report them as rough expectations tied to a neutral-week level, never as forecast earnings.",
        totalHoursRanked: result.hours.length,
        blocks: result.blocks.map((b) => ({
          rank: b.rank,
          core: `${fmt(b.coreStartDate)} - ${fmt(b.coreEndDate)}`,
          recommended: `${fmt(b.startDate)} - ${fmt(b.endDate)}`,
          hours: b.hoursCount,
          coreTotalScore: b.coreTotalScore,
          extendedTotalScore: b.extendedTotalScore,
          extendedAvgScore: b.extendedAvgScore,
          extended: b.hasExtension
        })),
        totalRecommendedHours: result.totalRecommendedHours,
        extensionThreshold: result.extensionThreshold,
        minStartGapHours: result.minStartGapHours,
        complianceNotes: result.complianceNotes.length ? result.complianceNotes : undefined,
        complianceCaveat: result.complianceCaveat,
        bestDaysOff: result.bestDaysOff.map((d, i) => ({
          rank: i + 1,
          day: new Intl.DateTimeFormat("en-US", {
            timeZone: "America/Los_Angeles",
            weekday: "long",
            month: "short",
            day: "numeric"
          }).format(d.date),
          avgScore: Math.round(d.avgScore * 10) / 10
        })),
        oneOffHours: result.oneOffHours.length
          ? result.oneOffHours.map((h) => ({ when: fmt(h.date), score: h.score, reasons: h.reasons }))
          : [],
        oneOffMessage: result.oneOffMessage
      };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  }

  if (name === "web_search") {
    try {
      const result = await webSearch(input.query, { count: input.count, provider: input.provider });
      if (!result.ok) {
        return {
          ok: false,
          error: result.error || result.note,
          note: result.note,
          searchConfigured: result.configured === true
        };
      }
      return {
        ok: true,
        provider: result.providerLabel,
        kind: result.kind,
        query: result.query,
        results: result.results,
        summary: result.summary,
        caveat: result.caveat,
        reminder:
          "These are search results, not verified facts. Open the relevant URL with read_web_page before stating any specific date, number, or claim as true.",
        providerFailures: result.attempts && result.attempts.length ? result.attempts : undefined
      };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  }

  if (name === "read_web_page") {
    try {
      const page = await fetchPage(input.url, {
        maxChars: input.maxChars,
        includeLinks: Boolean(input.includeLinks)
      });
      if (!page.ok) return { ok: false, url: input.url, status: page.status, error: page.error };
      return {
        ok: true,
        url: page.url,
        finalUrl: page.finalUrl !== page.url ? page.finalUrl : undefined,
        title: page.title,
        kind: page.kind,
        text: page.text,
        truncated: page.truncated || undefined,
        charsAvailable: page.truncated ? page.charsAvailable : undefined,
        events: page.events && page.events.length ? page.events : undefined,
        eventsNote:
          page.events && page.events.length
            ? "These came from the page's own schema.org markup, so their times and names are the publisher's structured data rather than something parsed out of prose."
            : undefined,
        links: page.links,
        redirects: page.redirects && page.redirects.length ? page.redirects : undefined
      };
    } catch (e) {
      // Destination-guard refusals land here and should be reported as-is:
      // they are a deliberate safety boundary, not a transient failure to
      // retry or route around.
      return { ok: false, url: input.url, error: String(e.message || e) };
    }
  }

  if (name === "calculate") {
    try {
      if (Array.isArray(input.values)) {
        return { ok: true, kind: "series", ...calcDescribe(input.values) };
      }
      if (typeof input.expression === "string") {
        const value = calcEvaluate(input.expression);
        return { ok: true, kind: "expression", expression: input.expression, result: value };
      }
      return { ok: false, error: "Supply either `expression` (a string) or `values` (an array of numbers)." };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  }

  if (name === "parse_data") {
    try {
      switch (input.mode) {
        case "csv":
          return { ok: true, ...parseDelimited({ text: input.text, delimiter: input.delimiter, headers: input.headers !== false }) };
        case "json_path":
          return { ok: true, ...tkJsonPath({ data: input.data, path: input.path }) };
        case "json_schema":
          return { ok: true, schema: tkInferSchema({ data: input.data }) };
        case "regex":
          return { ok: true, ...tkRegex({ text: input.text, pattern: input.pattern, flags: input.flags, limit: input.limit }) };
        default:
          return { ok: false, error: `Unknown mode "${input.mode}". Use csv, json_path, json_schema, or regex.` };
      }
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  }

  if (name === "transform_text") {
    try {
      switch (input.mode) {
        case "normalize":
          return { ok: true, ...tkNormalize({ text: input.text, lower: input.lower, stripPunctuation: input.stripPunctuation, form: input.form }) };
        case "compare":
          return { ok: true, ...tkCompare({ before: input.before, after: input.after }) };
        case "dedupe":
          return { ok: true, ...tkDedupe({ items: input.items, key: input.key }) };
        case "chunk":
          return { ok: true, ...tkChunk({ data: input.data !== undefined ? input.data : input.text, size: input.size, overlap: input.overlap }) };
        case "base64_encode":
          return { ok: true, ...base64Encode({ text: input.text }) };
        case "base64_decode":
          return { ok: true, ...base64Decode({ data: input.data }) };
        case "sha256":
          return { ok: true, ...tkSha256({ text: input.text }) };
        default:
          return { ok: false, error: `Unknown mode "${input.mode}".` };
      }
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  }

  if (name === "inspect_code") {
    try {
      switch (input.mode) {
        case "syntax":
          return { ok: true, ...(await tkCheckJs({ code: input.code, module: input.module !== false })) };
        case "risks":
          return { ok: true, ...tkAnalyzeSource({ code: input.code, language: input.language }) };
        case "privacy":
          return { ok: true, ...tkPrivacy({ text: input.text, data: input.data }) };
        case "openapi":
          return { ok: true, ...tkOpenApi({ document: input.data }) };
        default:
          return { ok: false, error: `Unknown mode "${input.mode}". Use syntax, risks, privacy, or openapi.` };
      }
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  }

  if (name === "inspect_package") {
    try {
      if (input.source === "npm") return await tkNpm({ name: input.name });
      if (input.source === "github") return await tkGithub({ repo: input.repo, tokenEnv: "GITHUB_TOKEN" });
      return { ok: false, error: `Unknown source "${input.source}". Use npm or github.` };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  }

  if (name === "fetch_json_api") {
    try {
      return { ok: true, ...(await tkJsonApi({ url: input.url, headers: input.headers, timeoutMs: input.timeoutMs })) };
    } catch (e) {
      return { ok: false, url: input.url, error: String(e.message || e) };
    }
  }

  throw new Error(`Unknown Claude tool: ${name}`);
}

// The most recent schedule run, so the Driver tab can show the full 168-hour
// ranking without recomputing it (and without the model having to relay all
// 168 rows through the chat).
let lastRenoSchedule = null;


const CORE_ENGINE_CONFIG_KEYS = [
  "PROSPECT_EMAIL_MODE",
  "PROSPECT_AUTO_SEND",
  "MAX_FRESH_DISCOVERY_RUNS_PER_MARKET_CYCLE",
  "FOURTH_RUN_REQUIRES_NEW_SOURCE_FAMILY",
  "SMALL_LEFTOVER_YIELD_EXTENDS_CITY",
  "SWITCH_AFTER_DIMINISHING_RETURNS",
  "POLICY_GATE_REQUIRED_BEFORE_ACTIONABLE",
  "POLICY_UNKNOWN_COUNTS_AS_ACTIONABLE",
  "ACTIONABLE_POOL_STATES",
  "SWITCH_USES_ACTIONABLE_NEW_AB",
  "GLOBAL_MAINTENANCE_RECHECK_LIMIT",
  "OWNER_DIGEST_SEND",
  "RUN_TIMESTAMP_TIMEZONE",
  "RUN_TIMESTAMP_FORMAT"
];

async function buildLiveRuntimeContext() {
  const [market, config] = await Promise.all([
    readActiveMarket(),
    readEngineConfig(CORE_ENGINE_CONFIG_KEYS)
  ]);

  return {
    activeMarket: market,
    engineConfig: config.byKey,
    trading: {
      mode: isLiveEndpoint() ? "LIVE" : "PAPER",
      configured: Boolean(process.env.ALPACA_KEY_ID && process.env.ALPACA_SECRET_KEY),
      guardrails: TRADING_LIMITS
    }
  };
}

async function askClaude(history, userMessage) {
  const runtimeContext = await buildLiveRuntimeContext();

  const runtimeSystem =
    SYSTEM_PROMPT +
    "\n\nLIVE AUTHORITATIVE RUNTIME CONTEXT — fetched from the master Google Sheet for this request:\n" +
    JSON.stringify(runtimeContext, null, 2) +
    "\n\nRules for this runtime context: Engine Config overrides inference and descriptive notes. A missing active market means NO_MARKET_LOCK and must never block ordinary chat, database research, or cross-market analysis. Discovery Phase is only relevant when discussing or executing a market-specific production run. Never invent fixed thresholds. Never recommend promotional sending when PROSPECT_EMAIL_MODE=DRAFT_ONLY or PROSPECT_AUTO_SEND=FALSE.";

  const messages = [...history, { role: "user", content: userMessage }];
  let providerUsed = "anthropic";

  // One call, either provider, always the SAME system prompt and SAME
  // tool list either way. This is the one place a fallback model differs
  // from Claude at all: which wire format its response arrives in. See
  // llm-provider.js for why that boundary is drawn exactly here.
  async function callModelRound() {
    try {
      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        system: runtimeSystem,
        tools: CLAUDE_TOOLS,
        messages
      });
      return { content: response.content };
    } catch (error) {
      if (!isQuotaOrRateLimitError(error) || !fallbackConfigured()) throw error;

      console.error(
        `[llm-fallback] Anthropic call failed (${error.message || error}); retrying via ${process.env.LITELLM_MODEL}.`
      );
      providerUsed = `fallback:${process.env.LITELLM_MODEL}`;

      try {
        const fb = await callFallbackModel({ system: runtimeSystem, tools: CLAUDE_TOOLS, messages });
        return { content: fb.content };
      } catch (fallbackError) {
        // Both providers failed. Surface the ORIGINAL Anthropic error as
        // the primary cause — that is almost always the more diagnosable
        // one (a fallback misconfiguration is a distraction from "why did
        // the primary provider fail" the first time this happens) — with
        // the fallback failure appended rather than swallowed.
        throw new Error(
          `Anthropic failed (${error.message || error}) and the fallback also failed (${fallbackError.message || fallbackError}).`
        );
      }
    }
  }

  for (let round = 0; round < 8; round++) {
    const { content } = await callModelRound();

    const toolUses = content.filter((block) => block.type === "tool_use");

    if (toolUses.length === 0) {
      const text = content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();
      return { text, provider: providerUsed };
    }

    messages.push({
      role: "assistant",
      content
    });

    const toolResults = [];

    for (const toolUse of toolUses) {
      // A tool call whose arguments a fallback model produced as invalid
      // JSON is reported back as a tool error, exactly like a live
      // failure of that tool — never silently dropped, never guessed at.
      if (toolUse._argumentParseError) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          is_error: true,
          content: `Arguments for ${toolUse.name} were not valid JSON: ${toolUse._argumentParseError}`
        });
        continue;
      }

      try {
        const result = await executeClaudeTool(
          toolUse.name,
          toolUse.input || {}
        );

        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: JSON.stringify(result)
        });
      } catch (error) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          is_error: true,
          content: String(error.message || error)
        });
      }
    }

    messages.push({
      role: "user",
      content: toolResults
    });
  }

  throw new Error("Claude exceeded tool-call round limit");
}

async function extractAndSaveLead(reply) {
  const marker = "LEAD_DATA_JSON:";
  const idx = reply.indexOf(marker);

  if (idx === -1) return null;

  try {
    const jsonStr = reply
      .slice(idx + marker.length)
      .split("\n")[0]
      .trim();

    let lead = JSON.parse(jsonStr);

    if (!lead.id || !lead.name) return null;

    const existing = getLeadById(lead.id);

    if (existing) {
      lead = {
        ...existing,
        ...lead,
        log: [
          ...(existing.log || []),
          ...(lead.log || [])
        ]
      };
    }

    upsertLead(lead);

    if (
      isEmailAddress(lead.contact) &&
      lead.outreachEmail?.subject &&
      lead.outreachEmail?.body &&
      !lead.gmailDraftUid
    ) {
      try {
        const draft = await createGmailDraft(lead);

        lead.gmailDraftUid = draft.uid;
        lead.gmailDraftMailbox = draft.mailbox;
        lead.gmailDraftCreatedAt = new Date().toISOString();

        lead.log = lead.log || [];
        lead.log.push({
          date: lead.gmailDraftCreatedAt,
          action: "Gmail draft created",
          subject: lead.outreachEmail.subject
        });

        upsertLead(lead);

        console.log(
          "Gmail draft created:",
          lead.id,
          draft.uid
        );
      } catch (e) {
        console.error(
          "Gmail draft failed:",
          lead.id,
          e.message
        );
      }
    }

    return lead;
  } catch (e) {
    console.error("Lead extract error", e.message);
    return null;
  }
}

function cleanReply(reply) {
  const idx = reply.indexOf("LEAD_DATA_JSON:");
  return idx === -1 ? reply : reply.slice(0, idx).trim();
}

function isEmailAddress(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
    String(value || "").trim()
  );
}

function getBusinessGmailCredentials() {
  const REQUIRED = "referralmarket.site@gmail.com";

  const user = String(process.env.GMAIL_USER || "")
    .trim()
    .toLowerCase();

  if (user !== REQUIRED) {
    throw new Error(
      "Wrong Gmail account: " + (user || "NOT SET")
    );
  }

  if (!process.env.GMAIL_APP_PASSWORD) {
    throw new Error("GMAIL_APP_PASSWORD is missing");
  }

  return {
    user: REQUIRED,
    password: process.env.GMAIL_APP_PASSWORD
  };
}

async function createGmailDraft(lead) {
  if (
    !lead?.outreachEmail?.subject ||
    !lead?.outreachEmail?.body
  ) {
    throw new Error("Lead has no outreach email");
  }

  if (!isEmailAddress(lead.contact)) {
    throw new Error("Lead contact is not an email address");
  }

  const { user, password } =
    getBusinessGmailCredentials();

  const { createTransport } =
    await import("nodemailer");

  const { ImapFlow } =
    await import("imapflow");

  const builder = createTransport({
    streamTransport: true,
    newline: "unix",
    buffer: true
  });

  const message = await builder.sendMail({
    from: user,
    to: lead.contact,
    subject: lead.outreachEmail.subject,
    text: lead.outreachEmail.body
  });

  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: {
      user,
      pass: password
    },
    logger: false
  });

  await client.connect();

  try {
    const boxes = await client.list();

    const drafts =
      boxes.find(
        b => b.specialUse === "\\Drafts"
      )?.path ||
      boxes.find(
        b => /draft/i.test(b.path)
      )?.path;

    if (!drafts) {
      throw new Error("Gmail Drafts mailbox not found");
    }

    const result = await client.append(
      drafts,
      message.message,
      ["\\Draft"]
    );

    return {
      mailbox: drafts,
      uid: result?.uid ? String(result.uid) : ""
    };
  } finally {
    await client.logout();
  }
}

function htmlPage() {
  return `<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Darkly Research Console</title>
<style>
*{box-sizing:border-box}
body{
  font-family:system-ui,-apple-system,sans-serif;
  margin:0;
  background:#0d0d0f;
  color:#e8e8eb;
  height:100vh;
  height:100dvh;
  overflow:hidden;
}
button,input,select,textarea{font:inherit}
button{cursor:pointer}

#login-overlay{
  position:fixed;inset:0;background:#0d0d0f;
  display:flex;align-items:center;justify-content:center;
  z-index:1000;
}
#login-box{
  width:min(340px,88vw);
  background:#151519;
  border:1px solid #303038;
  border-radius:18px;
  padding:28px;
}
#login-box h2{margin:0 0 8px}
#login-box p{color:#888;margin:0 0 18px;font-size:13px}
#pass{
  width:100%;padding:12px;
  border-radius:10px;border:1px solid #34343d;
  background:#1b1b20;color:#fff;margin-bottom:10px;
}
#unlock-btn{
  width:100%;padding:12px;border:0;border-radius:10px;
  background:#243d31;color:#68e59c;
}

#app{
  height:100vh;
  height:100dvh;
  display:flex;
  flex-direction:column;
  overflow:hidden;
}

#topbar{
  flex:0 0 auto;
  display:flex;
  flex-direction:column;
  gap:8px;
  padding:8px 12px;
  border-bottom:1px solid #26262d;
  background:#141417;
}
#topbar-main{
  display:flex;
  align-items:center;
  gap:8px;
  min-width:0;
}
#nav{
  display:flex;
  gap:6px;
}
#nav .navbtn{
  flex:1 1 0;
  min-width:0;
  text-align:center;
}
#title{
  font-weight:700;
  font-size:17px;
  white-space:nowrap;
  overflow:hidden;
  text-overflow:ellipsis;
  min-width:0;
}
.mode-badge{
  font-size:10px;
  padding:4px 7px;
  border-radius:999px;
  background:#2a1c34;
  color:#dc8cff;
  white-space:nowrap;
}
#row-count{
  font-size:11px;color:#999;
  white-space:nowrap;
}
.spacer{flex:1}
.navbtn{
  border:1px solid #33333a;
  border-radius:9px;
  padding:7px 10px;
  background:#1b1b1f;
  color:#aaa;
}
.navbtn.active{
  background:#243d31;
  color:#6ce5a0;
  border-color:#315743;
}

#research-view{
  flex:1;
  overflow:hidden;
  display:flex;
  flex-direction:column;
}

#summary{
  display:flex;
  gap:7px;
  overflow-x:auto;
  padding:8px 10px;
  border-bottom:1px solid #232329;
  scrollbar-width:none;
}
.stat{
  flex:0 0 auto;
  padding:7px 10px;
  border-radius:10px;
  background:#17171b;
  border:1px solid #292930;
  min-width:90px;
}
.stat .n{font-weight:700;font-size:16px}
.stat .l{color:#777;font-size:9px;text-transform:uppercase;letter-spacing:.5px}

#filters{
  display:flex;
  gap:7px;
  flex-wrap:wrap;
  padding:8px 10px;
  border-bottom:1px solid #24242a;
  background:#111114;
}
#filters input,#filters select{
  background:#19191e;
  border:1px solid #303038;
  color:#ddd;
  border-radius:8px;
  padding:8px;
  min-height:38px;
}
#search{flex:1;min-width:180px}
.filter-small{max-width:175px}
#refresh-btn{
  border:0;border-radius:8px;
  padding:8px 12px;
  background:#243d31;color:#68e59c;
}

#table-wrap{
  flex:1;
  overflow:auto;
  position:relative;
}
table{
  border-collapse:separate;
  border-spacing:0;
  min-width:1500px;
  width:100%;
  font-size:11px;
}
th{
  position:sticky;
  top:0;
  z-index:4;
  background:#17171b;
  color:#8b8b96;
  text-align:left;
  padding:8px 7px;
  border-bottom:1px solid #33333a;
  white-space:nowrap;
  cursor:pointer;
}
td{
  padding:7px;
  border-bottom:1px solid #202026;
  vertical-align:top;
}
tbody tr{cursor:pointer}
tbody tr:hover{background:#17171c}
.rank{
  color:#777;
  text-align:right;
  width:45px;
}
.name{
  font-weight:650;
  color:#eee;
  max-width:250px;
}
.id{color:#777;white-space:nowrap}
.market{white-space:nowrap}
.muted{color:#777}
.good{color:#69df9d}
.warn{color:#f0c35a}
.bad{color:#ff7878}
.top-tier{
  color:#e999ff;
  font-weight:700;
}
.kind-pill{
  padding:3px 6px;
  border-radius:6px;
  font-size:9px;
  white-space:nowrap;
}
.kind-channel{background:#20382d;color:#65df98}
.kind-prospect{background:#253247;color:#83b7ff}
.kind-connectorCandidate{background:#403421;color:#efc56d}
.kind-businessCandidate{background:#382444;color:#db91f0}

#footer{
  display:flex;
  align-items:center;
  gap:10px;
  padding:7px 10px;
  border-top:1px solid #292930;
  font-size:11px;
  color:#777;
}
#visible-info{flex:1}

#chat-view{
  display:none;
  flex:1;
  overflow:hidden;
  flex-direction:column;
}
#chat-header{
  display:flex;justify-content:space-between;align-items:center;gap:8px;
  padding:8px 10px 0;
}
#chat-slot-tabs{display:flex;gap:6px;flex-wrap:wrap}
.slot-tab{
  border:1px solid #33333b;border-radius:9px;
  background:#18181c;color:#888;padding:6px 12px;
  font-size:12px;
}
.slot-tab.active{
  background:#203126;color:#68e59c;border-color:#2c4a3a;
}
#new-chat-btn{
  border:1px solid #33333b;border-radius:9px;
  background:#18181c;color:#999;padding:6px 12px;
  font-size:12px;
  flex-shrink:0;
}
#chat{
  flex:1;
  overflow-y:auto;
  padding:14px;
  display:flex;
  flex-direction:column;
  gap:10px;
}
.msg{
  padding:11px 14px;
  border-radius:13px;
  white-space:pre-wrap;
  line-height:1.45;
  font-size:14px;
}
.me{align-self:flex-end;background:#203126;max-width:88%}
.bot{
  align-self:flex-start;background:#18181c;
  border:1px solid #292930;max-width:96%
}
#inputbar{
  display:flex;gap:8px;padding:10px;
  border-top:1px solid #292930;
}
#message{
  flex:1;min-height:52px;max-height:150px;
  border-radius:11px;border:1px solid #33333b;
  background:#19191e;color:#eee;padding:10px;
  resize:vertical;
}
#send-btn{
  border:0;border-radius:11px;
  background:#243d31;color:#68e59c;padding:10px 16px;
}

#modal{
  display:none;
  position:fixed;inset:0;
  background:rgba(0,0,0,.85);
  z-index:500;
  align-items:center;justify-content:center;
}
#modal.open{display:flex}
#modal-box{
  width:min(760px,94vw);
  max-height:88vh;
  overflow:auto;
  background:#151519;
  border:1px solid #323239;
  border-radius:15px;
  padding:18px;
}
#modal-head{
  display:flex;gap:10px;align-items:flex-start;
  margin-bottom:12px;
}
#modal-name{font-size:18px;font-weight:700;flex:1}
#close-modal{
  border:1px solid #33333a;background:#202025;color:#aaa;
  border-radius:8px;padding:6px 10px;
}
#detail-grid{
  display:grid;
  grid-template-columns:150px 1fr;
  gap:1px;
  background:#25252b;
  border:1px solid #292930;
}
.dk,.dv{padding:7px;background:#151519}
.dk{color:#777;font-size:10px;text-transform:uppercase}
.dv{font-size:12px;white-space:pre-wrap;word-break:break-word}

#stocks-view,#driver-view{
  flex:1;
  overflow:hidden;
  display:none;
  flex-direction:column;
}
#driver-refresh{
  border:0;border-radius:8px;
  padding:7px 12px;
  background:#243d31;color:#68e59c;
}
.evnote{
  font-size:11px;
  line-height:1.5;
  padding:8px 10px;
  border-bottom:1px solid #232329;
}
.ev-warn{background:#2b2617;color:#e0c97a}
.ev-ok{background:#182a20;color:#7fd3a3}
.subtle{color:#777;font-size:11px;line-height:1.5}
.blk{
  border:1px solid #24242a;
  border-radius:10px;
  padding:10px;
  margin-bottom:8px;
  background:#131316;
}
.blk-head{display:flex;align-items:center;gap:8px;margin-bottom:4px}
.blk-rank{font-weight:700;color:#68e59c;font-size:13px}
.blk-score{font-size:11px;color:#999;margin-left:auto}
.blk-when{font-size:13px;color:#ddd}
.blk-ext{font-size:11px;color:#e0c97a;margin-top:2px}
.blk-hours{font-size:11px;color:#777;margin-top:3px}
.blk-total{
  font-size:12px;color:#68e59c;font-weight:600;
  padding:8px 0 4px;
}
.compliance{
  font-size:11px;color:#e0c97a;line-height:1.5;
  background:#2b2617;border-radius:8px;padding:8px;margin:6px 0;
}
.dayoff{font-size:13px;color:#ddd;margin-bottom:6px}
.dayoff-rank{color:#68e59c;font-weight:600;font-size:11px}
.oneoff-head{
  margin:14px 0 6px;font-size:11px;text-transform:uppercase;
  letter-spacing:.5px;color:#777;font-weight:600;
}
.oneoff{margin-bottom:8px;font-size:12px;color:#ddd}
.dtable{width:100%;border-collapse:collapse;font-size:11px}
.dtable th{
  text-align:left;padding:6px 8px;color:#777;font-weight:600;
  border-bottom:1px solid #24242a;position:sticky;top:0;background:#0e0e11;
  text-transform:uppercase;letter-spacing:.4px;font-size:10px;
}
.dtable td{padding:6px 8px;border-bottom:1px solid #1b1b20;color:#ccc;vertical-align:top}
.dtable td.num{text-align:right;font-variant-numeric:tabular-nums}
.dtable td.reasons{color:#888;min-width:200px;font-variant-numeric:tabular-nums}
.dtable td.conf{font-size:10px;text-transform:uppercase;letter-spacing:.3px}
.dtable td.conf-high{color:#68e59c}
.dtable td.conf-medium{color:#e0c97a}
.dtable td.conf-low{color:#777}
.dtable td.plat{color:#9aa;font-size:10px;white-space:nowrap}
#stocks-bar{
  display:flex;
  align-items:center;
  gap:8px;
  padding:8px 10px;
  border-bottom:1px solid #24242a;
  background:#111114;
  font-size:12px;
  color:#999;
}
.mode-pill{
  font-size:10px;
  font-weight:700;
  padding:4px 8px;
  border-radius:999px;
  background:#243d31;
  color:#68e59c;
  white-space:nowrap;
}
.mode-pill.live{background:#3d2424;color:#ff8c8c}
#stocks-refresh{
  border:0;border-radius:8px;
  padding:7px 12px;
  background:#243d31;color:#68e59c;
}
#stocks-summary{
  display:flex;
  gap:7px;
  overflow-x:auto;
  padding:8px 10px;
  border-bottom:1px solid #232329;
  scrollbar-width:none;
}
#stocks-body{
  flex:1;
  overflow-y:auto;
  padding:10px;
}
.sblock{margin-bottom:18px}
.sblock h3{
  margin:0 0 8px;
  font-size:11px;
  text-transform:uppercase;
  letter-spacing:.5px;
  color:#777;
  font-weight:600;
}
.card{
  background:#15151a;
  border:1px solid #26262d;
  border-radius:11px;
  padding:10px 12px;
  margin-bottom:7px;
}
.card-top{
  display:flex;
  align-items:baseline;
  gap:8px;
}
.card-sym{font-weight:700;font-size:15px}
.card-qty{color:#777;font-size:11px}
.card-val{margin-left:auto;font-weight:600;font-size:14px;white-space:nowrap}
.card-bot{
  display:flex;
  align-items:baseline;
  gap:8px;
  margin-top:5px;
  font-size:11px;
  color:#888;
}
.card-pnl{margin-left:auto;font-weight:600;font-size:12px;white-space:nowrap}
.pill{
  font-size:9px;
  font-weight:700;
  text-transform:uppercase;
  letter-spacing:.4px;
  padding:3px 7px;
  border-radius:999px;
  background:#22222a;
  color:#999;
}
.pill.buy{background:#1d3328;color:#68e59c}
.pill.sell{background:#33201f;color:#ff9a9a}
.pos{color:#68e59c}
.neg{color:#ff8c8c}
.empty{color:#666;font-size:12px;padding:6px 0}
#guardrails-wrap{
  display:grid;
  grid-template-columns:repeat(auto-fill,minmax(150px,1fr));
  gap:7px;
}
.guard{
  background:#17171b;
  border:1px solid #292930;
  border-radius:10px;
  padding:8px 10px;
}
.guard .n{font-weight:700;font-size:15px}
.guard .l{color:#777;font-size:9px;text-transform:uppercase;letter-spacing:.5px}

@media(min-width:700px){
  #topbar{flex-direction:row;align-items:center}
  #topbar-main{flex:1}
  #nav .navbtn{flex:0 0 auto}
}

@media(max-width:700px){
  #title{font-size:15px}
  .mode-badge{display:none}
  #topbar{padding:7px}
  #filters{padding:7px}
  #summary{padding:7px}
  table{font-size:10px}
  th,td{padding:6px}
  #detail-grid{grid-template-columns:105px 1fr}
}
</style>
</head>

<body>

<div id="login-overlay">
  <div id="login-box">
    <h2>Darkly Agent</h2>
    <p>ReferralMarket research console</p>
    <input id="pass" type="password" placeholder="Passcode">
    <button id="unlock-btn">Unlock</button>
  </div>
</div>

<div id="app">

  <div id="topbar">
    <div id="topbar-main">
      <div id="title">Darkly</div>
      <div class="mode-badge">PRE-LAUNCH CALIBRATION</div>
      <div id="row-count">0 rows</div>
      <div class="spacer"></div>
    </div>
    <div id="nav">
      <button id="research-tab" class="navbtn active">Research</button>
      <button id="stocks-tab" class="navbtn">Stocks</button>
      <button id="driver-tab" class="navbtn">Driver</button>
      <button id="chat-tab" class="navbtn">Chat</button>
    </div>
  </div>

  <section id="research-view">

    <div id="summary">
      <div class="stat"><div class="n" id="s-total">0</div><div class="l">All records</div></div>
      <div class="stat"><div class="n" id="s-channels">0</div><div class="l">Channels</div></div>
      <div class="stat"><div class="n" id="s-prospects">0</div><div class="l">Prospects</div></div>
      <div class="stat"><div class="n" id="s-raw">0</div><div class="l">Raw candidates</div></div>
      <div class="stat"><div class="n" id="s-top">0</div><div class="l">Top tier</div></div>
      <div class="stat"><div class="n" id="s-ready">0</div><div class="l">Ready</div></div>
      <div class="stat"><div class="n" id="s-review">0</div><div class="l">Policy review</div></div>
      <div class="stat"><div class="n" id="s-market">—</div><div class="l">Active market</div></div>
    </div>

    <div id="filters">

      <input id="search" placeholder="Search name, ID, type, source, market...">

      <select id="kind-filter" class="filter-small">
        <option value="">All datasets</option>
        <option value="channel">Channels</option>
        <option value="prospect">Business prospects</option>
        <option value="connectorCandidate">Connector candidates</option>
        <option value="businessCandidate">Business candidates</option>
      </select>

      <select id="market-filter" class="filter-small">
        <option value="">All markets</option>
      </select>

      <select id="state-filter" class="filter-small">
        <option value="">All states</option>
        <option value="READY">READY</option>
        <option value="APPROVAL REQUIRED">APPROVAL REQUIRED</option>
        <option value="POLICY REVIEW">POLICY REVIEW</option>
        <option value="INSTITUTIONAL ONLY">INSTITUTIONAL ONLY</option>
        <option value="BLOCKED">BLOCKED</option>
        <option value="ELIGIBLE">ELIGIBLE</option>
        <option value="REVIEW">REVIEW</option>
      </select>

      <select id="special-filter" class="filter-small">
        <option value="">All records</option>
        <option value="top">TOP TIER only</option>
        <option value="actionable">Actionable only</option>
        <option value="referral">Referral-system matches</option>
        <option value="policy">Policy review/intelligence</option>
      </select>

      <select id="sort-select" class="filter-small">
        <option value="rank">Research rank</option>
        <option value="market">Market</option>
        <option value="quality">Quality score</option>
        <option value="scalability">Scalability</option>
        <option value="latest">Newest evidence</option>
        <option value="name">Name</option>
      </select>

      <select id="limit-select" class="filter-small">
        <option value="50">50 rows</option>
        <option value="100">100 rows</option>
        <option value="250" selected>250 rows</option>
        <option value="500">500 rows</option>
        <option value="all">All rows</option>
      </select>

      <button id="refresh-btn">Refresh Live Data</button>
    </div>

    <div id="table-wrap">
      <table>
        <thead>
          <tr>
            <th data-sort="rank">#</th>
            <th>Dataset</th>
            <th data-sort="market">Market</th>
            <th>ID</th>
            <th data-sort="name">Name</th>
            <th>Type / Family</th>
            <th>Connector / Category</th>
            <th>Priority</th>
            <th>Actionability / State</th>
            <th>Policy</th>
            <th>Referral Match</th>
            <th>Top Tier</th>
            <th data-sort="quality">Quality</th>
            <th data-sort="scalability">Scale</th>
            <th>Recommendation</th>
            <th data-sort="latest">Last Evidence</th>
          </tr>
        </thead>
        <tbody id="results-body"></tbody>
      </table>
    </div>

    <div id="footer">
      <div id="visible-info">Loading...</div>
      <div id="load-status"></div>
    </div>

  </section>

  <section id="stocks-view">

    <div id="stocks-bar">
      <span id="stocks-mode" class="mode-pill">—</span>
      <span id="stocks-status">Not loaded</span>
      <div class="spacer"></div>
      <button id="stocks-refresh">Refresh</button>
    </div>

    <div id="stocks-summary"></div>

    <div id="stocks-body">
      <div class="sblock">
        <h3>Open positions</h3>
        <div id="positions-wrap" class="scroll-x"></div>
      </div>
      <div class="sblock">
        <h3>Recent orders</h3>
        <div id="orders-wrap" class="scroll-x"></div>
      </div>
      <div class="sblock">
        <h3>Guardrails</h3>
        <div id="guardrails-wrap"></div>
      </div>
    </div>

  </section>

  <section id="driver-view">

    <div id="stocks-bar">
      <span id="driver-version" class="mode-pill">—</span>
      <span id="driver-status">Not loaded</span>
      <div class="spacer"></div>
      <button id="driver-refresh">Recalculate</button>
    </div>

    <div id="driver-evidence-note" class="evnote"></div>

    <div id="stocks-body">
      <div class="sblock">
        <h3>Recommended driving blocks</h3>
        <div id="driver-blocks"></div>
      </div>
      <div class="sblock">
        <h3>Days off &amp; one-off hours</h3>
        <div id="driver-daysoff"></div>
      </div>
      <div class="sblock">
        <h3>Ranked hours <span class="subtle" id="driver-rank-count"></span></h3>
        <div id="driver-hours" class="scroll-x"></div>
      </div>
    </div>

  </section>

  <section id="chat-view">
    <div id="chat-header">
      <div id="chat-slot-tabs"></div>
      <button id="new-chat-btn" title="Clear this chat's history">New chat</button>
    </div>
    <div id="chat"></div>
    <div id="inputbar">
      <textarea id="message" placeholder="Ask Darkly about the live ReferralMarket data..."></textarea>
      <button id="send-btn">Send</button>
    </div>
  </section>

</div>

<div id="modal">
  <div id="modal-box">
    <div id="modal-head">
      <div id="modal-name">Record</div>
      <button id="close-modal">Close</button>
    </div>
    <div id="detail-grid"></div>
  </div>
</div>

<script>
let passcode="";

// A fixed set of named chat slots rather than one-session-per-browser:
// "chat" is the single persistent main thread (durable — see
// chat-store.js), and "2"-"5" are disposable side threads for
// brainstorming/theory-crafting that deliberately do NOT survive a
// restart (see server.js's EPHEMERAL_SLOTS). All five are shared across
// whatever device is talking to this console — there's no per-browser id
// to keep in localStorage at all anymore, which is simpler and matches
// what was actually wanted: one real "Chat", plus a few scratch ones.
const CHAT_SLOTS=["chat","2","3","4","5"];
let activeSlot="chat";

let researchRows=[];
let activeMarket=null;
let currentSort="rank";

const byId=id=>document.getElementById(id);

byId("unlock-btn").onclick=unlock;
byId("pass").onkeydown=e=>{if(e.key==="Enter")unlock()};

async function unlock(){
  const p=byId("pass").value.trim();
  if(!p)return;

  passcode=p;
  byId("login-overlay").style.display="none";

  loadResearch();
  await switchSlot("chat");
}

function renderSlotTabs(){
  const wrap=byId("chat-slot-tabs");
  wrap.innerHTML="";
  for (const slot of CHAT_SLOTS){
    const b=document.createElement("button");
    b.className="slot-tab"+(slot===activeSlot?" active":"");
    b.textContent=slot==="chat"?"Chat":slot;
    b.onclick=()=>switchSlot(slot);
    wrap.appendChild(b);
  }
}

// Switch which slot is showing and replay whatever it already holds.
// "chat" is durable (chat-store.js, survives a restart); "2"-"5" are
// ephemeral (in-memory only on the server, gone on the next restart) —
// see EPHEMERAL_SLOTS below. Either way the fetch/render logic is the
// same from the browser's side.
async function switchSlot(slot){
  activeSlot=slot;
  renderSlotTabs();
  byId("chat").innerHTML="";

  try {
    const r = await fetch("/chat-history", {
      headers: { "X-Agent-Passcode": passcode, "X-Session-Id": activeSlot }
    });

    if (r.status===401) {
      addMsg("Wrong passcode.","bot");
      byId("login-overlay").style.display="flex";
      return;
    }

    const data = await r.json();
    const messages = Array.isArray(data.messages) ? data.messages : [];

    if (messages.length===0) {
      addMsg(
        slot==="chat"
          ? "Darkly Agent ready. Live market data is available in the Research view."
          : "Side chat "+slot+" — not saved, cleared on restart. Good for throwing around ideas.",
        "bot"
      );
      return;
    }

    for (const m of messages) {
      addMsg(m.content, m.role==="user" ? "me" : "bot");
    }
  } catch (e) {
    // A failed restore should not block using the console — fall back
    // to a plain notice and let the next real message try again.
    addMsg(
      "Darkly Agent ready. (Could not load prior chat history: "+e.message+")",
      "bot"
    );
  }
}

async function newChat(){
  try {
    await fetch("/chat-reset", {
      method: "POST",
      headers: { "X-Agent-Passcode": passcode, "X-Session-Id": activeSlot }
    });
  } catch (e) {
    // Even if the server-side clear fails, still give a visibly fresh
    // pane locally — the next message will just carry stale context
    // from the server's side rather than losing the UI action entirely.
  }
  byId("chat").innerHTML="";
  addMsg("New conversation started.","bot");
}

byId("research-tab").onclick=()=>showView("research");
byId("stocks-tab").onclick=()=>showView("stocks");
byId("driver-tab").onclick=()=>showView("driver");
byId("chat-tab").onclick=()=>showView("chat");
byId("driver-refresh").onclick=()=>loadDriver(true);
byId("stocks-refresh").onclick=()=>loadStocks();
byId("new-chat-btn").onclick=newChat;

let stocksLoaded=false;

function showView(which){
  byId("research-view").style.display=which==="research"?"flex":"none";
  byId("stocks-view").style.display=which==="stocks"?"flex":"none";
  byId("driver-view").style.display=which==="driver"?"flex":"none";
  byId("chat-view").style.display=which==="chat"?"flex":"none";

  byId("research-tab").classList.toggle("active",which==="research");
  byId("stocks-tab").classList.toggle("active",which==="stocks");
  byId("driver-tab").classList.toggle("active",which==="driver");
  byId("chat-tab").classList.toggle("active",which==="chat");

  if(which==="chat")byId("message").focus();
  if(which==="stocks"&&!stocksLoaded)loadStocks();
  if(which==="driver"&&!driverLoaded)loadDriver();
}

let driverLoaded=false;

function renoTime(iso,opts){
  return new Intl.DateTimeFormat("en-US",Object.assign({timeZone:"America/Los_Angeles"},opts)).format(new Date(iso));
}

async function loadDriver(fresh){
  byId("driver-status").textContent=fresh?"Recalculating...":"Loading schedule...";
  try{
    const res=await fetch("/reno-schedule"+(fresh?"?fresh=1":""),{headers:{"X-Agent-Passcode":passcode}});
    if(!res.ok)throw new Error("HTTP "+res.status);
    const d=await res.json();
    renderDriver(d);
    driverLoaded=true;
    byId("driver-status").textContent="Week of "+renoTime(d.weekStart,{weekday:"short",month:"short",day:"numeric"})+" · 168 hours ranked";
    byId("driver-version").textContent=d.algorithmVersion;
  }catch(e){
    byId("driver-status").textContent="Failed: "+e.message;
  }
}

function renderDriver(d){
  // Evidence honesty banner: a baseline-only ranking must never be presented
  // as if it knew about this week's actual events.
  const note=byId("driver-evidence-note");
  note.className="evnote "+(d.evidenceApplied>0?"ev-ok":"ev-warn");
  note.innerHTML="<b>Source coverage: "+d.coverage+"</b> — "+esc(d.evidenceNote)+" "+esc(d.scoreMeaning);

  const blocks=d.blocks.map(b=>{
    const core=renoTime(b.coreStartIso,{weekday:"short",month:"short",day:"numeric",hour:"numeric",hour12:true})
      +" – "+renoTime(b.coreEndIso,{hour:"numeric",hour12:true});
    const ext=b.extended
      ? "<div class='blk-ext'>extend to "+renoTime(b.startIso,{hour:"numeric",hour12:true})
        +" – "+renoTime(b.endIso,{hour:"numeric",hour12:true})+"</div>"
      : "";
    return "<div class='blk'>"
      +"<div class='blk-head'><span class='blk-rank'>#"+b.rank+"</span>"
      +"<span class='blk-score'>"+b.coreTotalScore+" ("+b.extendedTotalScore+" / "+b.extendedAvgScore+" avg)</span></div>"
      +"<div class='blk-when'>"+core+"</div>"+ext
      +"<div class='blk-hours'>"+b.hours+" hours</div>"
      +"</div>";
  }).join("");

  const compliance=d.complianceNotes&&d.complianceNotes.length
    ? "<div class='compliance'>"+d.complianceNotes.map(n=>"⚠ "+n).join("<br>")+"</div>"
    : "";

  byId("driver-blocks").innerHTML=blocks
    +"<div class='blk-total'>Total recommended: "+d.totalRecommendedHours+" hours across "+d.blocks.length+" blocks</div>"
    +compliance
    +"<div class='subtle'>Extensions require the week's 75th-percentile score ("+d.extensionThreshold
    +"). Blocks are kept at least "+d.minStartGapHours+"h apart by the rolling 16h online / 12h passenger-service caps. "
    +esc(d.complianceCaveat||"")+"</div>";

  const daysOff=d.bestDaysOff.map((x,i)=>
    "<div class='dayoff'><span class='dayoff-rank'>Best day off #"+(i+1)+"</span> "
    +renoTime(x.iso,{weekday:"long",month:"short",day:"numeric"})
    +" <span class='subtle'>avg "+x.avgScore+"</span></div>").join("");

  const oneOffs=d.oneOffHours.length
    ? "<div class='oneoff-list'>"+d.oneOffHours.map(h=>
        "<div class='oneoff'><b>"+renoTime(h.iso,{weekday:"short",month:"short",day:"numeric",hour:"numeric",hour12:true})
        +"</b> · "+h.score+"<div class='subtle'>"+esc(h.reasons)+"</div></div>").join("")+"</div>"
    : "<div class='subtle'>"+(d.oneOffMessage||"No exceptional one-off hours this week.")+"</div>";

  byId("driver-daysoff").innerHTML=daysOff
    +"<h4 class='oneoff-head'>Optional one-off hours (81.6+)</h4>"+oneOffs;

  byId("driver-rank-count").textContent="(all "+d.hours.length+", best to worst)";
  const rows=d.hours.map(h=>
    "<tr><td>"+h.rank+"</td>"
    +"<td>"+renoTime(h.iso,{weekday:"short",month:"short",day:"numeric"})+"</td>"
    +"<td>"+renoTime(h.iso,{hour:"numeric",hour12:true})+"</td>"
    +"<td class='num'>"+h.score.toFixed(1)+"</td>"
    +"<td class='conf conf-"+esc(String(h.confidence).toLowerCase())+"'>"+esc(h.confidence)+"</td>"
    +"<td class='plat'>"+esc(h.platform)+"</td>"
    +"<td class='num'>$"+h.uberHourly.toFixed(0)+"</td>"
    +"<td class='num'>"+h.expectedTph.toFixed(2)+"</td>"
    +"<td class='reasons'>"+esc(h.reasons)+"</td></tr>").join("");
  byId("driver-hours").innerHTML=
    "<table class='dtable'><thead><tr><th>#</th><th>Date</th><th>Hour</th><th>Score</th><th>Conf</th>"
    +"<th>Platform</th><th>~$/hr</th><th>TPH</th><th>Primary reasons</th></tr></thead><tbody>"
    +rows+"</tbody></table>"
    +"<div class='subtle' style='padding:8px 0'>~$/hr is a downstream calibration of the relative score against a neutral-week level, not a prediction of actual earnings.</div>";
}

function money(v){
  const n=Number(v);
  if(!Number.isFinite(n))return "—";
  return (n<0?"-$":"$")+Math.abs(n).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
}

function signClass(v){
  const n=Number(v);
  if(!Number.isFinite(n)||n===0)return "";
  return n>0?"pos":"neg";
}

async function loadStocks(){
  byId("stocks-status").textContent="Loading Alpaca account...";

  try{
    const r=await fetch("/trading-data",{
      headers:{"X-Agent-Passcode":passcode}
    });

    if(r.status===401){
      byId("login-overlay").style.display="flex";
      byId("stocks-status").textContent="Wrong passcode";
      return;
    }

    const data=await r.json();

    if(!r.ok){
      byId("stocks-status").textContent=data.error||"Load failed";
      return;
    }

    renderStocks(data);
    stocksLoaded=true;
    byId("stocks-status").textContent="Updated "+new Date().toLocaleTimeString();
  }catch(e){
    byId("stocks-status").textContent="Error: "+e.message;
  }
}

function renderStocks(data){
  const live=data.mode==="LIVE";
  const pill=byId("stocks-mode");
  pill.textContent=data.mode||"—";
  pill.classList.toggle("live",live);

  const a=data.account||{};

  byId("stocks-summary").innerHTML=[
    ["Equity",money(a.equity),""],
    ["Cash",money(a.cash),""],
    ["Buying power",money(a.buyingPower),""],
    ["Day P&L",money(a.dayPnl)+" ("+(a.dayPnlPercent??0)+"%)",signClass(a.dayPnl)],
    ["Positions",String((data.positions||[]).length),""],
    ["Status",esc(a.status||"—"),""]
  ].map(([label,value,cls])=>
    '<div class="stat"><div class="n '+cls+'">'+value+'</div><div class="l">'+label+'</div></div>'
  ).join("");

  const positions=(data.positions||[])
    .slice()
    .sort((a,b)=>Number(a.unrealizedPl||0)-Number(b.unrealizedPl||0));

  byId("positions-wrap").innerHTML=positions.length===0
    ? '<div class="empty">No open positions.</div>'
    : positions.map(p=>
        '<div class="card">'
        +'<div class="card-top">'
        +'<span class="card-sym">'+esc(p.symbol)+'</span>'
        +'<span class="card-qty">'+p.qty+' sh</span>'
        +'<span class="card-val">'+money(p.marketValue)+'</span>'
        +'</div>'
        +'<div class="card-bot">'
        +'<span>'+money(p.avgEntryPrice)+' &rarr; '+money(p.currentPrice)+'</span>'
        +'<span class="card-pnl '+signClass(p.unrealizedPl)+'">'
        +money(p.unrealizedPl)+' ('+p.unrealizedPlPercent+'%)'
        +'</span>'
        +'</div>'
        +'</div>'
      ).join("");

  const orders=data.orders||[];
  byId("orders-wrap").innerHTML=orders.length===0
    ? '<div class="empty">No recent orders.</div>'
    : orders.map(o=>
        '<div class="card">'
        +'<div class="card-top">'
        +'<span class="card-sym">'+esc(o.symbol)+'</span>'
        +'<span class="pill '+(o.side==="buy"?"buy":"sell")+'">'+esc(o.side)+'</span>'
        +'<span class="card-qty">'+esc(o.type)+'</span>'
        +'<span class="card-val">'+(o.qty??o.notional??"—")+'</span>'
        +'</div>'
        +'<div class="card-bot">'
        +'<span>'+esc(o.status)
        +(o.filledAvgPrice?' @ '+money(o.filledAvgPrice):"")+'</span>'
        +'<span class="card-pnl" style="color:#777;font-weight:400">'
        +(o.submittedAt?new Date(o.submittedAt).toLocaleString(undefined,{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"}):"—")
        +'</span>'
        +'</div>'
        +'</div>'
      ).join("");

  const g=data.guardrails||{};
  byId("guardrails-wrap").innerHTML=[
    ["Max trades/day",g.maxTradesPerDay],
    ["Max position",money(g.maxPositionUsd)],
    ["Max daily loss",money(g.maxDailyLossUsd)],
    ["Cooldown",(g.cooldownMinutes??"—")+" min"]
  ].map(([label,value])=>
    '<div class="guard"><div class="n">'+value+'</div><div class="l">'+label+'</div></div>'
  ).join("");
}

function esc(value){
  return String(value??"")
    .replace(/&/g,"&amp;")
    .replace(/</g,"&lt;")
    .replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;");
}

function num(v){
  const n=parseFloat(String(v??"").replace(/[^0-9.-]/g,""));
  return Number.isFinite(n)?n:0;
}

function str(v){return String(v??"").trim()}

function normalizeChannel(raw){
  return {
    kind:"channel",
    id:str(raw["Channel ID"]),
    name:str(raw["Channel"]),
    market:str(raw["Market"]||raw["City Group"]),
    type:str(raw["Channel Type"]),
    category:str(raw["Connector Type"]),
    family:str(raw["Parent / Branch Source"]),
    priority:str(raw["Priority"]),
    state:str(raw["Actionability State"]),
    policy:str(raw["Policy Compatibility"]),
    referral:str(raw["Referral-System Match"]),
    topTier:str(raw["Top-Tier Candidate"]),
    quality:num(raw["Quality Score"]),
    scalability:num(raw["Scalability Score"]),
    recommendation:num(raw["Recommendation Score"]),
    last:str(raw["Last Checked"]||raw["Policy Checked At (PT)"]),
    status:str(raw["Status"]),
    confidence:str(raw["Verification Confidence"]),
    raw
  };
}

function normalizeProspect(raw){
  return {
    kind:"prospect",
    id:str(raw["Prospect ID"]),
    name:str(raw["Business"]),
    market:str(raw["Market"]),
    type:str(raw["Category"]),
    category:str(raw["Referral Fit"]),
    family:str(raw["Eligibility"]),
    priority:String(raw["Prospect Score"]??""),
    state:str(raw["Outreach State"]||raw["Eligibility"]),
    policy:"",
    referral:str(raw["Referral Fit"]),
    topTier:"",
    quality:num(raw["Prospect Score"]),
    scalability:0,
    recommendation:0,
    last:str(raw["Last Checked"]||raw["First Found"]),
    status:str(raw["Eligibility"]),
    confidence:str(raw["Verification Confidence"]),
    raw
  };
}

function normalizeConnectorCandidate(raw){
  return {
    kind:"connectorCandidate",
    id:str(raw["Candidate ID"]),
    name:str(raw["Candidate / Organization"]),
    market:str(raw["Market"]),
    type:str(raw["Source Family"]),
    category:str(raw["Connector Role(s)"]),
    family:str(raw["Discovery Source"]||raw["Source Family"]),
    priority:str(raw["Qualification Priority"]),
    state:str(raw["Universe State"]),
    policy:str(raw["Policy Status"]),
    referral:"",
    topTier:"",
    quality:0,
    scalability:0,
    recommendation:0,
    last:str(raw["Discovered At (PT)"]),
    status:str(raw["Universe State"]),
    confidence:"",
    raw
  };
}

function normalizeBusinessCandidate(raw){
  return {
    kind:"businessCandidate",
    id:str(raw["Candidate ID"]),
    name:str(raw["Business / Venue"]),
    market:str(raw["Market"]),
    type:str(raw["Category"]),
    category:"",
    family:str(raw["Universe State"]),
    priority:str(raw["Qualification Priority"]),
    state:str(raw["Universe State"]),
    policy:"",
    referral:"",
    topTier:"",
    quality:0,
    scalability:0,
    recommendation:0,
    last:str(raw["Discovered At (PT)"]),
    status:str(raw["Universe State"]),
    confidence:"",
    raw
  };
}

function rankRecord(r){
  let score=0;

  if(r.kind==="channel"){
    score+=40000;

    const action=r.state.toUpperCase();

    if(action==="READY")score+=18000;
    else if(action==="APPROVAL REQUIRED")score+=15000;
    else if(action==="POLICY REVIEW")score+=7000;
    else if(action==="INSTITUTIONAL ONLY")score+=4000;
    else if(action==="BLOCKED")score-=5000;

    if(r.topTier.toUpperCase()==="TOP TIER")score+=25000;

    const referral=r.referral.toUpperCase();
    if(referral==="YES"||referral==="EXPLICIT")score+=7000;
    else if(referral==="PARTIAL")score+=2500;

    if(r.priority.toUpperCase()==="A")score+=5000;
    else if(r.priority.toUpperCase()==="B")score+=2500;

    score+=r.quality*20;
    score+=r.scalability*120;
    score+=r.recommendation*5;

    if(r.confidence.toUpperCase()==="HIGH")score+=800;
    else if(r.confidence.toUpperCase()==="MEDIUM")score+=400;
  }

  if(r.kind==="prospect"){
    score+=30000;

    const state=r.state.toUpperCase();
    const status=r.status.toUpperCase();

    if(status==="ELIGIBLE")score+=8000;
    if(state==="READY")score+=5000;
    if(state==="DRAFTED")score+=4500;

    score+=r.quality*30;

    const fit=r.referral.toUpperCase();
    if(fit.includes("VERY HIGH"))score+=5000;
    else if(fit.includes("HIGH"))score+=3500;
    else if(fit.includes("MEDIUM"))score+=1500;
  }

  if(r.kind==="connectorCandidate"){
    score+=18000;

    if(r.priority.toUpperCase()==="HIGH")score+=5000;
    else if(r.priority.toUpperCase()==="MEDIUM")score+=2500;

    if(r.policy.toUpperCase().includes("PENDING"))score+=500;
  }

  if(r.kind==="businessCandidate"){
    score+=12000;

    if(r.priority.toUpperCase()==="HIGH")score+=5000;
    else if(r.priority.toUpperCase()==="MEDIUM")score+=2500;
  }

  r.rankScore=score;
  return score;
}

function buildRows(data){
  const out=[];

  for(const r of data.channels||[])out.push(normalizeChannel(r));
  for(const r of data.prospects||[])out.push(normalizeProspect(r));
  for(const r of data.connectorCandidates||[])out.push(normalizeConnectorCandidate(r));
  for(const r of data.businessCandidates||[])out.push(normalizeBusinessCandidate(r));

  out.forEach(rankRecord);

  return out;
}

async function loadResearch(){
  byId("load-status").textContent="Loading live Sheet data...";

  try{
    const r=await fetch("/research-data",{
      headers:{"X-Agent-Passcode":passcode}
    });

    if(r.status===401){
      byId("login-overlay").style.display="flex";
      byId("load-status").textContent="Wrong passcode";
      return;
    }

    const data=await r.json();

    if(!r.ok){
      byId("load-status").textContent=data.error||"Load failed";
      return;
    }

    activeMarket=data.activeMarket||null;
    researchRows=buildRows(data);

    populateMarkets();
    updateSummary();
    renderResearch();

    byId("row-count").textContent=researchRows.length+" records";
    byId("load-status").textContent="Live";
  }catch(e){
    byId("load-status").textContent="Error: "+e.message;
  }
}

function populateMarkets(){
  const select=byId("market-filter");
  const old=select.value;

  const markets=[...new Set(
    researchRows.map(r=>r.market).filter(Boolean)
  )].sort((a,b)=>a.localeCompare(b));

  select.innerHTML='<option value="">All markets</option>';

  for(const market of markets){
    const option=document.createElement("option");
    option.value=market;
    option.textContent=market;
    select.appendChild(option);
  }

  if(markets.includes(old))select.value=old;
}

function updateSummary(){
  const channels=researchRows.filter(r=>r.kind==="channel");
  const prospects=researchRows.filter(r=>r.kind==="prospect");
  const raw=researchRows.filter(
    r=>r.kind==="connectorCandidate"||r.kind==="businessCandidate"
  );

  const top=channels.filter(
    r=>r.topTier.toUpperCase()==="TOP TIER"
  );

  const ready=channels.filter(
    r=>r.state.toUpperCase()==="READY"
  );

  const review=channels.filter(
    r=>r.state.toUpperCase()==="POLICY REVIEW"
  );

  byId("s-total").textContent=researchRows.length;
  byId("s-channels").textContent=channels.length;
  byId("s-prospects").textContent=prospects.length;
  byId("s-raw").textContent=raw.length;
  byId("s-top").textContent=top.length;
  byId("s-ready").textContent=ready.length;
  byId("s-review").textContent=review.length;

  byId("s-market").textContent=
    activeMarket?
      (activeMarket.marketId||activeMarket["Market ID"]||"ACTIVE"):
      "—";
}

function filteredRows(){
  const q=byId("search").value.trim().toLowerCase();
  const kind=byId("kind-filter").value;
  const market=byId("market-filter").value;
  const state=byId("state-filter").value.toUpperCase();
  const special=byId("special-filter").value;

  let rows=researchRows.filter(r=>{
    if(kind && r.kind!==kind)return false;
    if(market && r.market!==market)return false;

    if(state){
      const hay=(r.state+" "+r.status+" "+r.policy).toUpperCase();
      if(!hay.includes(state))return false;
    }

    if(special==="top" && r.topTier.toUpperCase()!=="TOP TIER")
      return false;

    if(special==="actionable" &&
      !["READY","APPROVAL REQUIRED"].includes(r.state.toUpperCase()))
      return false;

    if(special==="referral" &&
      !(r.referral||"").trim())
      return false;

    if(special==="policy" &&
      !["POLICY REVIEW","INSTITUTIONAL ONLY"].includes(r.state.toUpperCase()))
      return false;

    if(q){
      const hay=[
        r.id,r.name,r.market,r.type,r.category,r.family,r.priority,
        r.state,r.policy,r.referral,r.topTier,r.status,r.confidence
      ].join(" ").toLowerCase();

      if(!hay.includes(q))return false;
    }

    return true;
  });

  const sort=byId("sort-select").value;

  rows.sort((a,b)=>{
    if(sort==="market")
      return a.market.localeCompare(b.market)||b.rankScore-a.rankScore;

    if(sort==="quality")
      return b.quality-a.quality||b.rankScore-a.rankScore;

    if(sort==="scalability")
      return b.scalability-a.scalability||b.rankScore-a.rankScore;

    if(sort==="latest")
      return String(b.last).localeCompare(String(a.last));

    if(sort==="name")
      return a.name.localeCompare(b.name);

    return b.rankScore-a.rankScore;
  });

  return rows;
}

function stateClass(v){
  const s=String(v||"").toUpperCase();

  if(s==="READY"||s==="COMPATIBLE"||s==="ELIGIBLE")
    return "good";

  if(s==="APPROVAL REQUIRED"||s==="CONDITIONAL"||s==="POLICY REVIEW")
    return "warn";

  if(s==="BLOCKED"||s==="INCOMPATIBLE")
    return "bad";

  return "";
}

function renderResearch(){
  let rows=filteredRows();
  const totalMatched=rows.length;

  const limitValue=byId("limit-select").value;
  const limit=limitValue==="all"?rows.length:parseInt(limitValue,10);

  rows=rows.slice(0,limit);

  const body=byId("results-body");
  body.innerHTML="";

  rows.forEach((r,i)=>{
    const tr=document.createElement("tr");

    tr.innerHTML=
      '<td class="rank">'+(i+1)+'</td>'+
      '<td><span class="kind-pill kind-'+esc(r.kind)+'">'+
        esc(
          r.kind==="channel"?"Channel":
          r.kind==="prospect"?"Prospect":
          r.kind==="connectorCandidate"?"Connector raw":"Business raw"
        )+
      '</span></td>'+
      '<td class="market">'+esc(r.market)+'</td>'+
      '<td class="id">'+esc(r.id)+'</td>'+
      '<td class="name">'+esc(r.name)+'</td>'+
      '<td>'+esc(r.type||r.family)+'</td>'+
      '<td>'+esc(r.category)+'</td>'+
      '<td>'+esc(r.priority)+'</td>'+
      '<td class="'+stateClass(r.state)+'">'+esc(r.state)+'</td>'+
      '<td class="'+stateClass(r.policy)+'">'+esc(r.policy)+'</td>'+
      '<td>'+esc(r.referral)+'</td>'+
      '<td class="'+(r.topTier.toUpperCase()==="TOP TIER"?"top-tier":"")+'">'+
        esc(r.topTier)+
      '</td>'+
      '<td>'+esc(r.quality||"")+'</td>'+
      '<td>'+esc(r.scalability||"")+'</td>'+
      '<td>'+esc(r.recommendation||"")+'</td>'+
      '<td class="muted">'+esc(r.last)+'</td>';

    tr.onclick=()=>openDetail(r);
    body.appendChild(tr);
  });

  byId("visible-info").textContent=
    "Showing "+rows.length+" of "+totalMatched+
    " matched · "+researchRows.length+" total loaded";
}

function openDetail(row){
  byId("modal-name").textContent=row.name||row.id||"Record";

  const grid=byId("detail-grid");
  grid.innerHTML="";

  const preferred=[
    "Channel ID","Prospect ID","Candidate ID",
    "Channel","Business","Candidate / Organization","Business / Venue",
    "Market","Sub-zone",
    "Channel Type","Connector Type","Source Family","Connector Role(s)","Category",
    "Priority","Quality Score","Scalability Score","Priority Score",
    "Actionability State","Actionable Score",
    "Policy Compatibility","Acquisition Scope","Policy Status",
    "Referral-System Match","Referral-System Evidence","Top-Tier Candidate",
    "Eligibility","Eligibility Reason","Referral Fit","Prospect Score","Outreach State",
    "Primary URL","Website / Source URL","Evidence Source","Source URL",
    "Public Email","Public Contact URL","Phone","Contact / Access",
    "Parent / Branch Source","Discovery Source",
    "Verification Confidence",
    "First Found","Discovered At (PT)","Last Checked","Policy Checked At (PT)",
    "Notes","Policy Gate Notes"
  ];

  const used=new Set();

  function addField(k,v){
    if(v===undefined||v===null||String(v).trim()==="")return;

    const dk=document.createElement("div");
    dk.className="dk";
    dk.textContent=k;

    const dv=document.createElement("div");
    dv.className="dv";
    dv.textContent=String(v);

    grid.appendChild(dk);
    grid.appendChild(dv);
    used.add(k);
  }

  for(const k of preferred){
    if(Object.prototype.hasOwnProperty.call(row.raw,k))
      addField(k,row.raw[k]);
  }

  for(const [k,v] of Object.entries(row.raw)){
    if(k==="_rowIndex"||used.has(k))continue;
    addField(k,v);
  }

  byId("modal").classList.add("open");
}

byId("close-modal").onclick=()=>byId("modal").classList.remove("open");
byId("modal").onclick=e=>{
  if(e.target===byId("modal"))
    byId("modal").classList.remove("open");
};

for(const id of [
  "search","kind-filter","market-filter","state-filter",
  "special-filter","sort-select","limit-select"
]){
  byId(id).addEventListener(
    id==="search"?"input":"change",
    renderResearch
  );
}

document.querySelectorAll("th[data-sort]").forEach(th=>{
  th.onclick=()=>{
    byId("sort-select").value=th.dataset.sort;
    renderResearch();
  };
});

byId("refresh-btn").onclick=loadResearch;


// ============================================================
// CHAT
// ============================================================

byId("send-btn").onclick=sendMsg;
byId("message").onkeydown=e=>{
  if(e.key==="Enter"&&!e.shiftKey){
    e.preventDefault();
    sendMsg();
  }
};

function addMsg(text,cls){
  const c=byId("chat");
  const d=document.createElement("div");

  d.className="msg "+cls;
  d.textContent=text;

  c.appendChild(d);
  d.scrollIntoView({behavior:"smooth",block:"end"});
}

async function sendMsg(){
  const ta=byId("message");
  const text=ta.value.trim();

  if(!text)return;

  addMsg(text,"me");
  ta.value="";
  byId("send-btn").disabled=true;

  try{
    const r=await fetch("/chat",{
      method:"POST",
      headers:{
        "Content-Type":"application/json",
        "X-Agent-Passcode":passcode,
        "X-Session-Id":activeSlot
      },
      body:JSON.stringify({message:text})
    });

    const data=await r.json();

    if(r.status===401){
      addMsg("Wrong passcode.","bot");
      byId("login-overlay").style.display="flex";
      return;
    }

    if(data.provider && data.provider.startsWith("fallback:")){
      addMsg("⚠ Anthropic unavailable — answered by fallback model ("+data.provider.slice(9)+"). Same rules, weaker model; verify anything important.","bot");
    }
    addMsg(data.reply||data.error||"No response","bot");

    if(data.leadSaved)
      loadResearch();

  }catch(e){
    addMsg("Error: "+e.message,"bot");
  }

  byId("send-btn").disabled=false;
}

setInterval(loadResearch,180000);
</script>

</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  function send(status, body, type) {
    res.writeHead(status, {"Content-Type": type||"application/json","Cache-Control":"no-store"});
    res.end(type==="text/html" ? body : JSON.stringify(body));
  }
  function auth() {
    return process.env.AGENT_PASSCODE &&
      req.headers["x-agent-passcode"] === process.env.AGENT_PASSCODE;
  }
  async function readBody() {
    let raw="";
    for await (const chunk of req) raw+=chunk;
    return JSON.parse(raw||"{}");
  }

  if (req.method==="GET" && req.url==="/") return send(200, htmlPage(), "text/html");

  // GET /health — deliberately unauthenticated: a monitor pinging this
  // has to work even when it doesn't carry AGENT_PASSCODE. Kept to the
  // scheduler heartbeat only (schedulerHeartbeat — no run in far longer
  // than the configured interval means the process itself may have
  // stopped, not just declined to trade), so an external uptime check can
  // catch the case a run-triggered email never could: the scheduler going
  // silent entirely. This deliberately does NOT include getAlertStatus()'s
  // lastAlert — its reason text can embed account P&L (see the daily-loss
  // case in alerts.js), which has no business being readable without
  // AGENT_PASSCODE. That fuller picture is in GET /autotrader-data instead.
  if (req.method==="GET" && req.url==="/health") {
    try {
      const heartbeat = autoTraderHeartbeat();
      return send(heartbeat.alive === false ? 503 : 200, {
        ok: heartbeat.alive !== false,
        heartbeat,
        alertingConfigured: autoTraderAlertStatus().configured
      });
    } catch (e) {
      return send(500, { ok: false, error: String(e.message || e) });
    }
  }

  if (req.method==="GET" && req.url==="/leads") {
    if (!auth()) return send(401,{error:"Unauthorized"});
    return send(200, loadLeads());
  }

  // --- History export ---------------------------------------------
  //
  // The run archive lives on a Railway volume, which is reachable from
  // nowhere except this process. This streams it out so a copy can be
  // kept on hardware you own.
  //
  // It supports a byte offset so repeated backups send only what is new:
  // ask for the size, then request from where you left off. Over mobile
  // data that is the difference between re-downloading the whole history
  // every time and downloading the day's handful of KB.
  if (req.method==="GET" && req.url.startsWith("/export-history")) {
    if (!auth()) return send(401,{error:"Unauthorized"});

    try {
      const url = new URL(req.url, "http://localhost");
      const plan = resolveExport({
        file: url.searchParams.get("file"),
        offset: url.searchParams.get("offset")
      });

      if (!plan.ok) return send(plan.status, { error: plan.error });

      // meta=1 answers "how much is there?" without transferring it, so a
      // backup script can decide whether there is anything worth fetching.
      if (url.searchParams.get("meta") === "1") {
        return send(200, {
          file: plan.name,
          exists: plan.exists,
          bytes: plan.size,
          appendOnly: plan.appendOnly,
          storage: autoTraderHistoryInfo(),
          hint: "Request the same file with ?offset=<bytes you already have> to fetch only what is new."
        });
      }

      const headers = {
        "content-type": "text/plain",
        "x-total-bytes": String(plan.size),
        "x-offset": String(plan.start),
        "x-new-bytes": String(plan.newBytes),
        "x-restarted": plan.restarted ? "1" : "0"
      };

      if (!plan.exists || plan.newBytes === 0) {
        res.writeHead(200, headers);
        return res.end("");
      }

      res.writeHead(200, headers);
      return fs.createReadStream(plan.path, { start: plan.start }).pipe(res);
    } catch (e) {
      return send(500, { error: String(e.message || e) });
    }
  }

  if (req.method==="GET" && req.url==="/autotrader-data") {
    if (!auth()) return send(401,{error:"Unauthorized"});
    try {
      return send(200, {
        status: autoTraderStatus(),
        runs: autoTraderRuns(10),
        heartbeat: autoTraderHeartbeat(),
        alerting: autoTraderAlertStatus(),
        configDetails: autoTraderConfigDetails()
      });
    } catch (e) {
      return send(500, { error: String(e.message || e) });
    }
  }

  if (req.method==="GET" && req.url.startsWith("/reno-schedule")) {
    if (!auth()) return send(401,{error:"Unauthorized"});
    try {
      // If the chat has already run a schedule (with researched evidence),
      // show that one. Otherwise compute the baseline ranking on demand, and
      // say plainly that it carries no evidence — an evidence-free ranking
      // presented as if it knew about this week's events would be a lie.
      const fresh = new URL(req.url, "http://x").searchParams.get("fresh") === "1";
      const result = !fresh && lastRenoSchedule ? lastRenoSchedule : scheduleReno({});
      if (fresh || !lastRenoSchedule) lastRenoSchedule = result;

      const evidenceCount = result.hours.reduce((s, h) => s + h.applied.length, 0);

      return send(200, {
        algorithmVersion: result.algorithmVersion,
        formulaFingerprint: result.formulaFingerprint,
        weekStart: result.weekStart,
        evidenceApplied: evidenceCount,
        evidenceNote: evidenceCount === 0
          ? "Baseline only — no researched evidence applied. This reflects normal Reno hour/day patterns, not this week's actual events, weather, flights, or closures."
          : `${evidenceCount} evidence application(s) across the week.`,
        scoreMeaning: "Relative weekly opportunity score (0-100), not dollars/hour and not a probability.",
        coverage: result.coverage,
        extensionThreshold: result.extensionThreshold,
        minStartGapHours: result.minStartGapHours,
        hours: result.ranked.map((h) => ({
          rank: h.rank,
          iso: h.date.toISOString(),
          weekday: h.weekday,
          hour: h.hour,
          score: Math.round(h.score * 10) / 10,
          confidence: h.confidenceLabel,
          platform: h.platform,
          uberHourly: Math.round(h.income.uber * 100) / 100,
          lyftHourly: Math.round(h.income.lyft * 100) / 100,
          expectedTph: Math.round(h.expectedTph * 100) / 100,
          reasons: h.reasons
        })),
        blocks: result.blocks.map((b) => ({
          rank: b.rank,
          startIso: b.startDate.toISOString(),
          endIso: b.endDate.toISOString(),
          coreStartIso: b.coreStartDate.toISOString(),
          coreEndIso: b.coreEndDate.toISOString(),
          hours: b.hoursCount,
          coreTotalScore: b.coreTotalScore,
          extendedTotalScore: b.extendedTotalScore,
          extendedAvgScore: b.extendedAvgScore,
          extended: b.hasExtension
        })),
        totalRecommendedHours: result.totalRecommendedHours,
        complianceNotes: result.complianceNotes,
        complianceCaveat: result.complianceCaveat,
        bestDaysOff: result.bestDaysOff.map((d) => ({
          iso: d.date.toISOString(),
          avgScore: Math.round(d.avgScore * 10) / 10
        })),
        oneOffHours: result.oneOffHours.map((h) => ({ iso: h.date.toISOString(), score: h.score, reasons: h.reasons })),
        oneOffMessage: result.oneOffMessage
      });
    } catch (e) {
      return send(500, { error: String(e.message || e) });
    }
  }

  if (req.method==="POST" && req.url==="/autotrader-run") {
    if (!auth()) return send(401,{error:"Unauthorized"});
    try {
      const body = await readBody();
      const run = await autoTradeRunOnce({
        force: Boolean(body.force),
        mode: body.mode
      });
      return send(200, run);
    } catch (e) {
      return send(500, { error: String(e.message || e) });
    }
  }

  if (req.method==="POST" && req.url==="/autotrader-kill") {
    if (!auth()) return send(401,{error:"Unauthorized"});
    try {
      const body = await readBody();
      return send(200, setKillSwitch(Boolean(body.engaged), body.reason || null));
    } catch (e) {
      return send(500, { error: String(e.message || e) });
    }
  }

  if (req.method==="GET" && req.url==="/trading-data") {
    if (!auth()) return send(401,{error:"Unauthorized"});
    try {
      const [account, positions, orders] = await Promise.all([
        getAccount(),
        getPositions(),
        getOrders({ limit: 25 })
      ]);
      return send(200, {
        mode: isLiveEndpoint() ? "LIVE" : "PAPER",
        guardrails: TRADING_LIMITS,
        account,
        positions,
        orders,
        tradeLog: getTradeLog(25)
      });
    } catch (e) {
      return send(500, { error: String(e.message || e) });
    }
  }

  if (req.method==="POST" && req.url==="/chat") {
    if (!auth()) return send(401,{error:"Wrong passcode"});
    const body = await readBody();
    const message = String(body.message||"").trim();
    if (!message) return send(400,{error:"Message required"});
    const slot = resolveSlot(req.headers["x-session-id"]);
    const history = historyForSlot(slot);

    if (message.toUpperCase()==="LIST LEADS") {
      const leads = loadLeads();
      const reply = leads.length===0
        ? "No leads tracked yet. Paste a lead row to get started."
        : "Tracked leads:\n\n"+leads.map(l=>
            `${l.id||"?"} — ${l.name} [${l.tier||"?"}] ${l.status||"New"} · Follow-up: ${l.nextFollowUp||"not set"}`
          ).join("\n");
      history.push({role:"user",content:message});
      history.push({role:"assistant",content:reply});
      saveHistoryForSlot(slot);
      return send(200,{reply});
    }

    try {
      const { text: reply, provider } = await askClaude(history, message);
      history.push({role:"user",content:message});
      history.push({role:"assistant",content:reply});
      saveHistoryForSlot(slot);
      const lead = await extractAndSaveLead(reply);
      return send(200,{reply:cleanReply(reply), leadSaved:!!lead, provider});
    } catch(e) {
      console.error("Claude error",e.message);
      return send(502,{error:"Model error: "+e.message});
    }
  }

  // GET /chat-history — replay a slot's conversation so switching to it
  // (or reopening the console, on a new page load, a different device,
  // or after a Railway restart) restores what was actually said instead
  // of starting from an empty pane pretending nothing was ever said.
  // For the "chat" slot this is real persisted history; for a "2"-"5"
  // side slot it's just whatever survived in this process's memory.
  if (req.method==="GET" && req.url==="/chat-history") {
    if (!auth()) return send(401,{error:"Unauthorized"});
    const slot = resolveSlot(req.headers["x-session-id"]);
    return send(200, { messages: historyForSlot(slot) });
  }

  // POST /chat-reset — an explicit "start a new conversation" action.
  // Only clears the one slot named by X-Session-Id; every other slot
  // (the main "chat", or another side slot) is untouched.
  if (req.method==="POST" && req.url==="/chat-reset") {
    if (!auth()) return send(401,{error:"Unauthorized"});
    const slot = resolveSlot(req.headers["x-session-id"]);
    resetHistoryForSlot(slot);
    return send(200, { ok: true });
  }

  if (req.method==="POST" && req.url==="/send-email") {
    if (!auth()) return send(401,{error:"Unauthorized"});
    const body = await readBody();
    const lead = getLeadById(body.leadId);
    if (!lead) return send(404,{error:"Lead not found"});
    if (!lead.outreachEmail||!lead.contact) return send(400,{error:"No email data for this lead"});

    const REQUIRED_GMAIL = "referralmarket.site@gmail.com";
    const gmailUser = String(process.env.GMAIL_USER || "").trim().toLowerCase();

    if (!gmailUser || !process.env.GMAIL_APP_PASSWORD) {
      return send(200,{
        ok:false,
        message:"ReferralMarket business Gmail is not configured."
      });
    }

    if (gmailUser !== REQUIRED_GMAIL) {
      return send(403,{
        ok:false,
        blocked:true,
        error:
          "Wrong Gmail account configured. ReferralMarket email must use " +
          REQUIRED_GMAIL
      });
    }

    try {
      const {createTransport} = await import("nodemailer");
      const transporter = createTransport({
        service:"gmail",
        auth:{
          user:REQUIRED_GMAIL,
          pass:process.env.GMAIL_APP_PASSWORD
        }
      });
      await transporter.sendMail({
        from:REQUIRED_GMAIL,
        to:lead.contact,
        subject:lead.outreachEmail.subject,
        text:lead.outreachEmail.body
      });
      lead.log=lead.log||[];
      lead.log.push({date:new Date().toISOString(),action:"Email sent",subject:lead.outreachEmail.subject});
      lead.status="Contacted";
      upsertLead(lead);
      return send(200,{ok:true,message:"Email sent to "+lead.contact});
    } catch(e) {
      return send(500,{error:"Send failed: "+e.message});
    }
  }

  // GET /research-data
  // Read-only high-volume pre-launch calibration dataset.
  if (req.method==="GET" && req.url==="/research-data") {
    if (!auth()) return send(401,{error:"Unauthorized"});

    try {
      let activeMarket = null;

      try {
        activeMarket = await readActiveMarket();
      } catch (e) {
        activeMarket = null;
      }

      const [
        channels,
        prospects,
        connectorCandidates,
        businessCandidates
      ] = await Promise.all([
        readAllLeads(),
        readBusinessProspects(),
        readConnectorCandidateUniverse(),
        readBusinessCandidateUniverse()
      ]);

      return send(200,{
        activeMarket,
        counts:{
          channels:channels.length,
          prospects:prospects.length,
          connectorCandidates:connectorCandidates.length,
          businessCandidates:businessCandidates.length,
          total:
            channels.length+
            prospects.length+
            connectorCandidates.length+
            businessCandidates.length
        },
        channels,
        prospects,
        connectorCandidates,
        businessCandidates
      });

    } catch(e) {
      console.error("Research data error",e);
      return send(500,{
        error:"Research data failed: "+e.message
      });
    }
  }

  // GET /sheet-sync
  if (req.method==="GET" && req.url==="/sheet-sync") {
    if (!auth()) return send(401,{error:"Unauthorized"});
    try {
      const activeMarket = await readActiveMarket();
        const leads = await readAllLeads();
        const queue = pickDailyQueue(leads, activeMarket);

        return send(200,{
          total: leads.length,
          runMarket: activeMarket.canonicalMarket,
          marketId: activeMarket.marketId,
          queue: queue.length,
          leads: queue
        });
    } catch(e) {
      return send(500,{error:"Sheet sync failed: "+e.message});
    }
  }

  // POST /upsert-lead
  if (req.method==="POST" && req.url==="/upsert-lead") {
    if (!auth()) return send(401,{error:"Unauthorized"});
    const body = await readBody();
    if (body.id && body.name) upsertLead(body);
    return send(200,{ok:true});
  }

  // POST /log-result
  if (req.method==="POST" && req.url==="/log-result") {
    if (!auth()) return send(401,{error:"Unauthorized"});
    const body = await readBody();
    try {
      await updateLeadStatus(body.rowIndex, body.status, body.followUpDate, body.notes);
      return send(200,{ok:true});
    } catch(e) {
      return send(500,{error:"Log failed: "+e.message});
    }
  }

  return send(404,{error:"Not found"});
});

server.listen(PORT,"0.0.0.0",()=>{
  console.log("Darkly Agent v2 running on port "+PORT);

  // Say where state is going and whether it survives a restart. Without
  // this line, a volume that silently failed to mount looks identical in
  // the logs to one that worked, right up until a deploy erases the
  // history and nothing says why.
  const storage = stateInfo();
  console.log(
    `[state] ${storage.directory} — ${storage.durable ? "DURABLE (survives deploys)" : "EPHEMERAL (history will be lost on the next deploy)"}`
  );

  const auto = startAutoTrader();
  if (auto.started) {
    console.log(
      `[autotrader] active: every ${auto.intervalMinutes}m, mode=${auto.mode}`
    );
  } else {
    console.log(`[autotrader] not scheduled: ${auto.reason}`);
  }
});
