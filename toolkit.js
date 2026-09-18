/**
 * toolkit.js — the portable data/text utilities from the Factory tool
 * registry, reimplemented for this agent.
 *
 * WHAT IS HERE AND WHAT IS NOT
 *
 * The registry listed 71 tools. They are not all the same kind of thing,
 * and porting them indiscriminately would have produced a menu of
 * functions that mostly cannot work here:
 *
 *  - 22 are portable utilities that need nothing but Node. Those are
 *    implemented below, minus two that already exist in this codebase
 *    (`statistics` is calc.js's describe(), `webpage_url_reader` is
 *    web-read.js's fetchPage()) — duplicating them would mean two
 *    implementations drifting apart.
 *  - 10 are APK tools that shell out to apksigner/zipalign and take a
 *    local `apk_path`. Railway has neither the Android SDK nor any way
 *    for a user to hand this service a file, so they would be dead
 *    entries.
 *  - 2 run supplied HTML/JS inside jsdom. That is code execution in the
 *    process holding the trading keys — the same thing calc.js declines
 *    to do, for the same reason.
 *  - 14 manage Factory-internal state (its 960-entry registry, learning
 *    queues, artifact store). None of that state exists here.
 *  - 23 are HTTP wrappers around darkly-ai-factory.hatchable.site. One
 *    generic bridge covers all 23; 23 near-identical tool definitions
 *    would just crowd the model's tool list.
 *
 * Everything below is pure computation or a guarded fetch, with no
 * dependencies beyond Node's standard library.
 */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertSafeUrl } from "./web-read.js";

const execFileAsync = promisify(execFile);

export const MAX_TEXT_INPUT = 500_000;
export const MAX_REGEX_INPUT = 200_000;
export const MAX_PATTERN_LENGTH = 1_000;

function requireText(value, name = "text", cap = MAX_TEXT_INPUT) {
  if (typeof value !== "string") throw new Error(`\`${name}\` must be a string.`);
  if (value.length > cap) throw new Error(`\`${name}\` is too long (${value.length} chars; cap is ${cap}).`);
  return value;
}

/* ------------------------------------------------------------------ *
 * Encoding and hashing
 * ------------------------------------------------------------------ */

export function base64Encode({ text, bytesBase64 } = {}) {
  if (typeof text === "string") {
    const buf = Buffer.from(text, "utf8");
    return { base64: buf.toString("base64"), bytes: buf.length, source: "text" };
  }
  if (typeof bytesBase64 === "string") {
    const buf = Buffer.from(bytesBase64, "base64");
    return { base64: buf.toString("base64"), bytes: buf.length, source: "bytes" };
  }
  throw new Error("Supply either `text` or `bytesBase64`.");
}

export function base64Decode({ data } = {}) {
  if (typeof data !== "string") throw new Error("`data` must be a base64 string.");
  const buf = Buffer.from(data, "base64");

  // Round-tripping detects input that was not actually valid base64;
  // Buffer.from silently discards bad characters rather than throwing,
  // which would otherwise turn garbage into confident-looking output.
  const canonical = buf.toString("base64");
  const normalized = data.replace(/\s+/g, "");
  const looksValid = canonical.replace(/=+$/, "") === normalized.replace(/=+$/, "");

  const text = buf.toString("utf8");
  const isPrintableText = !text.includes("�");

  return {
    bytes: buf.length,
    text: isPrintableText ? text : null,
    isUtf8Text: isPrintableText,
    looksLikeValidBase64: looksValid,
    note: looksValid
      ? isPrintableText
        ? null
        : "Decoded successfully but the bytes are not valid UTF-8 text (probably binary)."
      : "Input was not clean base64 — invalid characters were discarded, so this result may be wrong."
  };
}

export function sha256({ text } = {}) {
  const value = requireText(text, "text");
  return { algorithm: "sha256", hex: createHash("sha256").update(value, "utf8").digest("hex"), bytes: Buffer.byteLength(value, "utf8") };
}

/* ------------------------------------------------------------------ *
 * Chunking and deduplication
 * ------------------------------------------------------------------ */

