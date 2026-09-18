/**
 * web-read.js — fetch a public web page and turn it into something the
 * agent can actually reason about.
 *
 * This is the capability the agent has been telling the user it lacks. It
 * needs no API key: Railway containers have outbound network access, so
 * the only thing standing between the agent and a real page was code.
 *
 * SECURITY — why the URL guard below is not optional.
 *
 * This function fetches URLs chosen by a language model, inside a
 * container that also holds live Alpaca trading keys, Gmail credentials,
 * Supabase keys, and Railway private networking to a sibling LiteLLM
 * service. A fetcher without an allowlist on destination is a
 * server-side request forgery (SSRF) primitive: "read
 * http://169.254.169.254/latest/meta-data/" is a cloud-metadata
 * credential dump, "read http://darkly-litellm.railway.internal/..."
 * reaches an internal service that was never meant to be public, and
 * "read http://localhost:PORT/autotrader-data" would let an outside
 * prompt pull this agent's own authenticated data back out through a
 * tool that looks innocent.
 *
 * So the destination is checked against private, loopback, link-local and
 * internal ranges BEFORE the request, and again after every redirect,
 * because a public URL that 302s to 169.254.169.254 defeats a check that
 * only runs once. This cannot be disabled by an argument.
 */

import dns from "node:dns/promises";
import net from "node:net";

export const MAX_BYTES = 2_000_000; // hard cap on downloaded bytes
export const MAX_TEXT_CHARS = 60_000; // hard cap on extracted text handed back
export const MAX_REDIRECTS = 5;
export const DEFAULT_TIMEOUT_MS = 15_000;

/* ------------------------------------------------------------------ *
 * Destination safety
 * ------------------------------------------------------------------ */

/** IPv4/IPv6 ranges that must never be reachable through this tool. */
function isBlockedIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 10) return true; // private
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local INCLUDING cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
    if (a >= 224) return true; // multicast + reserved
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === "::" || lower === "::1") return true;
    if (lower.startsWith("fe80")) return true; // link-local
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique local
    // IPv4-mapped IPv6 must be unwrapped and re-checked against the IPv4
    // rules. This appears in TWO forms and both have to be handled: the
    // readable "::ffff:169.254.169.254", and the hex form
    // "::ffff:a9fe:a9fe" that Node normalizes it into. Only handling the
    // dotted form left the cloud metadata address reachable through an
    // IPv6 literal — caught by web-read.test.mjs.
    const dotted = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (dotted) return isBlockedIp(dotted[1]);

    const hex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const high = parseInt(hex[1], 16);
      const low = parseInt(hex[2], 16);
      const quad = [(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff].join(".");
      return isBlockedIp(quad);
    }

    return false;
  }
  return true; // not a recognizable IP: refuse rather than guess
}

const BLOCKED_HOST_SUFFIXES = [
  ".railway.internal",
  ".internal",
  ".local",
  ".localhost"
];

/**
 * Validate a URL's destination. Resolves DNS so that a public-looking
 * hostname pointing at a private address is caught too — the classic
 * SSRF bypass.
 */
export async function assertSafeUrl(rawUrl, options = {}) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch (e) {
    throw new Error(`Not a valid URL: ${rawUrl}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Refusing to fetch a non-HTTP URL (${url.protocol}).`);
  }

  // Node returns IPv6 literals from url.hostname still wrapped in brackets
  // ("[::1]"), which net.isIP() does not recognize as an IP at all. Without
  // stripping them, every IPv6 literal — including ::1 and the
  // IPv4-mapped form of the cloud metadata address — would skip the IP
  // check entirely and fall through to DNS resolution, which is not a
  // security control. Caught by the IPv6 cases in web-read.test.mjs.
  const host = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");

  if (host === "localhost" || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new Error(`Refusing to fetch an internal hostname (${host}).`);
  }

  // A literal IP can be checked directly; a name has to be resolved.
  if (net.isIP(host)) {
    if (isBlockedIp(host)) throw new Error(`Refusing to fetch a private or internal address (${host}).`);
    return url;
  }

  const resolver = options._resolve || ((h) => dns.lookup(h, { all: true, verbatim: true }));
  let addresses;
  try {
    addresses = await resolver(host);
  } catch (e) {
    throw new Error(`Could not resolve ${host}: ${e.message}`);
  }

  if (!addresses || addresses.length === 0) throw new Error(`Could not resolve ${host}.`);
  for (const a of addresses) {
    const ip = typeof a === "string" ? a : a.address;
    if (isBlockedIp(ip)) {
      throw new Error(`Refusing to fetch ${host}: it resolves to a private or internal address (${ip}).`);
    }
  }

  return url;
}

