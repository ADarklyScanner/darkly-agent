/**
 * Tests for web-read.js — run with: node web-read.test.mjs
 *
 * The security tests here are the important ones and they come first.
 * This module fetches URLs chosen by a language model from inside a
 * container holding live Alpaca keys, Gmail credentials and Railway
 * private networking. If the destination guard is wrong, the tool is an
 * SSRF primitive rather than a research feature — so these tests try the
 * actual known bypasses (cloud metadata, DNS pointing at a private IP,
 * a public URL redirecting inward) rather than just checking that
 * "localhost" is rejected.
 *
 * The parsing tests exist because this sandbox cannot reach the network,
 * so the transport is the one part that can only be proven in
 * production. Everything that turns bytes into meaning is proven here.
 */

import {
  assertSafeUrl,
  htmlToText,
  extractTitle,
  extractLinks,
  extractJsonLd,
  extractEvents,
  decodeEntities,
  fetchPage,
  _setFetchForTests,
  MAX_TEXT_CHARS
} from "./web-read.js";

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

async function rejects(label, fn, matcher) {
  try {
    await fn();
    check(label, false, "did not throw");
  } catch (e) {
    check(label, matcher ? matcher.test(e.message) : true, e.message);
  }
}

async function resolves(label, fn) {
  try {
    await fn();
    check(label, true);
  } catch (e) {
    check(label, false, e.message);
  }
}

// A stub resolver so DNS behaviour is deterministic and offline.
const resolveTo = (ip) => async () => [{ address: ip, family: ip.includes(":") ? 6 : 4 }];

/* ------------------------------------------------------------------ */

console.log("\nSSRF guard: literal addresses");

await rejects("refuses loopback by name", () => assertSafeUrl("http://localhost/x"), /internal hostname/);
await rejects("refuses 127.0.0.1", () => assertSafeUrl("http://127.0.0.1/x"), /private or internal/);
await rejects("refuses 127.0.0.1 on another port", () => assertSafeUrl("http://127.0.0.1:8080/autotrader-data"), /private or internal/);
await rejects("refuses IPv6 loopback", () => assertSafeUrl("http://[::1]/x"), /private or internal/);
await rejects("refuses 10.x private range", () => assertSafeUrl("http://10.1.2.3/x"), /private or internal/);
await rejects("refuses 192.168.x private range", () => assertSafeUrl("http://192.168.0.5/x"), /private or internal/);
await rejects("refuses 172.16-31 private range", () => assertSafeUrl("http://172.20.0.1/x"), /private or internal/);
await rejects("refuses 0.0.0.0", () => assertSafeUrl("http://0.0.0.0/x"), /private or internal/);
await rejects("refuses carrier-grade NAT range", () => assertSafeUrl("http://100.64.0.1/x"), /private or internal/);

// The one that actually matters on a cloud host.
await rejects("refuses the AWS/GCP metadata address",
  () => assertSafeUrl("http://169.254.169.254/latest/meta-data/"), /private or internal/);
await rejects("refuses link-local generally", () => assertSafeUrl("http://169.254.1.1/"), /private or internal/);
await rejects("refuses IPv4-mapped IPv6 metadata address",
  () => assertSafeUrl("http://[::ffff:169.254.169.254]/"), /private or internal/);
await rejects("refuses IPv6 unique-local", () => assertSafeUrl("http://[fd00::1]/"), /private or internal/);
await rejects("refuses IPv6 link-local", () => assertSafeUrl("http://[fe80::1]/"), /private or internal/);

console.log("\nSSRF guard: internal hostnames and schemes");

await rejects("refuses Railway private networking",
  () => assertSafeUrl("http://darkly-litellm.railway.internal:4000/chat"), /internal hostname/);
await rejects("refuses .internal", () => assertSafeUrl("http://svc.internal/x"), /internal hostname/);
await rejects("refuses .local", () => assertSafeUrl("http://printer.local/x"), /internal hostname/);
await rejects("refuses file://", () => assertSafeUrl("file:///etc/passwd"), /non-HTTP/);
await rejects("refuses gopher://", () => assertSafeUrl("gopher://x/1"), /non-HTTP/);
await rejects("rejects nonsense input", () => assertSafeUrl("not a url"), /valid URL/);

console.log("\nSSRF guard: DNS-based bypasses");