export function chunk({ data, size = 1000, overlap = 0 } = {}) {
  const n = Math.max(1, Math.floor(Number(size) || 1000));
  const ov = Math.max(0, Math.floor(Number(overlap) || 0));
  if (ov >= n) throw new Error(`\`overlap\` (${ov}) must be smaller than \`size\` (${n}), or chunking would never advance.`);

  const step = n - ov;
  const chunks = [];

  if (typeof data === "string") {
    requireText(data, "data");
    for (let i = 0; i < data.length; i += step) {
      chunks.push(data.slice(i, i + n));
      if (i + n >= data.length) break;
    }
    return { kind: "text", count: chunks.length, size: n, overlap: ov, chunks };
  }

  if (Array.isArray(data)) {
    for (let i = 0; i < data.length; i += step) {
      chunks.push(data.slice(i, i + n));
      if (i + n >= data.length) break;
    }
    return { kind: "array", count: chunks.length, size: n, overlap: ov, chunks };
  }

  throw new Error("`data` must be a string or an array.");
}

/** Stable stringify so object identity does not depend on key order. */
function stableKey(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableKey).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableKey(value[k])}`)
    .join(",")}}`;
}

export function deduplicate({ items, key } = {}) {
  if (!Array.isArray(items)) throw new Error("`items` must be an array.");
  const seen = new Set();
  const unique = [];
  const duplicates = [];

  for (const item of items) {
    const identity =
      key && item && typeof item === "object"
        ? stableKey(item[key])
        : stableKey(item);
    if (seen.has(identity)) {
      duplicates.push(item);
      continue;
    }
    seen.add(identity);
    unique.push(item);
  }

  return {
    input: items.length,
    unique: unique.length,
    removed: duplicates.length,
    by: key ? `key "${key}"` : "whole-value identity (key order independent)",
    items: unique
  };
}

/* ------------------------------------------------------------------ *
 * CSV / TSV
 * ------------------------------------------------------------------ */

/**
 * RFC4180-ish CSV parsing: handles quoted fields, embedded delimiters,
 * embedded newlines, and doubled quotes. Written as a character scanner
 * rather than a split() because splitting on commas corrupts any real
 * spreadsheet export the moment a field contains one.
 */
export function parseDelimited({ text, delimiter, headers = true } = {}) {
  const src = requireText(text, "text");
  if (src.trim() === "") return { rows: [], columns: [], rowCount: 0, delimiter: delimiter || ",", note: "Input was empty." };

  let delim = delimiter;
  if (!delim) {
    // Infer from the first line: whichever of tab/comma/semicolon/pipe
    // appears most outside of quotes.
    const firstLine = src.split(/\r?\n/)[0];
    const counts = { "\t": 0, ",": 0, ";": 0, "|": 0 };
    let inQ = false;
    for (let i = 0; i < firstLine.length; i++) {
      const c = firstLine[i];
      if (c === '"') inQ = !inQ;
      else if (!inQ && counts[c] !== undefined) counts[c]++;
    }
    delim = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][1] > 0
      ? Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]
      : ",";
  }

  const records = [];
  let field = "";
  let record = [];
  let inQuotes = false;

  for (let i = 0; i < src.length; i++) {
    const c = src[i];

    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') {
      inQuotes = true;
    } else if (c === delim) {
      record.push(field);
      field = "";
    } else if (c === "\n") {
      record.push(field);
      records.push(record);
      record = [];
      field = "";
    } else if (c === "\r") {
      // handled by the \n branch
    } else {
      field += c;
    }
  }
  if (field !== "" || record.length > 0) {
    record.push(field);
    records.push(record);
  }

  if (records.length === 0) return { rows: [], columns: [], rowCount: 0, delimiter: delim };

  if (!headers) {
    return {
      rows: records,
      columns: [],
      rowCount: records.length,
      delimiter: delim === "\t" ? "\\t" : delim,
      note: "Returned as arrays because `headers` was false."
    };
  }

  const columns = records[0].map((h, i) => h.trim() || `column_${i + 1}`);
  const rows = records.slice(1).map((r) => {
    const obj = {};
    columns.forEach((col, i) => {
      obj[col] = r[i] !== undefined ? r[i] : null;
    });
    return obj;
  });

  const ragged = records.slice(1).filter((r) => r.length !== columns.length).length;

  return {
    rows,
    columns,
    rowCount: rows.length,
    delimiter: delim === "\t" ? "\\t" : delim,
    note: ragged > 0 ? `${ragged} row(s) did not have ${columns.length} fields; missing values are null.` : null
  };
}

