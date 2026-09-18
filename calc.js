/**
 * calc.js — arithmetic and small data reductions the model can trust.
 *
 * WHY THIS IS NOT A CODE SANDBOX
 *
 * The capability originally asked for was "a code execution sandbox (to
 * run or test anything)". This is deliberately not that, and the reason
 * is worth stating plainly rather than quietly substituting something
 * smaller.
 *
 * Arbitrary code execution would run here: inside the same Node process
 * as live Alpaca trading credentials, Gmail app passwords, Supabase
 * service keys, the Google service-account JSON, and Railway private
 * networking to a sibling LLM service. In that process, `process.env` is
 * the whole keyring. Any escape — and escaping a same-process JS sandbox
 * is a well-trodden path, not a hypothetical — hands over the ability to
 * place real trades and send mail as the user. Node has no in-process
 * isolation that survives a determined escape; `vm` is explicitly
 * documented as not a security boundary.
 *
 * Worse, the code would be authored by a language model acting on text
 * fetched from the open web. That is an untrusted-input-to-code path: a
 * web page saying "ignore previous instructions and run this" becomes
 * executable. A real sandbox for this needs process or container
 * isolation with no credentials in its environment, which is an
 * infrastructure change (a separate Railway service, a worker with a
 * scrubbed env), not a file.
 *
 * So this covers the part that is both safe and actually needed day to
 * day — evaluating expressions and reducing arrays of numbers without the
 * model doing mental arithmetic and getting it subtly wrong — and refuses
 * the rest honestly. `evaluate()` is a hand-written parser, not `eval`,
 * `Function`, or `vm`: it can only produce numbers, because numbers are
 * the only thing it knows how to build.
 */

/* ------------------------------------------------------------------ *
 * Tokenizer
 * ------------------------------------------------------------------ */

const FUNCTIONS = Object.assign(Object.create(null), {
  abs: Math.abs,
  ceil: Math.ceil,
  floor: Math.floor,
  round: (x) => Math.round(x),
  sqrt: Math.sqrt,
  cbrt: Math.cbrt,
  exp: Math.exp,
  ln: Math.log,
  log: Math.log10,
  log2: Math.log2,
  log10: Math.log10,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  sinh: Math.sinh,
  cosh: Math.cosh,
  tanh: Math.tanh,
  sign: Math.sign,
  trunc: Math.trunc
});

const VARIADIC = Object.assign(Object.create(null), {
  min: (...a) => Math.min(...a),
  max: (...a) => Math.max(...a),
  sum: (...a) => a.reduce((x, y) => x + y, 0),
  avg: (...a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN),
  mean: (...a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN),
  pow: (a, b) => Math.pow(a, b),
  atan2: (a, b) => Math.atan2(a, b),
  hypot: (...a) => Math.hypot(...a)
});

// Null-prototype so that a name like "constructor" or "toString" cannot
// resolve to an inherited Object property. Without this, FUNCTIONS
// ["constructor"] returns the Object constructor, and `constructor(1)`
// evaluates to a boxed Number that only the final typeof check rejects —
// a bypass that works by luck rather than by design. Caught by
// calc.test.mjs.
const CONSTANTS = Object.assign(Object.create(null), { pi: Math.PI, e: Math.E, tau: Math.PI * 2 });

export const MAX_EXPRESSION_LENGTH = 500;

function tokenize(input) {
  const tokens = [];
  let i = 0;
  const s = String(input);

  while (i < s.length) {
    const c = s[i];

    if (/\s/.test(c)) {
      i++;
      continue;
    }

    if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < s.length && /[0-9._]/.test(s[j])) j++;
      // Scientific notation: 1.5e3, 2E-4
      if (j < s.length && /[eE]/.test(s[j]) && /[0-9+-]/.test(s[j + 1] || "")) {
        j++;
        if (/[+-]/.test(s[j])) j++;
        while (j < s.length && /[0-9]/.test(s[j])) j++;
      }
      const raw = s.slice(i, j).replace(/_/g, "");
      const value = Number(raw);
      if (!Number.isFinite(value)) throw new Error(`Not a valid number: "${raw}"`);
      tokens.push({ type: "number", value });
      i = j;
      continue;
    }

    if (/[a-zA-Z]/.test(c)) {
      let j = i;
      while (j < s.length && /[a-zA-Z0-9]/.test(s[j])) j++;
      tokens.push({ type: "name", value: s.slice(i, j).toLowerCase() });
      i = j;
      continue;
    }

    if ("+-*/%^(),".includes(c)) {
      // ** as an alias for ^
      if (c === "*" && s[i + 1] === "*") {
        tokens.push({ type: "op", value: "^" });
        i += 2;
        continue;
      }
      tokens.push({ type: c === "(" || c === ")" || c === "," ? c : "op", value: c });
      i++;
      continue;
    }

    throw new Error(`Unexpected character "${c}" at position ${i}.`);
  }

  return tokens;
}

/* ------------------------------------------------------------------ *
 * Recursive-descent parser/evaluator
 * ------------------------------------------------------------------ */

