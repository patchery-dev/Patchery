/**
 * The reviewer's claim, turned into something the terminal can settle.
 *
 * Until now the second model's verdict was a text. It said "refuted" and we
 * wrote that down, and benchmark #11 shipped a change the reviewer had called
 * wrong - correctly, because `verify-mode` defaults to `warn`, but the deeper
 * problem was visible in the same row: nothing anywhere had *checked* whether
 * the reviewer was right. Every other layer in this action is mechanical. The
 * layer we advertise most loudly was the one layer that was an opinion.
 *
 * So the reviewer stops being asked for a verdict it cannot support. When it
 * wants to refute a fix, it must hand over a test: code that PASSES on the
 * repository as it worked before, and FAILS on the patch, with the failure it
 * predicted. The reviewer never runs it - it has no Bash and no network, by
 * design, and that does not change here. The harness runs it, on both trees,
 * more than once, and the exit codes decide.
 *
 * The model proposes. The terminal disposes. That was already true of the
 * fixer; this file makes it true of the reviewer.
 *
 * Everything here is fail-closed in the same direction as the rest of the
 * guard: a counterexample we could not run, could not screen, or could not
 * make sense of establishes NOTHING. It does not block the pull request - a
 * broken accusation must not sink a fix that passed the mechanical guard and
 * the project's own tests - and it equally does not clear it. "We could not
 * tell" is a third answer, and it is never rounded to either side.
 */

/**
 * The largest counterexample we will look at, in bytes.
 *
 * A refutation that needs more than this is not a counterexample, it is a
 * second implementation, and nothing downstream could review it either.
 */
export const MAX_COUNTEREXAMPLE_BYTES = 8000;

/**
 * How many times each side is run before the difference is believed.
 *
 * One run of a test is one observation - the same lesson benchmark #11 forced
 * on the fixer, where 5 of 14 cases did not give the same answer twice. A
 * counterexample is a test like any other and gets the same treatment: if it
 * only fails sometimes, it has not demonstrated anything about the patch.
 */
export const DEFAULT_K = 3;

/**
 * Patterns that make a proposed counterexample unusable, and why.
 *
 * Two different jobs, deliberately in one screen, because both end the same way
 * - the test is not evidence:
 *
 *   1. NON-DETERMINISM. A test that reaches the network, sleeps, or draws
 *      unseeded randomness can fail on the patched tree for reasons that have
 *      nothing to do with the patch. Run it three times and it may well fail
 *      three times, so the K-repeat rule below does not catch this on its own -
 *      the flakiness has to be screened out before it is ever run.
 *
 *   2. ESCAPE. This is model-authored code about to be executed in CI. The
 *      fixer's output is executed too, so this is not a new category of risk,
 *      but the fixer's output is at least constrained to a diff a human will
 *      read in a pull request. A counterexample is run and then, if it does not
 *      establish anything, discarded - so it gets the tighter screen, not the
 *      looser one.
 *
 * Text-based, and honest about it, for the same reason `protectedReason` is:
 * this runs on a file we did not parse and could not trust a parse of. A regex
 * that is candid about being a regex beats a parser that is wrong about being a
 * parser. The cost is false positives - a comment mentioning `setTimeout` is
 * refused - and that is the safe direction: a rejected counterexample costs the
 * reviewer one accusation, an accepted bad one costs the guarantee.
 *
 * @param {string} code
 * @returns {string[]} reasons, empty when the code may be run
 */
