#!/usr/bin/env node
/**
 * Turns one benchmark run into one row of the table the project is judged on.
 *
 * The row has to be readable by somebody who will not open a log - a YC partner,
 * an investor, a developer on Hacker News - and it has to be honest enough that
 * opening the log would not change their mind. So the outcomes are few, and the
 * two kinds of "no fix" are kept apart on purpose:
 *
 *   FIXED      the tests are green again, and the same tests are green
 *   REFUSED    Patchery found a fix it could not prove, and did not ship it
 *   NO-CHANGE  Patchery had nothing to offer
 *   WRONG      it shipped a change and the suite is still red, or got smaller
 *   BLOCKED    it never got to try - setup failed on our side
 *
 * REFUSED is not a failure to be buried in the same column as WRONG. It is the
 * product's claim: an agent that would rather say nothing than say something
 * unproven. A table that hides it is measuring somebody else's product.
 */

import { censusHeld } from "./test-census.mjs";

/**
 * `--flag value` pairs, with missing flags coming back as "" rather than
 * undefined - every one of these arrives from a workflow expression that is
 * empty when the step it names was skipped.
 */
export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    // Written the long way on purpose. This file has to parse on whatever Node
    // the candidate repository needs, and node-fetch's CI runs Node 12, where
    // `??` is a syntax error - so the whole script failed to load and three
    // cases produced no result at all. The workflow now runs our tooling on the
    // runner's own Node, but a script that cannot be parsed by an old one is a
    // trap waiting for the next caller who forgets.
    const next = argv[i + 1];
    if (argv[i].indexOf("--") === 0) out[argv[i].slice(2)] = next === undefined || next === null ? "" : next;
  }
  return out;
}

/**
 * The whole judgement, as one pure function of what was observed.
 *
 * Order matters, and the ordering rules live at the branches that depend on them.
 * A shipped change is judged against the census before its exit code; a run that
 * shipped nothing is not judged against it at all.
 */
export function benchmarkOutcome({
  baselineExit,
  finalExit,
  actionOutcome = "",
  changed = "",
  review = "",
  before = null,
  after = null,
  version = "",
  installed = "",
  brokenExit = "",
} = {}) {
  if (baselineExit !== "0") {
    return {
      outcome: "BLOCKED",
      detail: "the case never started green on our runner, so nothing could be measured",
    };
  }

  // If the version we asked for is not the version that landed, everything below
  // is measuring an unbroken repository. The first run of this benchmark ended
  // green and read as "Patchery had nothing to offer" - a sentence about the
  // product, from a container where the break may never have existed.
  if (version && installed && String(installed).split(".")[0] !== String(version).split(".")[0]) {
    return {
      outcome: "BLOCKED",
      detail:
        "asked for v" +
        version +
        " but v" +
        installed +
        " is what installed - the break was not present, so nothing here is about Patchery",
    };
  }

  // The break has to be visible in THIS container before the agent is graded in
  // it. Three runs handed express to Patchery with content-disposition@3 installed
  // and the suite green; Patchery said "already passes, nothing to fix", which was
  // true and got written down as a fact about the product. verify-case reproduced
  // the same case red, twice. Whatever the difference is, a row from the green
  // container describes our setup, not the agent.
  if (brokenExit === "0") {
    return {
      outcome: "BLOCKED",
      detail:
        "the suite was still green after installing v" +
        (version || "?") +
        " - there was no break in this container for Patchery to fix",
    };
  }
  if (brokenExit === "") {
    return {
      outcome: "BLOCKED",
      detail: "the run never established whether the break was present",
    };
  }

  const shipped = changed === "true";

  if (!shipped) {
    // The action distinguishes these itself, and the distinction is the product.
    if (/refus|reject|block/i.test(actionOutcome) || /refut/i.test(review)) {
      return {
        outcome: "REFUSED",
        detail: "a fix was written and then withheld: " + (actionOutcome || review || "unproven"),
      };
    }
    // "Ran out of turns" and "had nothing to offer" are not the same result, and
    // the first benchmark reported seven of the second when all seven were the
    // first. On winston the agent had reached the exact cause - v3 set
    // `state.pipes` to the destination, v4 always keeps an array - and the budget
    // ended mid-investigation. Filed as NO-CHANGE, that reads as a product with
    // no answer; it was a product with no room.
    //
    // It stays in the denominator, because a customer whose run does not finish
    // has not been helped. But it is named, because we set the budget and the
    // difference tells us which of us to fix.
    // The three phrasings the action actually emits for this, plus room for the
    // obvious variants. Matching only one of them would leave the distinction
    // technically present and practically absent.
    const RAN_OUT = /max.?turns|exhaust|out of turns|used all \d+ turns|inconclusive/i;
    if (RAN_OUT.test(actionOutcome)) {
      return {
        outcome: "EXHAUSTED",
        detail: "the turn budget ran out before a fix was verified: " + actionOutcome,
      };
    }
    return {
      outcome: "NO-CHANGE",
      detail: actionOutcome ? "no fix produced: " + actionOutcome : "no fix produced",
    };
  }

  // Only now, and only for a change that actually shipped. Asked before the exit
  // code, because a green run on a shrunken suite is the failure that looks most
  // like a success. Asked after the shipped check, because a run where nothing
  // was shipped is still red from the break itself - counting that as a shrunken
  // suite would file every honest refusal under WRONG.
  const held = censusHeld(before, after);
  if (held.ok === false) {
    return { outcome: "WRONG", detail: held.why };
  }

  if (finalExit === "0") {
    return {
      outcome: "FIXED",
      detail: "tests green again" + (held.ok ? " and " + held.why : "") + (review ? "; reviewer: " + review : ""),
    };
  }

  if (finalExit === "") {
    return { outcome: "BLOCKED", detail: "a change was made but the final test run never finished" };
  }

  return {
    outcome: "WRONG",
    detail: "a change was shipped and the tests are still failing (exit " + finalExit + ")",
  };
}

