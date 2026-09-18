/**
 * Tests for calc.js — run with: node calc.test.mjs
 *
 * The escape tests are the point of this file. This evaluator exists
 * inside a process holding live Alpaca keys and Gmail credentials, and it
 * receives strings that a language model composed from web pages. So the
 * tests deliberately feed it the standard JavaScript sandbox-escape
 * payloads — constructor chains, process.env, require, prototype access —
 * and assert not merely that they fail, but that they fail as *unknown
 * words*, which is what "there is no code path from text to execution"
 * actually looks like from the outside.
 */

import { evaluate, describe as describeSeries, MAX_EXPRESSION_LENGTH } from "./calc.js";

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

function approx(a, b, tol = 1e-9) {
  return Math.abs(a - b) <= tol;
}

function throws(label, expr, matcher) {
  try {
    const v = evaluate(expr);
    check(label, false, `returned ${v} instead of throwing`);
  } catch (e) {
    check(label, matcher ? matcher.test(e.message) : true, e.message);
  }
}

/* ------------------------------------------------------------------ */

console.log("\nArithmetic");

check("adds", evaluate("2 + 3") === 5);
check("respects precedence", evaluate("2 + 3 * 4") === 14);
check("respects parentheses", evaluate("(2 + 3) * 4") === 20);
check("subtracts and divides", approx(evaluate("10 - 4 / 2"), 8));
check("handles unary minus", evaluate("-5 + 2") === -3);
check("handles double negation", evaluate("--5") === 5);
check("handles modulo", evaluate("17 % 5") === 2);
check("exponent is right-associative", evaluate("2 ^ 3 ^ 2") === 512);
check("** works as an alias for ^", evaluate("2 ** 10") === 1024);
check("unary minus binds tighter than ^ on the exponent", approx(evaluate("2 ^ -1"), 0.5));
check("decimals work", approx(evaluate("0.1 + 0.2"), 0.30000000000000004));
check("scientific notation works", evaluate("1.5e3") === 1500);
check("negative exponents in notation work", approx(evaluate("2E-2"), 0.02));
check("underscores in numbers are allowed", evaluate("1_000 + 1") === 1001);
check("whitespace is irrelevant", evaluate("  7   *   6  ") === 42);

console.log("\nFunctions and constants");

check("sqrt", evaluate("sqrt(16)") === 4);
check("abs", evaluate("abs(-7)") === 7);
check("round", evaluate("round(2.6)") === 3);
check("floor and ceil", evaluate("floor(2.9) + ceil(0.1)") === 3);
check("ln", approx(evaluate("ln(e)"), 1));
check("log is base 10", approx(evaluate("log(1000)"), 3));
check("log2", approx(evaluate("log2(8)"), 3));
check("min/max take many arguments", evaluate("max(1, 9, 4)") === 9 && evaluate("min(1, 9, 4)") === 1);
check("sum", evaluate("sum(1,2,3,4)") === 10);
check("avg", approx(evaluate("avg(2,4,6)"), 4));
check("pow", evaluate("pow(3,4)") === 81);
check("hypot", evaluate("hypot(3,4)") === 5);
check("pi is available", approx(evaluate("pi"), Math.PI));
check("nested calls work", approx(evaluate("sqrt(pow(3,2) + pow(4,2))"), 5));
check("functions compose with arithmetic", approx(evaluate("2 * sqrt(9) + 1"), 7));

console.log("\nA realistic driver/trading calculation");

// The sort of thing this exists for: the model should not be doing this
// in its head and quietly getting it wrong.
check("computes earnings per hour correctly",
  approx(evaluate("(1143.93 - 259.00) / 22.75"), 38.898021978021975, 1e-9),
  String(evaluate("(1143.93 - 259.00) / 22.75")));
check("computes trips per hour", approx(evaluate("70 / 22.75"), 3.076923076923077, 1e-9));
check("computes a percentage change", approx(evaluate("(92.1 - 81.6) / 81.6 * 100"), 12.867647058823529, 1e-9));

console.log("\nRefuses anything that is not arithmetic");

// These are the payloads that matter. Each should fail as an UNKNOWN NAME,
// which demonstrates there is no text-to-execution path at all.
throws("rejects process.env", "process", /Unknown name/);
throws("rejects require", "require('fs')", /Unexpected character|Unknown/);
// "constructor" is the dangerous one: it is already lowercase, so it
// survived case-folding and resolved off Object.prototype until the
// lookup tables were given null prototypes.
throws("rejects constructor as a bare name", "constructor", /Unknown name/);
throws("rejects constructor as a call", "constructor(1)", /Unknown function/);
throws("rejects other inherited Object properties", "valueOf(1)", /Unknown function/);
throws("rejects toString", "toString(1)", /Unknown function/);
throws("rejects hasOwnProperty", "hasOwnProperty(1)", /Unknown function/);
throws("rejects the classic Function constructor chain",
  "this.constructor.constructor('return process.env')()", /Unexpected|Not a valid number|Unknown/);
