#!/usr/bin/env node
/**
 * Reads a failing test run and says what kind of break it is.
 *
 * The agent spent thirteen minutes on express working out that
 * `content-disposition@3` publishes only the new module format while
 * `lib/response.js` still loads it the old way. Node had said exactly that, in
 * the first line of the failure, before the agent was even started:
 *
 *   Error [ERR_REQUIRE_ESM]: require() of ES Module .../dist/index.js
 *   from .../lib/response.js not supported.
 *
 * Those codes are Node's own and they do not move. Matching them is not a
 * judgement call, so it does not belong to a model: everything moved from a
 * model into plain code in this project has been free, instant and correct,
 * and everything left to a model has cost money or been wrong at least once.
 *
 * What this produces is a BRIEFING, not a gate. It never stops the agent - it
 * tells it what the failure already says, so its turns go on solving rather
 * than on rediscovering. A classifier that refuses work would be our guess
 * wearing the costume of a finding, which is the exact mistake this project
 * has made repeatedly.
 *
 * `inScope` is advisory in the same way. It answers "is this the kind of break
 * Patchery claims to fix" so the benchmark can report the classes separately -
 * a rate that mixes call-site migrations with build configuration is two
 * numbers crushed into one.
 */

/** Terminal colour breaks every pattern below. */
export function stripAnsi(text) {
  return String(text || "").replace(/\[[0-9;]*m/g, "");
}

/**
 * Ordered: the first match wins, and the order is the order in which one
 * failure hides another. A module that will not load at all reports itself
 * before any call inside it can fail, so loading problems are asked about
 * first - which is also why classification has to be repeated after every
 * fix, rather than decided once.
 */
const KINDS = [
  {
    kind: "esm-require",
    inScope: "partial",
    test: /ERR_REQUIRE_ESM|require\(\) of ES Module/,
    what: "the package now ships only as an ES module, and the code still loads it the old way",
    // Written as a boundary, not a recipe. Given the two options and nothing
    // else, the agent on express spent its budget building a third one: it
    // transcribed the dependency's source into the project. That compiles, and
    // no maintainer would take it - it forks a dependency to avoid a version
    // decision that is theirs to make.
    strategy:
      "Nothing was renamed - the import mechanism is what broke, so do not go looking for a changed " +
      "signature. There are exactly two legitimate fixes. One: convert the call site to a dynamic " +
      "import(), which is only possible if the surrounding function can become async without changing " +
      "its public behaviour. Two: adjust the build or test configuration so the dependency is " +
      "transformed for this project. " +
      "If neither applies - a synchronous public API that cannot become async, and no build step to " +
      "adjust - then this break cannot be fixed at the call site. Stop editing, and write the " +
      "recommendation instead: name which call sites are affected, why an async conversion would change " +
      "the project's public behaviour, and which of the two decisions would unblock it - raising the " +
      "project's minimum runtime, or replacing the dependency - with what you checked to be sure. " +
      "That report is the deliverable; it is not a failure to produce it. " +
      "Do NOT copy the dependency's source into this project, do not re-implement it, and do not pin " +
      "the old version. Those three are the same evasion in different clothes, and each hides a " +
      "decision that belongs to whoever maintains this repository.",
  },
  {
    kind: "exports-blocked",
    inScope: true,
    test: /ERR_PACKAGE_PATH_NOT_EXPORTED|is not exported from package/,
    what: "the package stopped exposing the exact file the code reaches into",
    strategy:
      "A deep path into the package is no longer published. Find what the package's entry point exports " +
      "now and reach the same value through it. Do not add a path back by editing node_modules.",
  },
  {
    kind: "missing-module",
    inScope: true,
    test: /Cannot find module|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND/,
    what: "something the code imports is not there any more",
    strategy:
      "Usually the package was split and the piece moved to its own name, or a submodule was removed. " +
      "Check the changelog for a rename or a split before assuming the install is broken.",
  },
  {
    kind: "engine",
    inScope: false,
    test: /EBADENGINE|Unsupported engine|requires Node\.js version/,
    what: "the new version of the package needs a newer Node than this project runs on",
    strategy:
      "This is not a code break, and no edit to any call site changes which Node the project runs on. " +
      "Do not work around it - a polyfill, a vendored copy or a pinned old version all disguise the same " +
      "unmade decision. Stop editing and write the recommendation: which version the package requires, " +
      "which one this project declares, where that declaration lives, and what else would have to move " +
      "with it. Raising the minimum runtime breaks the project's own users, so it is the maintainers' " +
      "call - but they should get the finished analysis, not a shrug.",
  },
  {
    kind: "not-a-function",
    inScope: true,
    test: /is not a function|is not a constructor/,
    what: "something the code calls no longer exists under that name, or is no longer callable that way",
    strategy:
      "This is the ordinary migration case. Find the new name or the new shape in the changelog and " +
      "update every call site, including the ones the failing test does not reach.",
  },
  {
    kind: "shape-change",
    inScope: true,
    // `propert(y|ies)` is followed directly by " of" in Node's own wording, so
    // the middle has to be allowed to be empty - " .* of" quietly demands two
    // spaces and matches nothing real.
    test: /Cannot read propert(?:y|ies)[^\n]*? of (?:undefined|null)|Cannot destructure/,
    what: "the value the package returns has a different shape than the code expects",
    strategy:
      "The call still works but gives back something else - a promise instead of a value, an object " +
      "instead of an array, a named export instead of a default. Read what the new version returns " +
      "before changing anything.",
  },
  {
    kind: "type-error",
    inScope: true,
    test: /\bTS\d{4}\b|error TS\d/,
    what: "the types no longer line up",
    strategy:
      "The signature changed. Follow the compiler to every call site rather than silencing it; a cast " +
      "that hides the error ships the break.",
  },
];

/**
 * Returns `{ kind, inScope, what, strategy, evidence }`, or a null-kind result
 * when nothing matched.
 *
 * A null kind is a refusal to guess, not a verdict of "fine". The caller hands
 * the agent no briefing at all in that case, which is exactly where it was
 * before this existed - never worse.
 */
export function classifyFailure(output) {
  const text = stripAnsi(output);
  for (const k of KINDS) {
    const line = text.split(/\r?\n/).find((l) => k.test.test(l));
    if (line) {
      return {
        kind: k.kind,
        inScope: k.inScope,
        what: k.what,
        strategy: k.strategy,
        evidence: line.trim().slice(0, 300),
      };
    }
  }
  return { kind: null, inScope: null, what: null, strategy: null, evidence: null };
}

/**
 * The briefing as the agent receives it. Deliberately short: it says what Node
 * already said and where not to look, and nothing else. Anything longer starts
 * competing with the changelog the agent is supposed to read.
 */
export function briefing(classification) {
  if (!classification || !classification.kind) return "";
  return [
    "The test failure has already been classified mechanically, from the runner's own error code.",
    "",
    "Kind: " + classification.kind,
    "What it means: " + classification.what,
    "Evidence: " + classification.evidence,
    "",
    "How to approach it: " + classification.strategy,
    "",
    "This classification is advisory. If the code contradicts it, believe the code and say so.",
  ].join("\n");
}

const isMain = process.argv[1] && process.argv[1].endsWith("classify-break.mjs");
if (isMain) {
  const fs = await import("node:fs");
  let text = "";
  try {
    text = fs.readFileSync(process.argv[2], "utf8");
  } catch {
    text = "";
  }
  const c = classifyFailure(text);
  process.stdout.write(JSON.stringify(c) + "\n");
  if (c.kind) process.stderr.write(c.kind + ": " + c.what + "\n");
}
