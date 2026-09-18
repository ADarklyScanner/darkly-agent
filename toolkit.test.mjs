/**
 * Tests for toolkit.js — run with: node toolkit.test.mjs
 *
 * Several of these tools are the kind that look right while being
 * quietly wrong, so the tests aim at exactly those failure modes:
 * a CSV parser that splits on commas and corrupts any real spreadsheet
 * export; a base64 decoder that turns garbage into confident output
 * because Buffer.from discards bad characters silently; a regex tool that
 * hangs the process that also runs the autotrader; a privacy scanner that
 * leaks the credentials it just found into the transcript.
 */

import {
  base64Encode,
  base64Decode,
  sha256,
  chunk,
  deduplicate,
  parseDelimited,
  jsonPath,
  inferSchema,
  regexExtract,
  normalizeText,
  compareText,
  analyzeSource,
  analyzePrivacy,
  inspectOpenApi,
  readJsonApi,
  inspectNpmPackage,
  inspectGithubRepo,
  checkJavaScript,
  _setFetchForTests
} from "./toolkit.js";

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

function throwsWith(label, fn, matcher) {
  try {
    fn();
    check(label, false, "did not throw");
  } catch (e) {
    check(label, matcher ? matcher.test(e.message) : true, e.message);
  }
}

async function rejectsWith(label, fn, matcher) {
  try {
    await fn();
    check(label, false, "did not reject");
  } catch (e) {
    check(label, matcher ? matcher.test(e.message) : true, e.message);
  }
}

/* ------------------------------------------------------------------ */

console.log("\nBase64 and hashing");

check("encodes text", base64Encode({ text: "hello" }).base64 === "aGVsbG8=");
check("reports byte length", base64Encode({ text: "héllo" }).bytes === 6);
check("round-trips", base64Decode({ data: base64Encode({ text: "round trip" }).base64 }).text === "round trip");
throwsWith("requires an input", () => base64Encode({}), /Supply either/);

{
  // Buffer.from silently discards invalid characters, so a naive decoder
  // turns nonsense into plausible-looking output without complaint.
  const bad = base64Decode({ data: "!!!not base64 at all!!!" });
  check("invalid base64 is flagged rather than silently mangled", bad.looksLikeValidBase64 === false);
  check("and it says so in a note", /not clean base64/.test(bad.note), bad.note);

  const good = base64Decode({ data: "aGVsbG8=" });
  check("valid base64 is not flagged", good.looksLikeValidBase64 === true && good.note === null);

  const binary = base64Decode({ data: Buffer.from([0xff, 0xfe, 0x00, 0x01]).toString("base64") });
  check("binary content reports text:null instead of mojibake", binary.text === null && binary.isUtf8Text === false);
  check("and explains that it is binary", /not valid UTF-8/.test(binary.note));
}

