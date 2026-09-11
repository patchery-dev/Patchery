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
const BENCHMARK_ORDER = [
  "FIXED",
  "REFUSED",
  "NEEDS-DECISION",
  "EXHAUSTED",
  "NO-CHANGE",
  "WRONG",
  // In the denominator, and each under its own name. CRASHED is the product
  // failing to run - run #11's eight "blocked" legs were all this, six of them
  // our own Node packaging bug. UNANSWERED is the model never replying. Both
  // are failed runs for whoever installed the action; neither is our container
  // failing to start, which is what BLOCKED now means and nothing else.
  "CRASHED",
  "UNANSWERED",
  "BLOCKED",
];

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

/**
 * Fixes the independent reviewer did not agree with.
 *
 * The reviewer runs after the tests are green and it can only lower the claim,
 * never raise it - so a fix it objected to is still FIXED: the suite really did
 * go from red to green, and the same tests really are the ones passing. That is
 * why splitting FIXED in two would be a lie in the other direction.
 *
 * But it happened on the one real result this project has (express with
 * content-type@3, 1255 of 1255 passing, reviewer objected), and a headline that
 * says only "1 fixed" invites a reader to find that out from somebody else.
 *
 * Both of the reviewer's ways of disagreeing count. `refuted` is "this change is
 * wrong"; `concerns` is "something here needs a human" - and a headline that
 * counted only the first would still be quietly rounding in our favour.
 */
export function objectedFixes(rows) {
  return rows.filter(
    (r) => label(r, "benchmark") === "FIXED" && /^(refuted|concerns)$/i.test(String(r.review || "").trim())
  ).length;
}



/**
 * The same case, run more than once, collapsed into what it actually did.
 *
 * This exists because of one measurement. body-parser + raw-body@4, on a single
 * model, came back BLOCKED in run #8, FIXED in #9 and EXHAUSTED in #10. Read one
 * run at a time that is a fix; read three, it is a coin. Every ratio this project
 * has argued about was built from single observations, and none of them carried
 * an error bar because there was no way to draw one.
 *
 * Grouped by repo+package rather than by a repeat counter, so a batch that was
 * dispatched twice by hand groups the same way a `repeats: 3` run does.
 */
export function repeatGroups(rows, kind = "benchmark") {
  const byCase = new Map();
  for (const r of rows || []) {
    const key = String(r.repo) + "|" + String(r.package) + "@" + String(r.version);
    if (!byCase.has(key)) {
      byCase.set(key, { repo: r.repo, package: r.package, version: r.version, outcomes: [], breakClass: "" });
    }
    byCase.get(key).outcomes.push(label(r, kind));
    // Kept on the group so the report can split by mechanism. Taken from the
    // first leg that carries one: the three legs of a case are the same case,
    // and a leg written before the field existed would otherwise blank it.
    if (!byCase.get(key).breakClass && r.breakClass) byCase.get(key).breakClass = String(r.breakClass);
  }
  return [...byCase.values()].map((g) => {
    const distinct = [...new Set(g.outcomes)];
    return { ...g, runs: g.outcomes.length, distinct, stable: distinct.length === 1 };
  });
}

