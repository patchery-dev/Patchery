#!/usr/bin/env node
/**
 * Refuses logic buried in a workflow's `run:` block.
 *
 * This exists because of a pattern, not a principle. Over one night of building
 * the benchmark pipeline, every failure came from JavaScript embedded in YAML,
 * and nothing with a test in `scripts/` misbehaved once:
 *
 *   `">=22.0.0"` parsed as bare digits installed Node 0.12.18, and the error
 *   surfaced three steps later inside corepack, naming nothing.
 *
 *   Backslashes in a regex were eaten twice on the way through a shell heredoc
 *   into a template literal, so `\/` became `/` and the pattern silently matched
 *   the wrong thing.
 *
 *   A `??` in a result-writing script ran on the candidate's Node 12 and failed
 *   to parse, so three benchmark cases finished with no result at all.
 *
 * None of them were hard problems. All of them were invisible: YAML has no
 * syntax check for the code inside a string, no test can reach it, and the
 * failure always appears somewhere else. A script has all three.
 *
 * So: a `node -e` or `node -p` longer than a few lines has to move to a file.
 * Short one-liners are fine - the rule is about logic, not about shelling out.
 */

import fs from "node:fs";
import path from "node:path";

const MAX_INLINE_LINES = 3;

/**
 * Every inline `node -e` / `node -p` in a file, with how many lines it spans.
 *
 * Deliberately crude: it counts from the flag to the closing quote of the same
 * kind. A miscount only changes which side of the threshold something lands on,
 * and the fix for either answer is the same - put it in a script.
 */
export function inlineNodeBlocks(text) {
  const out = [];
  const src = String(text || "");
  const re = /node\s+-[ep]\s+(["'])/g;
  for (const m of src.matchAll(re)) {
    const quote = m[1];
    const start = m.index + m[0].length;
    let end = src.indexOf(quote, start);
    if (end < 0) end = src.length;
    const body = src.slice(start, end);
    const lines = body.split("\n").length;
    if (lines > MAX_INLINE_LINES) {
      out.push({
        line: src.slice(0, m.index).split("\n").length,
        lines,
        preview: body.trim().split("\n")[0].slice(0, 60),
      });
    }
  }
  return out;
}

const isMain = process.argv[1] && process.argv[1].endsWith("check-workflows.mjs");
if (isMain) {
  const files = [];
  const wf = ".github/workflows";
  try {
    for (const f of fs.readdirSync(wf)) if (/\.ya?ml$/i.test(f)) files.push(path.join(wf, f));
  } catch {
    // No workflows here; nothing to check.
  }
  if (fs.existsSync("action.yml")) files.push("action.yml");

  let bad = 0;
  for (const f of files) {
    for (const b of inlineNodeBlocks(fs.readFileSync(f, "utf8"))) {
      bad++;
      console.error(
        f + ":" + b.line + "  " + b.lines + " lines of JavaScript inline  (" + b.preview + "...)"
      );
    }
  }
  if (bad > 0) {
    console.error(
      "\n" + bad + " inline block(s) over " + MAX_INLINE_LINES + " lines.\n" +
        "Move each into scripts/ and give it a test. Every failure in this pipeline so far\n" +
        "has come from logic in a run: block, and none from a script with a test - YAML has\n" +
        "no syntax check for the code inside a string, and the failure always surfaces\n" +
        "somewhere else."
    );
    process.exit(1);
  }
  console.log("workflows: no logic buried in a run: block");
}
