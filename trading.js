import { readState, writeState, stateInfo } from "./state.js";

/* ------------------------------------------------------------------ *
 * Config
 * ------------------------------------------------------------------ */

// Defaults to Alpaca paper trading. Switching to live is a deliberate
// env change, never a code change.
const ALPACA_BASE =
  process.env.ALPACA_BASE_URL || "https://paper-api.alpaca.markets/v2";

const ALPACA_KEY_ID = process.env.ALPACA_KEY_ID || "";
const ALPACA_SECRET_KEY = process.env.ALPACA_SECRET_KEY || "";

// Alpaca's market data API. Free accounts get the IEX feed; "sip" needs a
// paid subscription and will 403 without one.
const ALPACA_DATA_BASE =
  process.env.ALPACA_DATA_BASE_URL || "https://data.alpaca.markets/v2";
const ALPACA_FEED = process.env.ALPACA_FEED || "iex";

// AutoTradeFlux's still-live Supabase backend supplies market data / signals.
const SUPABASE_URL =
  process.env.SUPABASE_URL || "https://klwesxkhsuqerpkavuuv.supabase.co";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "";

const TRADE_LOG_FILE = "darkly-trades.json";

export const LIMITS = {
  maxTradesPerDay: Number(process.env.MAX_TRADES_PER_DAY || 10),
  maxPositionUsd: Number(process.env.MAX_POSITION_USD || 1000),
  maxDailyLossUsd: Number(process.env.MAX_DAILY_LOSS_USD || 500),
  cooldownMinutes: Number(process.env.TRADE_COOLDOWN_MINUTES || 5)
};

export function isLiveEndpoint() {
  return !/paper-api\.alpaca\.markets/.test(ALPACA_BASE);
}

/**
 * fetch(), but bounded. Every call in this file used to be a bare
 * fetch() with no timeout — fine as long as the network behaves, but a
 * broker or market-data endpoint that stalls instead of erroring would
 * hang the request forever. Since this process also runs the autotrader
 * on a fixed schedule with no reentrancy protection against a run that
 * never finishes, an indefinitely hanging fetch here was a direct path
 * to that overlap. Same AbortController pattern already used in
 * sources.js/web-read.js/toolkit.js — ported here rather than invented
 * fresh.
 */
const DEFAULT_TIMEOUT_MS = 15000;