/** Whether this batch ran anything more than once. */
export function hasRepeats(groups) {
  return (groups || []).some((g) => g.runs > 1);
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

/**
 * The same count, split by what actually broke - because one number over both
 * mechanisms is not a measurement of the tool.
 *
 * Our 14 verified cases are 11 packaging breaks and 3 API changes. A packaging
 * break announces itself the moment anything runs; an API change is invisible
 * unless the project's existing tests happen to reach that call. Pooling them
 * gives a figure four-fifths decided by the easier class - and one that moves
 * when we author more cases while the tool stays exactly the same. A number
 * that changes under a relabelling of the test suite is not about the artefact.
 *
 * No percentage, and no interval. Three cases cannot carry a rate: at n=3 even
 * a clean sweep is consistent with a true rate below half, and nothing said
 * over three units is an estimate. Counts and the word "cases", nothing more.
 */
export function byBreakClass(attempted, always) {
  const classOf = (g) => String(g.breakClass || "").trim() || "unlabelled";
  const classes = [...new Set(attempted.map(classOf))].sort();
  // One class, or none labelled: there is nothing to split, and printing a
  // one-row breakdown would imply a comparison we did not make.
  if (classes.length < 2) return [];
  const out = ["### By what broke", "", "| break | fixed every time | cases |", "| --- | --- | --- |"];
  for (const c of classes) {
    const inClass = attempted.filter((g) => classOf(g) === c);
    const fixed = always.filter((g) => classOf(g) === c).length;
    out.push("| " + c + " | " + fixed + " | " + inClass.length + " |");
  }
  out.push(
    "",
    "Counts, not rates. The split between these classes is an accident of which " +
      "cases we found, so a single figure over both would move as we add cases " +
      "without the tool changing. A class with only a few cases carries no rate " +
      "at all - it is an example, and should be read as one.",
    ""
  );
  return out;
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
    //
    // What BLOCKED no longer covers: the product crashing, and the model going
    // quiet. Both used to land here and both are now counted, because the
    // exclusion was doing work it was never meant to do - in run #11 all eight
    // "blocked" legs were the product, six of them a packaging bug of ours that
    // stopped the action before it began. Two blind outside rounds agreed on
    // the rule that catches this: a denominator is fixed before the results
    // arrive and is never shrunk by a category discovered afterwards.
    const judged = sorted.length - n("BLOCKED") - n(UNREPORTED);
    const models = [...new Set(sorted.map((r) => r.model).filter(Boolean))];
    // The objection belongs in the headline, not three lines into a detail cell.
    // FIXED stays one number - the suite went red to green and the census held,
    // and no reviewer opinion changes that - but the one result this project can
    // point at is also the one the reviewer objected to, and a reader should not
    // learn that from anyone else.
    const objected = objectedFixes(sorted);
    const groups = repeatGroups(sorted, kind);
    if (hasRepeats(groups)) {
      // A repeated batch must not be counted in legs. Three runs of one case is
      // one case measured three times, and a headline that says "1 fixed of 3"
      // has turned a coin flip into a rate.
      //
      // A case counts as fixed only if it was fixed EVERY time. Anything else is
      // named separately rather than rounded up, because the whole reason this
      // count exists is that a fix which happens sometimes was being reported as
      // a fix.
      const attempted = groups.filter((g) => !g.distinct.every((o) => o === "BLOCKED" || o === UNREPORTED));
      const always = attempted.filter((g) => g.stable && g.distinct[0] === "FIXED");
      const sometimes = attempted.filter((g) => !g.stable && g.distinct.includes("FIXED"));
      const runsEach = [...new Set(groups.map((g) => g.runs))];
      out.push(
        "## " + always.length + " fixed of " + attempted.length + " cases, every time" +
          (runsEach.length === 1 ? " (" + runsEach[0] + " runs each)" : ""),
        ""
      );
      if (sometimes.length) {
        out.push(
          "**" + sometimes.length + " more case(s) were fixed in some runs and not others** - " +
            "counted here as not fixed, because a fix that happens sometimes is not a fix you can be sold.",
          ""
        );
      }
      out.push(...byBreakClass(attempted, always));
    } else {
      out.push(
        "## " + n("FIXED") + " fixed of " + judged + " cases it was able to attempt" +
          (objected > 0 ? " — the reviewer objected to " + objected + " of them" : ""),
        ""
      );
    }
    out.push(models.length ? "Fixer: " + models.join(", ") : "Fixer: the repository default", "");
    // The headline counts cases and this table counts runs, so a repeated batch
    // shows "1 fixed" above "fixed | 4" and both are true. Saying which is which
    // costs one line; leaving a reader to work it out is how a number gets
    // quoted in the wrong unit.
    if (hasRepeats(groups)) {
      out.push("Counted in runs, not cases - each case below was run more than once:", "");
    }
    out.push("| | |", "|---|---|");
    out.push("| fixed | " + n("FIXED") + " |");
    out.push("| refused to ship an unproven fix | " + n("REFUSED") + " |");
    // Sits below FIXED and REFUSED and above the failures, because that is where
    // it belongs: not a success, not a shortfall. The label says what the finding
    // was rather than what we did not do - "no code fix exists" is the answer, and
    // a row reading "could not fix" would be describing the same run as a failure
    // of ours, which is the thing this outcome was added to stop.
    out.push("| no code fix exists; the decision is the answer | " + n("NEEDS-DECISION") + " |");
    out.push("| ran out of turns mid-investigation | " + n("EXHAUSTED") + " |");
    out.push("| produced nothing | " + n("NO-CHANGE") + " |");
    // Bold, because shipping something broken is the only outcome that costs a
    // user anything, and a benchmark that does not make it prominent is an advert.
    out.push("| **shipped something wrong** | **" + n("WRONG") + "** |");
    // Counted, and named apart. Folding either into "produced nothing" would say
    // the agent examined the case and had no answer, about runs where it never
    // started or never got one.
    out.push("| our own code could not run | " + n("CRASHED") + " |");
    out.push("| the model never answered | " + n("UNANSWERED") + " |");
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

    // What each outcome cost, when the runs recorded it.
    //
    // The question this answers is the one a total on a provider dashboard
    // cannot: does a run that shipped nothing cost as much as one that shipped a
    // fix? In run #10 nine of fourteen cases produced no patch and every one of
    // them wrote a long diagnosis, and nothing said what that was worth.
    //
    // Absent for rows recorded before the field existed, and absent is not zero:
    // same rule as the node column and the census.
    const withTokens = sorted.filter((r) => Number(r.tokensOutput) > 0 || Number(r.tokensInput) > 0);
    if (withTokens.length) {
      // Cached input is the bulk of the bill on a long agent loop, and no row
      // carried it until the action exposed it: run #13's reported input came
      // to about a fifth of what the provider's dashboard charged for the same
      // window. So the table shows it, and shows it as its own column - the
      // four quantities bill at four different rates, and one summed column
      // could not be priced by anyone.
      //
      // A row counts as carrying cache accounting only when the field is
      // present. An older row is not a row that spent nothing, and averaging it
      // in as zero would drag its group down by exactly the amount this column
      // exists to reveal - so a group holding even one such row prints nothing
      // for these two rather than a number that is quietly too low.
      const measured = (v) => v !== undefined && v !== null && v !== "";
      const byOutcome = new Map();
      for (const r of withTokens) {
        const k = label(r, kind);
        const acc = byOutcome.get(k) || { runs: 0, input: 0, output: 0, cacheRead: 0, total: 0, cacheRuns: 0 };
        acc.runs++;
        acc.input += Number(r.tokensInput) || 0;
        acc.output += Number(r.tokensOutput) || 0;
        if (measured(r.tokensCacheRead)) {
          acc.cacheRuns++;
          acc.cacheRead += Number(r.tokensCacheRead) || 0;
          acc.total += measured(r.tokensTotal)
            ? Number(r.tokensTotal) || 0
            : (Number(r.tokensInput) || 0) +
              (Number(r.tokensOutput) || 0) +
              (Number(r.tokensCacheRead) || 0) +
              (Number(r.tokensCacheWrite) || 0);
        }
        byOutcome.set(k, acc);
      }
      const each = (sum, runs) => Math.round(sum / runs).toLocaleString("en-US");
      let anyUnmeasured = false;
      out.push(
        "| what it cost | runs | output tokens each | fresh input each | cached input each | billed total each |",
        "|---|---|---|---|---|---|"
      );
      for (const [name, a] of [...byOutcome.entries()].sort((x, y) => y[1].output / y[1].runs - x[1].output / x[1].runs)) {
        const full = a.cacheRuns === a.runs;
        if (!full) anyUnmeasured = true;
        out.push(
          "| " + name + " | " + a.runs + " | " + each(a.output, a.runs) + " | " + each(a.input, a.runs) +
            " | " + (full ? each(a.cacheRead, a.runs) : "not measured") +
            " | " + (full ? each(a.total, a.runs) : "not measured") + " |"
        );
      }
      if (anyUnmeasured) {
        out.push(
          "",
          '"not measured" means at least one run in that group predates cache accounting. ' +
            "Those runs did spend cached tokens - the action counted them and no output carried them - " +
            "so the fresh-input column beside it is a fraction of what the provider billed, not the bill."
        );
      }
      if (withTokens.length < sorted.length) {
        out.push("", (sorted.length - withTokens.length) + " row(s) recorded no token count and are not in this table.");
      }
      out.push("");
    }

    // And WHICH rule caught them, because the count alone hides the finding.
    //
    // The first two runs blocked four patches and all four were one escape:
    // the agent replaced an imported name with a local reimplementation, so the
    // calls still resolved, the tests still passed, and the package was never
    // reached. Three repositories, three packages, one strategy. A single total
    // would have shown "4" and lost the only interesting part.
    //
    // Rows from before the slug existed are counted separately rather than
    // dropped: a breakdown that quietly omits them would understate the total it
    // sits under.
    const withReason = sorted.filter((r) => r.guardReason);
    if (withReason.length) {
      const byReason = {};
      for (const r of withReason) byReason[r.guardReason] = (byReason[r.guardReason] || 0) + 1;
      const unlabelled = guardCaught(sorted) - withReason.length;
      if (unlabelled > 0) byReason["(recorded before the reason was)"] = unlabelled;
      out.push("| which rule caught it | |", "|---|---|");
      for (const [reason, count] of Object.entries(byReason).sort((a, b) => b[1] - a[1])) {
        out.push("| " + reason + " | " + count + " |");
      }
      out.push("");
    }

    // The point of running anything twice, printed. A stable case is one line;
    // an unstable one names every outcome it produced, because "FIXED, EXHAUSTED,
    // BLOCKED" is the finding and a majority vote would hide it.
    const groupsForTable = repeatGroups(sorted, kind);
    if (hasRepeats(groupsForTable)) {
      const unstable = groupsForTable.filter((g) => !g.stable);
      out.push("| repeated case | runs | outcome |", "|---|---|---|");
      for (const g of groupsForTable.sort((a, b) => Number(a.stable) - Number(b.stable))) {
        out.push(
          "| " + g.repo + " `" + g.package + "@" + g.version + "` | " + g.runs + " | " +
            (g.stable ? g.distinct[0] : "**" + g.outcomes.join(", ") + "**") + " |"
        );
      }
      out.push(
        "",
        unstable.length
          ? "**" + unstable.length + " of " + groupsForTable.length +
            " cases did not give the same answer twice.** That is a property of the" +
            " fixer, not of the break: the case, the model and the commit were identical."
          : "Every case gave the same answer in every run.",
        ""
      );
    }
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