// The classic: a perfectly ordinary public hostname that resolves inward.
await rejects("refuses a public hostname that resolves to a private address",
  () => assertSafeUrl("https://totally-normal.example.com/x", { _resolve: resolveTo("10.0.0.7") }),
  /resolves to a private/);
await rejects("refuses a public hostname resolving to metadata",
  () => assertSafeUrl("https://evil.example.com/x", { _resolve: resolveTo("169.254.169.254") }),
  /resolves to a private/);
await rejects("refuses when any resolved address is private (not just the first)",
  () => assertSafeUrl("https://mixed.example.com/x", {
    _resolve: async () => [{ address: "93.184.216.34" }, { address: "127.0.0.1" }]
  }),
  /resolves to a private/);

await resolves("allows an ordinary public address",
  () => assertSafeUrl("https://example.com/x", { _resolve: resolveTo("93.184.216.34") }));
await resolves("allows a public literal IP", () => assertSafeUrl("https://93.184.216.34/x"));

console.log("\nSSRF guard: redirects are re-validated");

{
  // A public page that 302s straight at cloud metadata.
  _setFetchForTests(async (url) => {
    if (url.includes("example.com")) {
      return {
        status: 302,
        headers: new Map([["location", "http://169.254.169.254/latest/meta-data/"]]),
        text: async () => ""
      };
    }
    return { status: 200, headers: new Map([["content-type", "text/html"]]), text: async () => "<html>secret</html>" };
  });
  // Map-based headers need a .get, which Map already has.
  await rejects("a redirect into cloud metadata is refused mid-chain",
    () => fetchPage("https://example.com/start", { _resolve: resolveTo("93.184.216.34") }),
    /private or internal/);
  _setFetchForTests(null);
}

console.log("\nEntity decoding");

check("decodes named entities", decodeEntities("Tom &amp; Jerry&nbsp;&mdash; 5&deg;") === "Tom & Jerry — 5°");
check("decodes numeric entities", decodeEntities("&#65;&#66;&#67;") === "ABC");
check("decodes hex entities", decodeEntities("&#x41;&#x42;") === "AB");
check("leaves unknown entities alone", decodeEntities("&notreal; x") === "&notreal; x");
check("survives an out-of-range code point", typeof decodeEntities("&#99999999;") === "string");

console.log("\nHTML to text");

{
  const html = `
    <html><head><title>  Reno   Events </title>
    <style>.a{color:red}</style>
    <script>var junk = {"lots":"of state"};</script>
    </head>
    <body>
      <h1>Concerts</h1>
      <p>First paragraph.</p>
      <p>Second &amp; last.</p>
      <ul><li>Item one</li><li>Item two</li></ul>
      <div>Block text</div>
    </body></html>`;

  const text = htmlToText(html);
  check("title is extracted and whitespace-normalized", extractTitle(html) === "Reno Events", extractTitle(html));
  check("script contents are removed", !/junk|lots/.test(text), text.slice(0, 80));
  check("style contents are removed", !/color:red/.test(text));
  check("visible prose survives", /First paragraph\./.test(text) && /Second & last\./.test(text));
  check("entities inside prose are decoded", text.includes("Second & last"));
  check("list items become separate lines with bullets", /• Item one/.test(text) && /• Item two/.test(text), text);
  check("block elements do not run together",
    !/First paragraph\.Second/.test(text) && !/Item oneItem two/.test(text));
  check("no raw tags remain", !/<[a-z]/i.test(text), text.slice(0, 120));
  check("no runs of 3+ newlines", !/\n{3,}/.test(text));
}

check("a page with no title returns null", extractTitle("<html><body>hi</body></html>") === null);
check("an empty title returns null", extractTitle("<title>   </title>") === null);
check("htmlToText on empty input returns empty string", htmlToText("") === "");

console.log("\nLink extraction");

{
  const html = `
    <a href="/events">Events</a>
    <a href="https://other.com/x">Other</a>
    <a href="#skip">Anchor</a>
    <a href="javascript:void(0)">JS</a>
    <a href="mailto:a@b.com">Mail</a>
    <a href="/events">Events again</a>`;
  const links = extractLinks(html, "https://visitrenotahoe.com/page");

  check("relative links are resolved against the page URL",
    links.some((l) => l.url === "https://visitrenotahoe.com/events"), JSON.stringify(links));
  check("absolute links are kept", links.some((l) => l.url === "https://other.com/x"));
  check("fragment-only links are dropped", !links.some((l) => l.url.includes("#skip")));
  check("javascript: links are dropped", !links.some((l) => /javascript/i.test(l.url)));
  check("mailto: links are dropped", !links.some((l) => /mailto/i.test(l.url)));
  check("duplicate URLs appear once", links.filter((l) => l.url.endsWith("/events")).length === 1);
  check("link text is captured", links[0].text === "Events", links[0].text);
}

