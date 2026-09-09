/**
 * Is a hand-written patch actually a fix for this case?
 *
 * The golden/empty control asks whether the tool can recognise a known-good
 * patch. That question is worthless if "known-good" was decided by the same
 * pipeline the control is meant to test: a patch judged only by the thing it is
 * meant to check is not a control, it is a mirror.
 *
 * So the proof runs here, in verify-case, with nothing from benchmark-outcome.mjs
 * in the path. This file deliberately imports none of the classifier. It answers
 * one mechanical question - the suite was red after the upgrade, is it green
 * after the patch - and it answers it from exit codes the workflow captured, not
 * from anything a model said.
 *
 * The verdicts are kept apart on purpose:
 *
 *   GOLDEN       red after the upgrade, green after the patch. Usable as a control.
 *   NOT-A-FIX    the patch applied and the suite is still red. Not usable.
 *   NOT-APPLIED  the patch did not apply to this checkout at all. Says nothing
 *                about the patch's quality - it says the patch and the commit
 *                have drifted, which is a different repair.
 *   UNKNOWN      there was nothing to prove a patch against.
 *
 * NOT-APPLIED and NOT-A-FIX are separate for the same reason REFUSED and WRONG
 * are: "we could not try" and "we tried and it did not work" look alike in a
 * table and mean opposite things about the artifact.
 */

/** An exit code as the workflow recorded it: a string, "" when the step never ran. */
function code(v) {
  const s = String(v ?? "").trim();
  return s === "" ? null : s;
}

export function goldenVerdict({ afterExit, applyExit, goldenExit } = {}) {
  const after = code(afterExit);
  const applied = code(applyExit);
  const golden = code(goldenExit);

  if (after === null) {
    return { verdict: "UNKNOWN", why: "the run after the upgrade never finished, so there was nothing to repair" };
  }
  if (after === "0") {
    return {
      verdict: "UNKNOWN",
      why: "the suite was still green after the upgrade - this case cannot prove a patch, because there is nothing here to fix",
    };
  }
  if (applied === null) {
    return { verdict: "UNKNOWN", why: "the patch step never ran" };
  }
  if (applied !== "0") {
    return {
      verdict: "NOT-APPLIED",
      why: "the patch did not apply to this checkout (git apply exit " + applied + ") - the patch and the pinned commit have drifted",
    };
  }
  if (golden === null) {
    return { verdict: "UNKNOWN", why: "the patch applied, but the suite never finished afterwards" };
  }
  if (golden === "0") {
    return {
      verdict: "GOLDEN",
      why: "red after the upgrade (exit " + after + "), green after the patch - this patch is a known-good fix for this case",
    };
  }
  return {
    verdict: "NOT-A-FIX",
    why: "the patch applied cleanly and the suite is still red (exit " + golden + ") - it is not a fix for this break",
  };
}

/** One line for the step summary, in the shape verify-case's own verdict uses. */
export function renderGolden({ verdict, why } = {}) {
  return ["", "### " + verdict, "", why, ""].join("\n");
}

if (process.argv[1] && process.argv[1].endsWith("golden-verdict.mjs")) {
  const [, , afterExit, applyExit, goldenExit] = process.argv;
  const result = goldenVerdict({ afterExit, applyExit, goldenExit });
  process.stdout.write(renderGolden(result) + "\n");
  // Exit 0 whatever the verdict: this reports, it does not gate. A patch that
  // turns out not to be a fix is a finding, not a failed run.
  process.exit(0);
}
