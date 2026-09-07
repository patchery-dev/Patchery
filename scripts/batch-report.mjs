#!/usr/bin/env node
/**
 * Turns a directory of per-case results into the one table anyone reads.
 *
 * Lifted out of two `run:` blocks, for the reason this project keeps
 * rediscovering: the table is the artefact the whole benchmark exists to
 * produce, and it was the least testable code in the repository.
 *
 * Two shapes, one function. `verify` reports whether each break is real;
 * `benchmark` reports what the agent did about it.
 *
 * Usage:
 *   node scripts/batch-report.mjs verify   results result.json    --queued 33
 *   node scripts/batch-report.mjs benchmark results benchmark.json --queued 11
 */

const VERIFY_ORDER = ["VALID", "UNKNOWN", "NOT-A-CASE"];
const BENCHMARK_ORDER = ["FIXED", "REFUSED", "EXHAUSTED", "NO-CHANGE", "WRONG", "BLOCKED"];

/**
 * A row whose verdict field is missing or empty.
 *
 * This is not a hypothetical tidy-up. A result file written in one shape and
 * read in another renders as the literal string "undefined" and still lands in
 * the denominator - so a case nobody ever judged silently becomes a case the
 * product failed. Naming it keeps the number honest and points at the bug.
 */
export const UNREPORTED = "UNREPORTED";

/** The verdict a row carries, or UNREPORTED if it carries none we can read. */
export function label(row, kind) {
  const raw = kind === "verify" ? row.verdict : row.outcome;
  return typeof raw === "string" && raw.trim() ? raw.trim() : UNREPORTED;
}

/**
 * How many bad fixes the guard caught, from the only field that says so.
 *
 * REFUSED is the wrong source for this number and it is the tempting one. It
 * covers two different events: the guard reverting a change (the agent
 * abandoned the package it was sent to migrate, the suite went green anyway),
 * and the independent reviewer refuting a change that was otherwise fine.
 * Counting REFUSED as "the guard caught it" would credit the guard with the
 * reviewer's work, which is the sort of number that survives right up until
 * someone asks how it was measured.
 *
 * `blocked-by-guard` is the outcome agent.mjs writes for the guard's own
 * reverts, and nothing else writes it - so it is the number.
 *
 * Rows written before the field existed carry nothing, and the caller must not
 * read that as zero: see guardVisible below.
 */
export function guardCaught(rows) {
  return rows.filter((r) => /^blocked-by-guard$/i.test(String(r.actionOutcome || "").trim())).length;
}

/**
 * Did these rows record what the action said, at all?
 *
 * A batch collected before `actionOutcome` was written would render "caught by
 * the guard: 0" - which is not a measurement of a guard that caught nothing, it
 * is the absence of a measurement, and this project has already learned once
 * what a 0 standing in for null does to a table. Same rule as the node column:
 * shown when something recorded it, absent when nothing did.
 */
export function guardVisible(rows) {
  return rows.some((r) => String(r.actionOutcome || "").trim());
}


/** Rows first, in the order a reader should meet them. */
export function sortRows(rows, kind) {
  const order = kind === "verify" ? VERIFY_ORDER : BENCHMARK_ORDER;
  const rank = (r) => {
    const i = order.indexOf(label(r, kind));
    return i < 0 ? order.length : i;
  };
  return [...rows].sort((a, b) => rank(a) - rank(b) || String(a.repo).localeCompare(String(b.repo)));
}

