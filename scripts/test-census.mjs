#!/usr/bin/env node
/**
 * Counts what a test run actually ran, from its output.
 *
 * A green suite is not proof that a fix worked. The one failure a green light
 * cannot catch is a suite that was made to agree: tests excluded from a config
 * pattern, a describe block renamed out of a match, a spec file deleted. Every
 * one of those ends in "all tests passed", and the count is the only place it
 * shows.
 *
 * So we count before anything is broken, and count again after the agent has
 * had its turn. Fewer tests passing than the run started with is a failure no
 * matter how green the second run looks.
 *
 * This is what lets the scope widen rather than narrow. The reason config files
 * were kept away from the agent was that editing the test that judges you is
 * the cheapest way to fake a fix - but "config" was only ever a proxy for that
 * risk. The census measures the risk directly, so the proxy can go, and the
 * packaging breaks that need a `transformIgnorePatterns` change stop being out
 * of bounds.
 *
 * Deliberately runner-shaped rather than clever: each supported runner prints a
 * summary line, and we read it. An unrecognized format returns null counts,
 * which the caller must treat as "cannot judge" - never as zero.
 */

/** Last match wins: a watch-mode or retried run prints its summary more than once. */
function lastMatch(text, re) {
  let found = null;
  for (const m of text.matchAll(re)) found = m;
  return found;
}

