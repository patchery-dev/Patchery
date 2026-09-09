#!/usr/bin/env node
/**
 * Turns one benchmark run into one row of the table the project is judged on.
 *
 * The row has to be readable by somebody who will not open a log - a YC partner,
 * an investor, a developer on Hacker News - and it has to be honest enough that
 * opening the log would not change their mind. So the outcomes are few, and the
 * two kinds of "no fix" are kept apart on purpose:
 *
 *   FIXED           the tests are green again, and the same tests are green
 *   REFUSED         Patchery found a fix it could not prove, and did not ship it
 *   NEEDS-DECISION  no code change fixes this break; the analysis names what does
 *   NO-CHANGE       Patchery had nothing to offer
 *   WRONG           it shipped a change and the suite is still red, or got smaller
 *   BLOCKED         it never got to try - setup failed on our side
 *
 * REFUSED is not a failure to be buried in the same column as WRONG. It is the
 * product's claim: an agent that would rather say nothing than say something
 * unproven. A table that hides it is measuring somebody else's product.
 *
 * NEEDS-DECISION separates two things that are not alike: a break this agent
 * could not solve, and a break that has no solution in the customer's code at
 * all. When a package requires a newer Node than the project runs, no edit to
 * any call site changes which Node the project runs - the answer is a decision,
 * and it belongs to whoever owns the consequences. Reporting that as "Patchery
 * had nothing to offer" states the opposite of what happened.
 *
 * It stays in the denominator. A customer whose build is still red has not been
 * helped, whoever is at fault, and a column where nothing is ever our failure is
 * how a benchmark stops measuring anything.
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
  actionSummary = "",
  stepOutcome = "",
  decisionReason = "",
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

  // A provider that stopped answering is not a product result. Four cases in the
  // second benchmark ended "no fix produced: failed", which reads as an agent
  // with no ideas; the logs said the model had produced nothing for twenty
  // minutes and the run was stopped waiting for it. On winston the agent had
  // already written down the exact break - `is-stream` v4 is ESM-only with named
  // exports, so `require('is-stream')` no longer returns a function - and then
  // the request stalled.
  //
  // Filed with BLOCKED and kept out of the denominator, because it says nothing
  // about whether Patchery can fix the break.
  //
  // The `failed` requirement is load-bearing and was missing. `actionSummary`
  // is a shared channel: on a real stall it carries guard.mjs's timeoutReason,
  // written by fail(), which also sets outcome `failed`. But on an ordinary
  // unproductive run it carries the MODEL's own closing message - agent.mjs
  // takes the last 1500 characters of it into the handover and stops with
  // `no-changes`. So an agent that wrote "the second one was a stalled request
  // against the registry, so I gave up" moved its own failed case from
  // NO-CHANGE (in the denominator) to BLOCKED (outside it). Measured.
  //
  // That is the model marking its own homework, in our favour, and 200 lines
  // below this one the same file states the rule it was breaking: "a summary is
  // written by the model, and a model that learned this phrase would have
  // learned an excuse."
  //
  // Requiring `failed` closes it, because the model-authored path stops with
  // `no-changes` and can never set it. Nothing legitimate is lost: a stall with
  // no outcome at all still lands in the "never reported" branch below, which
  // is BLOCKED anyway.
  //
  // The real fix is for the stall to travel as its own output slug rather than
  // as prose sharing a channel with the model. Written up; this is the gate in
  // the meantime.
  const stalled =
    /^failed$/i.test(String(actionOutcome || "").trim()) &&
    /stalled request|produced nothing for \d+ minutes/i.test(actionSummary);
  // A stall is not our setup failing, so it does not belong in the bucket that
  // means "our setup failed". Two independent blind rounds landed on the same
  // rule for it: it may never be dropped silently, because outages fall hardest
  // on the longest attempts and dropping them flatters exactly the runs that
  // were going worst. One of the two allows excluding it from a headline only
  // when it is pre-specified, counted, retried, and published alongside a rate
  // that counts it as failure.
  //
  // We cannot retry a past run, and the model is part of what we ship - so
  // "the service we chose did not answer" is a failed run for the customer.
  // In the denominator, under its own name, so that a rate which excludes it
  // can still be computed deliberately and labelled rather than arrived at by
  // deletion.
  if (stalled) {
    return {
      outcome: "UNANSWERED",
      detail: "the model stopped answering mid-run and the request was abandoned - no verdict on the fix, and a failed run for whoever was waiting",
    };
  }

  // An action that never reported is not an agent with no ideas.
  //
  // Four legs of a cancelled batch came out "NO-CHANGE - no fix produced", which
  // is a sentence about the product, from runs that were killed seven minutes in
  // while the model was still working. The table then read "0 fixed of 4 cases it
  // was able to attempt", and it had attempted none of them.
  //
  // Every path out of agent.mjs writes an outcome, including its error path, so
  // an empty one means the process never got there: cancelled, timed out, or
  // killed. That is our side of the fence, so it is BLOCKED and out of the
  // denominator.
  // "Never reported" means no trace of the action at all, and the self-test
  // narrowed this twice:
  //
  //   - a review verdict or a summary proves it ran far enough to produce
  //     something worth judging; a refuted review is REFUSED, not blocked
  //   - `changed: "false"` is an output. The action wrote it, so it finished and
  //     said "I changed nothing". Only an EMPTY `changed` means no output at all
  //
  // So the test is emptiness across every field the action sets, not the value
  // of any one of them.
  // The SDK stopped before the agent reached a conclusion. This was BLOCKED -
  // out of the denominator as "a limit of our harness" - and that was wrong.
  //
  // Every one of run #11's eight BLOCKED legs was this branch. Opened one at a
  // time: six were node-fetch running our own code on Node 16.20.2, because the
  // action asked PATH which Node was ours and got the customer's (fixed in
  // 77d33f1). Two were treeherder hitting the 25,000-token read limit, which
  // this repository's own notes already call a prompt problem rather than a
  // limit. Not one was a container that failed to start.
  //
  // Both halves are the product. A customer whose workflow sets up Node before
  // calling this action watches it die in eight seconds; that is a defect we
  // shipped, not an outage we suffered. Excluding it counted our own packaging
  // bug as something that happened TO us.
  //
  // So it is in the denominator, and it keeps its own name. Folding it into
  // NO-CHANGE would say "the agent examined this and had nothing to offer"
  // about a run where the agent never started - the exact conflation this file
  // exists to prevent.
  if (/harness-error/i.test(actionOutcome)) {
    return {
      outcome: "CRASHED",
      detail: "the agent runtime stopped before it could reach a conclusion - our defect, and a failed run for whoever installed it",
    };
  }

  const killed = /cancel|skip/i.test(stepOutcome);
  const silent = !actionOutcome && !review && !actionSummary && changed === "";
  if (killed || silent) {
    return {
      outcome: "BLOCKED",
      detail: killed
        ? "the run was " + stepOutcome.toLowerCase() + " before Patchery finished - nothing here is about the fix"
        : "Patchery never reported an outcome, so it was stopped mid-run (cancelled, timed out or killed) - not a verdict",
    };
  }

  const shipped = changed === "true";

  if (!shipped) {
    // The action distinguishes these itself, and the distinction is the product.
    // `review` is not prose: it is the review-status output, and reviewOutcome
    // emits exactly one of not-refuted | concerns | refuted | not-reviewed |
    // unavailable. An unanchored /refut/ therefore matched "not-refuted" - the
    // reviewer's APPROVAL, its rank-0 verdict - and filed the run as REFUSED,
    // detail "a fix was written and then withheld: not-refuted".
    //
    // That error ran in our favour, which is why it is worth the anchor.
    // REFUSED is the column this product is proud of - a fix withheld because
    // it could not be proved - while the alternative here is NO-CHANGE,
    // "produced nothing". A run the reviewer was happy with, that shipped
    // nothing, was being credited as a principled refusal.
    //
    // Anchored the same way batch-report.mjs reads the same field. Note the two
    // files disagreed until now, which is what pointed at this.
    //
    // "concerns" is deliberately NOT added here. It is a real objection and
    // batch-report counts it as one, so arguably a withheld fix the reviewer had
    // concerns about is REFUSED too - but that change would move cases INTO the
    // flattering column, and it is not this pass's call to make. Left as
    // NO-CHANGE, and written up for the founder.
    if (/refus|reject|block/i.test(actionOutcome) || /^refuted$/i.test(String(review || "").trim())) {
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
      // Two budgets end a run, and saying "turn budget" for both was wrong half
      // the time. Five legs of run #11 hit the WALL CLOCK - and, reported as a
      // plain failure, were filed NO-CHANGE, "Patchery had nothing to offer".
      // On one of them the agent had already written the migration and said it
      // was about to verify. The row is the opposite of what happened.
      //
      // Which budget it was decides what to change: turns is a number in the
      // workflow, minutes is a number in the workflow and the job limit above it.
      const wallClock = /run-budget-exhausted/i.test(actionOutcome);
      return {
        outcome: "EXHAUSTED",
        detail:
          (wallClock
            ? "the run's wall-clock budget ended while the agent was still working"
            : "the turn budget ran out before a fix was verified") + ": " + actionOutcome,
      };
    }
    // The action's summary says which break it was looking at and how far it got.
    // "no fix produced: no-changes" is a shrug; the row should carry the reason,
    // because this is the most common outcome and a table full of shrugs teaches
    // nobody anything.
    // A break with no fix in the customer's code is not a failure of ours, and
    // filing it as "Patchery had nothing to offer" says the opposite.
    //
    // This is the mirror of BLOCKED and it earns its place the same way. BLOCKED
    // exists because our setup failing is not a finding about the product;
    // NEEDS-DECISION exists because the customer's situation having no code fix
    // is not a finding about the product either. Neither is a verdict on the
    // agent. Both must be visible rather than blended away.
    //
    // But unlike BLOCKED it stays IN the denominator, and that is the whole
    // discipline. A customer whose build is still red has not been helped,
    // whoever is at fault - so this must never become the column where nothing
    // is ever our failure. It is named so a reader can see how often it fires:
    // if most runs end here, that is a weak product and the table has to say so
    // in its own numbers rather than hide it inside a friendlier word.
    //
    // Reachable only via the action's own `needs-decision` outcome, which is
    // gated on a regex over the test output rather than on anything the model
    // asserts. Nothing here pattern-matches the summary text - a summary is
    // written by the model, and a model that learned this phrase would have
    // learned an excuse.
    if (/^needs-decision$/i.test(String(actionOutcome).trim())) {
      return {
        outcome: "NEEDS-DECISION",
        detail:
          "no code change fixes this break - the analysis names the decision that does" +
          (decisionReason ? " (" + decisionReason + ")" : ""),
      };
    }
    const said = String(actionSummary || "").trim();
    return {
      outcome: "NO-CHANGE",
      detail: said || (actionOutcome ? "no fix produced: " + actionOutcome : "no fix produced"),
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
    // `held.ok` is a tri-state and the ternary above used to read it as a
    // boolean, so `null` - "the runner's output was not recognized, I could not
    // count" - printed as though there were nothing to say. The row read
    // "tests green again", full stop, and a reader could not tell it apart from
    // a run where the census was taken and held.
    //
    // test-census.mjs says it in its own docstring: "ok: null means we could
    // not tell, which must never be read as a pass." This is the null-is-not-
    // zero rule the outcome code has now learned four times.
    //
    // What is NOT changed here: the outcome. FIXED with an unmeasured census is
    // arguably not FIXED - this file's own header defines FIXED as "the tests
    // are green again, AND the same tests are green", and the second half is
    // exactly what went unproven. But every candidate reclassification moves the
    // case across the denominator line the founder is currently deciding
    // (BLOCKED's boundary, [[23]] B2), and picking one here would be settling
    // that decision by implementation. Reported instead.
    //
    // So: the outcome stands, and it stops being able to hide why it is unsure.
    const censusNote =
      held.ok === true ? " and " + held.why : held.ok === null ? " - but " + held.why : "";
    return {
      outcome: "FIXED",
      detail: "tests green again" + censusNote + (review ? "; reviewer: " + review : ""),
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
        // Same rule as the detail line above: an after-count we could not read
        // used to drop out of the sentence entirely, leaving "Tests: 100 passing
        // before the break" and no hint that the half which judges the fix is
        // missing. Named, not omitted.
        (after && after.total != null
          ? ", " + after.passed + " passing after the fix"
          : ", after the fix NOT COUNTED - the runner's output was not recognized") +
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
    stepOutcome: a["step-outcome"],
    guardReason: a["guard-reason"],
    changed: a.changed,
    review: a.review,
    version: a.version,
    installed: a.installed,
    brokenExit: a["broken-exit"],
    actionSummary: a["action-summary"],
    decisionReason: a["decision-reason"],
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
    // The mechanism that broke this case, carried so the report can refuse to
    // average two of them. 11 of our 14 cases are packaging breaks, which
    // announce themselves the moment anything runs; 3 are API changes that only
    // surface if the existing tests happen to reach that call. A single number
    // over both is four-fifths decided by the easier half, and it moves when we
    // author more cases without the tool changing at all.
    breakClass: a["break-class"] || "",
    // The three measures the blind rounds asked for and this row did not have.
    // All continuous, all present whatever the outcome was - which is the point:
    // no affordable design answers "does the ceiling bind" from a binary result,
    // and the distance to the ceiling answers it directly.
    clockMinutes: a["clock-minutes"] || "",
    clockPercent: a["clock-percent"] || "",
    modelWaitSeconds: a["model-wait-seconds"] || "",
    localWorkSeconds: a["local-work-seconds"] || "",
    // Deliberately left varying, therefore recorded. A run that differed on a
    // different machine or a different image is a different explanation from one
    // that differed on the same.
    runner: a.runner || "",
    // Tokens, not money. The SDK prices with Anthropic's own table whatever
    // endpoint served the request - it was wrong by a factor of 195 once - so
    // the honest half is the quantity the provider actually bills for.
    //
    // Per case, because the question worth asking is per OUTCOME: does a run
    // that shipped nothing cost as much as one that shipped a fix? In run #10
    // nine of fourteen cases produced no patch and every one of them wrote a
    // long diagnosis, and nothing in the table said what that cost.
    tokensInput: Number(a["tokens-input"]) || 0,
    tokensOutput: Number(a["tokens-output"]) || 0,
    guardReason: a["guard-reason"] || "",
    outcome,
    detail,
    // Kept beside the outcome because the two answer different questions. The
    // outcome says what the case came to; this says what the action itself
    // reported, and it is the only place `blocked-by-guard` survives into the
    // table - REFUSED covers the reviewer's refutations too, so it cannot be
    // read as the guard's catch count.
    actionOutcome: a["action-outcome"] || "",
    // What the independent reviewer said, as its own field. It is already inside
    // `detail` for FIXED rows, but a headline cannot parse prose, and an
    // objection to a fix that shipped is the one thing a reader of the headline
    // must not have to look for.
    review: a.review || "",
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