console.log("\nschema.org JSON-LD and events");

{
  // The shape venue and tourism sites actually publish — which is exactly
  // what the Reno engine's event evidence needs.
  const html = `
    <script type="application/ld+json">
    {"@context":"https://schema.org","@type":"Event",
     "name":"Lawlor Events Center Concert","startDate":"2026-09-19T20:00:00-07:00",
     "endDate":"2026-09-19T23:00:00-07:00",
     "location":{"@type":"Place","name":"Lawlor Events Center"},
     "url":"https://unr.edu/e/1","eventStatus":"https://schema.org/EventScheduled"}
    </script>
    <script type="application/ld+json">
    [{"@type":"MusicEvent","name":"Casino Show","startDate":"2026-09-20T21:00:00-07:00",
      "location":{"@type":"Place","address":{"addressLocality":"Reno"}}},
     {"@type":"Organization","name":"Not an event"}]
    </script>
    <script type="application/ld+json">{ this is broken json }</script>
    <script type="application/ld+json">
    {"@graph":[{"@type":"SportsEvent","name":"Aces Home Game","startDate":"2026-09-21T18:05:00-07:00"}]}
    </script>`;

  const blocks = extractJsonLd(html);
  check("valid JSON-LD blocks are parsed", blocks.length >= 4, String(blocks.length));
  check("malformed JSON-LD is skipped without throwing", true);
  check("@graph contents are flattened", blocks.some((b) => b.name === "Aces Home Game"));

  const events = extractEvents(html);
  check("Event objects are extracted", events.length === 3, JSON.stringify(events.map((e) => e.name)));
  check("subtypes like MusicEvent and SportsEvent count as events",
    events.some((e) => e.name === "Casino Show") && events.some((e) => e.name === "Aces Home Game"));
  check("non-events are excluded", !events.some((e) => e.name === "Not an event"));
  check("start and end times are captured",
    events[0].startDate === "2026-09-19T20:00:00-07:00" && events[0].endDate === "2026-09-19T23:00:00-07:00");
  check("a named place location is flattened to its name", events[0].location === "Lawlor Events Center");
  check("an address-only location falls back to locality",
    events.find((e) => e.name === "Casino Show").location === "Reno");
  check("event status is captured", /EventScheduled/.test(events[0].eventStatus));
}

check("a page with no JSON-LD returns an empty array", extractJsonLd("<html></html>").length === 0);
check("a page with no events returns an empty array", extractEvents("<html></html>").length === 0);

console.log("\nfetchPage behaviour (stubbed transport)");

function stub({ status = 200, headers = {}, body = "" }) {
  _setFetchForTests(async () => ({
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    text: async () => body
  }));
}

{
  stub({
    headers: { "content-type": "text/html; charset=utf-8" },
    body: "<html><head><title>Reno Weather</title></head><body><p>Rain likely Saturday night.</p></body></html>"
  });
  const r = await fetchPage("https://weather.example.com/reno", { _resolve: resolveTo("93.184.216.34") });
  check("a successful HTML fetch reports ok", r.ok === true);
  check("kind is html", r.kind === "html");
  check("title comes back", r.title === "Reno Weather", String(r.title));
  check("text is extracted, not raw HTML", /Rain likely Saturday night\./.test(r.text) && !/</.test(r.text));
  check("status is reported", r.status === 200);
}

{
  stub({ status: 404, headers: { "content-type": "text/html" }, body: "<html>nope</html>" });
  const r = await fetchPage("https://example.com/missing", { _resolve: resolveTo("93.184.216.34") });
  check("a 404 reports ok:false with the status", r.ok === false && r.status === 404, JSON.stringify(r));
  check("a 404 explains itself rather than returning empty text", /HTTP 404/.test(r.error));
}

{
  stub({ headers: { "content-type": "application/json" }, body: '{"temperature":72,"wind":5}' });
  const r = await fetchPage("https://api.example.com/data", { _resolve: resolveTo("93.184.216.34") });
  check("JSON responses are returned as JSON, not HTML-stripped", r.kind === "json" && r.text.includes('"temperature":72'));
}

