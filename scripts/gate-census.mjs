#!/usr/bin/env node
/**
 * Which gates have ever actually fired.
 *
 * The guard is a stack of rules, each written after a real failure, each pinned
 * by a regression test. A test says the rule works on the input the test hands
 * it. It cannot say the rule is reachable - that the shape of a real run ever
 * arrives at that branch - and two of this project's own bugs lived exactly
 * there:
 *
 *   NEEDS-DECISION      shipped, tested, and fired zero times in a 14-case run,
 *                       because the only classification that opens it never
 *                       occurred (35 §5).
 *   harness-config      .mocharc.json was on the protected list and judged by
 *                       nothing: settingValues could not read a quoted key, so
 *                       the rule returned null every time (37 #8).
 *
 * Both were invisible to the suite and both are obvious here: a gate that has
 * never fired across every run we have is either unnecessary or broken, and it
 * costs one query to ask.
 *
 * The gate list is DERIVED from the source, never typed here. A hand-kept
 * inventory drifts the moment somebody adds a rule and forgets the list - which
 * is the same silent, systematic failure the census exists to catch, one level
 * up.
 *
 * Usage:
 *   node scripts/gate-census.mjs results/            # a directory of result json
 */

/**
 * Every guard slug agent.mjs can emit, read out of its refuse() call sites.
 *
 * Throws rather than returning an empty list. A census over zero known gates
 * would print "0 gates never fired" and read as a clean bill of health, which is
 * the "0 results means the search is broken" failure this repository has paid
 * for once already.
 */
export function knownGuardReasons(agentSource = "") {
  const found = new Set();
  // refuse(<message, possibly spanning lines>, "slug")
  for (const call of String(agentSource).matchAll(/refuse\(([\s\S]{0,600}?)\)\s*;/g)) {
    const last = [...call[1].matchAll(/"([a-z][a-z0-9-]+)"/g)].pop();
    if (last) found.add(last[1]);
  }
  found.delete("unspecified");
  if (found.size === 0) throw new Error("no guard slugs found in agent.mjs - the census cannot run blind");
  return [...found].sort();
}

/**
 * Every outcome agent.mjs can actually write.
 *
 * `stop(outcome, ...)` and `fail(message, outcome)` both put their argument
 * straight into the output, and `refuse` writes a fixed one. needs-decision is
 * produced by a ternary rather than a literal call, so it is matched from the
 * expression instead.
 *
 * Throws on an empty result for the same reason knownGuardReasons does: a
 * contract checked against nothing passes.
 */