export function counterexampleReasons(code) {
  const src = typeof code === "string" ? code : "";
  const reasons = [];

  if (!src.trim()) return ["the counterexample is empty"];
  if (Buffer.byteLength(src, "utf8") > MAX_COUNTEREXAMPLE_BYTES) {
    reasons.push("longer than " + MAX_COUNTEREXAMPLE_BYTES + " bytes");
  }

  // Anchored on a non-identifier character so `myFetch(` and `resetTimeout(`
  // are not caught, while `fetch(`, `await fetch(` and `globalThis.fetch(` are.
  const RULES = [
    [/(^|[^A-Za-z0-9_$.])fetch\s*\(/, "calls fetch()"],
    [/\bglobalThis\.fetch\b|\bwindow\.fetch\b/, "calls fetch()"],
    [/\b(?:require\(|from\s+)["'](?:node:)?(?:http|https|net|dgram|dns|tls)["']/, "opens a socket"],
    [/\b(?:axios|got|node-fetch|undici|superagent)\b/, "uses a network client"],
    [/\bXMLHttpRequest\b|\bWebSocket\b/, "uses a network client"],
    [/(^|[^A-Za-z0-9_$.])set(?:Timeout|Interval|Immediate)\s*\(/, "uses a real timer"],
    [/\bMath\.random\s*\(/, "uses unseeded randomness"],
    [/\bcrypto\.randomUUID\s*\(|\brandomBytes\s*\(/, "uses unseeded randomness"],
    [/\bDate\.now\s*\(|\bnew\s+Date\s*\(\s*\)/, "reads the wall clock"],
    [
      /\b(?:require\(|from\s+)["'](?:node:)?child_process["']|\bexecSync\s*\(|\bspawnSync\s*\(/,
      "starts another process",
    ],
    [/\bprocess\.exit\s*\(/, "calls process.exit()"],
    [/\bprocess\.chdir\s*\(/, "changes the working directory"],
    // Reading the filesystem is how a test inspects a build; writing to it is
    // how a test edits the repository it is supposed to be judging.
    [
      /\bfs(?:\.promises)?\.(?:write|append|unlink|rm|rmdir|mkdir|copy|rename|chmod)[A-Za-z]*\s*\(/,
      "writes to the filesystem",
    ],
  ];
  for (const [re, why] of RULES) {
    if (re.test(src) && !reasons.includes(why)) reasons.push(why);
  }
  return reasons;
}

/**
 * One side of the differential, reduced to what the decision needs.
 *
 * `exitCode` null means the run did not happen or did not report - never
 * silently a zero, which would read as "the test passed".
 *
 * @typedef {{exitCode: number|null, output?: string}} CounterexampleRun
 */

/**
 * Did the counterexample actually demonstrate what the reviewer claimed?
 *
 * The bar, and every clause of it is load-bearing:
 *
 *   - It must PASS K times on the tree that worked. A counterexample that
 *     fails on the original code has not found a regression, it has found its
 *     own bug, and the reviewer would otherwise be able to refute any patch by
 *     writing a test that fails everywhere.
 *   - It must FAIL K times on the patch. Once is an observation.
 *   - Each of those failures must carry the failure the reviewer PREDICTED.
 *     Without this the reviewer can write a test that throws a typo on both
 *     trees and collect a refutation from a crash it caused itself.
 *
 * Anything else returns `established: null` - could not tell. That value is not
 * a pass and not a fail, and callers must keep it a third thing: see
 * `censusHeld`, which learned the same lesson earlier and the hard way.
 *
 * @param {object} a
 * @param {CounterexampleRun[]} a.oldRuns  on the tree as it worked before
 * @param {CounterexampleRun[]} a.newRuns  on the patched tree
 * @param {string} a.expectedFailure  the substring the reviewer predicted
 * @param {number} [a.k]
 * @returns {{established: boolean|null, why: string}}
 */
export function differentialVerdict({ oldRuns, newRuns, expectedFailure = "", k = DEFAULT_K } = {}) {
  const olds = Array.isArray(oldRuns) ? oldRuns : [];
  const news = Array.isArray(newRuns) ? newRuns : [];

  if (olds.length < k || news.length < k) {
    return {
      established: null,
      why:
        "needed " + k + " runs on each side, got " + olds.length + " and " + news.length,
    };
  }
  if (olds.some((r) => r?.exitCode == null) || news.some((r) => r?.exitCode == null)) {
    return { established: null, why: "a run did not report an exit code" };
  }

  const oldPassed = olds.filter((r) => r.exitCode === 0).length;
  if (oldPassed < k) {
    return {
      established: false,
      why:
        "the counterexample passed only " +
        oldPassed +
        " of " +
        k +
        " times on the code that worked, so it does not describe a regression",
    };
  }

  const newFailed = news.filter((r) => r.exitCode !== 0).length;
  if (newFailed < k) {
    return {
      established: false,
      why: "the counterexample failed only " + newFailed + " of " + k + " times on the patch",
    };
  }

  const want = String(expectedFailure || "").trim();
  if (!want) {
    return { established: null, why: "the reviewer predicted no particular failure to look for" };
  }
  const matched = news.filter((r) => String(r.output ?? "").includes(want)).length;
  if (matched < k) {
    return {
      established: false,
      why:
        "the patch failed, but only " +
        matched +
        " of " +
        k +
        " failures carried the predicted error",
    };
  }

  return {
    established: true,
    why: "passed " + k + "/" + k + " before the patch and failed " + k + "/" + k + " after it, with the predicted error",
  };
}

/**
 * How many counterexamples one review may attempt.
 *
 * A reviewer given unlimited attempts is a reviewer that eventually produces a
 * test that fails for some unrelated reason, and every attempt is a model call
 * against a repository we do not own. Three is enough to recover from a typo
 * and few enough that the cost is bounded before the run starts.
 */
export const MAX_ATTEMPTS = 3;

/**
 * Whether to ask the reviewer for another counterexample, and why we stopped.
 *
 * Two terminating conditions and nothing else, so the loop cannot run away:
 *
 *   - SHORT CIRCUIT. The first counterexample that establishes itself ends the
 *     search immediately. There is no point asking for a second accusation once
 *     one has been proven, and continuing would only give the reviewer more
 *     chances to produce a flaky one.
 *   - BUDGET. Attempts run out.
 *
 * The direction of the budget is the part worth being careful about: running
 * out of attempts means THIS REVIEWER FAILED TO SUPPORT ITS ACCUSATION. It does
 * not mean the patch was examined and cleared. `exhausted` is reported so the
 * pull request can say which of those two happened, because they read
 * identically in a table and mean opposite things.
 *
 * @param {Array<{established: boolean|null}>} attempts  results so far
 * @param {number} [max]
 * @returns {{keepTrying: boolean, stopReason: string|null, established: boolean|null, exhausted: boolean}}
 */
export function attemptPolicy(attempts = [], max = MAX_ATTEMPTS) {
  const seen = Array.isArray(attempts) ? attempts : [];
  const proven = seen.find((a) => a?.established === true);
  if (proven) {
    return {
      keepTrying: false,
      stopReason: "a counterexample established the claim",
      established: true,
      exhausted: false,
    };
  }
  if (seen.length >= max) {
    return {
      keepTrying: false,
      stopReason: "the reviewer used all " + max + " attempts without establishing a claim",
      // Not `false`: the accusations failed, which is not the same as the patch
      // having been checked and found sound. Only the fixer's own test run and
      // the mechanical guard get to say anything in that direction.
      established: null,
      exhausted: true,
    };
  }
  return { keepTrying: true, stopReason: null, established: null, exhausted: false };
}

/**
 * What a counterexample is allowed to do to the review's rank.
 *
 * Strictly one-directional, the same rule `reviewOutcome` already follows: this
 * can RAISE the severity of an accusation that proved itself, and can LOWER an
 * accusation that did not. It can never move a fix from "reviewed" to
 * "refuted" on the model's say-so alone, and it can never be the reason a fix
 * is blessed - `established: false` means this particular accusation failed,
 * not that the patch is correct. Those are different sentences and the second
 * one is not ours to say.
 *
 * @param {object} a
 * @param {number} a.rank  from reviewOutcome, 0..2
 * @param {{established: boolean|null, why: string}|null} a.verdict
 * @param {string[]} [a.screenReasons]  from counterexampleReasons
 * @returns {{rank: number, note: string}}
 */
export function applyCounterexample({ rank = 0, verdict = null, screenReasons = [] } = {}) {
  const start = Math.max(0, Math.min(2, Number(rank) || 0));
  if (screenReasons.length) {
    // An unusable counterexample is not evidence the fix is bad, and it is not
    // evidence the fix is good either - but a reviewer that answers with code
    // we refuse to run has failed to support its accusation, so a rank-2
    // accusation drops to a concern rather than standing unexamined.
    return {
      rank: Math.min(start, 1),
      note: "counterexample not run - " + screenReasons.join(", "),
    };
  }
  if (!verdict || verdict.established == null) {
    return {
      rank: Math.min(start, 1),
      note: "counterexample inconclusive - " + (verdict?.why ?? "no result"),
    };
  }
  if (verdict.established === true) {
    return { rank: 2, note: "counterexample established - " + verdict.why };
  }
  return { rank: Math.min(start, 1), note: "counterexample did not hold - " + verdict.why };
}
