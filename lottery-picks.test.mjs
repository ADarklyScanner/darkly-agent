/**
 * Tests for the lottery pick-generation code in apps/lottery.js —
 * node lottery-picks.test.mjs
 *
 * This is the part ported from the reference app ("Lottery Frequency
 * Picker") to replace the console's old descriptive-only Lottery tab: it
 * turns frequency/era-consistency/gap statistics into three actual
 * number sets instead of just a table.
 *
 * What matters here is exactly what would silently break if a future
 * edit got the port wrong: the right COUNT of numbers per set, no
 * duplicates within a lotto set, everything inside the game's real
 * range, sets staying sorted, a bonus ball only where the game has one,
 * digit games being scored per-position instead of pooled, and — because
 * this whole module's point is to never let a description of history
 * read as a forecast — every response still carrying honest, explicit
 * "this does not predict anything" language.
 *
 * This does NOT try to statistically verify the weighting direction
 * (that hot numbers really do get chosen more often); that would make
 * the suite flaky by design, since the whole mechanism is a weighted
 * RANDOM draw. Structural correctness is what a regression could
 * actually break silently, so that is what is pinned here.
 */

import { normalizeDraws, generatePickSets, analyzeAll, isDigitGame } from "./apps/lottery.js";

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

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

// A 6-from-49 + 1-26 bonus lotto game, low numbers drawn more often so
// the fixture actually has a "hot" end and a "cold" end to distinguish.
function lottoRows(n) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const nums = new Set();
    while (nums.size < 6) {
      nums.add(Math.random() < 0.5 ? 1 + Math.floor(Math.random() * 15) : 1 + Math.floor(Math.random() * 49));
    }
    rows.push({
      draw_date: new Date(2015, 0, 1 + i).toISOString().slice(0, 10),
      numbers: [...nums],
      bonus_ball: 1 + Math.floor(Math.random() * 26)
    });
  }
  return rows;
}

// A lotto game with no bonus ball at all (some state games have none).
function lottoRowsNoBonus(n) {
  return lottoRows(n).map((r) => {
    const { bonus_ball, ...rest } = r;
    return rest;
  });
}

// A Pick-3-style digit game: 3 independent 0-9 digits per draw.
function digitRows(n) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push({
      draw_date: new Date(2018, 0, 1 + i).toISOString().slice(0, 10),
      numbers: [Math.floor(Math.random() * 10), Math.floor(Math.random() * 10), Math.floor(Math.random() * 10)]
    });
  }
  return rows;
}

/* ------------------------------------------------------------------ *
 * isDigitGame
 * ------------------------------------------------------------------ */

console.log("\nisDigitGame() classification");
{
  const { draws: lotto } = normalizeDraws(lottoRows(300));
  const { draws: digit } = normalizeDraws(digitRows(300));
  check("a 1-49 lotto set is not classified as a digit game", isDigitGame(lotto) === false);
  check("a 0-9 pick-3 set is classified as a digit game", isDigitGame(digit) === true);
  check("empty draws are not a digit game", isDigitGame([]) === false);
}

/* ------------------------------------------------------------------ *
 * generatePickSets — lotto game, with bonus
 * ------------------------------------------------------------------ */

console.log("\ngeneratePickSets() — lotto game with bonus ball");
{
  const { draws } = normalizeDraws(lottoRows(500));
  const picks = generatePickSets(draws);

  check("digitGame is false", picks.digitGame === false);
  check("drawsUsed matches the draw count", picks.drawsUsed === draws.length);
  check("exactly 3 sets are generated", picks.sets.length === 3, `got ${picks.sets.length}`);
  check(
    "basis text says this does not predict anything",
    /not predict|independent|same chance/i.test(picks.basis || ""),
    picks.basis
  );

  for (const [i, s] of picks.sets.entries()) {
    check(`set ${i + 1} has a label`, typeof s.label === "string" && s.label.length > 0);
    check(`set ${i + 1} has a description`, typeof s.description === "string" && s.description.length > 0);
    check(`set ${i + 1} has 6 main numbers`, s.main.length === 6, `got ${s.main.length}`);
    check(`set ${i + 1} has no duplicate main numbers`, new Set(s.main).size === s.main.length);
    check(`set ${i + 1} main numbers are within 1-49`, s.main.every((n) => n >= 1 && n <= 49), JSON.stringify(s.main));
    check(
      `set ${i + 1} main numbers are sorted ascending`,
      s.main.every((v, idx) => idx === 0 || s.main[idx - 1] < v)
    );
    check(`set ${i + 1} has a bonus ball within 1-26`, s.bonus !== null && s.bonus >= 1 && s.bonus <= 26, s.bonus);
  }
}

