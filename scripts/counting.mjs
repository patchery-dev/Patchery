/**
 * Patchery - which outcomes are in the denominator, in one place.
 *
 * This file exists because the rule had no place. It lived in comments in
 * benchmark-outcome.mjs and in a table in the founder's notes, and the product
 * itself carried a sentence claiming the opposite of what the benchmark did:
 *
 *     guard.mjs, before this change:
 *       "...is reported as `harness-error` so it stays out of any success ratio."
 *
 *     benchmark-outcome.mjs, the whole time:
 *       harness-error -> CRASHED -> IN the denominator.
 *
 * Run #13 printed that sentence seven times. Nothing could have caught it,
 * because there was nothing to compare the sentence against.
 *
 * ## The rule the product may not state
 *
 * A tool cannot declare its own exclusion. Whether a run counts is a decision
 * about the measurement, made by whoever fixed the denominator before the
 * results were seen - not a fact the tool observes about itself. So the product
 * says what happened and what that says about the break; the counting rule
 * lives here, and the benchmark reads it.
 *
 * The split matters beyond tidiness. "This run is excluded" in a log is a
 * promise to a reader who cannot check it, and an excluded failure is exactly
 * the kind a vendor has an incentive to produce: if exclusion is free, the
 * worst reliability buys the best score.
 */

/**
 * Every outcome the benchmark can file, and whether it counts.
 *
 * `counted: false` is the expensive one and there is exactly one of them. The
 * test below enforces that, because widening this list is how a success rate
 * quietly becomes a rate over the runs that went well.
 */
export const COUNTING = {
  FIXED: { counted: true, why: "the tests pass and the same tests pass" },
  REFUSED: { counted: true, why: "a good design decision is not a success, and refusing is the product working" },
  EXHAUSTED: { counted: true, why: "we chose the budget; the run did happen" },
  "NO-CHANGE": { counted: true, why: "the agent looked and had nothing to offer" },
  WRONG: { counted: true, why: "something shipped and the suite is still broken, or smaller" },
  CRASHED: {
    counted: true,
    why:
      "the tool could not run its own code. That is the tool being evaluated failing, " +
      "not the measuring apparatus failing, and the difference is the whole of this file",
  },
  UNANSWERED: { counted: true, why: "the model never answered; the attempt was still made" },
  "NEEDS-DECISION": { counted: true, why: "a real outcome of a real attempt" },
  BLOCKED: {
    counted: false,
    why:
      "it never got to try, because setup failed on OUR side. The failure is " +
      "attributable to the measuring apparatus rather than to the tool under test",
  },
};

/**
 * Whether an outcome is in the denominator.
 *
 * Throws on an unknown name rather than guessing. A tenth outcome added without
 * a counting decision is a run whose status nobody chose, and defaulting it
 * either way would make that invisible.
 *
 * @param {string} outcome
 * @returns {{counted: boolean, why: string}}
 */
export function countingRule(outcome) {
  const rule = COUNTING[String(outcome)];
  if (!rule) throw new Error("no counting rule for outcome: " + outcome);
  return rule;
}

/**
 * Phrases that promise a reader something about how a run will be counted.
 *
 * Narrow on purpose. This is not a style check on the word "ratio" - it is a
 * list of the ways a sentence can tell somebody that a result is in or out of a
 * score. Each entry earned its place: the first is the exact sentence that
 * shipped and was false.
 */
const PROMISES = [
  /stays? out of (?:any |the )?(?:success )?rat(?:io|e)/i,
  /(?:kept |stays? |left )?out of the denominator/i,
  /(?:not |n't )counted (?:in|towards|toward)/i,
  /does(?: not|n't) count (?:in|towards|toward|against)/i,
  /excluded from (?:any |the )?(?:success |pass )?(?:rat(?:io|e)|score|denominator)/i,
];

/** Source with line and block comments removed, so only what the product can print is left. */
function printableOnly(source) {
  return String(source ?? "")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

/**
 * The first counting promise in text the product can print, or null.
 *
 * Comments are stripped first: a comment explaining the rule to the next
 * developer is the right place for it. A string is what reaches the operator's
 * log, and that is where the promise may not be made.
 *
 * @param {string} source
 * @returns {string|null} the matched phrase, or null
 */
export function countingPromise(source) {
  const text = printableOnly(source);
  for (const re of PROMISES) {
    const hit = re.exec(text);
    if (hit) return hit[0];
  }
  return null;
}
