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
    // Candidates that live somewhere other than the repository root - i.e. the
    // monorepo half of the ecosystem, which until now produced rows that all
    // said "." and a note asking a human to fix it. This is the number that says
    // whether that changed.
    //
    // null, not 0, for a pool generated before target-dir was resolved: nothing
    // in it recorded the reasoning, and "we did not measure this" must not
    // render as "we measured it and it was none". The node column and the guard
    // count each had to learn this separately; this is the third time.
    inWorkspace: r.some((x) => x._dir_why) ? count((x) => x["target-dir"] && x["target-dir"] !== ".") : null,
    // And of those, how many had both signals point the same way. One signal is
    // an answer; two agreeing is a different level of confidence, and collapsing
    // them into one count would hide which we have.
    bothSignals: r.some((x) => x._dir_why) ? count((x) => x._dir_agreed === true) : null,
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
    ["in a workspace, not the root", "inWorkspace"],
    ["...both signals agreed", "bothSignals"],
  ];
  const out = ["| | new | was | change |", "|---|---|---|---|"];
  for (const [label, key] of rows) {
    const a = now[key];
    const b = before ? before[key] : null;
    // A dimension neither pool recorded has no difference to report, and
    // subtracting null would print it as one.
    const d = a === null || b === null ? "-" : a - b > 0 ? "+" + (a - b) : String(a - b);
    out.push(
      "| " + label + " | " + (a === null ? "not recorded" : a) +
        " | " + (b === null ? "-" : b) + " | " + d + " |"
    );
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