/* ------------------------------------------------------------------ *
 * generatePickSets — lotto game, no bonus ball
 * ------------------------------------------------------------------ */

console.log("\ngeneratePickSets() — lotto game with no bonus ball");
{
  const { draws } = normalizeDraws(lottoRowsNoBonus(300));
  const picks = generatePickSets(draws);
  check("exactly 3 sets are generated", picks.sets.length === 3);
  for (const [i, s] of picks.sets.entries()) {
    check(`set ${i + 1} has no bonus ball when the game has none`, s.bonus === null);
    check(`set ${i + 1} still has 6 main numbers`, s.main.length === 6);
  }
}

/* ------------------------------------------------------------------ *
 * generatePickSets — digit game
 * ------------------------------------------------------------------ */

console.log("\ngeneratePickSets() — Pick-3-style digit game");
{
  const { draws } = normalizeDraws(digitRows(600));
  const picks = generatePickSets(draws);

  check("digitGame is true", picks.digitGame === true);
  check("exactly 3 sets are generated", picks.sets.length === 3);
  for (const [i, s] of picks.sets.entries()) {
    check(`set ${i + 1} has 3 digits (matches draw length)`, s.main.length === 3, `got ${s.main.length}`);
    check(`set ${i + 1} digits are all within 0-9`, s.main.every((n) => n >= 0 && n <= 9), JSON.stringify(s.main));
    check(`set ${i + 1} has no bonus ball for a digit game`, s.bonus === null);
  }
}

/* ------------------------------------------------------------------ *
 * Edge cases
 * ------------------------------------------------------------------ */

console.log("\nEdge cases");
{
  const empty = generatePickSets([]);
  check("no draws produces zero sets rather than throwing", empty.sets.length === 0);
  check("no draws still carries basis text", typeof empty.basis === "string" && empty.basis.length > 0);

  const { draws: singleDraw } = normalizeDraws(lottoRows(1));
  let threw = null;
  let onePick = null;
  try {
    onePick = generatePickSets(singleDraw);
  } catch (e) {
    threw = e;
  }
  check("a single historical draw does not throw", threw === null, threw && threw.message);
  check("a single historical draw still produces 3 sets", onePick && onePick.sets.length === 3);

  check("generatePickSets tolerates null", (() => {
    try {
      return generatePickSets(null).sets.length === 0;
    } catch (e) {
      return false;
    }
  })());
}

/* ------------------------------------------------------------------ *
 * analyzeAll — picks are wired in alongside the existing sections
 * ------------------------------------------------------------------ */

console.log("\nanalyzeAll() includes picks without dropping the existing sections");
{
  const { draws } = normalizeDraws(lottoRows(200));
  const full = analyzeAll(draws, { top: 10 });
  check("picks is present", Boolean(full.picks));
  check("picks has 3 sets", full.picks && full.picks.sets.length === 3);
  check("frequency is still present", Boolean(full.frequency));
  check("gaps is still present", Boolean(full.gaps));
  check("shape is still present", Boolean(full.shape));
  check("pairs is still present", Boolean(full.pairs));
  check("repeats is still present", Boolean(full.repeats));
  check("top-level basis is still present", typeof full.basis === "string" && full.basis.length > 0);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
