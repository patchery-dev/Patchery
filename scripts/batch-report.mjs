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
    out.push("| blocked by our setup (not counted) | " + n("BLOCKED") + " |", "");
  }

  out.push("| " + (kind === "verify" ? "verdict" : "outcome") + " | repo | upgrade | what happened |");
  out.push("|---|---|---|---|");
  for (const r of sorted) {
    out.push(
      "| " + label(r, kind) +
        " | " + r.repo +
        " | `" + r.package + "@" + r.version + "`" +
        " | " + String(r.detail || "").replace(/\|/g, "\\|").replace(/\n+/g, " ") + " |"
    );
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