{
  stub({ headers: { "content-type": "text/plain" }, body: "plain body text" });
  const r = await fetchPage("https://example.com/robots.txt", { _resolve: resolveTo("93.184.216.34") });
  check("plain text passes through untouched", r.kind === "text" && r.text === "plain body text");
}

{
  const long = "<html><body>" + "word ".repeat(40_000) + "</body></html>";
  stub({ headers: { "content-type": "text/html" }, body: long });
  const r = await fetchPage("https://example.com/long", { _resolve: resolveTo("93.184.216.34") });
  check("very long pages are truncated to the cap", r.text.length <= MAX_TEXT_CHARS);
  check("truncation is reported rather than hidden", r.truncated === true);
  check("the full available length is reported", r.charsAvailable > r.text.length);
}

{
  stub({ headers: { "content-type": "text/html", "content-length": "99000000" }, body: "x" });
  const r = await fetchPage("https://example.com/huge", { _resolve: resolveTo("93.184.216.34") });
  check("an oversized page is refused before download", r.ok === false && /too large/.test(r.error));
}

{
  const maxChars = 50;
  stub({ headers: { "content-type": "text/html" }, body: "<html><body>" + "a".repeat(500) + "</body></html>" });
  const r = await fetchPage("https://example.com/x", { _resolve: resolveTo("93.184.216.34"), maxChars });
  check("a caller-supplied maxChars is honored", r.text.length === maxChars, String(r.text.length));
}

{
  stub({
    headers: { "content-type": "text/html" },
    body: `<html><body><script type="application/ld+json">
      {"@type":"Event","name":"Rib Cook-Off","startDate":"2026-09-19T17:00:00-07:00"}
      </script><p>Come hungry</p></body></html>`
  });
  const r = await fetchPage("https://example.com/events", { _resolve: resolveTo("93.184.216.34") });
  check("events are extracted automatically on HTML pages", r.events.length === 1 && r.events[0].name === "Rib Cook-Off",
    JSON.stringify(r.events));
  check("links are omitted unless asked for", r.links === undefined);

  const r2 = await fetchPage("https://example.com/events", { _resolve: resolveTo("93.184.216.34"), includeLinks: true });
  check("links are included when requested", Array.isArray(r2.links));
}

{
  // Redirect chain that stays public: should follow and report the hops.
  let call = 0;
  _setFetchForTests(async (url) => {
    call++;
    if (call === 1) {
      return { status: 301, headers: { get: (k) => (k.toLowerCase() === "location" ? "https://example.com/final" : null) }, text: async () => "" };
    }
    return {
      status: 200,
      headers: { get: (k) => (k.toLowerCase() === "content-type" ? "text/html" : null) },
      text: async () => "<html><title>Final</title><body>arrived</body></html>"
    };
  });
  const r = await fetchPage("https://example.com/start", { _resolve: resolveTo("93.184.216.34") });
  check("public redirects are followed", r.ok === true && r.title === "Final", JSON.stringify(r.title));
  check("the final URL is reported", r.finalUrl === "https://example.com/final", r.finalUrl);
  check("the redirect chain is reported", Array.isArray(r.redirects) && r.redirects.length === 1);
}

{
  // A redirect loop must terminate rather than hang.
  _setFetchForTests(async () => ({
    status: 302,
    headers: { get: (k) => (k.toLowerCase() === "location" ? "https://example.com/loop" : null) },
    text: async () => ""
  }));
  await rejects("a redirect loop is stopped, not followed forever",
    () => fetchPage("https://example.com/loop", { _resolve: resolveTo("93.184.216.34") }),
    /Too many redirects/);
}

{
  _setFetchForTests(async () => {
    const e = new Error("aborted");
    e.name = "AbortError";
    throw e;
  });
  await rejects("a timeout is reported as a timeout",
    () => fetchPage("https://example.com/slow", { _resolve: resolveTo("93.184.216.34"), timeoutMs: 5 }),
    /Timed out/);
}

{
  _setFetchForTests(async () => {
    throw new Error("ECONNREFUSED");
  });
  await rejects("a network failure names the host rather than leaking a stack",
    () => fetchPage("https://example.com/down", { _resolve: resolveTo("93.184.216.34") }),
    /Could not fetch example\.com/);
}

_setFetchForTests(null);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