/* ------------------------------------------------------------------ *
 * JSON path, schema inference
 * ------------------------------------------------------------------ */

export function jsonPath({ data, path: expr } = {}) {
  let root = data;
  if (typeof data === "string") {
    try {
      root = JSON.parse(data);
    } catch (e) {
      throw new Error(`\`data\` is a string but not valid JSON: ${e.message}`);
    }
  }

  if (!expr || expr === "$" || expr === "") return { path: expr || "$", found: true, value: root };

  const parts = String(expr)
    .replace(/^\$\.?/, "")
    .split(/\.|\[/)
    .map((p) => p.replace(/\]$/, "").replace(/^["']|["']$/g, ""))
    .filter((p) => p !== "");

  let cursor = root;
  const walked = [];
  for (const part of parts) {
    if (cursor === null || cursor === undefined) {
      return { path: expr, found: false, value: null, failedAt: walked.join(".") || "(root)", reason: `"${part}" was looked up on ${cursor === null ? "null" : "undefined"}.` };
    }
    const index = /^\d+$/.test(part) ? Number(part) : part;
    if (typeof cursor !== "object") {
      return { path: expr, found: false, value: null, failedAt: walked.join("."), reason: `"${part}" was looked up on a ${typeof cursor}.` };
    }
    if (!(index in cursor)) {
      const available = Array.isArray(cursor) ? `${cursor.length} items` : Object.keys(cursor).slice(0, 12).join(", ");
      return { path: expr, found: false, value: null, failedAt: walked.join(".") || "(root)", reason: `"${part}" is not present. Available: ${available}` };
    }
    cursor = cursor[index];
    walked.push(part);
  }

  return { path: expr, found: true, value: cursor };
}

export function inferSchema({ data } = {}) {
  let value = data;
  if (typeof data === "string") {
    try {
      value = JSON.parse(data);
    } catch (e) {
      // A plain string is legitimate input too.
    }
  }

  const MAX_DEPTH = 12;

  function describe(v, depth = 0) {
    if (depth > MAX_DEPTH) return { type: "unknown", note: "max depth reached" };
    if (v === null) return { type: "null" };
    if (Array.isArray(v)) {
      if (v.length === 0) return { type: "array", items: {}, note: "empty array — item type unknown" };
      const sampled = v.slice(0, 50).map((x) => describe(x, depth + 1));
      const types = [...new Set(sampled.map((s) => s.type))];
      return {
        type: "array",
        length: v.length,
        items: types.length === 1 ? sampled[0] : { anyOf: dedupeSchemas(sampled) }
      };
    }
    if (typeof v === "object") {
      const properties = {};
      for (const [k, val] of Object.entries(v).slice(0, 200)) properties[k] = describe(val, depth + 1);
      return { type: "object", properties, required: Object.keys(properties) };
    }
    if (typeof v === "number") return { type: Number.isInteger(v) ? "integer" : "number" };
    if (typeof v === "string") {
      const fmt = detectFormat(v);
      return fmt ? { type: "string", format: fmt } : { type: "string" };
    }
    return { type: typeof v };
  }

  function dedupeSchemas(list) {
    const seen = new Map();
    for (const s of list) seen.set(stableKey(s), s);
    return [...seen.values()];
  }

  function detectFormat(s) {
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return "date-time";
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return "date";
    if (/^https?:\/\//i.test(s)) return "uri";
    if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)) return "email";
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return "uuid";
    return null;
  }

  return { $schema: "http://json-schema.org/draft-07/schema#", ...describe(value) };
}

/* ------------------------------------------------------------------ *
 * Regex extraction
 * ------------------------------------------------------------------ */

/**
 * Patterns with nested quantifiers can backtrack catastrophically. That
 * matters more here than in a normal script: this runs in the single Node
 * process that also drives the autotrader scheduler, so a hung regex does
 * not just fail a tool call, it freezes trading. Node has no regex
 * timeout, so the mitigations available are input caps and refusing the
 * shapes that cause it.
 */
const CATASTROPHIC_SHAPES = [
  /\([^)]*[+*]\)[+*]/, // (a+)+ or (a*)*
  /\([^)]*\{\d+,\}\)[+*]/, // (a{2,})+
  /\([^)]*[+*][^)]*\)\{\d+,\}/ // (a+){2,}
];