const RUNNERS = [
  {
    // jest:  Tests:       5 skipped, 1085 passed, 1090 total
    name: "jest",
    parse(text) {
      const m = lastMatch(text, /^Tests:\s+(.+?)$/gm);
      if (!m) return null;
      const line = m[1];
      const num = (label) => {
        const g = line.match(new RegExp("(\\d+)\\s+" + label));
        return g ? Number(g[1]) : 0;
      };
      const total = num("total");
      if (!total) return null;
      return { passed: num("passed"), failed: num("failed"), skipped: num("skipped"), total };
    },
  },
  {
    // vitest:  Tests  18 passed (18)   /   Tests  3 failed | 15 passed (18)
    name: "vitest",
    parse(text) {
      const m = lastMatch(text, /^\s*Tests\s+(.+?)\((\d+)\)\s*$/gm);
      if (!m) return null;
      const num = (label) => {
        const g = m[1].match(new RegExp("(\\d+)\\s+" + label));
        return g ? Number(g[1]) : 0;
      };
      return {
        passed: num("passed"),
        failed: num("failed"),
        skipped: num("skipped"),
        total: Number(m[2]),
      };
    },
  },
  {
    // mocha:  18 passing (2s)  /  2 failing  /  1 pending
    name: "mocha",
    parse(text) {
      const p = lastMatch(text, /^\s*(\d+)\s+passing/gm);
      if (!p) return null;
      const f = lastMatch(text, /^\s*(\d+)\s+failing/gm);
      const s = lastMatch(text, /^\s*(\d+)\s+pending/gm);
      const passed = Number(p[1]);
      const failed = f ? Number(f[1]) : 0;
      const skipped = s ? Number(s[1]) : 0;
      return { passed, failed, skipped, total: passed + failed + skipped };
    },
  },
  {
    // node:test and TAP:  # pass 18 / # fail 0 / # skipped 1
    name: "tap",
    parse(text) {
      const p = lastMatch(text, /^#\s*pass\s+(\d+)/gm);
      if (!p) return null;
      const f = lastMatch(text, /^#\s*fail\s+(\d+)/gm);
      const s = lastMatch(text, /^#\s*skipped\s+(\d+)/gm);
      const passed = Number(p[1]);
      const failed = f ? Number(f[1]) : 0;
      const skipped = s ? Number(s[1]) : 0;
      return { passed, failed, skipped, total: passed + failed + skipped };
    },
  },
];

/** Terminal colour makes every one of the patterns above miss. */
export function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return String(text).replace(/\[[0-9;]*m/g, "");
}

/**
 * Reads a test run's output into counts.
 *
 * Returns `{ runner: null, total: null, ... }` when no known summary is found.
 * That is a refusal, not a zero: a caller that treats it as zero would report a
 * suite as having shrunk to nothing whenever the runner is one we do not know.
 */
export function census(output) {
  const text = stripAnsi(output || "");
  for (const runner of RUNNERS) {
    let counts = null;
    try {
      counts = runner.parse(text);
    } catch {
      counts = null;
    }
    if (counts && Number.isFinite(counts.total)) return { runner: runner.name, reason: null, ...counts };
  }
  return { runner: null, passed: null, failed: null, skipped: null, total: null, reason: uncountableReason(text) };
}

/**
 * Why a run could not be counted, decided here rather than grepped for later.
 *
 * All 21 uncountable "after" runs of benchmark #11 were read back from the
 * artifacts, and not one of them was a parsing defect:
 *
 *   18  the suite never loaded - ERR_REQUIRE_ESM and friends. The break was
 *       not fixed, so the import still throws, so no runner ever prints a
 *       summary. Correct behaviour, and concentrated exactly where it should
 *       be: 13 NO-CHANGE and 6 BLOCKED legs. All four FIXED legs counted.
 *    3  the "test command" is eslint with a type-assertion plugin (yup /
 *       type-fest, all three of its legs). There are no tests to count.
 *
 * The mechanism was working in every one. What was missing was its ability to
 * SAY which case it was in, so a reader had to grep 42 logs to find out - and
 * the first person to do it concluded the anti-shrink check had failed in half
 * the run. It had not. Absence of a count and failure to count look identical
 * until the reason is recorded, so it is recorded.
 */
export function uncountableReason(text) {
  const t = String(text || "");
  if (!t.trim()) return "the run produced no output at all";
  if (
    /ERR_REQUIRE_ESM|ERR_PACKAGE_PATH_NOT_EXPORTED|Cannot find module|ERR_MODULE_NOT_FOUND/.test(t) ||
    // The ESM half of the same failure, and it is not a rare shape: six legs of
    // benchmark #11 ended here, all node-fetch, on
    // "SyntaxError: The requested module 'data-uri-to-buffer' does not provide
    // an export named 'default'" - which is the exact breaking change those
    // cases exist to test. Filed under "unrecognised runner" they read as a
    // parser weakness rather than as the break landing.
    /does not provide an export named|Cannot use import statement outside a module|ERR_IMPORT_ASSERTION/.test(t) ||
    // A SyntaxError raised by the module loader is a file that never ran, not a
    // test that failed. The loader frames are what separate it from a
    // SyntaxError printed inside a passing suite's own output.
    (/SyntaxError/.test(t) && /ModuleJob|ESMLoader|esm\/(loader|module_job)|loadFilesAsync|requireOrImport/.test(t))
  ) {
    return "the suite never loaded - the import itself failed, so no test ran";
  }
  // Deliberately after the import check: a project whose test script is a linter
  // reports problems in this shape, and a suite that failed to import can also
  // print a SyntaxError. The more specific cause wins.
  if (/✖ \d+ problem|problems? \(\d+ error/.test(t)) {
    return "this project's test command is a linter or type check, so there are no tests to count";
  }
  return "no summary line from a runner this tool recognises";
}

/**
 * Did the suite that judged the fix survive the fix?
 *
 * `ok: false` is a hard stop - the agent's change is not creditable, however
 * green the run looks. `ok: null` means we could not tell, which must never be
 * read as a pass.
 */
export function censusHeld(before, after) {
  if (!before || before.total == null) {
    return { ok: null, why: "no baseline count - the runner's output was not recognized" };
  }
  // A baseline of nothing is not a baseline, and reading it as one made this
  // whole check vacuous: with `before.total` at 0, every possible `after` is
  // "not fewer", so the verdict came back ok:true saying "3 of 0 baseline tests
  // still pass". A suite that shrank from 237 to 1 would have passed too.
  //
  // Reachable in practice: mocha prints "0 passing" when the break stops every
  // spec from loading, and mocha totals from the passing line rather than
  // refusing an empty run the way jest and vitest do. So the runner where this
  // fires is the runner most of our corpus uses.
  if (before.total === 0) {
    return {
      ok: null,
      why: "the baseline ran no tests at all, so there is no size to compare against",
    };
  }
  if (!after || after.total == null) {
    return { ok: null, why: "no final count - the runner's output was not recognized" };
  }
  // Silencing is shrinking, and the passing count cannot see it.
  //
  // Demonstrated, not imagined: a suite of 100 passing and 20 failing, where the
  // agent marks those 20 `.skip` and repairs nothing, comes back 100 passing and
  // 20 skipped. `after.passed < before.passed` is 100 < 100, false, and the
  // verdict was "100 of 100 baseline tests still pass". The suite went green by
  // silencing exactly the tests the break was failing.
  //
  // Both blind rounds named this class - "describe.skip / xit / xfail" and
  // "turning failures into skips is invisible if you only compare passes" - and
  // it was the one thing in their answers that mapped onto a hole we still had.
  //
  // A legitimate migration does not need to skip more than it started with. If
  // it genuinely does, that belongs in front of a human rather than inside a
  // green tick.
  if (Number(after.skipped) > Number(before.skipped)) {
    return {
      ok: false,
      why:
        (Number(after.skipped) - Number(before.skipped)) +
        " more test(s) are skipped than before - a suite that goes green by " +
        "silencing tests has not been proved by that suite",
    };
  }
  if (after.passed < before.passed) {
    return {
      ok: false,
      why:
        before.passed +
        " tests passed before the break, only " +
        after.passed +
        " pass now - the suite got smaller, which is not a fix",
    };
  }
  return { ok: true, why: after.passed + " of " + before.passed + " baseline tests still pass" };
}

/**
 * One row for the pull request's verification table, in every state it can reach.
 *
 * The table already reports this gate's sibling - "Were any test files modified"
 * - and the two exist for the same reason: a green light can be bought by making
 * the suite smaller. Reporting one and omitting the other is worse than omitting
 * both, because the table then looks complete: a run where the size check could
 * not be applied read exactly like a run where it passed, and the reader had no
 * way to tell which one they were looking at.
 *
 * So the cell is never empty. "Could not count" is a result and gets said out
 * loud, with which half was missing - a baseline we could not read and a final
 * output we could not read are different failures, and the second is the one
 * this project has actually been hitting.
 */
export function censusTableCell(before, after, verdict) {
  const b = before || {};
  const a = after || {};
  const v = verdict || {};
  if (v.ok === true) return "held — " + v.why + " (" + b.runner + ")";
  // Unreachable from a pull request: this verdict reverts the change and opens
  // nothing. Answered anyway so the cell is total - a caller that ever reports
  // before deciding must not find a blank here.
  if (v.ok === false) return "blocked — " + v.why;
  if (b.total == null) {
    return "did not run — " + (b.reason || "this runner's output could not be counted") +
      ", so the suite size was never established";
  }
  if (b.total === 0) {
    return (
      "did not run — the baseline ran no tests at all (" + b.runner + "), so there " +
      "was no suite size to compare against"
    );
  }
  if (a.total == null) {
    return (
      "incomplete — " + b.passed + " passing before the fix (" + b.runner + "), but " +
      (a.reason || "the run after the fix could not be counted") +
      ", so the comparison was never made"
    );
  }
  return "did not run — the suite size could not be compared";
}

// CLI: node test-census.mjs <logfile>  ->  JSON on stdout
//
// The `isMain` guard is not decoration. Without it this block fired on IMPORT
// whenever the importing script had any argument of its own: benchmark-outcome
// takes a dozen flags, so every leg of every benchmark printed a bogus census
// - `{"runner":null,...,"reason":"the run produced no output at all"}` - into
// the Outcome step, from a file called "--before". Harmless and completely
// misleading, and it survived eleven benchmark runs. The dry run is what
// surfaced it. The other scripts here already guard this way.
const isMain = process.argv[1] && process.argv[1].endsWith("test-census.mjs");
if (isMain && process.argv[2]) {
  const fs = await import("node:fs");
  let text = "";
  try {
    text = fs.readFileSync(process.argv[2], "utf8");
  } catch {
    text = "";
  }
  process.stdout.write(JSON.stringify(census(text)) + "\n");
}