export function renderReport(rows, { kind = "benchmark", queued = 0 } = {}) {
  const sorted = sortRows(rows, kind);
  const n = (v) => sorted.filter((r) => label(r, kind) === v).length;
  const out = [];

  if (kind === "verify") {
    out.push("## " + n("VALID") + " valid case(s) of " + (sorted.length - n(UNREPORTED)) + " tried", "");
    out.push(n("NOT-A-CASE") + " were not cases, " + n("UNKNOWN") + " could not be measured.", "");
  } else {
    // BLOCKED is ours, not the product's, so it is named and kept out of the
    // denominator: a case our setup could not run is not a loss for the agent,
    // and counting it as one understates the tool for our own reasons.
    // UNREPORTED is out for the opposite reason - we do not know what it was,
    // and a case nobody judged must not be counted as one the agent failed.
    const judged = sorted.length - n("BLOCKED") - n(UNREPORTED);
    const models = [...new Set(sorted.map((r) => r.model).filter(Boolean))];
    out.push("## " + n("FIXED") + " fixed of " + judged + " cases it was able to attempt", "");
    out.push(models.length ? "Fixer: " + models.join(", ") : "Fixer: the repository default", "");
    out.push("| | |", "|---|---|");
    out.push("| fixed | " + n("FIXED") + " |");
    out.push("| refused to ship an unproven fix | " + n("REFUSED") + " |");
    out.push("| ran out of turns mid-investigation | " + n("EXHAUSTED") + " |");
    out.push("| produced nothing | " + n("NO-CHANGE") + " |");
    // Bold, because shipping something broken is the only outcome that costs a
    // user anything, and a benchmark that does not make it prominent is an advert.
    out.push("| **shipped something wrong** | **" + n("WRONG") + "** |");
    out.push("| blocked by our setup (not counted) | " + n("BLOCKED") + " |");
    // The two lines the guard exists for, and until now the table did not say
    // either of them. They are not a third total - every fix counted here is
    // already counted above - they are the same runs read from the guard's
    // side: of the bad fixes this batch produced, how many died in the guard
    // and how many a user would have had to review.
    //
    // "reached a PR" is WRONG by construction: a change that shipped with the
    // suite still red or smaller is a bad fix that got past everything.
    if (guardVisible(sorted)) {
      out.push("| bad fixes caught by the guard | " + guardCaught(sorted) + " |");
      out.push("| **bad fixes that reached a PR** | **" + n("WRONG") + "** |");
    }
    out.push("");
  }

  // The Node column is not decoration. The same case gave VALID on Node 12 and
  // NOT-A-CASE on Node 16, so a verdict without its runtime is not a verdict.
  //
  // Shown only when something recorded it: a column of "?" beside every row is
  // not honesty, it is noise, and results written before this field existed
  // genuinely do not know.
  const withNode = sorted.some((r) => r.node);
  const head = ["", kind === "verify" ? "verdict" : "outcome", "repo", "upgrade"];
  if (withNode) head.push("node");
  head.push("what happened", "");
  out.push(head.join(" | ").trim());
  out.push("|" + "---|".repeat(head.length - 2));
  for (const r of sorted) {
    const cells = [label(r, kind), r.repo, "`" + r.package + "@" + r.version + "`"];
    if (withNode) cells.push(r.node ? String(r.node) : "?");
    cells.push(String(r.detail || "").replace(/\|/g, "\\|").replace(/\n+/g, " "));
    out.push("| " + cells.join(" | ") + " |");
  }

  // A row we could not read is a bug in this pipeline, not a result. Say so on
  // the face of the table rather than leaving a blank cell to be interpreted.
  if (n(UNREPORTED) > 0) {
    out.push(
      "",
      "**" + n(UNREPORTED) + " row(s) carried no " + (kind === "verify" ? "verdict" : "outcome") +
        "** - not counted either way; a result file was written in a shape this report does not read."
    );
  }

  // A leg that died before writing anything is invisible above, so the totals
  // would otherwise imply full coverage.
  if (queued > sorted.length) {
    out.push("", "**" + (queued - sorted.length) + " case(s) reported nothing** - those runs died before reaching a verdict.");
  }
  return out.join("\n");
}

const isMain = process.argv[1] && process.argv[1].endsWith("batch-report.mjs");
if (isMain) {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const [kind, dir, filename] = process.argv.slice(2);
  const qi = process.argv.indexOf("--queued");
  const queued = qi >= 0 ? Number(process.argv[qi + 1]) || 0 : 0;

  const rows = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === filename) {
        try {
          rows.push(JSON.parse(fs.readFileSync(p, "utf8")));
        } catch {
          // A result we cannot read is one the totals must not silently include.
        }
      }
    }
  };
  try {
    walk(dir);
  } catch {
    // No results at all is itself reportable, below.
  }

  const text = renderReport(rows, { kind, queued });
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + "\n");
}
