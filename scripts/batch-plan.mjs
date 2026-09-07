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
 * @param {{only?: string, limit?: number, cap?: number}} opts
 * @returns {{picked: object[], dropped: number}}
 */
export function planBatch(rows, { only = "", limit = 0, cap = 256 } = {}) {
  const needle = String(only || "").trim().toLowerCase();
  const matched = (rows || []).filter(
    (r) => !needle || ((r.repo || "") + " " + (r.package || "")).toLowerCase().includes(needle)
  );
  // A limit the caller asked for, but never above the hard cap: GitHub refuses a
  // matrix over 256 legs, and every benchmark leg is a paid model run.
  const ceiling = limit > 0 ? Math.min(limit, cap) : cap;
  return { picked: matched.slice(0, ceiling), dropped: Math.max(0, matched.length - ceiling) };
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
  const { picked, dropped } = planBatch(rows, {
    only: flag("only", ""),
    limit: Number(flag("limit", 0)) || 0,
    cap: Number(flag("cap", 256)) || 256,
  });
  // Never silent: a truncation nobody announced reads as "we ran everything".
  if (dropped > 0) console.log("::warning::" + dropped + " row(s) not run - capped");
  console.log(picked.length + " case(s) queued");
  const out = process.env.GITHUB_OUTPUT;
  if (out) {
    fs.appendFileSync(out, "matrix=" + JSON.stringify(picked) + "\n");
    fs.appendFileSync(out, "count=" + picked.length + "\n");
  }
}