check("sha256 matches the known digest of 'abc'",
  sha256({ text: "abc" }).hex === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
throwsWith("sha256 rejects non-strings", () => sha256({ text: 123 }), /must be a string/);

console.log("\nChunking");

{
  const r = chunk({ data: "abcdefghij", size: 3 });
  check("splits text into fixed sizes", r.chunks.join("|") === "abc|def|ghi|j", r.chunks.join("|"));
  check("reports the count", r.count === 4);

  const ov = chunk({ data: "abcdefghij", size: 4, overlap: 2 });
  check("overlap repeats the tail of the previous chunk",
    ov.chunks[0] === "abcd" && ov.chunks[1] === "cdef", ov.chunks.join("|"));

  const arr = chunk({ data: [1, 2, 3, 4, 5], size: 2 });
  check("chunks arrays too", arr.kind === "array" && arr.chunks.length === 3);

  // The trap: overlap >= size means the window never advances.
  throwsWith("overlap >= size is refused rather than looping forever",
    () => chunk({ data: "abc", size: 2, overlap: 2 }), /never advance/);
  throwsWith("rejects unsupported types", () => chunk({ data: 42 }), /string or an array/);
}

console.log("\nDeduplication");

{
  const r = deduplicate({ items: [1, 2, 2, 3, 1] });
  check("removes duplicate primitives", r.items.join(",") === "1,2,3");
  check("counts what was removed", r.removed === 2 && r.input === 5);

  // Key order must not affect identity, or dedup silently does nothing
  // on objects that came from different sources.
  const objs = deduplicate({ items: [{ a: 1, b: 2 }, { b: 2, a: 1 }] });
  check("object identity ignores key order", objs.unique === 1, JSON.stringify(objs.items));

  const byKey = deduplicate({ items: [{ id: "x", v: 1 }, { id: "x", v: 2 }, { id: "y", v: 3 }], key: "id" });
  check("dedupes by a named key", byKey.unique === 2);
  check("keeps the first occurrence", byKey.items[0].v === 1);
  check("reports which rule was used", /key "id"/.test(byKey.by));

  check("distinguishes 1 from '1'", deduplicate({ items: [1, "1"] }).unique === 2);
  check("distinguishes null from undefined-ish values", deduplicate({ items: [null, 0, false, ""] }).unique === 4);
}

console.log("\nCSV / TSV parsing");

{
  const csv = 'name,city,note\n"Acme, Inc.",Reno,"He said ""hi"""\nBeta LLC,Sparks,plain';
  const r = parseDelimited({ text: csv });

  check("parses header columns", r.columns.join("|") === "name|city|note");
  check("parses row count", r.rowCount === 2);
  // The classic failure: splitting on commas destroys "Acme, Inc.".
  check("a quoted field containing the delimiter survives intact",
    r.rows[0].name === "Acme, Inc.", JSON.stringify(r.rows[0]));
  check("doubled quotes become one literal quote",
    r.rows[0].note === 'He said "hi"', JSON.stringify(r.rows[0].note));
  check("unquoted rows still parse", r.rows[1].city === "Sparks");
}

{
  const withNewline = 'a,b\n"line one\nline two",second';
  const r = parseDelimited({ text: withNewline });
  check("a newline inside quotes does not split the record", r.rowCount === 1, String(r.rowCount));
  check("the embedded newline is preserved", r.rows[0].a === "line one\nline two", JSON.stringify(r.rows[0].a));
}

{
  const tsv = "a\tb\n1\t2";
  const r = parseDelimited({ text: tsv });
  check("tab delimiter is detected automatically", r.delimiter === "\\t", r.delimiter);
  check("tsv rows parse", r.rows[0].b === "2");

  const semi = parseDelimited({ text: "a;b\n1;2" });
  check("semicolon delimiter is detected", semi.rows[0].b === "2");
}

{
  const ragged = parseDelimited({ text: "a,b,c\n1,2" });
  check("short rows produce nulls rather than dropping the row", ragged.rows[0].c === null);
  check("raggedness is reported, not hidden", /did not have 3 fields/.test(ragged.note), ragged.note);

  const noHeaders = parseDelimited({ text: "1,2\n3,4", headers: false });
  check("headers:false returns arrays", Array.isArray(noHeaders.rows[0]) && noHeaders.rows[1][1] === "4");

  const empty = parseDelimited({ text: "   " });
  check("empty input returns no rows with an explanation", empty.rowCount === 0 && /empty/i.test(empty.note));

  const blankHeader = parseDelimited({ text: "a,,c\n1,2,3" });
  check("a blank header gets a generated name", blankHeader.columns[1] === "column_2", blankHeader.columns.join("|"));
}

console.log("\nJSON path and schema inference");

{
  const data = { user: { name: "Jo", tags: ["a", "b"], address: { city: "Reno" } }, count: 2 };

  check("resolves a dotted path", jsonPath({ data, path: "user.name" }).value === "Jo");
  check("resolves array indexes", jsonPath({ data, path: "user.tags[1]" }).value === "b");
  check("resolves nested objects", jsonPath({ data, path: "user.address.city" }).value === "Reno");
  check("a leading $ is accepted", jsonPath({ data, path: "$.count" }).value === 2);
  check("$ alone returns the root", jsonPath({ data, path: "$" }).value === data);
  check("parses a JSON string input", jsonPath({ data: JSON.stringify(data), path: "count" }).value === 2);

  // A miss must be distinguishable from a real null, and must say why.
  const miss = jsonPath({ data, path: "user.email" });
  check("a missing path reports found:false, not undefined", miss.found === false);
  check("it says where it failed", miss.failedAt === "user", miss.failedAt);
  check("it lists what was actually available", /name|tags|address/.test(miss.reason), miss.reason);

  const realNull = jsonPath({ data: { x: null }, path: "x" });
  check("a genuine null is found:true with value null", realNull.found === true && realNull.value === null);

  throwsWith("invalid JSON string is reported clearly",
    () => jsonPath({ data: "{not json", path: "a" }), /not valid JSON/);
}

{
  const s = inferSchema({ data: { id: 1, name: "x", when: "2026-09-19T20:00:00Z", site: "https://a.b", tags: ["a"], nested: { ok: true } } });
  check("infers object type", s.type === "object");
  check("distinguishes integer from number", s.properties.id.type === "integer");
  check("detects date-time format", s.properties.when.format === "date-time");
  check("detects uri format", s.properties.site.format === "uri");
  check("infers array item types", s.properties.tags.type === "array" && s.properties.tags.items.type === "string");
  check("recurses into nested objects", s.properties.nested.properties.ok.type === "boolean");
  check("lists required keys", s.required.includes("id"));

  const mixed = inferSchema({ data: [1, "a"] });
  check("a mixed array reports anyOf", Array.isArray(mixed.items.anyOf) && mixed.items.anyOf.length === 2);

  const emptyArr = inferSchema({ data: [] });
  check("an empty array says the item type is unknown rather than guessing", /unknown/.test(emptyArr.note));
}

console.log("\nRegex extraction (including the ReDoS guard)");

{
  const r = regexExtract({ text: "call 775-555-1234 or 775-555-9999", pattern: "(\\d{3})-(\\d{3})-(\\d{4})" });
  check("finds all matches", r.count === 2);
  check("captures groups", r.matches[0].groups.join("-") === "775-555-1234");
  check("reports match positions", r.matches[0].index === 5, String(r.matches[0].index));

  const named = regexExtract({ text: "2026-09-19", pattern: "(?<y>\\d{4})-(?<m>\\d{2})" });
  check("supports named groups", named.matches[0].named.y === "2026");

  const limited = regexExtract({ text: "aaaaaa", pattern: "a", limit: 3 });
  check("respects the limit", limited.count === 3 && limited.truncated === true);

  // Zero-width matches loop forever unless lastIndex is advanced.
  const zeroWidth = regexExtract({ text: "abc", pattern: "" });
  check("a zero-width pattern terminates instead of hanging", zeroWidth.count > 0 && zeroWidth.count < 1000);

  check("the g flag is forced so extraction actually iterates",
    regexExtract({ text: "aa", pattern: "a", flags: "i" }).count === 2);

  throwsWith("an invalid regex is reported, not thrown raw",
    () => regexExtract({ text: "x", pattern: "([" }), /Invalid regular expression/);

  // The important one: this process also runs the autotrader.
  throwsWith("a catastrophic nested quantifier is refused",
    () => regexExtract({ text: "aaaaaaaaaaaaaaaaaaaaaaaaaaa!", pattern: "(a+)+$" }), /nested quantifier/);
  throwsWith("(a*)* is refused too",
    () => regexExtract({ text: "aaa", pattern: "(a*)*b" }), /nested quantifier/);
  throwsWith("(a{2,})+ is refused",
    () => regexExtract({ text: "aaa", pattern: "(a{2,})+b" }), /nested quantifier/);
  check("the refusal explains the real consequence",
    (() => {
      try {
        regexExtract({ text: "a", pattern: "(a+)+$" });
        return false;
      } catch (e) {
        return /autotrader|block the whole process/.test(e.message);
      }
    })());

  throwsWith("an overlong pattern is refused", () => regexExtract({ text: "a", pattern: "a".repeat(2000) }), /too long/);
  throwsWith("overlong input is refused", () => regexExtract({ text: "a".repeat(300_000), pattern: "a" }), /too long/);
}

console.log("\nText normalization and comparison");

{
  const n = normalizeText({ text: "  Héllo   WORLD!  ", lower: true });
  check("collapses whitespace and trims", n.text === "héllo world!", JSON.stringify(n.text));

  const p = normalizeText({ text: "a,b. c!", stripPunctuation: true });
  check("strips punctuation when asked", p.text === "a b c", JSON.stringify(p.text));

  // NFC vs NFD matters for any text that came off a web page.
  const decomposed = "é"; // e + combining acute
  const composed = normalizeText({ text: decomposed, form: "NFC" });
  check("unicode normalization composes combining marks", composed.text === "é", JSON.stringify(composed.text));
  check("normalization form is reported", composed.unicodeForm === "NFC");
  check("an invalid form falls back to NFC", normalizeText({ text: "a", form: "BOGUS" }).unicodeForm === "NFC");
  check("keeps punctuation by default", normalizeText({ text: "a,b" }).text === "a,b");
}

{
  const same = compareText({ before: "one\ntwo", after: "one\ntwo" });
  check("identical text is reported as identical", same.identical === true && same.lineSimilarity === 1);
  check("no changes are listed", same.linesAdded === 0 && same.linesRemoved === 0);

  const diff = compareText({ before: "alpha\nbeta\ngamma", after: "alpha\nBETA\ngamma" });
  check("a changed line is detected", diff.identical === false);
  check("the added line is listed", diff.added.includes("BETA"));
  check("the removed line is listed", diff.removed.includes("beta"));
  check("unchanged lines are not listed as changes", !diff.added.includes("alpha"));
  check("similarity is high for a small change", diff.lineSimilarity > 0.6, String(diff.lineSimilarity));

  const total = compareText({ before: "a\nb\nc", after: "x\ny\nz" });
  check("similarity is low for a total rewrite", total.lineSimilarity < 0.2, String(total.lineSimilarity));
  check("token similarity is reported separately", typeof total.tokenSimilarity === "number");
}

console.log("\nStatic source analysis");

{
  const code = [
    "const r = eval(userInput);",
    "const f = new Function('return 1');",
    "const { execSync } = require('child_process');",
    "fetch('http://insecure.example.com/x');",
    "const apiKey = 'sk_live_abcdef0123456789abcd';",
    "https.request({ rejectUnauthorized: false });",
    "el.innerHTML = untrusted;"
  ].join("\n");

  const r = analyzeSource({ code, language: "javascript" });
  const ids = r.findings.map((f) => f.id);

  check("flags eval", ids.includes("eval"));
  check("flags the Function constructor", ids.includes("function_constructor"));
  check("flags child_process", ids.includes("child_process"));
  check("flags disabled TLS verification", ids.includes("disable_tls_verify"));
  check("flags a hardcoded credential", ids.includes("hardcoded_secret"));
  check("flags innerHTML assignment", ids.includes("innerHTML"));
  check("flags plain HTTP", ids.includes("http_no_tls"));
  check("reports line numbers", r.findings.every((f) => Number.isInteger(f.line) && f.line >= 1));
  check("sorts high severity first", r.findings[0].severity === "high");
  check("counts by severity", r.bySeverity.high >= 4, JSON.stringify(r.bySeverity));

  check("clean code produces no findings", analyzeSource({ code: "const x = 1 + 2;\nexport default x;" }).findingCount === 0);
  check("it does not claim to be a security audit",
    /not a security audit/.test(analyzeSource({ code: "x" }).caveat));
  check("it warns that no findings is not proof of safety",
    /not evidence that code is safe/.test(analyzeSource({ code: "x" }).caveat));
}

console.log("\nPrivacy scanning");

{
  const text = "Contact jo@example.com or 775-555-1234. Key: sk_live_abcdefgh12345678 and AKIAIOSFODNN7EXAMPLE";
  const r = analyzePrivacy({ text });
  const ids = r.findings.map((f) => f.id);

  check("detects email", ids.includes("email"));
  check("detects phone numbers", ids.includes("us_phone"));
  check("detects api-key-shaped strings", ids.includes("api_key_like"));
  check("detects AWS access keys", ids.includes("aws_key"));
  check("rates credential findings as high risk", r.risk === "high", r.risk);

  // A scanner that echoes what it found has leaked it further than
  // whatever it was protecting against.
  const allSamples = r.findings.map((f) => f.sample).join(" ");
  check("the actual email is NOT echoed in full", !allSamples.includes("jo@example.com"), allSamples);
  check("the actual AWS key is NOT echoed in full", !allSamples.includes("AKIAIOSFODNN7EXAMPLE"));
  check("samples are masked", r.findings.every((f) => f.sample === null || f.sample.includes("*")));
  check("it admits to false positives", /false positives/.test(r.note));

  const keys = analyzePrivacy({ data: { user: { password: "hunter2", email_address: "x", nested: { api_key: "abc" } } } });
  check("sensitive-looking object keys are flagged", keys.sensitiveKeys.length >= 2, JSON.stringify(keys.sensitiveKeys));
  check("nested keys are found with a full path",
    keys.sensitiveKeys.some((k) => k.key === "user.nested.api_key"), JSON.stringify(keys.sensitiveKeys.map((k) => k.key)));
  check("key values are masked too",
    keys.sensitiveKeys.every((k) => k.sample === null || !k.sample.includes("hunter2")));

  const clean = analyzePrivacy({ text: "nothing sensitive here at all" });
  check("clean text is low risk with no findings", clean.risk === "low" && clean.findingCount === 0);
}

console.log("\nOpenAPI inspection");

{
  const doc = {
    openapi: "3.0.0",
    info: { title: "Reno API", version: "1.2.3" },
    servers: [{ url: "https://api.example.com" }],
    paths: {
      "/events": {
        get: { operationId: "listEvents", summary: "List events", parameters: [{ name: "date", in: "query", required: true }] },
        post: { operationId: "createEvent", requestBody: {} }
      },
      "/events/{id}": { delete: { operationId: "deleteEvent", deprecated: true } }
    },
    components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } }, schemas: { Event: {}, Venue: {} } }
  };

  const r = inspectOpenApi({ document: doc });
  check("reads the version", r.version === "3.0.0");
  check("reads the title", r.title === "Reno API");
  check("lists servers", r.servers[0] === "https://api.example.com");
  check("enumerates every operation", r.operationCount === 3, String(r.operationCount));
  check("captures method and path", r.operations.some((o) => o.method === "GET" && o.path === "/events"));
  check("captures parameters", r.operations[0].parameters[0].name === "date");
  check("notes request bodies", r.operations.some((o) => o.requestBody === true));
  check("marks deprecated operations", r.operations.some((o) => o.deprecated === true));
  check("lists security schemes", r.securitySchemes[0].name === "bearer");
  check("lists schema names", r.schemaNames.includes("Event"));

  check("accepts a JSON string", inspectOpenApi({ document: JSON.stringify(doc) }).operationCount === 3);
  throwsWith("rejects a non-OpenAPI object", () => inspectOpenApi({ document: { hello: 1 } }), /does not look like an OpenAPI/);
  throwsWith("rejects invalid JSON", () => inspectOpenApi({ document: "{oops" }), /not valid JSON/);
}