export function regexExtract({ text, pattern, flags = "g", limit = 100 } = {}) {
  const src = requireText(text, "text", MAX_REGEX_INPUT);
  if (typeof pattern !== "string") throw new Error("`pattern` must be a string.");
  if (pattern.length > MAX_PATTERN_LENGTH) {
    throw new Error(`\`pattern\` is too long (${pattern.length}; cap is ${MAX_PATTERN_LENGTH}).`);
  }

  for (const shape of CATASTROPHIC_SHAPES) {
    if (shape.test(pattern)) {
      throw new Error(
        "Refusing this pattern: it contains a nested quantifier (like (a+)+) that can backtrack catastrophically. " +
          "On this deployment a hung regex would block the whole process, including the autotrader. Rewrite it without the nested quantifier."
      );
    }
  }

  let safeFlags = String(flags).replace(/[^gimsuy]/g, "");
  if (!safeFlags.includes("g")) safeFlags += "g";

  let re;
  try {
    re = new RegExp(pattern, safeFlags);
  } catch (e) {
    throw new Error(`Invalid regular expression: ${e.message}`);
  }

  const cap = Math.max(1, Math.min(1000, Number(limit) || 100));
  const matches = [];
  let m;
  let guard = 0;

  while ((m = re.exec(src)) !== null) {
    matches.push({
      match: m[0],
      index: m.index,
      groups: m.length > 1 ? m.slice(1) : undefined,
      named: m.groups ? { ...m.groups } : undefined
    });
    if (matches.length >= cap) break;
    if (m[0] === "") re.lastIndex++; // zero-width match: advance or loop forever
    if (++guard > 100_000) break;
  }

  return {
    pattern,
    flags: safeFlags,
    count: matches.length,
    truncated: matches.length >= cap,
    matches
  };
}

/* ------------------------------------------------------------------ *
 * Text normalization and comparison
 * ------------------------------------------------------------------ */

export function normalizeText({ text, lower = false, stripPunctuation = false, collapseWhitespace = true, form = "NFC" } = {}) {
  let s = requireText(text, "text");
  const before = s.length;

  const validForms = ["NFC", "NFD", "NFKC", "NFKD"];
  const useForm = validForms.includes(form) ? form : "NFC";
  s = s.normalize(useForm);

  if (stripPunctuation) s = s.replace(/[^\p{L}\p{N}\s]/gu, " ");
  if (collapseWhitespace) s = s.replace(/\s+/g, " ").trim();
  if (lower) s = s.toLowerCase();

  return { text: s, unicodeForm: useForm, charsBefore: before, charsAfter: s.length };
}

