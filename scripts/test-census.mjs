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
    if (counts && Number.isFinite(counts.total)) return { runner: runner.name, ...counts };
  }
  return { runner: null, passed: null, failed: null, skipped: null, total: null };
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
  if (!after || after.total == null) {
    return { ok: null, why: "no final count - the runner's output was not recognized" };
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

// CLI: node test-census.mjs <logfile>  ->  JSON on stdout
if (process.argv[2]) {
  const fs = await import("node:fs");
  let text = "";
  try {
    text = fs.readFileSync(process.argv[2], "utf8");
  } catch {
    text = "";
  }
  process.stdout.write(JSON.stringify(census(text)) + "\n");
}