export function emittedOutcomes(agentSource = "") {
  const src = String(agentSource);
  const out = new Set(["failed"]); // fail()'s default, never written literally
  for (const m of src.matchAll(/\b(?:stop|fail)\(\s*(?:\n\s*)?"([a-z][a-z0-9-]*)"/g)) out.add(m[1]);
  for (const m of src.matchAll(/\bfail\([^)]*?,\s*"([a-z][a-z0-9-]*)"\s*\)/g)) out.add(m[1]);
  for (const m of src.matchAll(/outcome:\s*"([a-z][a-z0-9-]*)"/g)) out.add(m[1]);
  // Anchored to `stop(` on purpose. An unanchored ternary matched every
  // "true"/"false" pair in the file and reported them as outcomes - the same
  // over-broad pattern that let an npm warning decide a classification.
  for (const m of src.matchAll(/\bstop\(\s*[^;]{0,80}?\?\s*"([a-z][a-z0-9-]*)"\s*:\s*"([a-z][a-z0-9-]*)"/g)) {
    out.add(m[1]);
    out.add(m[2]);
  }
  if (out.size <= 1) throw new Error("no outcomes found in agent.mjs - the contract cannot be checked blind");
  return [...out].sort();
}

/** Every outcome action.yml tells a user to expect. */
export function documentedOutcomes(actionSource = "") {
  const block = /^ {2}outcome:\n([\s\S]*?)(?=^ {2}\S)/m.exec(String(actionSource).replace(/\r\n/g, "\n"));
  if (!block) return [];
  // Deduplicated, because the description names some values twice - the list
  // itself, and then "everything except 'failed' exits 0". The first census run
  // printed `failed` as two separate gates, which is the same class of double
  // count the report already refuses elsewhere.
  return [...new Set([...block[1].matchAll(/'([a-z][a-z0-9-]+)'/g)].map((m) => m[1]))].sort();
}

/**
 * What the runs actually produced.
 *
 * Counts rather than booleans: "fired once in 42 legs" and "fired in half of
 * them" are different findings and a boolean loses the second one.
 */
export function observed(rows = []) {
  const reasons = new Map();
  const outcomes = new Map();
  const bump = (map, key) => { if (key) map.set(key, (map.get(key) || 0) + 1); };
  for (const r of rows) {
    bump(reasons, String(r.guardReason || "").trim() || null);
    bump(outcomes, String(r.actionOutcome || "").trim() || null);
  }
  return { reasons, outcomes };
}

/**
 * The census. Every known gate, with how often it fired, and the ones that never did.
 *
 * `runs` is carried through because the answer means nothing without it: a gate
 * that never fired in 3 legs is not evidence of anything, and one that never
 * fired in 400 is a finding.
 */
export function gateCensus({ guardReasons = [], docOutcomes = [], rows = [] } = {}) {
  const seen = observed(rows);
  const gates = guardReasons.map((g) => ({ kind: "guard", gate: g, fired: seen.reasons.get(g) || 0 }));
  const outs = docOutcomes.map((o) => ({ kind: "outcome", gate: o, fired: seen.outcomes.get(o) || 0 }));

  // The other direction, and it is the one a documented list cannot see: an
  // outcome the product emits that action.yml never mentions. A user reading the
  // action's contract would not know it exists.
  const undocumented = [...seen.outcomes.keys()]
    .filter((o) => o && !docOutcomes.includes(o))
    .map((o) => ({ kind: "undocumented", gate: o, fired: seen.outcomes.get(o) }));

  return { runs: rows.length, gates: [...gates, ...outs], undocumented };
}

export function renderCensus({ runs = 0, gates = [], undocumented = [] } = {}) {
  const silent = gates.filter((g) => g.fired === 0);
  const out = [
    "## Gate census over " + runs + " run(s)",
    "",
    // Said before the table, because the table is only readable with it: silence
    // is a finding about the gate OR about the sample, and the reader has to be
    // told which they are looking at.
    runs < 20
      ? "**" + runs + " runs is a small sample.** A gate that did not fire here may simply not have been reached yet."
      : "A gate that never fired across " + runs + " runs is either unnecessary or broken.",
    "",
    "| gate | kind | fired |",
    "|---|---|---|",
  ];
  for (const g of [...gates].sort((a, b) => a.fired - b.fired || a.gate.localeCompare(b.gate))) {
    out.push("| " + (g.fired === 0 ? "**" + g.gate + "**" : g.gate) + " | " + g.kind + " | " + g.fired + " |");
  }
  out.push("", silent.length ? "**" + silent.length + " gate(s) never fired.**" : "Every gate fired at least once.");
  if (undocumented.length) {
    out.push(
      "",
      "**" + undocumented.length + " outcome(s) the product emits are not in action.yml's list:** " +
        undocumented.map((u) => "`" + u.gate + "` (" + u.fired + ")").join(", ") +
        " - a user reading the contract would not know they exist."
    );
  }
  return out.join("\n");
}

const isMain = process.argv[1] && process.argv[1].endsWith("gate-census.mjs");
if (isMain) {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const dir = process.argv[2] || "results";

  // `new URL(name, import.meta.url)` rather than a decoded pathname: this
  // repository lives under "API Projesi" and a manual decode turned the space
  // into %20 and the read into ENOENT.
  const guardReasons = knownGuardReasons(fs.readFileSync(new URL("agent.mjs", import.meta.url), "utf8"));
  const docOutcomes = documentedOutcomes(fs.readFileSync(new URL("../action.yml", import.meta.url), "utf8"));

  const rows = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.json$/.test(e.name) && !/census-/.test(e.name)) {
        try {
          const j = JSON.parse(fs.readFileSync(p, "utf8"));
          if (j && (j.outcome || j.actionOutcome)) rows.push(j);
        } catch {}
      }
    }
  };
  try { walk(dir); } catch { console.error("cannot read " + dir); process.exit(2); }

  const text = renderCensus(gateCensus({ guardReasons, docOutcomes, rows }));
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + "\n");
}