/* ------------------------------------------------------------------ *
 * HTML -> text
 * ------------------------------------------------------------------ */

const ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  rsquo: "'",
  lsquo: "'",
  rdquo: '"',
  ldquo: '"',
  middot: "·",
  bull: "•",
  deg: "°",
  times: "×"
};

export function decodeEntities(text) {
  return String(text)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => {
      const key = name.toLowerCase();
      return ENTITIES[key] !== undefined ? ENTITIES[key] : m;
    });
}

function safeCodePoint(cp) {
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return "";
  try {
    return String.fromCodePoint(cp);
  } catch (e) {
    return "";
  }
}

/** Page title, if the document has one. */
export function extractTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return null;
  const t = decodeEntities(m[1]).replace(/\s+/g, " ").trim();
  return t || null;
}

/**
 * Strip a page down to readable text.
 *
 * Order matters: script/style/noscript/svg content is removed FIRST,
 * because that content is not prose and would otherwise dominate the
 * extracted text on a modern page (inline JSON state blobs especially).
 * Block-level tags become newlines so that list items and paragraphs
 * don't run together into one unreadable line.
 */
export function htmlToText(html) {
  let s = String(html);

  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<(script|style|noscript|svg|template|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  s = s.replace(/<(br|hr)\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|section|article|header|footer|li|tr|h[1-6]|blockquote|pre|td|th)\s*>/gi, "\n");
  s = s.replace(/<li\b[^>]*>/gi, "\n• ");
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);

  // Collapse runs of spaces, then runs of blank lines, without destroying
  // the paragraph structure the newlines above just established.
  s = s.replace(/[ \t\f\v ]+/g, " ");
  s = s.replace(/ *\n */g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");

  return s.trim();
}

/** Absolute links found on the page, deduped, in document order. */
export function extractLinks(html, baseUrl) {
  const out = [];
  const seen = new Set();
  const re = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    let href = m[1].trim();
    if (!href || href.startsWith("#") || /^(javascript|mailto|tel):/i.test(href)) continue;
    try {
      href = new URL(href, baseUrl).toString();
    } catch (e) {
      continue;
    }
    if (seen.has(href)) continue;
    seen.add(href);
    const text = htmlToText(m[2]).replace(/\s+/g, " ").trim();
    out.push({ url: href, text: text.slice(0, 200) });
    if (out.length >= 300) break;
  }
  return out;
}

/**
 * schema.org JSON-LD blocks.
 *
 * Worth extracting specifically: venue, university and tourism sites
 * publish Event objects this way with start times, locations and names
 * already structured — which is exactly the shape the Reno engine's
 * event evidence needs, and far more reliable than scraping prose. A
 * block that fails to parse is skipped rather than failing the page.
 */
export function extractJsonLd(html) {
  const out = [];
  const re = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1].trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) out.push(...parsed);
      else if (parsed && typeof parsed === "object" && Array.isArray(parsed["@graph"])) out.push(...parsed["@graph"]);
      else out.push(parsed);
    } catch (e) {
      // Malformed JSON-LD is extremely common in the wild. Skip it.
    }
  }
  return out;
}

/** Just the Event-typed JSON-LD objects, flattened to a useful shape. */
export function extractEvents(html) {
  const isEvent = (t) => {
    const types = Array.isArray(t) ? t : [t];
    return types.some((x) => typeof x === "string" && /Event$/i.test(x));
  };

  return extractJsonLd(html)
    .filter((o) => o && typeof o === "object" && o["@type"] && isEvent(o["@type"]))
    .map((o) => ({
      name: typeof o.name === "string" ? o.name : null,
      startDate: typeof o.startDate === "string" ? o.startDate : null,
      endDate: typeof o.endDate === "string" ? o.endDate : null,
      location:
        typeof o.location === "string"
          ? o.location
          : o.location && typeof o.location === "object"
            ? o.location.name || (o.location.address && (o.location.address.streetAddress || o.location.address.addressLocality)) || null
            : null,
      url: typeof o.url === "string" ? o.url : null,
      eventStatus: typeof o.eventStatus === "string" ? o.eventStatus : null,
      eventAttendanceMode: typeof o.eventAttendanceMode === "string" ? o.eventAttendanceMode : null
    }))
    .filter((e) => e.name || e.startDate);
}