/** Longest common subsequence length, used for similarity. */
function lcsLength(a, b) {
  // Rolling two-row DP: the full matrix would be O(n*m) memory and these
  // are documents, not toy strings.
  const prev = new Array(b.length + 1).fill(0);
  const curr = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

export function compareText({ before, after, context = 2 } = {}) {
  const a = requireText(before, "before", 200_000);
  const b = requireText(after, "after", 200_000);

  const aLines = a.split(/\r?\n/);
  const bLines = b.split(/\r?\n/);

  const identical = a === b;
  const lcs = identical ? aLines.length : lcsLength(aLines, bLines);
  const lineSimilarity = aLines.length + bLines.length === 0 ? 1 : (2 * lcs) / (aLines.length + bLines.length);

  const aTokens = a.toLowerCase().split(/\s+/).filter(Boolean);
  const bTokens = b.toLowerCase().split(/\s+/).filter(Boolean);
  const aSet = new Set(aTokens);
  const bSet = new Set(bTokens);
  const intersection = [...aSet].filter((t) => bSet.has(t)).length;
  const union = new Set([...aSet, ...bSet]).size;
  const tokenSimilarity = union === 0 ? 1 : intersection / union;

  // A compact changed-lines report rather than a full unified diff: the
  // useful question is almost always "what changed", not "render me a
  // patch".
  const bSetLines = new Set(bLines);
  const aSetLines = new Set(aLines);
  const removed = aLines.filter((l) => !bSetLines.has(l));
  const added = bLines.filter((l) => !aSetLines.has(l));

  return {
    identical,
    lineSimilarity: Number(lineSimilarity.toFixed(4)),
    tokenSimilarity: Number(tokenSimilarity.toFixed(4)),
    linesBefore: aLines.length,
    linesAfter: bLines.length,
    linesAdded: added.length,
    linesRemoved: removed.length,
    added: added.slice(0, 200),
    removed: removed.slice(0, 200),
    truncated: added.length > 200 || removed.length > 200
  };
}

/* ------------------------------------------------------------------ *
 * Static source analysis and privacy scanning
 * ------------------------------------------------------------------ */

const RISKY_PATTERNS = [
  { id: "eval", re: /\beval\s*\(/, severity: "high", note: "eval() executes arbitrary code." },
  { id: "function_constructor", re: /\bnew\s+Function\s*\(/, severity: "high", note: "new Function() compiles arbitrary code." },
  { id: "child_process", re: /child_process|execSync|spawnSync|\bexecFile\b/, severity: "high", note: "Spawns operating-system processes." },
  { id: "shell_true", re: /shell\s*:\s*true/, severity: "high", note: "shell:true allows command injection via arguments." },
  { id: "vm_module", re: /require\(['"]vm['"]\)|from\s+['"]node:vm['"]/, severity: "high", note: "node:vm is explicitly not a security boundary." },
  { id: "dynamic_import", re: /\bimport\s*\(/, severity: "medium", note: "Dynamic import can load code decided at runtime." },
  { id: "fs_write", re: /writeFileSync|writeFile\(|unlinkSync|rmSync|rmdirSync/, severity: "medium", note: "Writes or deletes files." },
  { id: "process_env_dump", re: /JSON\.stringify\s*\(\s*process\.env|console\.log\s*\(\s*process\.env/, severity: "high", note: "Prints the entire environment, which is where credentials live." },
  { id: "innerHTML", re: /\.innerHTML\s*=/, severity: "medium", note: "innerHTML assignment can introduce XSS." },
  { id: "document_write", re: /document\.write\s*\(/, severity: "medium", note: "document.write can inject markup." },
  { id: "http_no_tls", re: /http:\/\/(?!localhost|127\.0\.0\.1)/, severity: "low", note: "Plain HTTP URL — traffic is unencrypted." },
  { id: "disable_tls_verify", re: /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED/, severity: "high", note: "Disables TLS certificate verification." },
  { id: "hardcoded_secret", re: /(api[_-]?key|secret|password|token)\s*[:=]\s*["'][A-Za-z0-9_\-]{16,}["']/i, severity: "high", note: "Looks like a credential written directly into the source." },
  { id: "sql_concat", re: /(SELECT|INSERT|UPDATE|DELETE)\b[^;]*\+\s*\w+/i, severity: "medium", note: "SQL built by string concatenation — possible injection." },
  { id: "wildcard_cors", re: /Access-Control-Allow-Origin["'\s:,]+\*/, severity: "medium", note: "CORS is open to every origin." },
  { id: "md5_or_sha1", re: /createHash\(\s*["'](md5|sha1)["']/, severity: "low", note: "MD5/SHA-1 are unsuitable for security purposes." }
];

export function analyzeSource({ code, language } = {}) {
  const src = requireText(code, "code");
  const lines = src.split(/\r?\n/);
  const findings = [];

  for (const p of RISKY_PATTERNS) {
    for (let i = 0; i < lines.length; i++) {
      if (p.re.test(lines[i])) {
        findings.push({
          id: p.id,
          severity: p.severity,
          line: i + 1,
          text: lines[i].trim().slice(0, 200),
          note: p.note
        });
        if (findings.filter((f) => f.id === p.id).length >= 5) break; // don't flood on one pattern
      }
    }
  }

  const order = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || a.line - b.line);

  return {
    language: language || "unspecified",
    lines: lines.length,
    findingCount: findings.length,
    bySeverity: {
      high: findings.filter((f) => f.severity === "high").length,
      medium: findings.filter((f) => f.severity === "medium").length,
      low: findings.filter((f) => f.severity === "low").length
    },
    findings,
    caveat:
      "This is a pattern scan, not a security audit. It finds well-known risky constructs and will both miss real problems and flag harmless code. Absence of findings is not evidence that code is safe."
  };
}

const PRIVACY_PATTERNS = [
  { id: "email", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, category: "contact" },
  { id: "us_phone", re: /\b(?:\+1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, category: "contact" },
  { id: "ssn_like", re: /\b\d{3}-\d{2}-\d{4}\b/g, category: "government_id" },
  { id: "credit_card_like", re: /\b(?:\d[ -]?){13,19}\b/g, category: "financial" },
  { id: "ip_address", re: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, category: "network" },
  // The body must allow _ and -, because real keys are segmented
  // (sk_live_..., pk_test_...). Requiring [A-Za-z0-9]{16,} straight after
  // the prefix silently missed the single most common leaked-key format
  // there is. Caught by toolkit.test.mjs.
  { id: "api_key_like", re: /\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{16,}\b/g, category: "credential" },
  { id: "bearer_token", re: /\bBearer\s+[A-Za-z0-9._-]{20,}/g, category: "credential" },
  { id: "aws_key", re: /\bAKIA[0-9A-Z]{16}\b/g, category: "credential" },
  { id: "private_key_block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, category: "credential" }
];

const SENSITIVE_KEY_NAMES = /(password|passwd|secret|token|api[_-]?key|auth|credential|ssn|dob|birth|salary|income|diagnosis|medical|patient)/i;

/**
 * Scan text and/or an object's keys for things that look sensitive.
 *
 * Deliberately reports matches by COUNT and TYPE with only a masked
 * sample, never the full value: a privacy scanner that echoes the
 * credentials it found into a chat transcript and a log has leaked them
 * more widely than whatever it was protecting against.
 */
export function analyzePrivacy({ text, data } = {}) {
  const findings = [];

  if (typeof text === "string") {
    const src = requireText(text, "text");
    for (const p of PRIVACY_PATTERNS) {
      const matches = src.match(p.re) || [];
      if (matches.length > 0) {
        findings.push({
          id: p.id,
          category: p.category,
          count: matches.length,
          sample: mask(matches[0]),
          where: "text"
        });
      }
    }
  }

  const sensitiveKeys = [];
  if (data && typeof data === "object") {
    walkKeys(data, "", sensitiveKeys, 0);
  }

  const categories = [...new Set(findings.map((f) => f.category))];
  const hasCredential = categories.includes("credential") || categories.includes("government_id");

  return {
    findingCount: findings.length + sensitiveKeys.length,
    categories,
    findings,
    sensitiveKeys: sensitiveKeys.slice(0, 100),
    risk: hasCredential ? "high" : findings.length + sensitiveKeys.length > 0 ? "medium" : "low",
    note:
      "Values are masked on purpose — a scanner that echoed what it found would spread it further. Pattern matching also produces false positives (any 16-digit number looks like a card) and misses anything it has no pattern for."
  };
}

function mask(value) {
  const s = String(value);
  if (s.length <= 4) return "*".repeat(s.length);
  return `${s.slice(0, 2)}${"*".repeat(Math.max(3, s.length - 4))}${s.slice(-2)}`;
}

function walkKeys(obj, prefix, out, depth) {
  if (depth > 8 || out.length >= 100) return;
  if (Array.isArray(obj)) {
    obj.slice(0, 50).forEach((v, i) => {
      if (v && typeof v === "object") walkKeys(v, `${prefix}[${i}]`, out, depth + 1);
    });
    return;
  }
  for (const [k, v] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${k}` : k;
    if (SENSITIVE_KEY_NAMES.test(k)) {
      out.push({ key: full, valueType: v === null ? "null" : typeof v, sample: typeof v === "string" ? mask(v) : null });
    }
    if (v && typeof v === "object") walkKeys(v, full, out, depth + 1);
  }
}

/* ------------------------------------------------------------------ *
 * OpenAPI inspection
 * ------------------------------------------------------------------ */

export function inspectOpenApi({ document } = {}) {
  let doc = document;
  if (typeof document === "string") {
    try {
      doc = JSON.parse(document);
    } catch (e) {
      throw new Error(`\`document\` is a string but not valid JSON: ${e.message}`);
    }
  }
  if (!doc || typeof doc !== "object") throw new Error("`document` must be an OpenAPI object or JSON string.");

  const version = doc.openapi || doc.swagger || null;
  if (!version) throw new Error("This does not look like an OpenAPI document (no `openapi` or `swagger` field).");

  const operations = [];
  const METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];

  for (const [p, item] of Object.entries(doc.paths || {})) {
    for (const method of METHODS) {
      const op = item && item[method];
      if (!op) continue;
      operations.push({
        method: method.toUpperCase(),
        path: p,
        operationId: op.operationId || null,
        summary: op.summary || op.description || null,
        parameters: (op.parameters || []).map((x) => ({ name: x.name, in: x.in, required: Boolean(x.required) })),
        requestBody: Boolean(op.requestBody),
        security: op.security ? op.security.map((s) => Object.keys(s)[0]) : undefined,
        deprecated: op.deprecated ? true : undefined
      });
    }
  }

  const schemes = doc.components?.securitySchemes || doc.securityDefinitions || {};

  return {
    version,
    title: doc.info?.title || null,
    apiVersion: doc.info?.version || null,
    servers: (doc.servers || []).map((s) => s.url),
    operationCount: operations.length,
    operations: operations.slice(0, 300),
    truncated: operations.length > 300,
    securitySchemes: Object.entries(schemes).map(([name, s]) => ({
      name,
      type: s.type,
      scheme: s.scheme,
      in: s.in
    })),
    schemaNames: Object.keys(doc.components?.schemas || doc.definitions || {}).slice(0, 200)
  };
}

/* ------------------------------------------------------------------ *
 * Guarded JSON fetch, npm and GitHub inspection
 * ------------------------------------------------------------------ */

let _fetchImpl = null;
export function _setFetchForTests(fn) {
  _fetchImpl = fn;
}
function theFetch() {
  return _fetchImpl || globalThis.fetch;
}

/**
 * Fetch a URL and parse JSON.
 *
 * Routed through the same destination guard as web-read.js — and it
 * matters more here, because this one accepts caller-supplied headers.
 * An unguarded version would happily send an Authorization header to an
 * internal address.
 */
export async function readJsonApi({ url, headers = {}, timeoutMs = 15000, _resolve } = {}) {
  await assertSafeUrl(url, _resolve ? { _resolve } : {});

  const safeHeaders = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (typeof v === "string" && /^[\w.-]+$/.test(k)) safeHeaders[k] = v;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Math.min(60_000, Number(timeoutMs) || 15000)));
  let res;
  try {
    res = await theFetch()(url, {
      headers: { Accept: "application/json", "User-Agent": "DarklyAgent/1.0", ...safeHeaders },
      signal: controller.signal
    });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === "AbortError") throw new Error(`Timed out fetching ${url}`);
    throw new Error(`Could not fetch ${url}: ${e.message}`);
  }
  clearTimeout(timer);

  const text = await res.text();
  if (text.length > 2_000_000) throw new Error("Response is too large to parse as JSON (over 2MB).");

  let json = null;
  let parseError = null;
  try {
    json = JSON.parse(text);
  } catch (e) {
    parseError = e.message;
  }

  return {
    ok: res.status < 400 && parseError === null,
    status: res.status,
    json,
    parseError,
    bodyPreview: parseError ? text.slice(0, 500) : undefined
  };
}

export async function inspectNpmPackage({ name, _resolve } = {}) {
  if (typeof name !== "string" || !/^(@[\w.-]+\/)?[\w.-]+$/.test(name)) {
    throw new Error("`name` must be a valid npm package name.");
  }
  const url = `https://registry.npmjs.org/${name.replace("/", "%2F")}`;
  const res = await readJsonApi({ url, _resolve });
  if (!res.ok) return { ok: false, package: name, status: res.status, error: `Registry returned HTTP ${res.status}.` };

  const d = res.json;
  const latest = d["dist-tags"]?.latest;
  const version = latest ? d.versions?.[latest] : null;

  return {
    ok: true,
    package: d.name,
    description: d.description || null,
    latest,
    license: version?.license || d.license || null,
    homepage: d.homepage || null,
    repository: typeof d.repository === "string" ? d.repository : d.repository?.url || null,
    lastPublished: d.time?.[latest] || null,
    versionCount: Object.keys(d.versions || {}).length,
    dependencies: version?.dependencies ? Object.keys(version.dependencies) : [],
    deprecated: version?.deprecated || undefined,
    maintainerCount: (d.maintainers || []).length
  };
}

export async function inspectGithubRepo({ repo, tokenEnv, _resolve, env = process.env } = {}) {
  if (typeof repo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new Error('`repo` must look like "owner/name".');
  }
  const headers = {};
  if (tokenEnv && env[tokenEnv]) headers.Authorization = `Bearer ${env[tokenEnv]}`;

  const res = await readJsonApi({ url: `https://api.github.com/repos/${repo}`, headers, _resolve });
  if (!res.ok) return { ok: false, repo, status: res.status, error: `GitHub returned HTTP ${res.status}.` };

  const d = res.json;
  return {
    ok: true,
    repo: d.full_name,
    description: d.description || null,
    private: d.private,
    stars: d.stargazers_count,
    forks: d.forks_count,
    openIssues: d.open_issues_count,
    language: d.language || null,
    license: d.license?.spdx_id || null,
    defaultBranch: d.default_branch,
    pushedAt: d.pushed_at,
    archived: d.archived || undefined,
    topics: d.topics || []
  };
}

/* ------------------------------------------------------------------ *
 * JavaScript parse check
 * ------------------------------------------------------------------ */

/**
 * Run `node --check` against supplied source.
 *
 * `node --check` PARSES ONLY — it does not execute the module body, which
 * is verifiable: a file whose top level calls process.exit(99) still
 * exits 0 under --check. That is what makes this safe to offer when
 * arbitrary execution is not. The source is written to a private temp
 * file, checked, and deleted.
 */
export async function checkJavaScript({ code, module: asModule = true } = {}) {
  const src = requireText(code, "code", 1_000_000);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "darkly-check-"));
  const file = path.join(dir, asModule ? "snippet.mjs" : "snippet.cjs");

  try {
    await fs.writeFile(file, src, "utf8");
    await execFileAsync(process.execPath, ["--check", file], { timeout: 10_000 });
    return { ok: true, valid: true, syntax: "valid", moduleType: asModule ? "module" : "commonjs" };
  } catch (e) {
    const stderr = String(e.stderr || e.message || "");
    // Strip the temp path so the caller sees the error, not our plumbing.
    const cleaned = stderr.split("\n").map((l) => l.replace(file, "(snippet)")).join("\n").trim();
    const line = cleaned.match(/\(snippet\):(\d+)/);
    return {
      ok: true,
      valid: false,
      syntax: "invalid",
      moduleType: asModule ? "module" : "commonjs",
      line: line ? Number(line[1]) : undefined,
      error: cleaned.slice(0, 2000)
    };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