console.log("\nGuarded JSON fetch, npm and GitHub");

const publicResolve = async () => [{ address: "93.184.216.34" }];

{
  // The guard matters more here than for plain page reads, because this
  // one forwards caller-supplied headers.
  await rejectsWith("refuses cloud metadata even with headers supplied",
    () => readJsonApi({ url: "http://169.254.169.254/latest/meta-data/", headers: { Authorization: "Bearer x" } }),
    /private or internal/);
  await rejectsWith("refuses internal hostnames",
    () => readJsonApi({ url: "http://darkly-litellm.railway.internal/v1/models" }), /internal hostname/);
}

{
  _setFetchForTests(async () => ({ status: 200, text: async () => '{"ok":true,"n":3}' }));
  const r = await readJsonApi({ url: "https://api.example.com/x", _resolve: publicResolve });
  check("parses a JSON response", r.ok === true && r.json.n === 3);

  _setFetchForTests(async () => ({ status: 200, text: async () => "<html>not json</html>" }));
  const bad = await readJsonApi({ url: "https://api.example.com/x", _resolve: publicResolve });
  check("non-JSON is reported rather than throwing", bad.ok === false && bad.parseError);
  check("a preview of the body is included so the cause is visible", /not json/.test(bad.bodyPreview));

  _setFetchForTests(async () => ({ status: 404, text: async () => "{}" }));
  const missing = await readJsonApi({ url: "https://api.example.com/x", _resolve: publicResolve });
  check("an HTTP error status is surfaced", missing.ok === false && missing.status === 404);
}