export async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (e) {
    if (e.name === "AbortError") {
      throw new Error(`Timed out after ${timeoutMs}ms fetching ${new URL(url).hostname}`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ *
 * Trade log (local, same pattern as darkly-leads.json)
 * ------------------------------------------------------------------ */

function loadTrades() {
  const trades = readState(TRADE_LOG_FILE, []);
  return Array.isArray(trades) ? trades : [];
}

function saveTrades(trades) {
  writeState(TRADE_LOG_FILE, trades);
}

/** Where the trade log lives and whether it survives a restart. */
export function tradeLogInfo() {
  const trades = loadTrades();
  return {
    ...stateInfo(),
    file: TRADE_LOG_FILE,
    entries: trades.length,
    oldestEntry: trades.length ? trades[0].submittedAt || null : null
  };
}

function logTrade(entry) {
  const trades = loadTrades();
  trades.push(entry);
  saveTrades(trades);
  return entry;
}

export function getTradeLog(limit = 50) {
  const trades = loadTrades();
  return trades.slice(-limit).reverse();
}

/**
 * Extract the actual execution from an Alpaca order object, or null if it
 * has not filled. Submitting an order tells you what you asked for; only
 * this tells you what you got, and the difference between them is
 * slippage — the cost that quietly eats systematic strategies alive.
 */
function fillFrom(order) {
  if (!order) return null;

  const price =
    order.filled_avg_price != null && order.filled_avg_price !== ""
      ? Number(order.filled_avg_price)
      : null;
  const qty =
    order.filled_qty != null && order.filled_qty !== ""
      ? Number(order.filled_qty)
      : null;

  if (!Number.isFinite(price) || !Number.isFinite(qty) || price <= 0 || qty <= 0) {
    return null;
  }

  return {
    price,
    qty,
    value: Number((price * qty).toFixed(2)),
    at: order.filled_at || order.updated_at || null,
    status: order.status || null
  };
}

const TERMINAL_UNFILLED = new Set([
  "canceled",
  "cancelled",
  "expired",
  "rejected",
  "suspended",
  "stopped"
]);

/**
 * Ask the broker what actually happened to orders we have only recorded as
 * submitted, and patch the log with real fills.
 *
 * This exists because the trade log was previously a record of intentions.
 * Every entry said what was requested and nothing said what was obtained,
 * which meant the history could not produce a single completed round-trip
 * and the question "how has this actually done?" had no answer available
 * even in principle. Run it before reading performance.
 */
export async function reconcileFills(options = {}) {
  const limit = Math.min(Math.max(Number(options.limit) || 60, 1), 200);
  const maxAttempts = 5;

  const trades = loadTrades();
  const pending = [];

  for (let i = trades.length - 1; i >= 0 && pending.length < limit; i--) {
    const t = trades[i];
    if (!t || !t.accepted || !t.orderId) continue;
    if (t.fill && t.fill.price) continue;
    if (t.unfilled) continue;
    if ((t.fillAttempts || 0) >= maxAttempts) continue;
    pending.push(i);
  }

  let filled = 0;
  let stillOpen = 0;
  let unfilled = 0;
  const errors = [];

  for (const i of pending) {
    const trade = trades[i];
    try {
      const order = await alpacaRequest("GET", `/orders/${trade.orderId}`);
      const fill = fillFrom(order);

      trade.fillAttempts = (trade.fillAttempts || 0) + 1;
      trade.fillCheckedAt = new Date().toISOString();
      trade.orderStatus = order.status || null;

      if (fill) {
        trade.fill = fill;
        filled++;
      } else if (TERMINAL_UNFILLED.has(String(order.status || "").toLowerCase())) {
        // It will never fill. Mark it so it stops being retried and so
        // performance never counts an intention as a trade.
        trade.unfilled = true;
        trade.unfilledReason = order.status;
        unfilled++;
      } else {
        stillOpen++;
      }
    } catch (e) {
      trade.fillAttempts = (trade.fillAttempts || 0) + 1;
      trade.fillLookupError = String(e.message || e);
      errors.push(`${trade.orderId}: ${trade.fillLookupError}`);
    }
  }

  if (pending.length) saveTrades(trades);

  return {
    checked: pending.length,
    filled,
    stillOpen,
    unfilled,
    errors,
    note:
      pending.length === 0
        ? "Nothing to reconcile: every accepted order already has a recorded fill or a terminal status."
        : `Patched ${filled} fill(s) into the trade log.`
  };
}

function todaysTrades() {
  const today = new Date().toISOString().slice(0, 10);
  return loadTrades().filter(
    (t) => t.submittedAt && t.submittedAt.slice(0, 10) === today && t.accepted
  );
}

/* ------------------------------------------------------------------ *
 * Alpaca REST
 * ------------------------------------------------------------------ */

async function alpacaRequest(method, endpoint, body, timeoutMs = DEFAULT_TIMEOUT_MS) {
  if (!ALPACA_KEY_ID || !ALPACA_SECRET_KEY) {
    throw new Error(
      "Alpaca credentials are not configured (ALPACA_KEY_ID / ALPACA_SECRET_KEY)."
    );
  }

  const res = await fetchWithTimeout(`${ALPACA_BASE}${endpoint}`, {
    method,
    headers: {
      "APCA-API-KEY-ID": ALPACA_KEY_ID,
      "APCA-API-SECRET-KEY": ALPACA_SECRET_KEY,
      "Content-Type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  }, timeoutMs);

  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch (e) {
    parsed = { raw: text };
  }

  if (!res.ok) {
    const detail =
      (parsed && (parsed.message || parsed.raw)) || `HTTP ${res.status}`;
    throw new Error(`Alpaca ${method} ${endpoint} failed: ${detail}`);
  }

  return parsed;
}

async function alpacaDataRequest(endpoint) {
  if (!ALPACA_KEY_ID || !ALPACA_SECRET_KEY) {
    throw new Error(
      "Alpaca credentials are not configured (ALPACA_KEY_ID / ALPACA_SECRET_KEY)."
    );
  }

  const res = await fetchWithTimeout(`${ALPACA_DATA_BASE}${endpoint}`, {
    headers: {
      "APCA-API-KEY-ID": ALPACA_KEY_ID,
      "APCA-API-SECRET-KEY": ALPACA_SECRET_KEY
    }
  });

  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch (e) {
    parsed = { raw: text };
  }

  if (!res.ok) {
    const detail =
      (parsed && (parsed.message || parsed.raw)) || `HTTP ${res.status}`;
    throw new Error(`Alpaca data ${endpoint} failed: ${detail}`);
  }

  return parsed;
}

/**
 * Live quotes straight from the broker, for ANY symbol - not just the
 * tracked universe. This is the authoritative price source; the Supabase
 * market table is a historical snapshot and must not be used for pricing.
 */
export async function getQuote(input = {}) {
  const symbols = (Array.isArray(input.symbols) ? input.symbols : [input.symbols])
    .map((s) => String(s || "").trim().toUpperCase())
    .filter(Boolean);

  if (symbols.length === 0) throw new Error("At least one symbol is required.");

  const data = await alpacaDataRequest(
    `/stocks/snapshots?symbols=${encodeURIComponent(symbols.join(","))}&feed=${ALPACA_FEED}`
  );

  const snapshots = data.snapshots || data;
  const quotes = [];
  const missing = [];

  for (const symbol of symbols) {
    const s = snapshots[symbol];
    if (!s) {
      missing.push(symbol);
      continue;
    }

    const last = s.latestTrade || {};
    const day = s.dailyBar || {};
    const prev = s.prevDailyBar || {};
    const price = Number(last.p ?? day.c ?? 0) || null;
    const prevClose = Number(prev.c ?? 0) || null;

    quotes.push({
      symbol,
      price,
      priceAsOf: last.t || day.t || null,
      dayOpen: Number(day.o ?? 0) || null,
      dayHigh: Number(day.h ?? 0) || null,
      dayLow: Number(day.l ?? 0) || null,
      dayVolume: Number(day.v ?? 0) || null,
      prevClose,
      change: price && prevClose ? Number((price - prevClose).toFixed(4)) : null,
      changePercent:
        price && prevClose
          ? Number((((price - prevClose) / prevClose) * 100).toFixed(2))
          : null
    });
  }

  return { feed: ALPACA_FEED, count: quotes.length, quotes, missing };
}

/**
 * How far back to ask for, in calendar days, to stand a good chance of
 * getting `limit` bars of `timeframe`.
 *
 * This exists because of a real bug: Alpaca treats `limit` as a CAP on the
 * response, not as a lookback. With no `start`, the window defaults to the
 * current day, so a 120-bar daily request returned exactly 1 bar per symbol
 * and silently starved the strategy — which then reported a calm
 * "insufficient history" for every symbol as though that were market
 * reality. Always send an explicit start.
 */
export function barsLookbackDays(timeframe, limit) {
  const tf = String(timeframe || "1Day").toLowerCase();
  const m = tf.match(/^(\d+)\s*(min|hour|day|week|month)/);
  const n = m ? Number(m[1]) : 1;
  const unit = m ? m[2] : "day";

  let barsPerTradingDay;
  if (unit === "min") barsPerTradingDay = 390 / n;
  else if (unit === "hour") barsPerTradingDay = 6.5 / n;
  else if (unit === "day") barsPerTradingDay = 1 / n;
  else if (unit === "week") barsPerTradingDay = 1 / (5 * n);
  else barsPerTradingDay = 1 / (21 * n);

  const tradingDays = limit / barsPerTradingDay;

  // ~252 trading days per 365 calendar days, plus padding for holidays,
  // long weekends and halts. Over-asking costs nothing; under-asking
  // silently degrades every signal.
  return Math.ceil(tradingDays * 1.5) + 10;
}

/** Historical bars from Alpaca, oldest first, keyed by symbol. */
export async function getBars(input = {}) {
  const symbols = (Array.isArray(input.symbols) ? input.symbols : [input.symbols])
    .map((s) => String(s || "").trim().toUpperCase())
    .filter(Boolean);

  if (symbols.length === 0) throw new Error("At least one symbol is required.");

  const timeframe = input.timeframe || "1Day";
  const limit = Math.min(Math.max(Number(input.limit) || 120, 30), 1000);

  const start = new Date(
    Date.now() - barsLookbackDays(timeframe, limit) * 86400000
  )
    .toISOString()
    .slice(0, 10);

  const bars = {};
  let pageToken = null;
  let pages = 0;

  // Paginate rather than trust one response: a truncated page would look
  // exactly like a short history, which is the failure we just fixed.
  do {
    const url =
      `/stocks/bars?symbols=${encodeURIComponent(symbols.join(","))}` +
      `&timeframe=${encodeURIComponent(timeframe)}` +
      `&start=${start}&limit=10000&sort=asc` +
      `&feed=${ALPACA_FEED}&adjustment=split` +
      (pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : "");

    const data = await alpacaDataRequest(url);

    for (const [symbol, rows] of Object.entries(data.bars || {})) {
      bars[symbol] = (bars[symbol] || []).concat(rows);
    }

    pageToken = data.next_page_token || null;
    pages++;
  } while (pageToken && pages < 20);

  // Keep the most recent `limit` bars per symbol, still oldest-first.
  for (const symbol of Object.keys(bars)) {
    bars[symbol] = bars[symbol].slice(-limit);
  }

  return bars;
}

/** Alpaca's market clock — the authority on whether trading is possible. */
export async function getClock() {
  const c = await alpacaRequest("GET", "/clock");
  return {
    timestamp: c.timestamp,
    isOpen: Boolean(c.is_open),
    nextOpen: c.next_open,
    nextClose: c.next_close
  };
}

export async function getAccount() {
  const a = await alpacaRequest("GET", "/account");

  const equity = Number(a.equity);
  const lastEquity = Number(a.last_equity);
  const dayPnl = equity - lastEquity;

  return {
    accountNumber: a.account_number,
    status: a.status,
    currency: a.currency,
    equity,
    lastEquity,
    dayPnl: Number(dayPnl.toFixed(2)),
    dayPnlPercent: lastEquity
      ? Number(((dayPnl / lastEquity) * 100).toFixed(2))
      : 0,
    cash: Number(a.cash),
    buyingPower: Number(a.buying_power),
    patternDayTrader: a.pattern_day_trader,
    tradingBlocked: a.trading_blocked,
    mode: isLiveEndpoint() ? "LIVE" : "PAPER"
  };
}

export async function getPositions() {
  const positions = await alpacaRequest("GET", "/positions");

  return positions.map((p) => ({
    symbol: p.symbol,
    qty: Number(p.qty),
    side: p.side,
    avgEntryPrice: Number(p.avg_entry_price),
    currentPrice: Number(p.current_price),
    marketValue: Number(p.market_value),
    costBasis: Number(p.cost_basis),
    unrealizedPl: Number(p.unrealized_pl),
    unrealizedPlPercent: Number((Number(p.unrealized_plpc) * 100).toFixed(2))
  }));
}

export async function getOrders(input = {}) {
  const status = input.status || "all";
  const limit = Math.min(Math.max(Number(input.limit) || 25, 1), 100);

  const orders = await alpacaRequest(
    "GET",
    `/orders?status=${encodeURIComponent(status)}&limit=${limit}&direction=desc`
  );

  return orders.map((o) => ({
    id: o.id,
    symbol: o.symbol,
    side: o.side,
    type: o.type,
    qty: o.qty ? Number(o.qty) : null,
    notional: o.notional ? Number(o.notional) : null,
    filledQty: Number(o.filled_qty),
    filledAvgPrice: o.filled_avg_price ? Number(o.filled_avg_price) : null,
    limitPrice: o.limit_price ? Number(o.limit_price) : null,
    status: o.status,
    submittedAt: o.submitted_at,
    filledAt: o.filled_at
  }));
}

export async function cancelOrder(input = {}) {
  const id = String(input.orderId || "").trim();
  if (!id) throw new Error("orderId is required.");

  await alpacaRequest("DELETE", `/orders/${encodeURIComponent(id)}`);

  logTrade({
    action: "cancel",
    orderId: id,
    submittedAt: new Date().toISOString(),
    accepted: true
  });

  return { cancelled: true, orderId: id };
}

/* ------------------------------------------------------------------ *
 * Asset tradability
 *
 * NAMING NOTE, kept deliberately literal: this is NOT live halt
 * detection. Alpaca's /assets endpoint reports whether a symbol is
 * structurally tradable on Alpaca at all (exists, is active, is not
 * delisted or otherwise disabled) — it does not report an in-progress
 * intraday trading halt, which needs the real-time trade/quote feed to
 * see and which this account tier does not have. Calling this "halt
 * detection" would be exactly the kind of overstated capability this
 * codebase exists to avoid. What it DOES catch, which is real and worth
 * catching: a delisted symbol, a typo'd or unsupported ticker, or a
 * name Alpaca has otherwise disabled for trading — all of which
 * previously would have been discovered only by the order failing (or
 * worse, appearing to succeed against a name that silently doesn't
 * behave the way the caller expects).
 * ------------------------------------------------------------------ */

export async function getAssetInfo(symbol) {
  const sym = String(symbol || "").trim().toUpperCase();
  if (!sym) throw new Error("symbol is required.");

  const a = await alpacaRequest("GET", `/assets/${encodeURIComponent(sym)}`);

  return {
    symbol: a.symbol,
    tradable: Boolean(a.tradable),
    status: a.status, // "active" | "inactive"
    exchange: a.exchange || null,
    shortable: Boolean(a.shortable),
    easyToBorrow: Boolean(a.easy_to_borrow),
    fractionable: Boolean(a.fractionable),
    marginable: Boolean(a.marginable)
  };
}

/**
 * Every currently active, tradable U.S. equity Alpaca will accept an
 * order for - the full replacement for a hand-picked watchlist. This is
 * one unpaginated call, but the response is unusually large (thousands
 * of rows), so it gets a longer timeout than the default rather than
 * risking a spurious abort on a slow connection.
 */
export async function getTradableAssets() {
  const assets = await alpacaRequest(
    "GET",
    "/assets?status=active&asset_class=us_equity",
    undefined,
    30000
  );

  return (Array.isArray(assets) ? assets : []).map((a) => ({
    symbol: a.symbol,
    tradable: Boolean(a.tradable),
    status: a.status,
    exchange: a.exchange || null,
    assetClass: a.class || null,
    shortable: Boolean(a.shortable),
    fractionable: Boolean(a.fractionable),
    marginable: Boolean(a.marginable)
  }));
}

function chunkSymbols(symbols, size) {
  const out = [];
  for (let i = 0; i < symbols.length; i += size) out.push(symbols.slice(i, i + size));
  return out;
}

/** Runs `fn` over `items` with at most `limit` calls in flight at once. */
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker)
  );
  return results;
}

/**
 * One lightweight snapshot (latest trade, day bar, previous close) per
 * symbol, for potentially thousands of symbols in one pass. This is the
 * "bulk" data a universe-wide ranking pass runs on: full historical bars
 * (getBars, above) are fetched only for whatever that ranking shortlists
 * afterward, never for the whole market.
 *
 * Chunked and concurrency-limited on purpose. Alpaca's snapshot endpoint
 * is not built to take an unbounded symbol list in one request, and
 * firing thousands of requests at once would trip Alpaca's own rate
 * limit long before anything here timed out. A chunk that errors marks
 * every symbol in it as missing rather than aborting the whole scan -
 * partial coverage is reported to the caller, never silently patched
 * over or retried into a fallback.
 */
export async function getBulkSnapshots(symbols, options = {}) {
  const chunkSize = Math.max(1, Number(options.chunkSize) || 200);
  const concurrency = Math.max(1, Number(options.concurrency) || 4);
  const feed = options.feed || ALPACA_FEED;

  const unique = Array.from(
    new Set(symbols.map((s) => String(s || "").trim().toUpperCase()).filter(Boolean))
  );
  const chunks = chunkSymbols(unique, chunkSize);

  const snapshots = {};
  const missing = [];
  const errors = [];

  await mapWithConcurrency(chunks, concurrency, async (symbolChunk) => {
    try {
      const data = await alpacaDataRequest(
        `/stocks/snapshots?symbols=${encodeURIComponent(symbolChunk.join(","))}&feed=${feed}`
      );
      const raw = data.snapshots || data || {};

      for (const symbol of symbolChunk) {
        const s = raw[symbol];
        if (!s) {
          missing.push(symbol);
          continue;
        }

        const last = s.latestTrade || {};
        const day = s.dailyBar || {};
        const prev = s.prevDailyBar || {};
        const price = Number(last.p ?? day.c ?? 0) || null;
        const prevClose = Number(prev.c ?? 0) || null;

        if (!price) {
          missing.push(symbol);
          continue;
        }

        snapshots[symbol] = {
          price,
          dayVolume: Number(day.v ?? 0) || 0,
          prevClose,
          changePercent: prevClose ? ((price - prevClose) / prevClose) * 100 : 0
        };
      }
    } catch (e) {
      errors.push(
        `chunk of ${symbolChunk.length} (${symbolChunk[0]}..${symbolChunk[symbolChunk.length - 1]}): ${e.message}`
      );
      missing.push(...symbolChunk);
    }
  });

  return { snapshots, missing, errors, symbolCount: unique.length, chunkCount: chunks.length };
}

/* ------------------------------------------------------------------ *
 * Guardrails
 *
 * Enforced in code before anything reaches Alpaca. These exist so an
 * unattended run can fail small instead of failing catastrophically.
 * ------------------------------------------------------------------ */

async function checkGuardrails(order) {
  const blocks = [];

  // 1. Trades per day
  const today = todaysTrades();
  if (today.length >= LIMITS.maxTradesPerDay) {
    blocks.push(
      `Daily trade limit reached (${today.length}/${LIMITS.maxTradesPerDay}).`
    );
  }

  // 2. Cooldown between trades
  if (today.length > 0 && LIMITS.cooldownMinutes > 0) {
    const last = today[today.length - 1];
    const elapsedMin =
      (Date.now() - new Date(last.submittedAt).getTime()) / 60000;
    if (elapsedMin < LIMITS.cooldownMinutes) {
      blocks.push(
        `Cooldown active: ${Math.ceil(
          LIMITS.cooldownMinutes - elapsedMin
        )} more minute(s) before the next trade.`
      );
    }
  }

  // 3. Account state + daily loss ceiling
  let account = null;
  try {
    account = await getAccount();

    if (account.tradingBlocked) {
      blocks.push("Alpaca reports trading is blocked on this account.");
    }

    if (account.dayPnl <= -Math.abs(LIMITS.maxDailyLossUsd)) {
      blocks.push(
        `Daily loss limit hit (${account.dayPnl} vs limit -${LIMITS.maxDailyLossUsd}). No new positions today.`
      );
    }
  } catch (e) {
    blocks.push(`Could not verify account state: ${e.message}`);
  }

  // 4. Position size ceiling
  //
  // An order whose value cannot be determined is BLOCKED, not waved through:
  // an unknown size is exactly the case the ceiling exists to catch.
  const estimatedUsd = await estimateOrderValue(order);

  if (estimatedUsd === null) {
    blocks.push(
      `Could not determine the order's dollar value for ${order.symbol}, so the max position size check cannot be applied. Use a limit order or a notional amount.`
    );
  } else if (estimatedUsd > LIMITS.maxPositionUsd) {
    blocks.push(
      `Order value ~$${estimatedUsd.toFixed(2)} exceeds max position size $${
        LIMITS.maxPositionUsd
      }.`
    );
  }

  // 5. Asset tradability. A sell that reduces or closes an existing
  // position is let through even if the asset now reports untradable —
  // otherwise a symbol Alpaca disables mid-position would trap the
  // account in it with no way to exit through this code path. A buy
  // gets no such exception: opening a new position in a name Alpaca
  // will not stand behind is exactly what this exists to stop.
  let assetInfo = null;
  if (order.side === "buy") {
    try {
      assetInfo = await getAssetInfo(order.symbol);
      if (!assetInfo.tradable || assetInfo.status !== "active") {
        blocks.push(
          `${order.symbol} is not tradable on Alpaca right now (status: ${assetInfo.status}, tradable: ${assetInfo.tradable}). This checks structural tradability, not an intraday halt — an actively halted-but-otherwise-listed name would not be caught here.`
        );
      }
    } catch (e) {
      blocks.push(`Could not verify ${order.symbol}'s tradability with Alpaca: ${e.message}`);
    }
  }

  return {
    ok: blocks.length === 0,
    blocks,
    context: {
      tradesToday: today.length,
      estimatedUsd,
      dayPnl: account ? account.dayPnl : null,
      assetInfo
    }
  };
}

async function estimateOrderValue(order) {
  if (order.notional) return Number(order.notional);
  if (!order.qty) return null;

  if (order.limit_price) return Number(order.qty) * Number(order.limit_price);

  // Market order: price it off Alpaca's live quote. The Supabase market
  // table is a historical snapshot and must never be used to size an order.
  try {
    const { quotes } = await getQuote({ symbols: [order.symbol] });
    const q = quotes && quotes[0];
    if (q && q.price) return Number(order.qty) * Number(q.price);
  } catch (e) {
    /* fall through - the caller blocks on null rather than assuming safe */
  }

  return null;
}

/* ------------------------------------------------------------------ *
 * Order placement
 * ------------------------------------------------------------------ */

async function placeOrderSerialized(input = {}) {
  const symbol = String(input.symbol || "").trim().toUpperCase();
  if (!symbol) throw new Error("symbol is required.");

  const side = String(input.side || "").trim().toLowerCase();
  if (side !== "buy" && side !== "sell") {
    throw new Error("side must be 'buy' or 'sell'.");
  }

  const type = String(input.type || "market").trim().toLowerCase();

  if (!input.qty && !input.notional) {
    throw new Error("Either qty (shares) or notional (dollar amount) is required.");
  }

  const order = {
    symbol,
    side,
    type,
    time_in_force: input.timeInForce || "day"
  };

  if (input.qty) order.qty = String(input.qty);
  if (input.notional) order.notional = String(input.notional);
  if (type === "limit") {
    if (!input.limitPrice) throw new Error("limitPrice is required for limit orders.");
    order.limit_price = String(input.limitPrice);
  }
  if (type === "stop" || type === "stop_limit") {
    if (!input.stopPrice) throw new Error("stopPrice is required for stop orders.");
    order.stop_price = String(input.stopPrice);
  }

  const guard = await checkGuardrails(order);

  if (!guard.ok) {
    logTrade({
      action: "order",
      accepted: false,
      order,
      rationale: input.rationale || null,
      blockedBy: guard.blocks,
      submittedAt: new Date().toISOString()
    });

    return {
      placed: false,
      blockedBy: guard.blocks,
      guardrailContext: guard.context,
      limits: LIMITS
    };
  }

  const result = await alpacaRequest("POST", "/orders", order);

  logTrade({
    action: "order",
    accepted: true,
    orderId: result.id,
    order,
    rationale: input.rationale || null,
    guardrailContext: guard.context,
    submittedAt: new Date().toISOString(),
    mode: isLiveEndpoint() ? "LIVE" : "PAPER",

    // The decision's own context, stored structurally rather than buried in
    // a prose rationale. Without the stop price there is no way to express
    // an outcome in R multiples later, and without the score there is no
    // way to ask whether the model's confidence meant anything.
    signal: input.signal
      ? {
          score: input.signal.score ?? null,
          confidence: input.signal.confidence ?? null,
          regime: input.signal.indicators?.marketRegime ?? null,
          stopPrice: input.signal.stopPrice ?? null,
          targetPrice: input.signal.targetPrice ?? null,
          action: input.signal.action ?? null
        }
      : null,

    // A submitted order is a request, not an outcome. Orders are rarely
    // filled at submission time, so this starts empty and is patched by
    // reconcileFills() once the broker reports what actually happened.
    fill: fillFrom(result)
  });

  return {
    placed: true,
    mode: isLiveEndpoint() ? "LIVE" : "PAPER",
    orderId: result.id,
    symbol: result.symbol,
    side: result.side,
    type: result.type,
    qty: result.qty ? Number(result.qty) : null,
    notional: result.notional ? Number(result.notional) : null,
    status: result.status,
    submittedAt: result.submitted_at,
    guardrailContext: guard.context
  };
}

/**
 * placeOrder() is reachable from more than one place at once: the
 * autotrader's scheduled run, a manual "place a trade" chat tool call,
 * and (independently of both) a manually triggered autotrader run — none
 * of which know about each other. checkGuardrails() reads today's trade
 * count and the time since the last trade, decides, and only much later
 * (after a real network round-trip to Alpaca) does the order get logged
 * — so two calls that both start before either has logged can both read
 * the same "under the limit, cooldown clear" state and both go through,
 * silently exceeding MAX_TRADES_PER_DAY or TRADE_COOLDOWN_MINUTES.
 *
 * This process is single-threaded, so the fix does not need a real lock
 * — just making sure the check-through-log sequence for one call always
 * finishes before the next one's check begins. Every call is chained
 * onto the previous one's completion (success or failure), which
 * serializes them without making a blocked caller wait more than one
 * order's worth of time, and without touching checkGuardrails() or
 * logTrade() themselves.
 */
let placeOrderChain = Promise.resolve();

export function placeOrder(input = {}) {
  const result = placeOrderChain.then(() => placeOrderSerialized(input));
  // Chain onto the settled result regardless of outcome, so one rejected
  // order never wedges every order after it — but swallow the rejection
  // here so it doesn't become a *second*, spurious unhandled rejection;
  // the real one is still delivered to this call's own caller via the
  // returned (unswallowed) promise below.
  placeOrderChain = result.catch(() => {});
  return result;
}

/* ------------------------------------------------------------------ *
 * Market data (AutoTradeFlux Supabase backend)
 * ------------------------------------------------------------------ */

export async function getMarketData(input = {}) {
  const symbols = Array.isArray(input.symbols)
    ? input.symbols.map((s) => String(s).trim().toUpperCase()).filter(Boolean)
    : [];

  const url = `${SUPABASE_URL}/functions/v1/api/market`;

  const res = await fetchWithTimeout(url, {
    headers: SUPABASE_ANON_KEY
      ? {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`
        }
      : {}
  });

  if (!res.ok) {
    throw new Error(
      `Market data request failed: HTTP ${res.status}. Check SUPABASE_ANON_KEY.`
    );
  }

  const payload = await res.json();
  const all = Array.isArray(payload.stocks) ? payload.stocks : [];

  let stocks = all;
  if (symbols.length > 0) {
    stocks = all.filter((s) =>
      symbols.includes(String(s.symbol || "").toUpperCase())
    );
  }

  // No artificial cap: return everything unless the caller asks otherwise.
  const limit = Number(input.limit) > 0 ? Number(input.limit) : stocks.length;
  const returned = stocks.slice(0, limit);

  const dataAsOf =
    all[0]?.updated_at || all[0]?.last_updated || all[0]?.updatedAt || null;

  const ageHours = dataAsOf
    ? (Date.now() - new Date(dataAsOf).getTime()) / 3600000
    : null;

  const history = {};
  if (payload.historyByStock && symbols.length > 0) {
    for (const row of returned) {
      const key = row.id ?? row.symbol;
      if (payload.historyByStock[key]) history[row.symbol] = payload.historyByStock[key];
    }
  }

  return {
    source: "AutoTradeFlux market table (historical snapshot, NOT a live feed)",
    dataAsOf,
    ageHours: ageHours === null ? null : Math.round(ageHours),
    stale: ageHours !== null && ageHours > 24,
    staleWarning:
      ageHours !== null && ageHours > 24
        ? `This snapshot is about ${Math.round(
            ageHours / 24
          )} day(s) old. Use get_quote for current prices; never price a trade from this data.`
        : null,
    universeSize: all.length,
    matched: stocks.length,
    returned: returned.length,
    stocks: returned,
    history: Object.keys(history).length > 0 ? history : undefined,
    missing:
      symbols.length > 0
        ? symbols.filter(
            (s) => !all.some((row) => String(row.symbol || "").toUpperCase() === s)
          )
        : []
  };
}
