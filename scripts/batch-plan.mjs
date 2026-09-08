#!/usr/bin/env node
/**
 * Chooses which rows of a case list a batch run will actually run.
 *
 * Lifted out of two `run:` blocks that were doing the same thing slightly
 * differently. Both had the same job - filter, cap, and say what was dropped -
 * and neither could be tested where it lived.
 *
 * Usage:
 *   node scripts/batch-plan.mjs benchmark/cases.json --only express --limit 5 --cap 50
 */

/**
 * @param {object[]} rows
 * @param {{only?: string, limit?: number, cap?: number, repeats?: number}} opts
 * @returns {{picked: object[], dropped: number, cases: number, repeats: number}}
 */
export function planBatch(rows, { only = "", limit = 0, cap = 256, repeats = 1 } = {}) {
  const needle = String(only || "").trim().toLowerCase();
  const matched = (rows || []).filter(
    (r) => !needle || ((r.repo || "") + " " + (r.package || "")).toLowerCase().includes(needle)
  );

  // Why repeats exist at all, measured rather than argued: body-parser +
  // raw-body@4, on one model, came back BLOCKED in run #8, FIXED in #9 and
  // EXHAUSTED in #10. One run of a case is one observation of a stochastic
  // process, and a ratio built from single observations has error bars nobody
  // has ever drawn. Running each case n times is the cheapest way to draw them.
  const n = Number.isFinite(repeats) && repeats > 0 ? Math.floor(repeats) : 1;

  // The cap counts LEGS, because that is what GitHub refuses above 256 and what
  // the bill is charged for. So the number of distinct cases has to come down as
  // the repeat count goes up.
  //
  // And it comes down to whole sets: a case run twice while its neighbours ran
  // three times makes the consistency column mean two different things in the
  // same table. Better to measure fewer cases properly than more of them
  // unevenly - the same reason BLOCKED sits outside the denominator.
  const legCeiling = limit > 0 ? Math.min(limit, cap) : cap;
  const caseCeiling = Math.max(1, Math.floor(legCeiling / n));

  const cases = matched.slice(0, caseCeiling);
  const picked = [];
  for (const row of cases) {
    for (let i = 1; i <= n; i++) picked.push(n > 1 ? { ...row, repeat: String(i) } : { ...row });
  }
  return { picked, dropped: Math.max(0, matched.length - cases.length), cases: cases.length, repeats: n };
}

const isMain = process.argv[1] && process.argv[1].endsWith("batch-plan.mjs");
if (isMain) {
  const fs = await import("node:fs");
  const argv = process.argv.slice(2);
  const flag = (name, fallback) => {
    const i = argv.indexOf("--" + name);
    return i >= 0 ? argv[i + 1] : fallback;
  };
  const rows = JSON.parse(fs.readFileSync(argv[0], "utf8"));
  const { picked, dropped, cases, repeats } = planBatch(rows, {
    only: flag("only", ""),
    limit: Number(flag("limit", 0)) || 0,
    cap: Number(flag("cap", 256)) || 256,
    repeats: Number(flag("repeats", 1)) || 1,
  });
  // Never silent: a truncation nobody announced reads as "we ran everything".
  // With repeats the sentence has to name both numbers, because "12 cases not
  // run" beside a repeat count of 3 is a choice we made for them, not a shortage.
  if (dropped > 0) {
    console.log(
      "::warning::" + dropped + " case(s) not run - capped" +
        (repeats > 1 ? " (each case runs " + repeats + " times, so the cap buys fewer cases)" : "")
    );
  }
  console.log(
    repeats > 1
      ? cases + " case(s) x " + repeats + " run(s) = " + picked.length + " leg(s) queued"
      : picked.length + " case(s) queued"
  );
  const out = process.env.GITHUB_OUTPUT;
  if (out) {
    fs.appendFileSync(out, "matrix=" + JSON.stringify(picked) + "\n");
    fs.appendFileSync(out, "count=" + picked.length + "\n");
  }
}