{
  _setFetchForTests(async () => ({
    status: 200,
    text: async () =>
      JSON.stringify({
        name: "left-pad",
        description: "pads on the left",
        "dist-tags": { latest: "1.3.0" },
        versions: { "1.3.0": { license: "MIT", dependencies: { a: "1" } } },
        time: { "1.3.0": "2026-01-01T00:00:00Z" },
        maintainers: [{ name: "x" }]
      })
  }));
  const npm = await inspectNpmPackage({ name: "left-pad", _resolve: publicResolve });
  check("reads npm package metadata", npm.ok && npm.package === "left-pad" && npm.latest === "1.3.0");
  check("reads the license", npm.license === "MIT");
  check("lists dependencies", npm.dependencies.includes("a"));

  await rejectsWith("rejects a malformed package name",
    () => inspectNpmPackage({ name: "not a package!" }), /valid npm package name/);
  check("accepts scoped names", /^@scope\//.test("@scope/pkg"));
}

{
  _setFetchForTests(async () => ({
    status: 200,
    text: async () =>
      JSON.stringify({
        full_name: "ADarklyScanner/darkly-agent",
        description: "agent",
        private: false,
        stargazers_count: 1,
        forks_count: 0,
        open_issues_count: 2,
        language: "JavaScript",
        license: { spdx_id: "MIT" },
        default_branch: "main",
        pushed_at: "2026-09-17T00:00:00Z",
        topics: ["agent"]
      })
  }));
  const gh = await inspectGithubRepo({ repo: "ADarklyScanner/darkly-agent", _resolve: publicResolve });
  check("reads GitHub repo metadata", gh.ok && gh.repo === "ADarklyScanner/darkly-agent");
  check("reads the default branch", gh.defaultBranch === "main");
  check("reads the license", gh.license === "MIT");

  await rejectsWith("rejects a malformed repo name",
    () => inspectGithubRepo({ repo: "justaname" }), /owner\/name/);
}

_setFetchForTests(null);

console.log("\nJavaScript parse check");

{
  const good = await checkJavaScript({ code: "const x = 1;\nexport default x;" });
  check("valid ESM passes", good.valid === true, JSON.stringify(good));

  const bad = await checkJavaScript({ code: "const x = ;" });
  check("invalid syntax is reported as invalid, not thrown", bad.ok === true && bad.valid === false);
  check("the error message is included", /SyntaxError|Unexpected/.test(bad.error), bad.error);
  check("a line number is extracted when available", bad.line === 1, String(bad.line));
  check("the temp path is not leaked into the error", !/darkly-check-/.test(bad.error), bad.error);

  // The property that makes this safe to offer at all.
  const sideEffect = await checkJavaScript({ code: "process.exit(99); throw new Error('should never run');" });
  check("checking does NOT execute the code", sideEffect.valid === true, JSON.stringify(sideEffect));

  const cjs = await checkJavaScript({ code: "const x = require('fs');", module: false });
  check("commonjs mode works", cjs.valid === true);

  await rejectsWith("rejects non-string code", () => checkJavaScript({ code: 5 }), /must be a string/);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