/* ------------------------------------------------------------------ *
 * Fetch
 * ------------------------------------------------------------------ */

let _fetchImpl = null;
/** Test seam: swap the transport without needing a live network. */
export function _setFetchForTests(fn) {
  _fetchImpl = fn;
}

function theFetch() {
  return _fetchImpl || globalThis.fetch;
}

/**
 * Read a public web page.
 *
 * Redirects are followed manually rather than by fetch, because each hop
 * has to be re-validated: a public URL that redirects into a private
 * address is the standard way an SSRF check that only runs once gets
 * bypassed.
 */
export async function fetchPage(rawUrl, options = {}) {
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const maxChars = Number(options.maxChars) > 0 ? Math.min(Number(options.maxChars), MAX_TEXT_CHARS) : MAX_TEXT_CHARS;

  let current = rawUrl;
  let response = null;
  const chain = [];

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const url = await assertSafeUrl(current, options);
    chain.push(url.toString());

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      response = await theFetch()(url.toString(), {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          // Identify honestly rather than impersonating a browser.
          "User-Agent": "DarklyAgent/1.0 (+research reader)",
          Accept: "text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.5"
        }
      });
    } catch (e) {
      clearTimeout(timer);
      if (e.name === "AbortError") throw new Error(`Timed out after ${timeoutMs}ms fetching ${url.hostname}`);
      throw new Error(`Could not fetch ${url.hostname}: ${e.message}`);
    }
    clearTimeout(timer);

    const status = response.status;
    if (status >= 300 && status < 400) {
      const location = response.headers.get("location");
      if (!location) break;
      current = new URL(location, url).toString();
      if (hop === MAX_REDIRECTS) {
        throw new Error(`Too many redirects (${MAX_REDIRECTS}) starting from ${rawUrl}`);
      }
      continue;
    }
    break;
  }

  const finalUrl = chain[chain.length - 1];
  const status = response.status;
  const contentType = (response.headers.get("content-type") || "").toLowerCase();

  if (status >= 400) {
    return {
      ok: false,
      url: rawUrl,
      finalUrl,
      status,
      error: `The page returned HTTP ${status}.`,
      redirects: chain.slice(1)
    };
  }

  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > MAX_BYTES) {
    return {
      ok: false,
      url: rawUrl,
      finalUrl,
      status,
      error: `Page is too large to read (${declaredLength} bytes; cap is ${MAX_BYTES}).`
    };
  }

  let body = await response.text();
  let truncatedBytes = false;
  if (body.length > MAX_BYTES) {
    body = body.slice(0, MAX_BYTES);
    truncatedBytes = true;
  }

  // Non-HTML content is handed back as-is rather than run through an HTML
  // stripper that would mangle it.
  const isHtml = contentType.includes("html") || /^\s*<(!doctype|html)/i.test(body);
  const isJson = contentType.includes("json");

  if (isJson && !isHtml) {
    const text = body.slice(0, maxChars);
    return {
      ok: true,
      url: rawUrl,
      finalUrl,
      status,
      contentType,
      kind: "json",
      title: null,
      text,
      truncated: body.length > maxChars || truncatedBytes,
      redirects: chain.slice(1)
    };
  }

  if (!isHtml) {
    const text = body.slice(0, maxChars);
    return {
      ok: true,
      url: rawUrl,
      finalUrl,
      status,
      contentType,
      kind: "text",
      title: null,
      text,
      truncated: body.length > maxChars || truncatedBytes,
      redirects: chain.slice(1)
    };
  }

  const fullText = htmlToText(body);
  const text = fullText.slice(0, maxChars);

  return {
    ok: true,
    url: rawUrl,
    finalUrl,
    status,
    contentType,
    kind: "html",
    title: extractTitle(body),
    text,
    truncated: fullText.length > maxChars || truncatedBytes,
    charsAvailable: fullText.length,
    links: options.includeLinks ? extractLinks(body, finalUrl) : undefined,
    events: extractEvents(body),
    jsonLd: options.includeJsonLd ? extractJsonLd(body) : undefined,
    redirects: chain.slice(1)
  };
}
