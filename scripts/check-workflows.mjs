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

/**
 * Every `${{ }}` left inside a `run:` block.
 *
 * GitHub does not pass these to the shell as values. It pastes them into the
 * script before any shell exists, so whatever the expression holds becomes part
 * of the program. One of the values pasted into this repository's benchmark was
 * a summary written by a language model:
 *
 *   syntax error near unexpected token `('
 *
 * An apostrophe in "the agent didn't change any files (22 turns)" closed the
 * quote and the rest of the sentence ran as shell. That cost two legs of a
 * benchmark, and it is the harmless version - the same hole runs whatever the
 * text says, on a runner holding the repository's token. Fixed once in `ad01240`
 * for that one value, which left every other one in place.
 *
 * The fix is always the same and it is mechanical: bind the expression under
 * `env:` and use `$NAME` in the script. The shell then gets a value, not a
 * program. A command that really is a command - `$TEST_COMMAND` - still works,
 * because the shell splits it into words itself, at the point where it is
 * allowed to.
 *
 * No allowlist. "Trusted enough" is a judgement, and this rule exists because
 * judgement is what missed twenty-odd of these; the mechanical version has no
 * cases to argue about. It also costs nothing: `${{ }}` outside a run: block -
 * in `env:`, `with:`, `if:`, `working-directory:` - is untouched and is where
 * they all belong.
 *
 * Crude on purpose, like inlineNodeBlocks: a `run:` key with a value, then every
 * more-indented line under it.
 */
export function shellInterpolations(text) {
  const out = [];
  const lines = String(text || "").split("\n");
  let runIndent = null;
  lines.forEach((raw, i) => {
    const line = raw.replace(/\r$/, "");
    const indent = line.search(/\S/);
    // A blank line inside a block scalar does not end it; a less-indented key does.
    if (runIndent !== null && indent >= 0 && indent <= runIndent) runIndent = null;
    // `- run: ...` is the same key with the sequence dash in front of it.
    const m = runIndent === null ? /^(\s*(?:-\s+)?)run:[ \t]*(\S.*)?$/.exec(line) : null;
    let body = null;
    if (m) {
      // `run:` with nothing after it is not a step. `jobs.run:` is a job named
      // "run", and this repository has one.
      if (!m[2]) return;
      runIndent = m[1].length;
      body = m[2];
    } else if (runIndent !== null) {
      body = line;
    }
    if (body === null) return;
    for (const hit of body.matchAll(/\$\{\{([^}]*)\}\}/g)) out.push({ line: i + 1, expr: hit[1].trim() });
  });
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
  let spliced = 0;
  for (const f of files) {
    const text = fs.readFileSync(f, "utf8");
    for (const b of inlineNodeBlocks(text)) {
      bad++;
      console.error(
        f + ":" + b.line + "  " + b.lines + " lines of JavaScript inline  (" + b.preview + "...)"
      );
    }
    for (const s of shellInterpolations(text)) {
      spliced++;
      console.error(f + ":" + s.line + "  ${{ " + s.expr + " }} pasted into a run: block");
    }
  }
  if (spliced > 0) {
    console.error(
      "\n" + spliced + " expression(s) pasted into a run: block.\n" +
        "GitHub does not pass these to the shell as values - it writes them into the\n" +
        "script before the shell exists, so the value becomes program text. Bind each\n" +
        "one under env: and use $NAME instead. A model-written summary already did this\n" +
        "here once: an apostrophe closed the quote and the rest of the sentence ran as\n" +
        "shell, on a runner holding the repository's token."
    );
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
  if (spliced > 0) process.exit(1);
  console.log("workflows: no logic buried in a run: block, no ${{ }} pasted into one");
}