throws("rejects __proto__", "__proto__", /Unexpected character|Unknown name/);
throws("rejects global", "global", /Unknown name/);
throws("rejects globalThis", "globalThis", /Unknown name/);
throws("rejects eval", "eval('1')", /Unexpected character|Unknown/);
throws("rejects import", "import('fs')", /Unexpected character|Unknown/);
throws("rejects property access syntax", "Math.random()", /Unexpected character|Not a valid number/);
throws("rejects assignment", "x = 5", /Unexpected character|Unknown name/);
throws("rejects semicolons and statements", "1; 2", /Unexpected character/);
throws("rejects string literals", "'hello'", /Unexpected character/);
throws("rejects template literals", "`x`", /Unexpected character/);
throws("rejects brackets", "[1,2]", /Unexpected character/);
throws("rejects braces", "{a:1}", /Unexpected character/);
throws("rejects arrow functions", "()=>1", /Unexpected|ended/);
throws("rejects comparison operators", "1 < 2", /Unexpected character/);
throws("rejects an unknown function", "frobnicate(2)", /Unknown function/);

// Even if a name somehow tokenized, it can only ever produce a number.
check("the evaluator can only return numbers", typeof evaluate("1+1") === "number");

console.log("\nMalformed input fails cleanly");

throws("unbalanced open paren", "(1 + 2", /Expected \)/);
throws("unbalanced close paren", "1 + 2)", /trailing input/);
throws("dangling operator", "5 +", /ended unexpectedly/);
throws("empty input", "", /Nothing to evaluate/);
throws("whitespace only", "    ", /Nothing to evaluate/);
throws("division by zero is explicit", "1/0", /Division by zero/);
throws("modulo by zero is explicit", "5 % 0", /Modulo by zero/);
throws("NaN results are rejected, not returned", "sqrt(-1)", /not a number/i);
throws("infinite results are rejected", "pow(10, 400)", /infinite/);
throws("wrong arity is caught", "sqrt(1,2)", /exactly one argument/);
throws("an overlong expression is refused", "1+".repeat(400) + "1", /too long/);

check("the length cap is a sane size", MAX_EXPRESSION_LENGTH >= 100 && MAX_EXPRESSION_LENGTH <= 10_000);

console.log("\nSeries statistics");

{
  const d = describeSeries([2, 4, 4, 4, 5, 5, 7, 9]);
  check("counts values", d.count === 8);
  check("sums", d.sum === 40);
  check("means", approx(d.mean, 5));
  check("medians an even-length list by interpolation", approx(d.median, 4.5));
  check("min and max", d.min === 2 && d.max === 9);
  check("range", d.range === 7);
  check("population stdev is the textbook value", approx(d.stdevPopulation, 2));
  check("sample stdev differs from population", d.stdevSample > d.stdevPopulation);
  check("quartiles are present", Number.isFinite(d.p25) && Number.isFinite(d.p75));
  check("it says which stdev is which rather than choosing silently",
    /sample of something larger/.test(d.note) && /entire population/.test(d.note));
}

{
  const d = describeSeries([5]);
  check("a single value still summarizes", d.count === 1 && d.mean === 5);
  check("sample stdev is null for one value, not zero", d.stdevSample === null);
  check("it explains why", /undefined/.test(d.note));
}

{
  const d = describeSeries([]);
  check("an empty list reports count 0 with an explanation", d.count === 0 && /No finite numbers/.test(d.note));
}

{
  const d = describeSeries([1, "two", null, 3, NaN, Infinity, "4"]);
  check("non-numeric entries are skipped, not coerced to zero", d.count === 3, String(d.count));
  check("numeric strings are accepted", d.sum === 8, String(d.sum));
  check("the number skipped is reported rather than hidden", d.skipped === 4, String(d.skipped));
  check("Infinity is excluded", d.max === 4);

  // The specific trap: Number(null) === 0, so a loose filter would keep
  // null as a real data point and silently drag the mean toward zero
  // while still reporting a plausible-looking count.
  const withNulls = describeSeries([1, null, 3]);
  check("null does NOT become a zero data point", withNulls.count === 2 && withNulls.mean === 2,
    `count ${withNulls.count}, mean ${withNulls.mean}`);
  const falsy = describeSeries([1, false, "", []]);
  check("false, empty string and empty array are all skipped, not zeroed",
    falsy.count === 1 && falsy.skipped === 3, `count ${falsy.count}, skipped ${falsy.skipped}`);
  check("booleans are never treated as numbers", describeSeries([true, true]).count === 0);
}

{
  const d = describeSeries([-5, -1, 0, 1, 5]);
  check("negatives are handled", d.mean === 0 && d.min === -5 && d.max === 5);
  check("median of an odd-length list is the middle value", d.median === 0);
}

check("a non-array input does not throw", describeSeries("not an array").count === 0);
check("undefined input does not throw", describeSeries(undefined).count === 0);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
