import fs from "node:fs";
import path from "node:path";

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

const TRADE_LOG_FILE = path.join(
  process.env.HOME || ".",
  "darkly-trades.json"
);

export const LIMITS = {
  maxTradesPerDay: Number(process.env.MAX_TRADES_PER_DAY || 10),
  maxPositionUsd: Number(process.env.MAX_POSITION_USD || 1000),
  maxDailyLossUsd: Number(process.env.MAX_DAILY_LOSS_USD || 500),
  cooldownMinutes: Number(process.env.TRADE_COOLDOWN_MINUTES || 5)
};

export function isLiveEndpoint() {
  return !/paper-api\.alpaca\.markets/.test(ALPACA_BASE);
}

/* ------------------------------------------------------------------ *
 * Trade log (local, same pattern as darkly-leads.json)
 * ------------------------------------------------------------------ */

function loadTrades() {
  try {
    if (fs.existsSync(TRADE_LOG_FILE)) {
      return JSON.parse(fs.readFileSync(TRADE_LOG_FILE, "utf8"));
    }
  } catch (e) {
    /* corrupt or unreadable log must never block trading decisions */
  }
  return [];
}

function saveTrades(trades) {
  fs.writeFileSync(TRADE_LOG_FILE, JSON.stringify(trades, null, 2));
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

function todaysTrades() {
  const today = new Date().toISOString().slice(0, 10);
  return loadTrades().filter(
    (t) => t.submittedAt && t.submittedAt.slice(0, 10) === today && t.accepted
  );
}

/* ------------------------------------------------------------------ *
 * Alpaca REST
 * ------------------------------------------------------------------ */

async function alpacaRequest(method, endpoint, body) {
  if (!ALPACA_KEY_ID || !ALPACA_SECRET_KEY) {
    throw new Error(
      "Alpaca credentials are not configured (ALPACA_KEY_ID / ALPACA_SECRET_KEY)."
    );
  }

  const res = await fetch(`${ALPACA_BASE}${endpoint}`, {
    method,
    headers: {
      "APCA-API-KEY-ID": ALPACA_KEY_ID,
      "APCA-API-SECRET-KEY": ALPACA_SECRET_KEY,
      "Content-Type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
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

  const res = await fetch(`${ALPACA_DATA_BASE}${endpoint}`, {
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

/** Historical bars from Alpaca, oldest first, keyed by symbol. */
export async function getBars(input = {}) {
  const symbols = (Array.isArray(input.symbols) ? input.symbols : [input.symbols])
    .map((s) => String(s || "").trim().toUpperCase())
    .filter(Boolean);

  if (symbols.length === 0) throw new Error("At least one symbol is required.");

  const timeframe = input.timeframe || "1Day";
  const limit = Math.min(Math.max(Number(input.limit) || 120, 30), 1000);

  const data = await alpacaDataRequest(
    `/stocks/bars?symbols=${encodeURIComponent(symbols.join(","))}` +
      `&timeframe=${encodeURIComponent(timeframe)}&limit=${limit}` +
      `&feed=${ALPACA_FEED}&adjustment=split`
  );

  return data.bars || {};
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

  return {
    ok: blocks.length === 0,
    blocks,
    context: {
      tradesToday: today.length,
      estimatedUsd,
      dayPnl: account ? account.dayPnl : null
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

export async function placeOrder(input = {}) {
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
    mode: isLiveEndpoint() ? "LIVE" : "PAPER"
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

/* ------------------------------------------------------------------ *
 * Market data (AutoTradeFlux Supabase backend)
 * ------------------------------------------------------------------ */

export async function getMarketData(input = {}) {
  const symbols = Array.isArray(input.symbols)
    ? input.symbols.map((s) => String(s).trim().toUpperCase()).filter(Boolean)
    : [];

  const url = `${SUPABASE_URL}/functions/v1/api/market`;

  const res = await fetch(url, {
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