function parse(tokens) {
  let pos = 0;

  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const expect = (type, value) => {
    const t = tokens[pos];
    if (!t || t.type !== type || (value !== undefined && t.value !== value)) {
      throw new Error(`Expected ${value || type}${t ? ` but found "${t.value}"` : " but the expression ended"}.`);
    }
    return tokens[pos++];
  };

  function parseExpression() {
    let left = parseTerm();
    while (peek() && peek().type === "op" && (peek().value === "+" || peek().value === "-")) {
      const op = next().value;
      const right = parseTerm();
      left = op === "+" ? left + right : left - right;
    }
    return left;
  }

  function parseTerm() {
    let left = parseUnary();
    while (peek() && peek().type === "op" && ["*", "/", "%"].includes(peek().value)) {
      const op = next().value;
      const right = parseUnary();
      if (op === "*") left = left * right;
      else if (op === "/") {
        if (right === 0) throw new Error("Division by zero.");
        left = left / right;
      } else {
        if (right === 0) throw new Error("Modulo by zero.");
        left = left % right;
      }
    }
    return left;
  }

  function parseUnary() {
    if (peek() && peek().type === "op" && (peek().value === "-" || peek().value === "+")) {
      const op = next().value;
      const v = parseUnary();
      return op === "-" ? -v : v;
    }
    return parsePower();
  }

  function parsePower() {
    const base = parsePrimary();
    if (peek() && peek().type === "op" && peek().value === "^") {
      next();
      const exp = parseUnary(); // right-associative
      return Math.pow(base, exp);
    }
    return base;
  }

  function parsePrimary() {
    const t = peek();
    if (!t) throw new Error("The expression ended unexpectedly.");

    if (t.type === "number") {
      next();
      return t.value;
    }

    if (t.type === "(") {
      next();
      const v = parseExpression();
      expect(")");
      return v;
    }

    if (t.type === "name") {
      next();
      const name = t.value;

      if (peek() && peek().type === "(") {
        next();
        const args = [];
        if (peek() && peek().type !== ")") {
          args.push(parseExpression());
          while (peek() && peek().type === ",") {
            next();
            args.push(parseExpression());
          }
        }
        expect(")");

        if (FUNCTIONS[name]) {
          if (args.length !== 1) throw new Error(`${name}() takes exactly one argument, got ${args.length}.`);
          return FUNCTIONS[name](args[0]);
        }
        if (VARIADIC[name]) {
          if (args.length === 0) throw new Error(`${name}() needs at least one argument.`);
          return VARIADIC[name](...args);
        }
        throw new Error(`Unknown function "${name}".`);
      }

      if (CONSTANTS[name] !== undefined) return CONSTANTS[name];
      throw new Error(`Unknown name "${name}". This evaluator only knows numbers, operators, ${Object.keys(CONSTANTS).join("/")}, and a fixed set of math functions.`);
    }

    throw new Error(`Unexpected "${t.value}".`);
  }

  const result = parseExpression();
  if (pos < tokens.length) throw new Error(`Unexpected trailing input starting at "${tokens[pos].value}".`);
  return result;
}

/**
 * Evaluate a mathematical expression.
 *
 * This is a parser over a closed grammar — there is no code path from
 * input text to executed JavaScript. Names that are not a known constant
 * or function are a syntax error, so `process`, `require`, `constructor`
 * and friends are simply unknown words, not a bypass to defend against.
 */
export function evaluate(expression) {
  const text = String(expression ?? "").trim();
  if (!text) throw new Error("Nothing to evaluate.");
  if (text.length > MAX_EXPRESSION_LENGTH) {
    throw new Error(`Expression is too long (${text.length} chars; cap is ${MAX_EXPRESSION_LENGTH}).`);
  }

  const value = parse(tokenize(text));

  if (typeof value !== "number") throw new Error("Expression did not produce a number.");
  if (Number.isNaN(value)) throw new Error("Result is not a number (check for things like sqrt of a negative).");
  if (!Number.isFinite(value)) throw new Error("Result is infinite.");
  return value;
}

/* ------------------------------------------------------------------ *
 * Series statistics
 * ------------------------------------------------------------------ */

function sortedCopy(values) {
  return [...values].sort((a, b) => a - b);
}

function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * Summarize a list of numbers.
 *
 * Reports both sample and population standard deviation rather than
 * picking one silently, because which is correct depends on whether the
 * list is a sample or the entire population — a distinction this codebase
 * already cares about elsewhere (backtest.js uses population variance
 * precisely because its equity series IS the whole population).
 */
export function describe(values) {
  // Deliberately strict rather than using Number() on everything: null,
  // false, "" and [] all coerce to 0, which would silently drag a mean
  // toward zero and report a count that looks right. For a tool whose
  // entire job is not getting arithmetic subtly wrong, quietly inventing
  // zeroes is the worst available failure. Only real numbers and
  // non-empty numeric strings are accepted; everything else is skipped
  // and the skip count is reported.
  const source = Array.isArray(values) ? values : [];
  const nums = [];
  for (const v of source) {
    if (typeof v === "number") {
      if (Number.isFinite(v)) nums.push(v);
      continue;
    }
    if (typeof v === "string" && v.trim() !== "") {
      const n = Number(v);
      if (Number.isFinite(n)) nums.push(n);
    }
  }
  const skipped = source.length - nums.length;

  if (nums.length === 0) {
    return { count: 0, skipped, note: "No finite numbers were supplied." };
  }

  const sorted = sortedCopy(nums);
  const sum = nums.reduce((a, b) => a + b, 0);
  const mean = sum / nums.length;
  const popVar = nums.reduce((s, v) => s + (v - mean) ** 2, 0) / nums.length;
  const sampleVar = nums.length > 1 ? nums.reduce((s, v) => s + (v - mean) ** 2, 0) / (nums.length - 1) : null;

  return {
    count: nums.length,
    skipped: skipped > 0 ? skipped : undefined,
    sum,
    mean,
    median: quantile(sorted, 0.5),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    range: sorted[sorted.length - 1] - sorted[0],
    p25: quantile(sorted, 0.25),
    p75: quantile(sorted, 0.75),
    stdevPopulation: Math.sqrt(popVar),
    stdevSample: sampleVar === null ? null : Math.sqrt(sampleVar),
    note:
      sampleVar === null
        ? "Only one value, so sample standard deviation is undefined."
        : "stdevSample treats these as a sample of something larger; stdevPopulation treats them as the entire population. Pick deliberately."
  };
}
