#!/usr/bin/env node
/**
 * Describes a candidate pool in the terms that decide what it can measure, and
 * says what changed against the pool it replaces.
 *
 * A count is not enough. The first pool was 86 candidates and looked healthy;
 * what it actually was, nobody checked until the confirmed cases came back and
 * thirteen of fourteen were libraries - a population that structurally cannot
 * take the fix most of those breaks need. The number said nothing about that.
 *
 * So the summary is by kind, by break class, and by language, and it prints the
 * old numbers beside the new ones.
 *
 * Usage:
 *   node scripts/pool-summary.mjs new.json [old.json]
 */

import fs from "node:fs";

const read = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
};

/** The shape of a pool, in the dimensions that change what it can find. */
export function poolShape(rows) {
  const r = rows || [];
  const count = (fn) => r.filter(fn).length;
  return {
    total: r.length,
    repos: new Set(r.map((x) => x.repo)).size,
    application: count((x) => x._kind === "application"),
    library: count((x) => x._kind === "library"),
    unknownKind: count((x) => !x._kind),
    api: count((x) => x._apiOnly),
    packaging: count((x) => x._apiOnly === false),
    typescript: count((x) => x._ts),
  };
}

/** One line per dimension: new, old, and the difference. */
export function renderShape(now, before) {
  const rows = [
    ["candidates", "total"],
    ["repositories", "repos"],
    ["applications", "application"],
    ["libraries", "library"],
    ["kind unknown (from an older run)", "unknownKind"],
    ["API breaks", "api"],
    ["packaging breaks", "packaging"],
    ["TypeScript projects", "typescript"],
  ];
  const out = ["| | new | was | change |", "|---|---|---|---|"];
  for (const [label, key] of rows) {
    const a = now[key];
    const b = before ? before[key] : null;
    const d = b === null ? "-" : a - b > 0 ? "+" + (a - b) : String(a - b);
    out.push("| " + label + " | " + a + " | " + (b === null ? "-" : b) + " | " + d + " |");
  }
  return out.join("\n");
}

const isMain = process.argv[1] && process.argv[1].endsWith("pool-summary.mjs");
if (isMain) {
  const [newPath, oldPath] = process.argv.slice(2);
  const now = poolShape(read(newPath));
  const before = oldPath ? poolShape(read(oldPath) || []) : null;
  const text = renderShape(now, before);
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, "## Candidate pool\n\n" + text + "\n");
  }
  // Not an error, but the thing worth noticing: a pool with no applications in
  // it can only ever measure the population that cannot take the harness fix.
  if (now.application === 0) console.log("\n::warning::no applications in the pool");
}