/** Markdown, because this lands in a step summary and later in a table. */
export function renderOutcome({ repo, pkg, version, outcome, detail, before, after, files }) {
  const lines = [];
  lines.push("## " + outcome);
  lines.push("");
  lines.push(repo + " - `" + pkg + "@" + version + "`");
  lines.push("");
  lines.push(detail);
  if (before && before.total != null) {
    lines.push("");
    lines.push(
      "Tests: " +
        before.passed +
        " passing before the break" +
        (after && after.total != null ? ", " + after.passed + " passing after the fix" : "") +
        (before.runner ? " (" + before.runner + ")" : "")
    );
  }
  if (files) {
    lines.push("");
    lines.push("Files changed: " + files.split(/\s+/).filter(Boolean).length);
  }
  return lines.join("\n");
}

const isMain = process.argv[1] && process.argv[1].endsWith("benchmark-outcome.mjs");
if (isMain) {
  const fs = await import("node:fs");
  const a = parseArgs(process.argv.slice(2));
  const read = (p) => {
    try {
      return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch {
      return null;
    }
  };
  const before = read(a.before);
  const after = read(a.after);
  const { outcome, detail } = benchmarkOutcome({
    baselineExit: a["baseline-exit"],
    finalExit: a["final-exit"],
    actionOutcome: a["action-outcome"],
    changed: a.changed,
    review: a.review,
    version: a.version,
    installed: a.installed,
    brokenExit: a["broken-exit"],
    before,
    after,
  });
  const row = {
    repo: a.repo,
    package: a.package,
    version: a.version,
    installed: a.installed || "",
    // A benchmark number is model-dependent. A table that does not say which
    // model produced it cannot be reproduced or compared, and invites the
    // reader to assume the best one.
    model: a.model || "",
    outcome,
    detail,
    before,
    after,
    files: a.files || "",
    run: process.env.GITHUB_RUN_ID || "",
  };
  if (a.out) fs.writeFileSync(a.out, JSON.stringify(row, null, 2) + "\n");
  process.stdout.write(
    renderOutcome({ repo: a.repo, pkg: a.package, version: a.version, outcome, detail, before, after, files: a.files }) +
      "\n"
  );
}
