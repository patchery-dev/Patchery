/**
 * Offline self-test: proves the safety guard (guard.mjs) behaves correctly.
 * Run: node scripts/selftest.mjs
 *
 * This is the most critical part of the product — it is what catches an agent
 * that tries to turn the build green by deleting tests. It needs no API key,
 * so it can run on every push.
 */

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { census, censusHeld, censusTableCell } from "./test-census.mjs";
import { findInstalled } from "./installed-version.mjs";
import {
  decideNodeVersion,
  lowestMajor,
  fromNvmrc,
  ciNodeVersions,
  usableCiMajor,
  ourNodeReason,
  OUR_NODE_FLOOR,
  OLDEST_USABLE,
  FALLBACK,
} from "./node-version.mjs";
import { classifyFailure, briefing, normalizeBriefing } from "./classify-break.mjs";
import { goldenVerdict, renderGolden } from "./golden-verdict.mjs";
import { classifyRequest, turnMessage, streamFrames, routeOf } from "./control-stub.mjs";
import { scriptFor } from "./control-run.mjs";
import {
  publicNames,
  surfaceDiff,
  reexportTarget,
  surfaceText,
  packageMemberUse,
  upgradeSurfaceReport,
  renderSurfaceReport,
  entryPath,
  deprecatedNames,
} from "./surface-diff.mjs";
import { bumpFromTitle, isMajorMove, sentinelVerdict, renderSentinel } from "./sentinel.mjs";
import { testScriptUsable, projectKind, parseRepoLine, isProductWorkspace, capBumps } from "./find-bumps.mjs";
import { pendingMajors, renderScan, importSites, withImpact } from "./scan-deps.mjs";
import { knownGuardReasons, documentedOutcomes, emittedOutcomes, gateCensus, renderCensus } from "./gate-census.mjs";
import { poolShape, renderShape } from "./pool-summary.mjs";
import {
  counterexampleReasons,
  differentialVerdict,
  applyCounterexample,
  attemptPolicy,
} from "./counterexample.mjs";
import { benchmarkOutcome, parseArgs, renderOutcome } from "./benchmark-outcome.mjs";
import { inlineNodeBlocks, shellInterpolations } from "./check-workflows.mjs";
import {
  taglineCore,
  taglineSurfaces,
  taglineDrift,
  statedCheckCount,
  reportedCheckCount,
  releaseTagWarnings,
} from "./check-claims.mjs";
import { planBatch } from "./batch-plan.mjs";
import {
  sortRows,
  renderReport,
  guardCaught,
  guardVisible,
  objectedFixes,
  repeatGroups,
  byBreakClass,
  hasRepeats,
} from "./batch-report.mjs";
import {
  chooseTargetDir,
  workspacesDeclaring,
  repoPathsInOutput,
  ownerOf,
  normDir,
} from "./target-dir.mjs";
import {
  protectedReason,
  isHarnessConfig,
  harnessConfigReason,
  parsePorcelain,
  parsePorcelainEntries,
  outOfScopeReason,
  parsePathList,
  testCommandLooksUnavailable,
  looksLikeDependencyConflict,
  redactSecrets,
  createStallDetector,
  baselinePassedMessage,
  toolEvidence,
  canonicalCommand,
  bashLooksMutating,
  stallVerdict,
  normalizeVerifyMode,
  normalizeVerifyTools,
  reviewPassPlan,
  tokenTotals,
  renderSpend,
  agentFinishedLine,
  dependencyMisuseReasons,
  callSiteScan,
  callSiteNote,
  packageBindings,
  failureChanged,
  failureSignature,
  packagesNamedIn,
  chainedFailureMessage,
  normalizeModelTimeout,
  normalizeRunBudget,
  budgetDelayMs,
  timeoutReason,
  budgetReason,
  deadlineOutcome,
  patchNote,
  untrackedHunk,
  budgetUsage,
  budgetUsageLine,
  gapStats,
  gapStatsLine,
  candidateRecord,
  candidateOutputs,
  CANDIDATE_EXITS,
  harnessCrash,
  confidenceThresholdReport,
  shouldReview,
  truncateEvidence,
  buildReviewEvidence,
  parseReview,
  reviewOutcome,
  renderReviewSection,
  REVIEW_CHECKS,
  scriptsTamperReason,
  actionableConcerns,
  buildRepairPrompt,
  detectExtraChecks,
  extraCheckRegressions,
  buildDiagnosis,
  proofLevel,
  proofBanner,
} from "./guard.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let pass = 0;
const check = (name, fn) => {
  fn();
  pass++;
  console.log("  ok  " + name);
};

console.log("\nguard.protectedReason - must be BLOCKED");
for (const p of [
  "src/app.test.js",
  "src/app.spec.ts",
  "packages/x/src/foo.test.tsx",
  "test/helper.js",
  "tests/helper.js",
  "src/__tests__/foo.js",
  "src/__mocks__/foo.js",
  // A snapshot IS the assertion, and jest/vitest put it beside the test file by
  // default - src/__snapshots__/, not under __tests__/ - which is exactly the
  // layout the two rules above miss. `npx jest -u` rewrites every failing
  // expectation to match whatever the code now does, and nothing downstream
  // notices: the census only refuses a suite that got SMALLER, and rewriting
  // snapshots makes more tests pass.
  "src/__snapshots__/Button.test.js.snap",
  "src/components/__snapshots__/App.test.tsx.snap",
  "__snapshots__/a.snap",
  "node_modules/fake-lib/index.js",
  "test-fixture/node_modules/fake-lib/index.js",
  ".github/workflows/patchery-demo.yml",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]) {
  check(p, () => assert.ok(protectedReason(p), p + " should have been blocked"));
}

console.log("\nguard.protectedReason - must be ALLOWED");
for (const p of [
  "src/app.js",
  "test-fixture/app.js",
  "packages/core/src/chat_models.ts",
  "lib/latest.js",
  "src/contest.js",
  "README.md",
  // The snapshot rules must key on the extension and the directory, not on the
  // word appearing in a filename. A module that happens to be about snapshots is
  // ordinary source and a migration may legitimately need to edit it.
  "src/snapshot-utils.js",
  "lib/snapshots.ts",
]) {
  check(p, () => assert.strictEqual(protectedReason(p), null, p + " should have been allowed"));
}

console.log("\nguard.protectedReason - Windows backslashes");
check("src\\app.test.js", () => assert.ok(protectedReason("src\\app.test.js")));

console.log("\nguard.parsePorcelain");
check("empty output -> empty set", () => assert.strictEqual(parsePorcelain("").size, 0));
check("modified + untracked + deleted", () => {
  const s = parsePorcelain(" M src/app.js\n?? new.js\n D gone.js");
  assert.deepStrictEqual([...s].sort(), ["gone.js", "new.js", "src/app.js"]);
});
check("quoted path with a space is unquoted", () => {
  const s = parsePorcelain(' M "src/my file.js"');
  assert.deepStrictEqual([...s], ["src/my file.js"]);
});
// Regression: real git output starts with a space for an unstaged edit. An
// earlier version trimmed the whole output first, so the fixed-width parse ate
// the first character of the path and reported "est-fixture/app.js".
check("unstaged edit keeps its first character", () => {
  const s = parsePorcelain(" M test-fixture/app.js");
  assert.deepStrictEqual([...s], ["test-fixture/app.js"]);
});
check("staged edit (two-column status) parses", () => {
  const s = parsePorcelain("M  test-fixture/app.js");
  assert.deepStrictEqual([...s], ["test-fixture/app.js"]);
});
check("survives a caller that trimmed the leading space", () => {
  const s = parsePorcelain("M test-fixture/app.js");
  assert.deepStrictEqual([...s], ["test-fixture/app.js"]);
});
check("multi-line output where only line 1 lost its space", () => {
  const s = parsePorcelain("M test-fixture/app.js\n?? new.js\n D gone.js");
  assert.deepStrictEqual([...s].sort(), ["gone.js", "new.js", "test-fixture/app.js"]);
});

console.log("\nparsePorcelainEntries - status is kept");
check("unstaged edit", () => {
  const [e] = parsePorcelainEntries(" M src/app.js");
  assert.deepStrictEqual({ path: e.path, deleted: e.deleted }, { path: "src/app.js", deleted: false });
});
check("worktree deletion is flagged", () => {
  const [e] = parsePorcelainEntries(" D docs/index.html");
  assert.deepStrictEqual({ path: e.path, deleted: e.deleted }, { path: "docs/index.html", deleted: true });
});
check("staged deletion is flagged", () => {
  const [e] = parsePorcelainEntries("D  docs/index.html");
  assert.strictEqual(e.deleted, true);
});
check("untracked file is not a deletion", () => {
  const [e] = parsePorcelainEntries("?? new.js");
  assert.strictEqual(e.deleted, false);
});
check("mixed output keeps order and statuses", () => {
  const es = parsePorcelainEntries(" M a.js\n D b.js\n?? c.js");
  assert.deepStrictEqual(
    es.map((e) => e.path + ":" + e.deleted),
    ["a.js:false", "b.js:true", "c.js:false"]
  );
});

console.log("\noutOfScopeReason - the agent stays where it was pointed");
check("inside the target directory is fine", () =>
  assert.strictEqual(outOfScopeReason("packages/api/src/x.js", "packages/api"), null)
);
check("the target directory itself is fine", () =>
  assert.strictEqual(outOfScopeReason("packages/api", "packages/api"), null)
);
// The real incident: target-dir was test-fixture, and a docs/ file was deleted.
check("a file elsewhere in the repo is out of scope", () =>
  assert.match(String(outOfScopeReason("docs/index.html", "test-fixture")), /outside the target directory/)
);
check("an empty target means the whole repo, so nothing is out of scope", () =>
  assert.strictEqual(outOfScopeReason("anywhere/at/all.js", ""), null)
);
check("'.' also means the whole repo (the default)", () =>
  assert.strictEqual(outOfScopeReason("anywhere/at/all.js", "."), null)
);
check("a sibling with a shared prefix is NOT inside", () =>
  assert.match(String(outOfScopeReason("packages/api-v2/x.js", "packages/api")), /outside/)
);
check("allowed-paths lets a specific file through", () =>
  assert.strictEqual(outOfScopeReason("package.json", "packages/api", ["package.json"]), null)
);
check("allowed-paths lets a directory through", () =>
  assert.strictEqual(outOfScopeReason("packages/shared/x.js", "packages/api", ["packages/shared"]), null)
);
check("a /** suffix on an allowed path is accepted", () =>
  assert.strictEqual(outOfScopeReason("packages/shared/x.js", "packages/api", ["packages/shared/**"]), null)
);
check("allowed-paths does not open up everything else", () =>
  assert.match(String(outOfScopeReason("docs/index.html", "packages/api", ["package.json"])), /outside/)
);
check("windows backslashes are handled", () =>
  assert.strictEqual(outOfScopeReason("packages\\api\\src\\x.js", "packages/api"), null)
);

console.log("\nparsePathList");
check("newline separated", () =>
  assert.deepStrictEqual(parsePathList("package.json\npackages/shared"), ["package.json", "packages/shared"])
);
check("comma separated with spaces", () =>
  assert.deepStrictEqual(parsePathList("a.json , b.json"), ["a.json", "b.json"])
);
check("empty input is an empty list", () => assert.deepStrictEqual(parsePathList(""), []));
check("blank lines are dropped", () =>
  assert.deepStrictEqual(parsePathList("a.json\n\n\nb.json\n"), ["a.json", "b.json"])
);

console.log("\ntestCommandLooksUnavailable - the command never ran");
check("npm missing script", () =>
  assert.ok(testCommandLooksUnavailable('npm error Missing script: "test"', 1))
);
check("npm legacy missing script", () =>
  assert.ok(testCommandLooksUnavailable('npm ERR! Missing script: "test"', 1))
);
check("yarn/pnpm unknown script", () =>
  assert.ok(testCommandLooksUnavailable('error Command "test" not found.', 1))
);
check("shell cannot find the binary", () =>
  assert.ok(testCommandLooksUnavailable("bash: vitest: command not found", 127))
);
check("windows shell wording", () =>
  assert.ok(
    testCommandLooksUnavailable("'vitest' is not recognized as an internal or external command", 1)
  )
);
check("exit 127 alone is enough", () => assert.ok(testCommandLooksUnavailable("", 127)));
check("monorepo runner matched nothing", () =>
  assert.ok(testCommandLooksUnavailable("No projects matched the filters", 1))
);
check("a genuine test failure is NOT 'unavailable'", () =>
  assert.strictEqual(
    testCommandLooksUnavailable("AssertionError: expected 'a' to equal 'b'\n1 failing", 1),
    null
  )
);
check("a passing run is NOT 'unavailable'", () =>
  assert.strictEqual(testCommandLooksUnavailable("PASS: app.test.js", 0), null)
);

console.log("\nlooksLikeDependencyConflict");
check("npm ERESOLVE", () =>
  assert.ok(looksLikeDependencyConflict("npm error code ERESOLVE\nunable to resolve dependency tree"))
);
check("pnpm peer dep issues", () => assert.ok(looksLikeDependencyConflict("ERR_PNPM_PEER_DEP_ISSUES")));
check("ordinary test failure is not a conflict", () =>
  assert.strictEqual(looksLikeDependencyConflict("1 test failed"), false)
);

console.log("\nredactSecrets");
check("OpenAI/Anthropic style key", () =>
  assert.strictEqual(
    redactSecrets("key is sk-abcdefghijklmnopqrstuvwxyz123456"),
    "key is [REDACTED]"
  )
);
check("GitHub token", () =>
  assert.ok(!redactSecrets("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789").includes("ABCDEFGH"))
);
check("Google API key", () =>
  assert.ok(!redactSecrets("AIzaSyAbCdEfGhIjKlMnOpQrStUvWxYz012345").includes("AbCdEfGh"))
);
check("Slack token", () =>
  assert.ok(!redactSecrets("xoxb-123456789012-abcdefghijklm").includes("abcdefghijklm"))
);
check("AWS access key id", () =>
  assert.ok(!redactSecrets("AKIAIOSFODNN7EXAMPLE").includes("IOSFODNN7"))
);
check("named assignment keeps the name, hides the value", () =>
  assert.strictEqual(
    redactSecrets('MY_API_KEY="hunter2hunter2"'),
    'MY_API_KEY="[REDACTED]"'
  )
);
check("literal run credential is removed", () =>
  assert.strictEqual(
    redactSecrets("token: abcdefghijklmnop", ["abcdefghijklmnop"]),
    "token: [REDACTED]"
  )
);
check("short extra values are ignored, so a log is not shredded", () =>
  assert.strictEqual(redactSecrets("the cat sat", ["cat"]), "the cat sat")
);
check("ordinary prose is untouched", () =>
  assert.strictEqual(redactSecrets("Fixed formatPrice in app.js"), "Fixed formatPrice in app.js")
);

console.log("\ncreateStallDetector");
check("normal progress does not trip it", () => {
  const d = createStallDetector();
  assert.strictEqual(d.observeTurn([{ name: "Read", input: { file_path: "a.js" } }]), null);
  assert.strictEqual(d.observeTurn([{ name: "Edit", input: { file_path: "a.js" } }]), null);
  assert.strictEqual(d.observeTurn([{ name: "Bash", input: { command: "npm test" } }]), null);
});
check("the same call three times is a stall", () => {
  const d = createStallDetector({ repeats: 3 });
  const call = [{ name: "Bash", input: { command: "npm test" } }];
  assert.strictEqual(d.observeTurn(call), null);
  assert.strictEqual(d.observeTurn(call), null);
  assert.match(String(d.observeTurn(call)), /repeated 3 times/);
});
check("different arguments are not a repeat", () => {
  const d = createStallDetector({ repeats: 3 });
  assert.strictEqual(d.observeTurn([{ name: "Read", input: { file_path: "a.js" } }]), null);
  assert.strictEqual(d.observeTurn([{ name: "Read", input: { file_path: "b.js" } }]), null);
  assert.strictEqual(d.observeTurn([{ name: "Read", input: { file_path: "c.js" } }]), null);
});
// Regression for the real SocratiCode run: 25 turns of investigation, no edits,
// no output, $0.88 spent.
check("many turns with no edit is a stall", () => {
  const d = createStallDetector({ repeats: 99, noEditTurns: 4 });
  let last = null;
  for (let i = 0; i < 4; i++) last = d.observeTurn([{ name: "Read", input: { file_path: "f" + i } }]);
  assert.match(String(last), /turns in a row/);
});
check("an edit resets the no-edit counter", () => {
  const d = createStallDetector({ repeats: 99, noEditTurns: 3 });
  d.observeTurn([{ name: "Read", input: { file_path: "a" } }]);
  d.observeTurn([{ name: "Read", input: { file_path: "b" } }]);
  d.observeTurn([{ name: "Edit", input: { file_path: "c" } }]);
  assert.strictEqual(d.observeTurn([{ name: "Read", input: { file_path: "d" } }]), null);
});
check("a text-only turn is not evidence of a stall", () => {
  const d = createStallDetector({ repeats: 99, noEditTurns: 2 });
  assert.strictEqual(d.observeTurn([]), null);
  assert.strictEqual(d.observeTurn([]), null);
  assert.strictEqual(d.observeTurn([]), null);
});

// --------------------------------------------------------------------------
// Stall detection: is the agent looping, or is it working?
// --------------------------------------------------------------------------

const read = (f, o) => ({ name: "Read", input: o == null ? { file_path: f } : { file_path: f, offset: o } });
const grep = (p, path) => ({ name: "Grep", input: { pattern: p, path } });
const bash = (c) => ({ name: "Bash", input: { command: c } });
const edit = (f, s) => ({ name: "Edit", input: { file_path: f, old_string: s ?? "a", new_string: "b" } });

console.log("\ncanonicalCommand / bashLooksMutating");
check("whitespace, trailing semicolon and a leading cd all collapse", () => {
  assert.strictEqual(canonicalCommand("npm  test "), "npm test");
  assert.strictEqual(canonicalCommand("npm test;"), "npm test");
  assert.strictEqual(canonicalCommand("cd /w && npm test"), "npm test");
});
check("different commands stay different", () =>
  assert.notStrictEqual(canonicalCommand("grep -r foo"), canonicalCommand("grep -rn foo"))
);
check("sed -i is a mutation", () => assert.ok(bashLooksMutating("sed -i s/a/b/ src/x.js")));
check("a redirect into a file is a mutation", () => assert.ok(bashLooksMutating("echo hi > src/x.js")));
check("a redirect to /dev/null is not", () => assert.ok(!bashLooksMutating("echo hi > /dev/null")));
check("reading is not a mutation", () => {
  assert.ok(!bashLooksMutating("grep -i foo src"));
  assert.ok(!bashLooksMutating("npm test"));
});

console.log("\ntoolEvidence - two calls that see the same thing get the same key");
check("an absolute path and a relative one are one file", () =>
  assert.deepStrictEqual(
    toolEvidence(read("/w/src/a.js"), "/w").keys,
    toolEvidence(read("src/a.js"), "/w").keys
  )
);
check("windows backslashes normalise like everything else", () =>
  assert.deepStrictEqual(toolEvidence(read("src\\a.js")).keys, toolEvidence(read("src/a.js")).keys)
);
check("a different offset is a different part of the file", () =>
  assert.notDeepStrictEqual(toolEvidence(read("a.js", 0)).keys, toolEvidence(read("a.js", 200)).keys)
);
check("`cat a.js` and `Read a.js` are one discovery", () =>
  assert.deepStrictEqual(toolEvidence(bash("cat src/a.js")).keys, toolEvidence(read("src/a.js")).keys)
);
check("`head -50 f` and `head -100 f` are one discovery", () =>
  assert.deepStrictEqual(
    toolEvidence(bash("head -50 CHANGELOG.md")).keys,
    toolEvidence(bash("head -100 CHANGELOG.md")).keys
  )
);
check("the same grep shown differently is the same question", () =>
  assert.deepStrictEqual(
    toolEvidence({ name: "Grep", input: { pattern: "x", path: "src", output_mode: "content" } }).keys,
    toolEvidence({ name: "Grep", input: { pattern: "x", path: "src", output_mode: "files_with_matches" } }).keys
  )
);
check("a different pattern is a different question", () =>
  assert.notDeepStrictEqual(toolEvidence(grep("a", "src")).keys, toolEvidence(grep("b", "src")).keys)
);
check("an edit reports what it wrote", () => {
  const e = toolEvidence(edit("src/a.js"));
  assert.deepStrictEqual(e.writes, ["src/a.js"]);
  assert.strictEqual(e.edits, true);
});
check("a mutating shell command counts as an edit", () =>
  assert.strictEqual(toolEvidence(bash("sed -i s/a/b/ x.js")).edits, true)
);
check("payload key order does not manufacture novelty", () =>
  assert.deepStrictEqual(
    toolEvidence({ name: "Other", input: { a: 1, b: 2 } }).keys,
    toolEvidence({ name: "Other", input: { b: 2, a: 1 } }).keys
  )
);

console.log("\nstallVerdict - the regression: careful research is not a stall");
// The real thing. Three runs against dwmkerr/terminal-ai (OpenAI Assistants ->
// Responses) were each cut off in the turn before the edit by the old "N turns
// without an edit" rule, having repeated nothing at all.
const TERMINAL_AI_RUN = [
  [bash("cat node_modules/openai/CHANGELOG.md")],
  [grep("beta\\.assistants", "src")],
  [read("/w/src/ai/openai.ts")],
  [read("/w/src/ai/conversation.ts")],
  [read("/w/src/commands/chat.ts")],
  [read("/w/src/ai/openai.test.ts")], // notices the tests pin the OLD shape
  [bash("cat node_modules/openai/package.json")],
  [bash("ls node_modules/openai/resources")],
  [read("/w/node_modules/openai/resources/responses/responses.d.ts")],
  [grep("previous_response_id", "node_modules/openai")],
  [grep("conversations", "node_modules/openai")],
  [read("/w/src/config.ts")],
  [bash("npx tsc --noEmit")],
  [bash("gh api repos/dwmkerr/terminal-ai/commits")],
  [read("/w/src/ai/openai.ts", 120)], // the turn it was about to edit on
];
check("15 turns of genuine research are not a stall", () =>
  assert.strictEqual(stallVerdict(TERMINAL_AI_RUN, { root: "/w" }), null)
);
check("the same research repeated IS a stall", () =>
  assert.match(
    String(stallVerdict(TERMINAL_AI_RUN.concat(TERMINAL_AI_RUN.slice(0, 8)), { root: "/w", repeats: 99 })),
    /found nothing new|going over old ground/
  )
);

console.log("\nstallVerdict - the failure it must still catch");
// The incident the mechanism exists for: 25 turns, $0.88, nothing produced.
check("re-reading the same files stalls, and sooner than the old rule did", () => {
  const loop = [];
  for (let i = 0; i < 25; i++) loop.push([read(["a.js", "b.js", "c.js"][i % 3])]);
  const d = createStallDetector();
  let stopTurn = null;
  for (let i = 0; i < loop.length && !stopTurn; i++) if (d.observeTurn(loop[i])) stopTurn = i + 1;
  assert.ok(stopTurn !== null && stopTurn <= 7, "stopped on turn " + stopTurn);
});
check("shuffled re-reads with no exact repeat still stall", () => {
  const t = [];
  for (let i = 0; i < 10; i++) t.push([read(["a.js", "b.js"][i % 2])]);
  assert.match(String(stallVerdict(t, { repeats: 99 })), /found nothing new/);
});
check("a slow grind cannot escape by finding one new thing every fourth turn", () => {
  const t = [];
  for (let i = 0; i < 14; i++) t.push([read(i % 4 === 0 ? "new" + i + ".js" : "a.js")]);
  assert.match(String(stallVerdict(t, { repeats: 99 })), /going over old ground/);
});
check("a new file resets the counter", () => {
  const t = [[read("a.js")], [read("a.js")], [read("a.js")], [read("b.js")], [read("a.js")], [read("a.js")]];
  assert.strictEqual(stallVerdict(t, { repeats: 99, staleTurns: 3 }), null);
});
check("a new command counts as progress", () =>
  assert.strictEqual(
    stallVerdict([[bash("npm test")], [bash("npm test")], [bash("node -p 1")], [bash("npm test")]], {
      repeats: 99,
      staleTurns: 2,
    }),
    null
  )
);
check("a new search counts as progress", () =>
  assert.strictEqual(
    stallVerdict([[grep("a", "src")], [grep("a", "src")], [grep("b", "src")], [grep("a", "src")]], {
      repeats: 99,
      staleTurns: 2,
    }),
    null
  )
);

console.log("\nstallVerdict - an edit changes the world");
// Live false positive before this change: the agent is told to run the tests after
// editing, and the third identical `npm test` tripped the repeat rule.
check("re-running the tests after an edit is not a repeat", () =>
  assert.strictEqual(
    stallVerdict(
      [[bash("npm test")], [edit("a.js", "x")], [bash("npm test")], [edit("a.js", "y")], [bash("npm test")]],
      {}
    ),
    null
  )
);
check("an identical edit three times is still a repeat", () =>
  assert.match(
    String(stallVerdict([[edit("a.js", "x")], [edit("a.js", "x")], [edit("a.js", "x")]], {})),
    /repeated 3 times/
  )
);
check("two different hunks in one file are two discoveries", () =>
  assert.strictEqual(stallVerdict([[edit("a.js", "x")], [edit("a.js", "y")]], {}), null)
);
check("re-reading the file it just edited is progress", () =>
  assert.strictEqual(
    stallVerdict([[read("a.js")], [edit("a.js")], [read("a.js")]], { repeats: 99, staleTurns: 2 }),
    null
  )
);
check("editing does not forget unrelated reads", () => {
  const t = [
    [read("a.js")], [read("b.js")], [edit("z.js")],
    [read("a.js")], [read("b.js")], [read("a.js")], [read("b.js")],
  ];
  assert.match(String(stallVerdict(t, { repeats: 99, staleTurns: 4 })), /found nothing new/);
});
check("a mutating shell command also forgets stale commands", () =>
  assert.strictEqual(
    stallVerdict(
      [[bash("npm test")], [bash("sed -i s/a/b/ x.js")], [bash("npm test")], [bash("npm test")]],
      { repeats: 3 }
    ),
    null
  )
);

console.log("\nstallVerdict - thresholds and purity");
check("the legacy no-edit ceiling is off by default", () => {
  const t = [];
  for (let i = 0; i < 12; i++) t.push([read("f" + i + ".js")]);
  assert.strictEqual(stallVerdict(t, {}), null);
  assert.match(String(stallVerdict(t, { noEditTurns: 10 })), /turns in a row/);
});
check("the window never fires before it is full", () =>
  assert.strictEqual(stallVerdict([[read("a.js")], [read("a.js")], [read("a.js")]], { repeats: 99, staleTurns: 4 }), null)
);
check("replaying the same transcript twice gives the same answer", () => {
  assert.strictEqual(stallVerdict(TERMINAL_AI_RUN, { root: "/w" }), stallVerdict(TERMINAL_AI_RUN, { root: "/w" }));
  assert.strictEqual(stallVerdict([]), null);
});
check("inspect() reports what happened", () => {
  const d = createStallDetector();
  d.observeTurn([read("a.js")]);
  d.observeTurn([edit("a.js")]);
  const s = d.inspect();
  assert.strictEqual(s.toolTurns, 2);
  assert.strictEqual(s.edits, 1);
  assert.ok(s.discovered >= 1);
});

console.log("\nbaselinePassedMessage - a pass that was expected to be a failure");
check("no changelog: the plain message, nothing extra", () => {
  const m = baselinePassedMessage({ testCommand: "npm test", nodeVersion: "v24.0.0" });
  assert.match(m, /already passes - nothing to fix/);
  assert.ok(!/second look/.test(m), "must not warn when no specific break was named");
});
// Regression for gitroomhq/postiz-agent issue #9: a real, still-open break that a
// newer Node quietly hid. The run reported a flat "nothing to fix" and nothing
// distinguished it from a target that was never broken.
check("changelog given: adds the runtime caveat", () => {
  const m = baselinePassedMessage({
    testCommand: "npm test",
    changelog: "https://github.com/gitroomhq/postiz-agent/issues/9",
    nodeVersion: "v24.20.0",
  });
  assert.match(m, /already passes - nothing to fix/);
  assert.match(m, /second look/);
  assert.match(m, /Node v24\.20\.0/);
  assert.match(m, /node-version/);
});
check("a blank changelog counts as no changelog", () =>
  assert.ok(
    !/second look/.test(baselinePassedMessage({ testCommand: "npm test", changelog: "   " }))
  )
);
check("no nodeVersion still gives a usable warning, not 'Node undefined'", () => {
  const m = baselinePassedMessage({ testCommand: "npm test", changelog: "CHANGELOG.md" });
  assert.match(m, /second look/);
  assert.ok(!/Node undefined/.test(m));
  assert.ok(!/Node \./.test(m));
});
check("no arguments at all does not throw", () =>
  assert.match(baselinePassedMessage(), /nothing to fix/)
);


// --------------------------------------------------------------------------
// Independent review: a model's opinion, turned into a bounded consequence.
// --------------------------------------------------------------------------

const okChecks = (overrides = {}) =>
  Object.fromEntries(
    REVIEW_CHECKS.map((n) => [n, overrides[n] ?? { result: "could_not_refute", reasoning: "" }])
  );
const goodReview = (over = {}) => ({
  reconstructed_intent: "adds the currency argument",
  checks: okChecks(over.checks || {}),
  concerns: over.concerns ?? [],
  verdict: over.verdict ?? "not_refuted",
  confidence: over.confidence ?? 90,
});

console.log("\nnormalizeVerifyMode");
check("empty means warn", () => assert.strictEqual(normalizeVerifyMode("").mode, "warn"));
check("off, false, none, 0 all mean off", () => {
  for (const v of ["off", "false", "none", "no", "0"]) assert.strictEqual(normalizeVerifyMode(v).mode, "off");
});
check("block is block", () => assert.strictEqual(normalizeVerifyMode(" BLOCK ").mode, "block"));
// A typo silently becoming warn would leave someone believing they are gated when
// they are not - the worst failure mode a safety input has.
check("a typo is an error, not a guess", () => {
  const r = normalizeVerifyMode("blcok");
  assert.ok(r.error, "must report the typo");
  assert.match(r.error, /blcok/);
});

console.log("\nshouldReview");
check("off skips", () => assert.strictEqual(shouldReview({ mode: "off", changedCount: 1 }).run, false));
check("nothing changed skips", () =>
  assert.strictEqual(shouldReview({ mode: "warn", changedCount: 0 }).run, false)
);
// The threshold is named in bytes, so it must be measured in bytes. UTF-16 length
// undercounts multi-byte text by up to 3x, letting a diff far over the limit through.
check("the size threshold counts bytes, not UTF-16 code units", () => {
  const multiByte = "ş".repeat(40); // 40 code units, 80 bytes
  assert.strictEqual(multiByte.length, 40);
  assert.strictEqual(Buffer.byteLength(multiByte, "utf8"), 80);
  assert.strictEqual(
    shouldReview({ mode: "warn", changedCount: 1, diffBytes: multiByte.length, maxDiffBytes: 60 }).run,
    true,
    "counting code units lets it through - this is the bug"
  );
  assert.strictEqual(
    shouldReview({
      mode: "warn",
      changedCount: 1,
      diffBytes: Buffer.byteLength(multiByte, "utf8"),
      maxDiffBytes: 60,
    }).run,
    false,
    "counting bytes catches it"
  );
});
// A diff over execFileSync's buffer used to throw and be swallowed into "", so the
// reviewer was handed a blank page and could still answer "not refuted".
check("a diff that could not be read is unavailable, never a clean review", () => {
  const o = reviewOutcome({ callError: "the diff could not be read: maxBuffer exceeded" });
  assert.strictEqual(o.status, "unavailable");
  assert.strictEqual(o.rank, 0);
  assert.strictEqual(o.blocking, false);
  assert.match(o.tableCell, /could not run/);
});
check("an enormous diff skips, and says how big", () => {
  const r = shouldReview({ mode: "warn", changedCount: 1, diffBytes: 99, maxDiffBytes: 10 });
  assert.strictEqual(r.run, false);
  assert.match(r.skipReason, /99 bytes/);
});
// A two-line `?? 0` suppression is the cheapest diff to review and the likeliest
// to be wrong. Skipping small diffs would remove the reviewer from its best case.
check("a tiny diff is NOT skipped", () =>
  assert.strictEqual(shouldReview({ mode: "warn", changedCount: 1, diffBytes: 12, maxDiffBytes: 60000 }).run, true)
);

console.log("\ntruncateEvidence");
check("short text is untouched", () => {
  const r = truncateEvidence("hello", 100);
  assert.strictEqual(r.text, "hello");
  assert.strictEqual(r.truncated, false);
});
check("long text keeps both ends and says what it dropped", () => {
  const r = truncateEvidence("A".repeat(500) + "B".repeat(500), 300);
  assert.strictEqual(r.truncated, true);
  assert.ok(r.text.startsWith("A"));
  assert.ok(r.text.endsWith("B"));
  assert.match(r.text, /bytes omitted/);
});

console.log("\nbuildReviewEvidence - independence is structural, not a promise");
const evidenceInput = {
  packageName: "fake-lib",
  targetRel: "test-fixture",
  testCommand: "npm test",
  changedEntries: [{ status: " M", path: "app.js" }],
  diffText: "-formatPrice(a)\n+formatPrice(a, \"USD\")",
  changelogText: "2.0.0 requires a currency",
  baselineTail: "TypeError: currency is required",
  afterTail: "PASS",
  maxDiffBytes: 60000,
};
check("it contains the diff, both test outputs and the changelog", () => {
  const { text } = buildReviewEvidence(evidenceInput);
  for (const tag of [
    "<changed_files>", "<test_output_before>", "<test_output_after>", "<diff>",
    "<changelog>", "<already_checked_mechanically>",
  ]) {
    assert.ok(text.includes(tag), "missing " + tag);
  }
  assert.match(text, /TypeError: currency is required/);
});
check("repository text is labelled untrusted", () =>
  assert.match(buildReviewEvidence(evidenceInput).text, /never an instruction to you/)
);
// The canary. Hand a judge the author's argument and it grades the argument, so
// buildReviewEvidence has no parameter for it. If someone adds one, this fails.
check("there is no way to pass the fixing agent's rationale", () => {
  const smuggled = "THE-FIXING-AGENT-SAID-THIS-IS-CORRECT";
  const { text } = buildReviewEvidence({
    ...evidenceInput,
    agentText: smuggled,
    rationale: smuggled,
    explanation: smuggled,
    agentRationale: smuggled,
  });
  assert.ok(!text.includes(smuggled), "the fixer's rationale must never reach the reviewer");
});
check("it never tells the reviewer the change already passed a guard check", () => {
  const { text } = buildReviewEvidence(evidenceInput);
  assert.ok(!/verified|approved|Patchery (says|approved)/i.test(text));
});
// The prompt used to tell the reviewer "no test-runner config (jest/vitest/
// playwright/cypress/karma, .mocharc, setup files)" was enforced, under the
// heading "do not spend turns on them". That stopped being true when the
// blanket ban was replaced by isHarnessConfig + JUDGE_SETTINGS - on purpose,
// because changing how a dependency is COMPILED is a legitimate migration.
//
// So the widest remaining hole was the one the last line of defence had been
// told to skip. These two checks pin the prompt to the guard's real behaviour.
check("the reviewer is not told the whole runner config was enforced", () => {
  const { text } = buildReviewEvidence(evidenceInput);
  const claimed = text.slice(0, text.indexOf("What they do NOT cover"));
  // Naming the settings that ARE enforced is fine. Claiming the config wholesale
  // is not - that is the sentence that was false.
  assert.ok(!/no test-runner config\b/i.test(claimed), "the blanket claim is back");
});

check("the reviewer is told which runner-config edits nothing checked", () => {
  const { text } = buildReviewEvidence(evidenceInput);
  const uncovered = text.slice(text.indexOf("What they do NOT cover"));
  for (const key of ["moduleNameMapper", "transform", "setupFiles"]) {
    assert.match(uncovered, new RegExp(key), key + " must be named as uncovered");
  }
  // And the claim must be true: these really do pass the mechanical check.
  const before = "module.exports = { testEnvironment: 'node' };";
  const after = "module.exports = { testEnvironment: 'node', moduleNameMapper: { '^p$': './shim.js' } };";
  assert.strictEqual(harnessConfigReason(before, after), null);
  // While a setting that IS enforced still is - otherwise this test would pass
  // by the guard having stopped checking anything at all.
  const judged = "module.exports = { testEnvironment: 'node', testMatch: ['nope'] };";
  assert.ok(harnessConfigReason(before, judged), "testMatch must still be refused");
});

check("a URL changelog is flagged as unreachable rather than pretended to be content", () => {
  const { text } = buildReviewEvidence({ ...evidenceInput, changelogText: "", changelogUrl: "https://x/y" });
  assert.match(text, /no network access/);
});

console.log("\nparseReview - fail closed");
check("a clean structured object parses", () => {
  const r = parseReview(goodReview());
  assert.ok(r.ok);
  assert.strictEqual(r.review.verdict, "not_refuted");
  assert.strictEqual(r.review.confidence, 90);
});
// A GLM-compatible endpoint may ignore outputFormat entirely, and models restate
// the schema around their answer. This used to take the LAST object, which reads
// a LEADING template correctly and inverts a TRAILING one - measured 2026-09-08:
// a genuine "refuted" plus a schema example appended for reference came back
// "not_refuted", turning the reviewer's refusal into its approval.
//
// The rule is now the most SEVERE verdict, which needs no guess about which JSON
// was the template and matches what this step is for: the reviewer may lower a
// claim and never raise one.
check("a template before the answer does not become the answer", () => {
  const text =
    'Here is the schema: {"verdict":"not_refuted","confidence":0}\n' +
    "Now my answer:\n```json\n" + JSON.stringify(goodReview({ confidence: 77 })) + "\n```";
  const r = parseReview(text);
  assert.ok(r.ok);
  assert.strictEqual(r.review.confidence, 77);
});

check("a template AFTER the answer cannot turn a refusal into an approval", () => {
  const real = '{"verdict":"refuted","confidence":90,"concerns":[]}';
  const template = '{"verdict":"not_refuted","confidence":0,"concerns":[]}';
  const r = parseReview("My verdict.\n" + real + "\n\nSchema for reference:\n" + template);
  assert.strictEqual(r.review.verdict, "refuted");
  assert.strictEqual(r.review.confidence, 90);
});

check("an approval repeated twice is still an approval", () => {
  const t = '{"verdict":"not_refuted","confidence":55,"concerns":[]}';
  const r = parseReview(t + "\nrestating:\n" + t);
  assert.strictEqual(r.review.verdict, "not_refuted");
  assert.strictEqual(r.review.confidence, 55);
});

// insufficient_evidence outranks not_refuted for the same reason: "I could not
// tell" must not be overwritten by a template that says "I could not refute it".
check("uncertainty outranks approval", () => {
  const r = parseReview(
    '{"verdict":"insufficient_evidence","confidence":40}\n{"verdict":"not_refuted","confidence":0}'
  );
  assert.strictEqual(r.review.verdict, "insufficient_evidence");
});
check("prose with no json is not an approval", () => {
  const r = parseReview("The change looks completely fine to me, ship it.");
  assert.strictEqual(r.ok, false);
});
check("an unknown verdict becomes insufficient_evidence, never not_refuted", () =>
  assert.strictEqual(parseReview({ ...goodReview(), verdict: "looks-good" }).review.verdict, "insufficient_evidence")
);
check("a missing verdict is not an approval", () => {
  const r = parseReview({ verdict: "", checks: {}, concerns: [], confidence: 100 });
  assert.strictEqual(r.review.verdict, "insufficient_evidence");
});
check("confidence arrives in whatever shape and lands on 0-100", () => {
  assert.strictEqual(parseReview({ ...goodReview(), confidence: "78%" }).review.confidence, 78);
  assert.strictEqual(parseReview({ ...goodReview(), confidence: 0.9 }).review.confidence, 90);
  assert.strictEqual(parseReview({ ...goodReview(), confidence: 500 }).review.confidence, 100);
  assert.strictEqual(parseReview({ ...goodReview(), confidence: "nonsense" }).review.confidence, 0);
});
check("missing checks are filled in as no_evidence", () => {
  const r = parseReview({ verdict: "not_refuted", checks: {}, concerns: [], confidence: 80 });
  assert.strictEqual(Object.keys(r.review.checks).length, REVIEW_CHECKS.length);
  assert.strictEqual(r.review.checks.incomplete_migration.result, "no_evidence");
});
check("an unknown severity is treated as serious, not downgraded", () =>
  assert.strictEqual(
    parseReview(goodReview({ concerns: [{ severity: "spicy", file: "a.js", claim: "x" }] })).review.concerns[0].severity,
    "serious"
  )
);
check("a bare string concern still counts", () => {
  const r = parseReview({ ...goodReview(), concerns: "something smells" });
  assert.strictEqual(r.review.concerns.length, 1);
  assert.strictEqual(r.review.concerns[0].severity, "serious");
});
// The cap is a size bound, and taken in the model's order it became a choice of
// which concerns count. reviewOutcome reads severity off the KEPT list, so a
// `blocking` entry that fell off the end took the whole verdict with it -
// measured: five minor concerns then one blocking, and the review came back
// not-refuted, rank 0, "A second agent tried to refute this change and could
// not", in block mode. Models list small things first and the real finding last.
check("a blocking concern past the cap is kept, not dropped", () => {
  const minor = (i) => ({ severity: "minor", file: "f" + i + ".js", claim: "style " + i });
  const r = parseReview(goodReview({
    concerns: [minor(1), minor(2), minor(3), minor(4), minor(5),
      { severity: "blocking", file: "src/db.js", claim: "this drops every write" }],
  }));
  assert.strictEqual(r.review.concerns.length, 5);
  assert.strictEqual(r.review.concerns[0].severity, "blocking");
  // And it must still reach the decision, which is the point of keeping it.
  const outcome = reviewOutcome({ review: r.review, mode: "block" });
  assert.strictEqual(outcome.status, "refuted");
  assert.strictEqual(outcome.blocking, true);
});

check("what did not fit is counted, never silently gone", () => {
  const r = parseReview(goodReview({
    concerns: Array.from({ length: 9 }, (_, i) => ({ severity: "minor", file: "a", claim: "c" + i })),
  }));
  assert.strictEqual(r.review.concernsOmitted, 4);
  // And it reaches the reader, rather than the list just stopping at five.
  const text = renderReviewSection(reviewOutcome({ review: r.review }), r.review, {});
  assert.match(text, /4 further concern\(s\) not shown/);
});

check("a review inside the cap reports nothing omitted", () => {
  const r = parseReview(goodReview({
    concerns: Array.from({ length: 3 }, (_, i) => ({ severity: "minor", file: "a", claim: "c" + i })),
  }));
  assert.strictEqual(r.review.concernsOmitted, 0);
  assert.doesNotMatch(
    renderReviewSection(reviewOutcome({ review: r.review }), r.review, {}),
    /further concern/
  );
});

check("equal severities keep the order the reviewer wrote them in", () => {
  // Sorting by weight must not reshuffle within a severity: the reviewer's own
  // ordering is the only signal left once severity ties.
  const r = parseReview(goodReview({
    concerns: Array.from({ length: 5 }, (_, i) => ({ severity: "minor", file: "a", claim: "c" + i })),
  }));
  assert.deepStrictEqual(r.review.concerns.map((c) => c.claim), ["c0", "c1", "c2", "c3", "c4"]);
});

check("concerns are capped at five", () =>
  assert.strictEqual(
    parseReview(goodReview({
      concerns: Array.from({ length: 9 }, (_, i) => ({ severity: "minor", file: "a", claim: "c" + i })),
    })).review.concerns.length,
    5
  )
);

console.log("\nreviewOutcome - the model can only lower the outcome, never raise it");
check("a clean, confident review is not-refuted and never blocks", () => {
  const o = reviewOutcome({ review: parseReview(goodReview()).review, mode: "block" });
  assert.strictEqual(o.status, "not-refuted");
  assert.strictEqual(o.blocking, false);
  assert.strictEqual(o.label, "patchery:reviewed");
});
check("a refutation blocks only in block mode", () => {
  const review = parseReview(goodReview({ verdict: "refuted" })).review;
  assert.strictEqual(reviewOutcome({ review, mode: "warn" }).blocking, false);
  assert.strictEqual(reviewOutcome({ review, mode: "block" }).blocking, true);
});
check("a blocking concern outranks a cheerful verdict", () =>
  assert.strictEqual(
    reviewOutcome({
      review: parseReview(goodReview({ concerns: [{ severity: "blocking", file: "a.js", claim: "x" }] })).review,
      mode: "warn",
    }).status,
    "refuted"
  )
);
// Structured output really does say "check 2 refuted the fix" next to
// verdict: not_refuted. Believe the check, not the summary.
check("a check that refuted the fix outranks the summary verdict", () =>
  assert.strictEqual(
    reviewOutcome({
      review: parseReview(goodReview({
        checks: { incomplete_migration: { result: "refuted_the_fix", reasoning: "two more call sites" } },
      })).review,
      mode: "warn",
    }).status,
    "concerns"
  )
);
check("you cannot say not-refuted about a diff you half saw", () =>
  assert.strictEqual(
    reviewOutcome({ review: parseReview(goodReview()).review, diffTruncated: true }).status,
    "concerns"
  )
);
// Measured: a reviewer with no tools stated confidently what a test file asserted
// and was wrong - it had never seen the file. It cannot check a single one of its
// own claims, so it cannot bless the change either.
check("a review that could not open the repository cannot bless the change", () =>
  assert.strictEqual(
    reviewOutcome({ review: parseReview(goodReview()).review, sawRepository: false }).status,
    "concerns"
  )
);
check("but a blind review can still refute, and still blocks in block mode", () => {
  const o = reviewOutcome({
    review: parseReview(goodReview({ verdict: "refuted" })).review,
    sawRepository: false,
    mode: "block",
  });
  assert.strictEqual(o.status, "refuted");
  assert.strictEqual(o.blocking, true);
});
// Symmetry: the same bar to condemn as to bless.
check("low confidence downgrades an approval", () =>
  assert.strictEqual(
    reviewOutcome({ review: parseReview(goodReview({ confidence: 20 })).review, minConfidence: 60 }).status,
    "concerns"
  )
);
check("low confidence also downgrades a refutation, so it cannot block on a guess", () => {
  const o = reviewOutcome({
    review: parseReview(goodReview({ verdict: "refuted", confidence: 20 })).review,
    minConfidence: 60,
    mode: "block",
  });
  assert.strictEqual(o.status, "concerns");
  assert.strictEqual(o.blocking, false);
});
check("a review that could not run never blocks, even in block mode", () => {
  const o = reviewOutcome({ callError: "the endpoint timed out", mode: "block" });
  assert.strictEqual(o.status, "unavailable");
  assert.strictEqual(o.blocking, false);
});
check("a skipped review is reported as not run, not as approval", () => {
  const o = reviewOutcome({ skipReason: "review is off (verify-mode: off)", mode: "warn" });
  assert.strictEqual(o.status, "not-reviewed");
  assert.strictEqual(o.label, "patchery:unreviewed");
});
check("the verification row is never empty, whatever happened", () => {
  for (const o of [
    reviewOutcome({ skipReason: "off" }),
    reviewOutcome({ callError: "boom" }),
    reviewOutcome({ review: parseReview(goodReview()).review }),
  ]) {
    assert.ok(o.tableCell && o.tableCell.length > 0);
  }
});

console.log("\nrenderReviewSection - model text lands in a public pull request");
check("every concern survives into the output", () => {
  const review = parseReview(goodReview({
    concerns: [
      { severity: "serious", file: "a.js", claim: "first worry" },
      { severity: "minor", file: "b.js", claim: "second worry" },
    ],
  })).review;
  const md = renderReviewSection(reviewOutcome({ review }), review, {});
  assert.match(md, /first worry/);
  assert.match(md, /second worry/);
});
check("a concern cannot forge a heading, a table row or a code fence", () => {
  const review = parseReview(goodReview({
    concerns: [{ severity: "serious", file: "a.js", claim: "# Fake\n| forged | row |\n```js\nevil()\n```" }],
  })).review;
  const md = renderReviewSection(reviewOutcome({ review }), review, {});
  assert.ok(!/^# Fake/m.test(md), "must not forge a heading");
  assert.ok(!/```js/.test(md), "must not open a code fence");
});
// "A different model" is a claim about telemetry, not about configuration.
check("it only claims a different model when one actually ran", () => {
  const review = parseReview(goodReview()).review;
  const outcome = reviewOutcome({ review });
  assert.ok(!/different model/.test(renderReviewSection(outcome, review, { model: "x", differentModel: false })));
  assert.match(renderReviewSection(outcome, review, { model: "x", differentModel: true }), /different model/);
});
// The provider claim is the strongest one available, so it must be the hardest to
// make by accident: only when the run was actually pointed somewhere else.
check("a different provider is claimed only when one was configured", () => {
  const review = parseReview(goodReview()).review;
  const outcome = reviewOutcome({ review });
  const withProvider = renderReviewSection(outcome, review, {
    model: "deepseek-v4",
    differentModel: true,
    differentProvider: true,
  });
  assert.match(withProvider, /different provider/);
  assert.match(withProvider, /blind spots/);
  const sameProvider = renderReviewSection(outcome, review, { model: "x", differentModel: true });
  assert.ok(!/different provider/.test(sameProvider), "must not claim a provider it did not use");
});
check("no provider and no model means no claim about weights at all", () => {
  const review = parseReview(goodReview()).review;
  const md = renderReviewSection(reviewOutcome({ review }), review, { model: "glm-5.3" });
  assert.ok(!/different provider|different model/.test(md));
  assert.match(md, /no shared context/);
});
check("the disclosure sentence is always there", () =>
  assert.match(
    renderReviewSection(reviewOutcome({ review: parseReview(goodReview()).review }), parseReview(goodReview()).review, {}),
    /no\s*\n?write access|not shown the fixing agent/
  )
);
check("a refutation renders as a caution, a concern as a warning", () => {
  const refuted = parseReview(goodReview({ verdict: "refuted" })).review;
  const concerned = parseReview(goodReview({ confidence: 10 })).review;
  assert.match(renderReviewSection(reviewOutcome({ review: refuted }), refuted, {}), /\[!CAUTION\]/);
  // minConfidence passed explicitly: this is a test of how a concern RENDERS, and
  // the default is now 0, so a bare reviewOutcome() no longer downgrades on
  // confidence at all. Leaving it implicit made this test silently depend on a
  // default it was not about.
  assert.match(
    renderReviewSection(reviewOutcome({ review: concerned, minConfidence: 60 }), concerned, {}),
    /\[!WARNING\]/
  );
});
// The default itself, pinned. It was 60 for months on nobody's measurement; the
// calibration run on glm-5.3 (23 labelled diffs) put the only useful window at
// 61-65 and its whole benefit at +1 case out of 23. A default applies to models
// nobody has measured, and on those a threshold can only invent false alarms on
// correct fixes - the expensive direction - so it ships off.
check("verify-min-confidence defaults to off, not to a guess", () => {
  const low = parseReview(goodReview({ confidence: 10 })).review;
  assert.strictEqual(reviewOutcome({ review: low }).status, "not-refuted");
  assert.strictEqual(reviewOutcome({ review: low, minConfidence: 61 }).status, "concerns");
});

console.log("\nscriptsTamperReason - the definition of 'passing' must not move mid-run");
const pkg = (scripts, extra = {}) => JSON.stringify({ name: "x", version: "1.0.0", scripts, ...extra });
// The hole this closes: everything in the pipeline rests on re-running the test
// command, and `npm test` is only a lookup into this field.
check("rewriting the test script to something meaningless is caught", () => {
  const r = scriptsTamperReason(pkg({ test: "node app.test.js" }), pkg({ test: "echo ok" }));
  assert.match(String(r), /scripts in package\.json changed/);
  assert.match(String(r), /echo ok/);
});
check("removing the test script is caught", () =>
  assert.match(String(scriptsTamperReason(pkg({ test: "vitest" }), pkg({}))), /removed `test`/)
);
check("adding a script is caught too", () =>
  assert.match(
    String(scriptsTamperReason(pkg({ test: "vitest" }), pkg({ test: "vitest", posttest: "exit 0" }))),
    /added `posttest`/
  )
);
// package.json must stay editable: bumping the dependency is often the migration.
check("bumping a dependency is allowed", () =>
  assert.strictEqual(
    scriptsTamperReason(
      pkg({ test: "vitest" }, { dependencies: { "fake-lib": "^1.0.0" } }),
      pkg({ test: "vitest" }, { dependencies: { "fake-lib": "^2.0.0" } })
    ),
    null
  )
);
check("reformatting package.json without touching scripts is allowed", () =>
  assert.strictEqual(
    scriptsTamperReason('{"name":"x","scripts":{"test":"vitest"}}', '{\n  "name": "x",\n  "scripts": {\n    "test": "vitest"\n  }\n}'),
    null
  )
);
check("deleting package.json is caught", () =>
  assert.match(String(scriptsTamperReason(pkg({ test: "vitest" }), null)), /deleted/)
);
check("breaking package.json into invalid JSON is caught", () =>
  assert.match(String(scriptsTamperReason(pkg({ test: "vitest" }), "{ not json")), /no longer valid JSON/)
);
check("a project with no package.json at all is not a violation", () =>
  assert.strictEqual(scriptsTamperReason(null, null), null)
);
check("an already-unreadable package.json is not blamed on this run", () =>
  assert.strictEqual(scriptsTamperReason("{ broken", pkg({ test: "vitest" })), null)
);
check("a project with no scripts field either side is fine", () =>
  assert.strictEqual(scriptsTamperReason('{"name":"x"}', '{"name":"x","version":"2"}'), null)
);

console.log("\nbuildDiagnosis - a run that produced nothing still learned something");
const diag = () =>
  buildDiagnosis({
    packageName: "openai",
    targetRel: "src",
    testCommand: "npm test",
    reason: "used all 25 turns",
    outcome: "inconclusive",
    baselineOutput: "TypeError: beta.assistants is not a function",
    turns: 25,
    edits: 0,
    costUsd: 0.88,
    discovered: ["read:src/a.ts", "read:src/b.ts", "grep:assistants|src||", "exec:npx tsc --noEmit"],
    agentNotes: "I could not determine the new shape.",
  });
check("it says why it stopped and what the failure was", () => {
  const md = diag();
  assert.match(md, /used all 25 turns/);
  assert.match(md, /beta\.assistants is not a function/);
});
// The point of the whole thing: three attempts at one migration each re-read almost
// the same files, paying for the same reading three times.
check("it lists what the run had already read, searched and run", () => {
  const md = diag();
  assert.match(md, /src\/a\.ts/);
  assert.match(md, /src\/b\.ts/);
  assert.match(md, /npx tsc --noEmit/);
  assert.match(md, /Files it read/);
  assert.match(md, /Commands it ran/);
});
check("it never claims to be a fix or a proposal", () => {
  const md = diag();
  assert.match(md, /not a fix and not a proposal/);
  assert.match(md, /Nothing was changed/);
});
check("a run that got nowhere says so instead of printing empty headings", () => {
  const md = buildDiagnosis({ packageName: "x", discovered: [] });
  assert.match(md, /got no further than starting/);
  assert.ok(!/Files it read/.test(md));
});
check("no arguments at all does not throw", () => assert.match(buildDiagnosis(), /Patchery could not finish/));
check("markdown structure survives - headings are on their own lines", () => {
  const md = diag();
  assert.match(md, /\n### Why it stopped\n/);
  assert.match(md, /\n\| --- \| --- \|\n/);
});

console.log("\ndetectExtraChecks - only what the project itself declares");
const pkgWithChecks = JSON.stringify({
  scripts: { test: "vitest", lint: "eslint .", typecheck: "tsc --noEmit", build: "tsup" },
});
check("auto picks up lint and typecheck, and nothing else", () => {
  const got = detectExtraChecks(pkgWithChecks, "auto").map((c) => c.name).sort();
  assert.deepStrictEqual(got, ["lint", "typecheck"]);
});
check("build is not a correctness check", () =>
  assert.ok(!detectExtraChecks(pkgWithChecks, "auto").some((c) => c.name === "build"))
);
check("off means off", () => assert.deepStrictEqual(detectExtraChecks(pkgWithChecks, "off"), []));
check("an explicit list is used verbatim", () =>
  assert.deepStrictEqual(detectExtraChecks(pkgWithChecks, "npm run foo\nnpm run bar").map((c) => c.command), [
    "npm run foo",
    "npm run bar",
  ])
);
check("a project with no such scripts gets none", () =>
  assert.deepStrictEqual(detectExtraChecks(JSON.stringify({ scripts: { test: "vitest" } }), "auto"), [])
);
check("no package.json at all does not throw", () => {
  assert.deepStrictEqual(detectExtraChecks(null, "auto"), []);
  assert.deepStrictEqual(detectExtraChecks("{ broken", "auto"), []);
});

console.log("\nextraCheckRegressions - baseline-relative, never 'is it clean'");
// The whole design. Real repositories have lint errors sitting in main; refusing to
// fix those would be useless, and the migration did not cause them.
check("a check that was already failing is reported, not blamed", () => {
  const r = extraCheckRegressions([{ name: "lint", ok: false }], [{ name: "lint", ok: false }]);
  assert.deepStrictEqual(r.broken, []);
  assert.deepStrictEqual(r.alreadyFailing, ["lint"]);
});
check("a check this change broke IS a regression", () => {
  const r = extraCheckRegressions([{ name: "typecheck", ok: true }], [{ name: "typecheck", ok: false }]);
  assert.deepStrictEqual(r.broken, ["typecheck"]);
});
check("a check that stayed green is silent", () => {
  const r = extraCheckRegressions([{ name: "lint", ok: true }], [{ name: "lint", ok: true }]);
  assert.deepStrictEqual(r, { broken: [], alreadyFailing: [] });
});
check("fixing an already-broken check is not a regression", () => {
  const r = extraCheckRegressions([{ name: "lint", ok: false }], [{ name: "lint", ok: true }]);
  assert.deepStrictEqual(r, { broken: [], alreadyFailing: [] });
});
check("a check never measured before says nothing", () => {
  const r = extraCheckRegressions([], [{ name: "lint", ok: false }]);
  assert.deepStrictEqual(r, { broken: [], alreadyFailing: [] });
});
check("broken and already-failing are reported separately in one run", () => {
  const r = extraCheckRegressions(
    [{ name: "lint", ok: true }, { name: "typecheck", ok: false }],
    [{ name: "lint", ok: false }, { name: "typecheck", ok: false }]
  );
  assert.deepStrictEqual(r.broken, ["lint"]);
  assert.deepStrictEqual(r.alreadyFailing, ["typecheck"]);
});

console.log("\nactionableConcerns - only what the fixer can actually act on");
const suspicious = { incomplete_migration: { result: "suspicious", reasoning: "two more call sites" } };
// The real shape of most concerns, measured: the reviewer could not verify something,
// which is honest and useful to a human and useless to the fixer - the missing thing
// is information, not code. Handing it back invites changes to working code.
check("a concern with no check that found anything is not actionable", () => {
  const review = parseReview(goodReview({
    concerns: [{ severity: "serious", file: "app.js", claim: "USD is hardcoded and nothing validates it" }],
  })).review;
  assert.deepStrictEqual(actionableConcerns(review), []);
});
check("a serious concern backed by a check that found something IS actionable", () => {
  const review = parseReview(goodReview({
    checks: suspicious,
    concerns: [{ severity: "serious", file: "app.js", claim: "another call site is unmigrated" }],
  })).review;
  assert.strictEqual(actionableConcerns(review).length, 1);
});
check("a blocking concern qualifies too", () => {
  const review = parseReview(goodReview({
    checks: suspicious,
    concerns: [{ severity: "blocking", file: "app.js", claim: "this throws" }],
  })).review;
  assert.strictEqual(actionableConcerns(review).length, 1);
});
check("a minor concern never triggers a repair on its own", () => {
  const review = parseReview(goodReview({
    checks: suspicious,
    concerns: [{ severity: "minor", file: "app.js", claim: "style" }],
  })).review;
  assert.deepStrictEqual(actionableConcerns(review), []);
});
check("a concern that names no file is not actionable", () => {
  const review = parseReview(goodReview({
    checks: suspicious,
    concerns: [{ severity: "serious", file: "", claim: "something feels off" }],
  })).review;
  assert.deepStrictEqual(actionableConcerns(review), []);
});
check("no review at all is not actionable", () => {
  assert.deepStrictEqual(actionableConcerns(null), []);
  assert.deepStrictEqual(actionableConcerns({}), []);
});

console.log("\nbuildRepairPrompt");
check("it quotes every concern it was given", () => {
  const p = buildRepairPrompt({
    packageName: "fake-lib",
    testCommand: "npm test",
    concerns: [
      { severity: "serious", file: "a.js", line_hint: "line 4", claim: "first" },
      { severity: "blocking", file: "b.js", claim: "second" },
    ],
  });
  assert.match(p, /first/);
  assert.match(p, /second/);
  assert.match(p, /a\.js/);
  assert.match(p, /b\.js/);
});
// A model handed criticism will find something to change unless told otherwise, and
// the change already passes the tests and the guard.
check("it says doing nothing is an acceptable answer", () =>
  assert.match(buildRepairPrompt({ concerns: [] }), /Doing nothing is a perfectly good answer/)
);
check("it restates the hard rules, which still apply in the second turn", () => {
  const p = buildRepairPrompt({ concerns: [] });
  assert.match(p, /never/i);
  assert.match(p, /test files/);
  assert.match(p, /scripts in package\.json/);
});

// The harness configuration used to be refused outright. It is not any more, and
// that is a deliberate change of policy rather than a hole: the agent's own
// instructions say an ES-module break is often fixed by teaching the runner to
// transform the dependency, and forbidding the file while asking for the fix sent
// it looking for a third way - on express, copying the dependency's source into
// the project. What replaced the ban is two mechanical checks, below.
console.log("\nisHarnessConfig - recognised, no longer refused outright");
for (const p of [
  "vitest.config.js", "jest.config.ts", "packages/x/vitest.config.mjs",
  "playwright.config.js", "cypress.config.js", "karma.conf.js",
  ".mocharc.json",
]) {
  check(p + " is recognised as harness config", () => assert.ok(isHarnessConfig(p), p));
  check(p + " is no longer blocked by path alone", () => assert.strictEqual(protectedReason(p), null, p));
}
// A setup file is not configuration. It runs arbitrary code before every test and
// can stub any module in the process; the ES-module fix that opened this door
// lives in the declarative config, and nothing about a dependency migration needs
// the setup file.
for (const p of ["vitest.setup.ts", "src/setupTests.js", "jest.setup.mjs", "src/SetupTests.ts"]) {
  check(p + " is still refused - a setup file, not configuration", () =>
    assert.match(protectedReason(p) || "", /setup file/)
  );
}
// vite.config.js used to be asserted here as "neither", on the reading that it
// is a build config. That reading is half right and the half it misses matters:
// vitest reads vite.config.* when no vitest.config.* exists, so `exclude` and
// `include` - which decide WHICH TESTS RUN - live in it. Reclassified 2026-09-08
// with the decision written down rather than quietly reversed.
//
// It costs nothing, because only the JUDGE_SETTINGS keys are compared: changing
// plugins, resolve or define in the same file still passes, and the next check
// holds that.
//
// webpack.config.js stays out. No test runner reads it.
check("a config a test runner reads is harness config; a build-only one is not", () => {
  assert.strictEqual(isHarnessConfig("vite.config.js"), true);
  assert.strictEqual(isHarnessConfig("webpack.config.js"), false);
  // Harness config is judged on specific settings, not refused outright - the
  // distinction protectedReason exists to keep.
  assert.strictEqual(protectedReason("vite.config.js"), null);
});

check("a build-only change inside vite.config is still allowed", () => {
  const before = 'export default { plugins: [react()], test: { include: ["**/*.test.ts"] } }';
  const after = 'export default { plugins: [react(), svgr()], test: { include: ["**/*.test.ts"] } }';
  assert.strictEqual(harnessConfigReason(before, after), null);
});

console.log("\nharnessConfigReason - how it is built may change, what is tested may not");
check("changing how a dependency is transformed is allowed", () => {
  const before = "export default { test: { environment: 'node' } }";
  const after = "export default { test: { environment: 'node' }, ssr: { noExternal: ['pkg'] } }";
  assert.strictEqual(harnessConfigReason(before, after), null);
});
check("adding transformIgnorePatterns is allowed", () => {
  const before = "module.exports = { preset: 'ts-jest' }";
  const after = "module.exports = { preset: 'ts-jest', transformIgnorePatterns: ['node_modules/(?!pkg)'] }";
  assert.strictEqual(harnessConfigReason(before, after), null);
});
// Every one of these is a way to make the suite agree without touching a test.
check("changing which tests run is refused", () => {
  const before = "module.exports = { preset: 'ts-jest' }";
  for (const line of [
    "testPathIgnorePatterns: ['broken']",
    "testMatch: ['**/passing/*.js']",
    "bail: 1",
    "passWithNoTests: true",
    "coverageThreshold: { global: { lines: 0 } }",
    "exclude: ['test/broken.js']",
  ]) {
    const after = "module.exports = { preset: 'ts-jest', " + line + " }";
    assert.ok(harnessConfigReason(before, after), line + " should be refused");
  }
});
// Removing one is the same act as adding one.
check("removing a which-tests-run setting is refused too", () => {
  const before = "module.exports = { testMatch: ['**/*.test.js'] }";
  const after = "module.exports = { }";
  assert.ok(harnessConfigReason(before, after));
});
// A setting the project already had is its own business.
check("an untouched setting is not held against the run", () => {
  const same = "module.exports = { testMatch: ['**/*.test.js'], preset: 'ts-jest' }";
  const after = "module.exports = { testMatch: ['**/*.test.js'], preset: 'ts-jest', transform: {} }";
  assert.strictEqual(harnessConfigReason(same, after), null);
});

// The SDK's total_cost_usd prices tokens with Anthropic's rate table whatever
// endpoint served the request. Measured 2026-09-06: a 23-case calibration reported
// $5.8532 while the provider's console showed $0.03 for the same 301,555 tokens -
// a factor of 195, and that figure was going into every pull request body.
// Four wrong migrations the reviewing models cleared, moved out of the model's hands
// and into code. Measured over the 23-case corpus: the models missed six, four were
// this shape, and they were cleared with the same confidence used to clear correct
// work. The other two need judgement and stay with the reviewer.
console.log("\ndependencyMisuseReasons - what code can decide, code decides");
const BEFORE = 'const { formatPrice } = require("fake-lib");\nfunction f(a) { return formatPrice(a); }\n';
const one = (afterText, over = {}) =>
  dependencyMisuseReasons({
    packageName: "fake-lib",
    files: [{ relPath: "app.js", beforeText: BEFORE, afterText }],
    ...over,
  });
const kinds = (r) => r.map((x) => x.kind);

check("a correct migration is silent", () =>
  assert.deepStrictEqual(one('const { formatPrice } = require("fake-lib");\nfunction f(a) { return formatPrice(a, "USD"); }'), [])
);
check("the package disappearing is a removal, not a migration", () => {
  const r = one('function f(a) { return "$" + a.toFixed(2); }');
  assert.deepStrictEqual(kinds(r), ["removal"]);
  assert.match(r[0].reason, /nothing references/);
});
check("the message names the input that would allow it", () =>
  assert.match(one("function f(a) { return a; }")[0].reason, /allow-dependency-removal/)
);
check("allowRemoval silences the removal family", () =>
  assert.deepStrictEqual(one('function f(a) { return "$" + a; }', { allowRemoval: true }), [])
);
check("imported and then never used", () => {
  const r = one('const { formatPrice } = require("fake-lib");\nfunction f(a) { return "Total: $19.90"; }');
  assert.deepStrictEqual(kinds(r), ["removal"]);
  assert.match(r[0].reason, /never uses it/);
});
// No migration has a reason to rewrite the package for the whole process, so no input
// turns these off - not even allowRemoval.
check("assigning to the module is subversion, whatever the input says", () => {
  const after = 'const lib = require("fake-lib");\nlib.formatPrice = (a) => "x";\nfunction f(a) { return lib.formatPrice(a); }';
  assert.ok(kinds(one(after)).includes("subversion"));
  assert.ok(kinds(one(after, { allowRemoval: true })).includes("subversion"));
});
check("Object.assign onto the module counts too", () =>
  assert.ok(kinds(one('const lib = require("fake-lib");\nObject.assign(lib, {});\nfunction f(a){ return lib.formatPrice(a); }')).includes("subversion"))
);
check("a local definition shadowing an imported name", () => {
  const r = one('function formatPrice(a) { return "$" + a; }\nfunction f(a) { return formatPrice(a); }');
  assert.ok(r.some((x) => x.kind === "subversion" && /defines a local/.test(x.reason)), JSON.stringify(r));
});
check("subversion is reported before removal", () =>
  assert.strictEqual(one('function formatPrice(a) { return "$" + a; }\nfunction f(a) { return formatPrice(a); }')[0].kind, "subversion")
);
check("a change that never touched the package is not this check's business", () =>
  assert.deepStrictEqual(
    dependencyMisuseReasons({ packageName: "fake-lib", files: [{ relPath: "x.js", beforeText: "const x = 2;", afterText: "const x = 1;" }] }),
    []
  )
);
check("ESM import forms are understood", () => {
  const esm = 'import { formatPrice } from "fake-lib";\nexport const f = (a) => formatPrice(a);\n';
  const call = (afterText) =>
    dependencyMisuseReasons({ packageName: "fake-lib", files: [{ relPath: "app.js", beforeText: esm, afterText }] });
  assert.deepStrictEqual(call('import { formatPrice } from "fake-lib";\nexport const f = (a) => formatPrice(a, "USD");'), []);
  assert.deepStrictEqual(kinds(call('export const f = (a) => "$" + a;')), ["removal"]);
});
check("aliased and namespace imports bind the right name", () => {
  const b = packageBindings('import * as ns from "fake-lib";\nimport { a as b } from "fake-lib/sub";', "fake-lib");
  assert.deepStrictEqual(b.bindings.sort(), ["b", "ns"]);
  assert.strictEqual(b.count, 2);
});

// The first version of this check asked each file on its own, and would have blocked
// the change below - a correct, tested migration that moved a call site into a new
// file. Destroying correct work its author never sees is the expensive direction, so
// the question is asked of the whole change instead.
console.log("\ndependencyMisuseReasons - the whole change, not one file at a time");
const multi = (files, over = {}) => dependencyMisuseReasons({ packageName: "fake-lib", files, ...over });

check("a call site moved into a NEW file is not a removal", () =>
  assert.deepStrictEqual(
    multi([
      { relPath: "app.js", beforeText: BEFORE, afterText: 'const { price } = require("./price.js");\nfunction f(a) { return price(a); }' },
      { relPath: "price.js", beforeText: "", afterText: 'const { formatPrice } = require("fake-lib");\nconst price = (a) => formatPrice(a, "USD");\nmodule.exports = { price };' },
    ]),
    []
  )
);
check("but losing it from every file still is", () =>
  assert.deepStrictEqual(
    kinds(multi([
      { relPath: "app.js", beforeText: BEFORE, afterText: 'const { price } = require("./price.js");\nfunction f(a) { return price(a); }' },
      { relPath: "price.js", beforeText: "", afterText: 'const price = (a) => "$" + a.toFixed(2);\nmodule.exports = { price };' },
    ])),
    ["removal"]
  )
);
check("the removal message names the files that used to have it", () =>
  assert.match(multi([{ relPath: "src/cart.js", beforeText: BEFORE, afterText: "const x = 1;" }])[0].reason, /src\/cart\.js/)
);
// Re-binding a name from a wrapper module is ordinary refactoring, not a shadow.
check("re-importing the same name from elsewhere is not shadowing", () =>
  assert.deepStrictEqual(
    multi([
      { relPath: "app.js", beforeText: BEFORE, afterText: 'const formatPrice = require("./shim.js").formatPrice;\nfunction f(a){ return formatPrice(a); }' },
      { relPath: "shim.js", beforeText: "", afterText: 'const lib = require("fake-lib");\nexports.formatPrice = (a) => lib.formatPrice(a, "USD");' },
    ]),
    []
  )
);

// The check that matters most: over every case in the corpus, the rules must fire on
// wrong migrations and stay completely silent on correct ones.
console.log("\ndependencyMisuseReasons - against the whole corpus");
{
  const corpusDir = path.join(root, "calibration");
  const corpus = JSON.parse(fs.readFileSync(path.join(corpusDir, "corpus.json"), "utf8"));
  const beforeText = fs.readFileSync(path.join(root, "test-fixture", "app.js"), "utf8");
  const fire = (c) =>
    dependencyMisuseReasons({
      packageName: corpus.package,
      files: [{
        relPath: corpus.target,
        beforeText,
        afterText: fs.readFileSync(path.join(corpusDir, "cases", c.file), "utf8"),
      }],
    });

  check("NO correct migration is blocked (11 cases)", () =>
    assert.deepStrictEqual(corpus.cases.filter((c) => c.label === "good" && fire(c).length > 0).map((c) => c.file), [])
  );
  // Pinned by name: if a later change quietly stops catching one of these, a count
  // alone would not say which, and these are the reason the rules exist.
  //
  // Six now. `bad-11` moved here from the reviewing model - it calls the library
  // correctly and then throws the answer away, which is a shape a model cleared
  // as readily as it cleared correct work.
  check("the six mechanically-detectable wrong migrations are caught", () =>
    assert.deepStrictEqual(
      corpus.cases.filter((c) => c.label === "bad" && fire(c).length > 0).map((c) => c.file).sort(),
      [
        "bad-01-hardcoded-return.js",
        "bad-03-reimplemented-locally.js",
        "bad-05-monkey-patch.js",
        "bad-08-tolocalestring.js",
        "bad-09-shadowing-stub.js",
        "bad-11-result-discarded.js",
      ]
    )
  );
}

// "The fix did not work" and "the fix worked and uncovered the next problem" used to
// end identically: revert, say "tests still fail", throw away the one thing the run
// learned. This tells them apart. It decides what to SAY - a run whose tests fail is
// still reverted in full either way.
console.log("\nfailureChanged - the same failure, or the next one?");
const ERR_A = "TypeError: currency is required as of fake-lib@2.0.0\n    at formatPrice (/home/x/node_modules/fake-lib/index.js:3:11)";
const ERR_B = 'Error: Cannot find module "other-lib"\n    at Module._load (node:internal/modules/cjs/loader:1215:15)';

check("the same failure at a different line is still the same failure", () =>
  assert.strictEqual(failureChanged(ERR_A, ERR_A.replace("3:11", "9:42")).changed, false)
);
check("a different failure is reported as changed", () => {
  const d = failureChanged(ERR_A, ERR_B);
  assert.strictEqual(d.changed, true);
  assert.deepStrictEqual(d.packages, ["other-lib"]);
});
// New noise on top of the same failure is not progress, so both halves are required:
// the original complaint has to have actually stopped.
check("extra output alongside the SAME error is not progress", () =>
  assert.strictEqual(failureChanged(ERR_A, ERR_A + "\nnpm warn something unrelated").changed, false)
);
check("passing tests are not a changed failure", () =>
  assert.strictEqual(failureChanged(ERR_A, "ok 1 - all good").changed, false)
);
check("stack frames are ignored - they move whenever anyone edits above them", () => {
  const sig = failureSignature(ERR_A);
  assert.strictEqual(sig.length, 1);
  assert.ok(!sig[0].includes("at formatPrice"));
});
check("paths, line numbers and timings are normalised away", () =>
  assert.strictEqual(
    failureSignature("Error: boom /a/b/c.js:12:3 in 41ms")[0],
    failureSignature("Error: boom /x/y/z.js:99:1 in 7ms")[0]
  )
);
check("relative paths are the project's own files, not a dependency", () =>
  assert.deepStrictEqual(packagesNamedIn(["Cannot find module './helpers'"]), [])
);
check("a scoped package keeps both of its segments", () =>
  assert.deepStrictEqual(packagesNamedIn(['Cannot find module "@scope/pkg/sub"']), ["@scope/pkg"])
);
check("the message says what to run next, and admits it is a guess", () => {
  const m = chainedFailureMessage({
    packageName: "fake-lib",
    testCommand: "npm test",
    diff: failureChanged(ERR_A, ERR_B),
  });
  assert.match(m, /other-lib/);
  assert.match(m, /heuristic/);
  assert.match(m, /reverted/);
});
// The package under migration naturally appears in its own error text; suggesting it
// as the next thing to try would be a loop.
check("it does not suggest re-running on the package it just tried", () =>
  assert.ok(
    !/Re-running with/.test(
      chainedFailureMessage({
        packageName: "other-lib",
        testCommand: "npm test",
        diff: failureChanged(ERR_A, ERR_B),
      })
    )
  )
);

console.log("\nnormalizeModelTimeout - a turn limit cannot end a hung request");
check("empty means the 20-minute default", () =>
  assert.strictEqual(normalizeModelTimeout("").minutes, 20)
);
check("0 stays reachable - waiting forever is a real choice", () =>
  assert.strictEqual(normalizeModelTimeout("0").minutes, 0)
);
check("nonsense is an error, not a silent default", () => {
  assert.ok(normalizeModelTimeout("soon").error);
  assert.ok(normalizeModelTimeout("-5").error);
  assert.ok(normalizeModelTimeout("999").error);
});
check("the message says what to do about it", () =>
  assert.match(timeoutReason("reviewer", 20), /model-timeout-minutes/)
);

console.log("\nharnessCrash - a dead runtime is not an agent with no ideas");
// Three benchmark cases sat in NO-CHANGE because the SDK's child process died
// and the message went out as a plain failure. NO-CHANGE is a sentence about the
// product; the agent was never alive long enough for one to be true.
check("the SDK's own wording for a dead child process is caught", () =>
  assert.ok(harnessCrash(new Error("Claude Code process exited with code 1")))
);
check("a plain string is read the same as an Error", () =>
  assert.ok(harnessCrash("process exited with code 143"))
);
check("killed from outside counts - OOM and cancellation both land here", () => {
  assert.ok(harnessCrash("child process terminated by SIGKILL"));
  assert.ok(harnessCrash(new Error("FATAL ERROR: JavaScript heap out of memory")));
});
check("a runtime that was never there counts too", () =>
  assert.ok(harnessCrash("spawn claude ENOENT"))
);
// The narrowness is the point: everything that leaves the denominator has to
// earn it, and a bug in our own loop is a real failure that should stay counted.
check("an ordinary throw from our own code is NOT a harness crash", () => {
  assert.strictEqual(harnessCrash(new Error("Cannot read properties of undefined")), null);
  assert.strictEqual(harnessCrash("the model refused to answer"), null);
});
check("nothing thrown is not a diagnosis", () => {
  assert.strictEqual(harnessCrash(null), null);
  assert.strictEqual(harnessCrash(""), null);
  assert.strictEqual(harnessCrash(new Error("   ")), null);
});
check("the message keeps the raw error and says why it is out of the ratio", () => {
  const m = harnessCrash("Claude Code process exited with code 1");
  assert.match(m, /process exited with code 1/);
  assert.match(m, /harness-error/);
});
// The two files are joined by nothing but this word, exactly as with
// blocked-by-guard above.
check("what the agent emits for a dead runtime is what the benchmark counts as CRASHED", () => {
  const r = benchmarkOutcome({
    baselineExit: "0", finalExit: "1", brokenExit: "1", changed: "false",
    actionOutcome: "harness-error",
    actionSummary: harnessCrash("Claude Code process exited with code 1"),
  });
  // Was BLOCKED, and being out of the denominator is what made it worth
  // checking again: all eight of run #11's blocked legs were this branch, six
  // of them our own Node packaging bug stopping the action before it began. A
  // defect we shipped is not an outage we suffered.
  assert.strictEqual(r.outcome, "CRASHED");
  assert.notStrictEqual(r.outcome, "BLOCKED");
});

check("a crash is not folded into 'produced nothing'", () => {
  // NO-CHANGE says the agent examined the case and had no answer. Saying that
  // about a run where the agent never started is the conflation this whole file
  // exists to prevent, and it would hide our own bugs inside the product's
  // weakest-looking column.
  const r = benchmarkOutcome({
    baselineExit: "0", finalExit: "1", brokenExit: "1", changed: "false",
    actionOutcome: "harness-error",
  });
  assert.notStrictEqual(r.outcome, "NO-CHANGE");
  assert.match(r.detail, /our defect/);
});


console.log("\nrenderSpend - never call another provider's bill a cost");
const usage = (o = {}) => ({
  m: { inputTokens: 12003, outputTokens: 4000, cacheReadInputTokens: 285552, cacheCreationInputTokens: 0, ...o },
});
check("tokens are summed across every model the run touched", () => {
  const t = tokenTotals({
    a: { inputTokens: 10, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    b: { inputTokens: 5, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4 },
  });
  assert.deepStrictEqual([t.input, t.output, t.cacheRead, t.cacheCreation, t.total], [15, 3, 3, 4, 25]);
});
check("junk in modelUsage does not become NaN", () => {
  const t = tokenTotals({ a: null, b: "nope", c: { inputTokens: "7" } });
  assert.strictEqual(t.total, 7);
});
check("on Anthropic's own endpoint the dollar figure is the cost", () =>
  assert.match(renderSpend({ modelUsage: usage(), costUsd: 5.8532 }), /^\$5\.8532 \(/)
);
// The whole point: on someone else's endpoint the number is not a cost and must
// not read like one.
check("on a custom endpoint the dollars are named as Anthropic's list price", () => {
  const s = renderSpend({ modelUsage: usage(), costUsd: 5.8532, customEndpoint: true });
  assert.ok(!/^\$/.test(s), "must not lead with a dollar figure");
  assert.match(s, /priced by your provider/);
  assert.match(s, /Anthropic's list price/);
});
// Cached input is 31x cheaper than fresh input on DeepSeek and 5x on GLM, so a
// single total cannot be turned back into money. The breakdown is the deliverable.
check("the breakdown is itemised, not totalled", () => {
  const s = renderSpend({ modelUsage: usage(), costUsd: 1, customEndpoint: true });
  assert.match(s, /12,003 in/);
  assert.match(s, /285,552 cached/);
  assert.match(s, /4,000 out/);
  assert.ok(!s.includes("301,555"), "a bare total invites multiplying by one rate");
});
check("cache-write is shown only when there was any", () => {
  assert.ok(!renderSpend({ modelUsage: usage() }).includes("cache-write"));
  assert.match(renderSpend({ modelUsage: usage({ cacheCreationInputTokens: 99 }) }), /99 cache-write/);
});
check("no usage reported says so instead of claiming zero tokens", () =>
  assert.strictEqual(renderSpend({ modelUsage: {}, customEndpoint: true }), "tokens not reported")
);

console.log("\nnormalizeVerifyTools - a typo must not silently pick a behaviour");
check("empty and auto both mean auto", () => {
  assert.strictEqual(normalizeVerifyTools("").tools, "auto");
  assert.strictEqual(normalizeVerifyTools("  AUTO ").tools, "auto");
});
check("the usual spellings of off and on are understood", () => {
  for (const v of ["off", "false", "no", "0", "NONE"]) {
    assert.strictEqual(normalizeVerifyTools(v).tools, "off", v);
  }
  for (const v of ["on", "true", "yes", "1"]) {
    assert.strictEqual(normalizeVerifyTools(v).tools, "on", v);
  }
});
check("anything else is an error, not a guess", () => {
  const r = normalizeVerifyTools("maybe");
  assert.ok(r.error);
  assert.match(r.error, /verify-tools/);
});

console.log("\nreviewPassPlan - paying to discover the same thing twice");
check("auto gives the reviewer tools and keeps the fallback", () => {
  const p = reviewPassPlan({ setting: "auto" });
  assert.strictEqual(p.useTools, true);
  assert.strictEqual(p.allowFallback, true);
});
// The point of the whole change: a run that reviews twice (verify-repair) used to
// spend the full turn budget re-learning that this model never converges with tools.
check("auto remembers a burnout for the rest of the run", () => {
  const p = reviewPassPlan({ setting: "auto", toolsBurnedOut: true });
  assert.strictEqual(p.useTools, false);
  assert.strictEqual(p.allowFallback, false);
  assert.match(p.note, /earlier pass/);
});
check("off skips the tool pass outright", () => {
  const p = reviewPassPlan({ setting: "off" });
  assert.strictEqual(p.useTools, false);
  assert.strictEqual(p.allowFallback, false);
  assert.match(p.note, /caps at concerns/);
});
// Someone who insisted on tools wants "the review could not run", not a quieter
// answer substituted for the one they asked for.
check("on insists, and does not fall back", () => {
  const p = reviewPassPlan({ setting: "on" });
  assert.strictEqual(p.useTools, true);
  assert.strictEqual(p.allowFallback, false);
});
check("on does not change its mind after a burnout either", () =>
  assert.strictEqual(reviewPassPlan({ setting: "on", toolsBurnedOut: true }).useTools, true)
);

console.log("\nconfidenceThresholdReport - what the threshold actually buys");
const sample = (label, verdict, confidence) => ({ label, verdict, confidence });
check("a threshold of 0 does nothing at all", () => {
  const r = confidenceThresholdReport([
    sample("good", "not_refuted", 10),
    sample("bad", "refuted", 10),
  ]);
  const row = r.rows.find((x) => x.threshold === 0);
  assert.deepStrictEqual([row.helped, row.falseAlarms, row.defused, row.net], [0, 0, 0, 0]);
});
// `verdict` has three values and caught/missed named two, so a bad diff the
// reviewer would not take a side on fell out of BOTH - and out of the
// denominator calibrate.mjs prints. Measured: 2/3 shown where 2/7 was true.
// The asymmetry ran one way: `doubted` on the good side is `!== not_refuted`
// and absorbs the unsure ones, so being unsure about a GOOD diff counted
// against us while being unsure about a BAD one vanished.
check("a bad diff the reviewer would not judge is counted, not dropped", () => {
  const r = confidenceThresholdReport([
    sample("bad", "refuted", 80),
    sample("bad", "refuted", 80),
    sample("bad", "not_refuted", 80),
    sample("bad", "insufficient_evidence", 80),
    sample("bad", "insufficient_evidence", 80),
    sample("bad", "insufficient_evidence", 80),
    sample("bad", "insufficient_evidence", 80),
  ]);
  assert.strictEqual(r.caught, 2);
  assert.strictEqual(r.missed, 1);
  assert.strictEqual(r.unsure, 4);
  // The whole point: every bad sample is somewhere.
  assert.strictEqual(r.caught + r.missed + r.unsure, 7);
});

check("unsure stays its own count and is not folded into missed", () => {
  // "it did not catch this" and "it declined to say" are different results;
  // merging them would replace one wrong number with a smaller wrong number.
  const r = confidenceThresholdReport([sample("bad", "insufficient_evidence", 50)]);
  assert.strictEqual(r.missed, 0);
  assert.strictEqual(r.unsure, 1);
});

check("flagging a low-confidence approval of a bad diff is the benefit", () => {
  const r = confidenceThresholdReport([sample("bad", "not_refuted", 30)]);
  assert.strictEqual(r.rows.find((x) => x.threshold === 50).helped, 1);
  assert.strictEqual(r.recommended, 35);
});
check("flagging a low-confidence approval of a good diff is the cost", () => {
  const r = confidenceThresholdReport([sample("good", "not_refuted", 30)]);
  assert.strictEqual(r.rows.find((x) => x.threshold === 50).falseAlarms, 1);
  // Nothing to gain anywhere, so it recommends never intervening.
  assert.strictEqual(r.recommended, 0);
});
// The direction people forget: the threshold does not only soften approvals. It
// softens refutations too, and in block mode that is a bad fix going through.
check("defusing a correct refutation is also counted as a cost", () => {
  const r = confidenceThresholdReport([sample("bad", "refuted", 30)]);
  assert.strictEqual(r.rows.find((x) => x.threshold === 50).defused, 1);
  assert.strictEqual(r.recommended, 0);
});
check("insufficient_evidence is untouched - it is already a concern", () => {
  const r = confidenceThresholdReport([
    sample("good", "insufficient_evidence", 5),
    sample("bad", "insufficient_evidence", 5),
  ]);
  assert.ok(r.rows.every((x) => x.helped === 0 && x.falseAlarms === 0 && x.defused === 0));
});
check("ties go to the lowest threshold, because the default is to intervene less", () => {
  const r = confidenceThresholdReport([sample("bad", "not_refuted", 10), sample("good", "not_refuted", 10)]);
  assert.strictEqual(r.recommended, 0);
  assert.strictEqual(r.net, 0);
});
check("it reports how right the reviewer was before any threshold", () => {
  const r = confidenceThresholdReport([
    sample("bad", "refuted", 90),
    sample("bad", "not_refuted", 90),
    sample("good", "not_refuted", 90),
    sample("good", "refuted", 90),
  ]);
  assert.deepStrictEqual([r.caught, r.missed, r.cleared, r.doubted], [1, 1, 1, 1]);
});
check("garbage samples are dropped rather than counted", () => {
  const r = confidenceThresholdReport([
    sample("good", "not_refuted", 50),
    sample("unknown", "not_refuted", 50),
    sample("bad", "not_refuted", NaN),
    null,
  ]);
  assert.strictEqual(r.samples, 1);
});
check("no samples at all does not throw", () => {
  const r = confidenceThresholdReport([]);
  assert.strictEqual(r.samples, 0);
  assert.strictEqual(r.recommended, 0);
});

// -------------------------------------------------------- calibration corpus
//
// The corpus is only worth anything if every case in it passes the tests: a wrong
// migration that fails is caught by the test re-run for free, before a reviewer is
// paid, so it says nothing about a confidence threshold. This runs the fixture's
// own test against every case, in a temp copy, and is why the claim in corpus.json
// is a checked fact rather than a comment.
console.log("\ncalibration corpus - every case must pass the tests");
{
  const corpusDir = path.join(root, "calibration");
  const corpus = JSON.parse(fs.readFileSync(path.join(corpusDir, "corpus.json"), "utf8"));

  check("the corpus is big enough to say anything, and balanced", () => {
    assert.ok(corpus.cases.length >= 20, "want 20+ cases, have " + corpus.cases.length);
    const good = corpus.cases.filter((c) => c.label === "good").length;
    const bad = corpus.cases.filter((c) => c.label === "bad").length;
    assert.ok(good >= 8 && bad >= 8, good + " good / " + bad + " bad");
  });
  check("every case is labelled, unique, and says why", () => {
    const seen = new Set();
    for (const c of corpus.cases) {
      assert.ok(["good", "bad"].includes(c.label), c.file + " has label " + c.label);
      assert.ok(c.why && c.why.length > 20, c.file + " needs a real justification");
      assert.ok(!seen.has(c.file), "duplicate case " + c.file);
      seen.add(c.file);
    }
  });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "patchery-corpus-"));
  try {
    for (const name of ["app.test.js", "package.json", "node_modules"]) {
      fs.cpSync(path.join(root, "test-fixture", name), path.join(tmp, name), { recursive: true });
    }
    for (const c of corpus.cases) {
      check(c.file + " passes the fixture's tests", () => {
        fs.copyFileSync(path.join(corpusDir, "cases", c.file), path.join(tmp, "app.js"));
        const r = spawnSync(process.execPath, ["app.test.js"], { cwd: tmp, encoding: "utf8" });
        assert.strictEqual(r.status, 0, c.file + " must pass:\n" + (r.stdout ?? "") + (r.stderr ?? ""));
      });
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}


// ---------------------------------------------------------------------------
// The test census: what stops a fix from being credited for a suite it shrank.
// ---------------------------------------------------------------------------

const JEST_GREEN = "Test Suites: 99 passed, 99 total\nTests:       5 skipped, 1085 passed, 1090 total\n";
const JEST_RED = "Test Suites: 25 failed, 11 passed, 36 of 99 total\nTests:       3 failed, 136 passed, 139 total\n";
const VITEST_GREEN = " Test Files  2 passed (2)\n      Tests  18 passed (18)\n";
const VITEST_RED = "      Tests  3 failed | 15 passed (18)\n";
const MOCHA_GREEN = "  18 passing (2s)\n  1 pending\n";
const MOCHA_RED = "  15 passing (2s)\n  3 failing\n";
const TAP_GREEN = "# tests 18\n# pass 18\n# fail 0\n";

check("census reads a jest summary", () => {
  const c = census(JEST_GREEN);
  assert.strictEqual(c.runner, "jest");
  assert.strictEqual(c.passed, 1085);
  assert.strictEqual(c.total, 1090);
});

check("census reads a jest run that ended early", () => {
  const c = census(JEST_RED);
  assert.strictEqual(c.failed, 3);
  assert.strictEqual(c.passed, 136);
});

check("census reads vitest, green and red", () => {
  assert.strictEqual(census(VITEST_GREEN).passed, 18);
  assert.strictEqual(census(VITEST_RED).failed, 3);
  assert.strictEqual(census(VITEST_RED).passed, 15);
});

check("census reads mocha", () => {
  const c = census(MOCHA_GREEN);
  assert.strictEqual(c.runner, "mocha");
  assert.strictEqual(c.passed, 18);
  assert.strictEqual(c.total, 19); // 18 passing + 1 pending
});

check("census reads node:test / TAP", () => {
  assert.strictEqual(census(TAP_GREEN).passed, 18);
});

check("census survives terminal colour", () => {
  const coloured = "\u001b[2m      Tests \u001b[22m \u001b[1m\u001b[32m18 passed\u001b[39m\u001b[22m\u001b[90m (18)\u001b[39m\n";
  assert.strictEqual(census(coloured).passed, 18);
});

// The refusal matters more than any parse. A runner we cannot read must not be
// reported as a suite of zero tests, because zero would make every later
// comparison look like a catastrophic shrink - or, worse, like a clean pass.
check("census refuses rather than guessing zero", () => {
  const c = census("some runner nobody has taught us about\nDone in 4.2s\n");
  assert.strictEqual(c.runner, null);
  assert.strictEqual(c.total, null);
});

// 13 of run #11's 42 legs printed no "-> agent finished" line at all, so their
// turn and spend record is simply gone. The line lived after the SDK loop and
// read from `result`, which a stall, a deadline and a dead child process all
// leave null. And because spend() was called INSIDE that log statement, a leg
// that skipped the line skipped its own accounting too - one bug wearing two of
// the six repair items.
check("agentFinishedLine reports a completed run the way it always did", () => {
  const line = agentFinishedLine({ subtype: "success", turns: 12, spend: "$0.0300" });
  assert.match(line, /agent finished: success/);
  assert.match(line, /turns: 12/);
  assert.match(line, /spend: \$0\.0300/);
});

check("agentFinishedLine says 'not recorded', never 0, for what it did not see", () => {
  // Zero is a measurement. Printing it for "we never looked" is exactly how a
  // benchmark starts lying about itself - the same error as counting a missing
  // census as a suite of no tests.
  const line = agentFinishedLine({});
  assert.match(line, /not reported/);
  assert.match(line, /turns: not recorded/);
  assert.match(line, /spend: not recorded/);
  assert.doesNotMatch(line, /: 0\b/);
});

check("agentFinishedLine marks a spend figure the fixer never contributed to as partial", () => {
  // The reviewer and the classifier report through the same counter, so the
  // number is real even when the fixer died. Real and short - and a reader who
  // is not told it is short will read it as the bill.
  const line = agentFinishedLine({ turns: 7, spend: "900 in · 40 out tokens", partial: true });
  assert.match(line, /partial - the fixer never reported/);
  assert.match(line, /turns: 7/);
});

check("agentFinishedLine does not call a finished run partial", () => {
  const line = agentFinishedLine({ subtype: "error_max_turns", turns: 45, spend: "$1.20", partial: false });
  assert.doesNotMatch(line, /partial/);
  assert.match(line, /error_max_turns/);
});

check("censusHeld passes when the same tests still pass", () => {
  const r = censusHeld(census(JEST_GREEN), census(JEST_GREEN));
  assert.strictEqual(r.ok, true);
});

// This is the case the whole census exists for: a green run that is green
// because the tests that would have failed are no longer being run.
check("censusHeld catches a suite that got smaller", () => {
  const shrunk = "Tests:       0 skipped, 900 passed, 900 total\n";
  const r = censusHeld(census(JEST_GREEN), census(shrunk));
  assert.strictEqual(r.ok, false);
  assert.match(r.why, /got smaller/);
});

// The anti-shrink check was vacuous whenever the baseline counted zero: every
// possible `after` is "not fewer" than none, so the verdict came back ok:true
// with the sentence "3 of 0 baseline tests still pass". A suite that shrank
// from 237 to 1 passed it too.
//
// Not hypothetical: mocha prints "0 passing" when the break stops every spec
// from loading, and totals from that line, where jest and vitest refuse an
// empty run. Packaging breaks are 11 of our 14 verified cases.
// Read back from benchmark #11's own artifacts: all 21 uncountable "after" runs
// were explained, and none was a parsing defect. 18 were suites that never
// loaded (the break was not fixed, so the import still throws), 3 were yup /
// type-fest, whose test command is eslint. All four FIXED legs counted fine.
// The check was working; it just could not say so, and the first reader
// concluded it had failed in half the run.
check("census names the suite that never loaded, rather than shrugging", () => {
  const c = census("Error [ERR_REQUIRE_ESM]: require() of ES Module /app/node_modules/is-stream/index.js");
  assert.strictEqual(c.total, null);
  assert.match(c.reason, /never loaded/);
});

// Six legs of benchmark #11 ended here, all node-fetch, and they were being
// filed as "unrecognised runner" - which reads as a weakness in this parser
// when it is the exact breaking change those cases exist to test, landing.
//
// Two independent clauses catch it, so they get two fixtures. A single sample
// carrying both signals cannot tell which one is doing the work, and a mutation
// run proved that: deleting either clause left the suite green.
check("the ESM export message alone is enough to know the suite never loaded", () => {
  const c = census(
    "> mocha\n\nfile:///case/src/index.js:15\nimport dataUriToBuffer from 'data-uri-to-buffer';\n" +
      "SyntaxError: The requested module 'data-uri-to-buffer' does not provide an export named 'default'\n"
  );
  assert.strictEqual(c.total, null);
  assert.match(c.reason, /never loaded/);
});

check("loader frames alone are enough, even with no message we know", () => {
  const c = census(
    "> mocha\n\nSyntaxError: Unexpected token '?'\n" +
      "    at ModuleJob._instantiate (node:internal/modules/esm/module_job:123:21)\n"
  );
  assert.strictEqual(c.total, null);
  assert.match(c.reason, /never loaded/);
});

check("a SyntaxError without loader frames is not called a load failure", () => {
  // A passing suite can print the words. Only a SyntaxError raised BY the module
  // loader means a file never ran, and that distinction is the whole point.
  const c = census("some output mentioning SyntaxError in a message\nand nothing else\n");
  assert.doesNotMatch(c.reason, /never loaded/);
});

check("census knows a linter is not a test runner", () => {
  const c = census("  1079:3  error  Expected type to be:\n\n✖ 3 problems (3 errors, 0 warnings)\n");
  assert.strictEqual(c.total, null);
  assert.match(c.reason, /linter or type check/);
});

check("an import failure is reported as that, not as a linter", () => {
  // A suite that fails to import can also print a SyntaxError, and a linter run
  // can mention modules. The more specific cause has to win, or 18 legs get
  // filed under the explanation that fits 3.
  const c = census("SyntaxError: Unexpected token\nCannot find module 'is-stream'\n✖ 1 problem (1 error, 0 warnings)");
  assert.match(c.reason, /never loaded/);
});

check("census says nothing ran when there is no output at all", () => {
  assert.match(census("").reason, /no output at all/);
  assert.match(census("   \n ").reason, /no output at all/);
});

check("a counted run carries no reason to explain away", () => {
  assert.strictEqual(census(MOCHA_GREEN).reason, null);
  assert.strictEqual(census(JEST_GREEN).reason, null);
});

check("the pull request table repeats the reason, not a shrug", () => {
  const before = census(MOCHA_GREEN);
  const after = census("Error [ERR_REQUIRE_ESM]: require() of ES Module");
  const cell = censusTableCell(before, after, censusHeld(before, after));
  assert.match(cell, /^incomplete —/);
  assert.match(cell, /never loaded/);
});

// The hole the second blind round found, reproduced before it was closed: a
// suite of 100 passing and 20 failing, where the agent marks those 20 `.skip`
// and repairs nothing, returns 100 passing and 20 skipped. Comparing only the
// passing count, that verdict was ok:true - "100 of 100 baseline tests still
// pass" - while the suite had gone green by silencing exactly the tests the
// break was failing.
check("censusHeld refuses a suite that went green by skipping", () => {
  const before = census("Tests:       20 failed, 100 passed, 120 total\n");
  const after = census("Tests:       20 skipped, 100 passed, 120 total\n");
  const r = censusHeld(before, after);
  assert.strictEqual(r.ok, false);
  assert.match(r.why, /20 more test\(s\) are skipped/);
});

check("skipping is refused even when more tests pass than before", () => {
  // The flattering direction, and the one a count alone cannot see: the agent
  // repairs some tests AND silences others, and the passing total goes up.
  const before = census("Tests:       30 failed, 100 passed, 130 total\n");
  const after = census("Tests:       10 skipped, 120 passed, 130 total\n");
  assert.strictEqual(censusHeld(before, after).ok, false);
});

check("a suite that skipped from the start may keep skipping that many", () => {
  // Not a rule against skipped tests - a rule against skipping MORE. A project
  // with permanently skipped specs is normal and must not be refused for it.
  const before = census("Tests:       5 skipped, 100 passed, 105 total\n");
  const after = census("Tests:       5 skipped, 100 passed, 105 total\n");
  assert.strictEqual(censusHeld(before, after).ok, true);
  const fewer = census("Tests:       2 skipped, 103 passed, 105 total\n");
  assert.strictEqual(censusHeld(before, fewer).ok, true, "un-skipping is progress");
});

check("censusHeld refuses a baseline of zero instead of passing everything", () => {
  const none = census("  0 passing (1ms)\n");
  assert.strictEqual(none.total, 0, "mocha really does report this shape");
  const r = censusHeld(none, census(MOCHA_GREEN));
  assert.strictEqual(r.ok, null);
  assert.match(r.why, /ran no tests at all/);
});

check("a zero baseline does not launder a suite that actually shrank", () => {
  const r = censusHeld(census("  0 passing (1ms)\n"), census("  1 passing (2s)\n"));
  assert.notStrictEqual(r.ok, true);
});

check("censusTableCell says the baseline was empty, not that the check held", () => {
  const none = census("  0 passing (1ms)\n");
  const after = census(MOCHA_GREEN);
  const c = censusTableCell(none, after, censusHeld(none, after));
  assert.match(c, /^did not run —/);
  assert.match(c, /ran no tests at all/);
});

check("a real baseline of one test is still a baseline", () => {
  // The refusal is for zero, not for "small". A one-test suite that keeps its
  // one test has genuinely held, and refusing it would be a different bug.
  const one = census("  1 passing (1ms)\n");
  assert.strictEqual(censusHeld(one, census("  1 passing (2s)\n")).ok, true);
});

check("censusHeld says 'cannot tell' rather than 'fine' when it cannot parse", () => {
  assert.strictEqual(censusHeld(census("mystery"), census(JEST_GREEN)).ok, null);
  assert.strictEqual(censusHeld(census(JEST_GREEN), census("mystery")).ok, null);
});

// The census ran, decided, and told nobody outside the CI log. A pull request
// reported the sibling gate ("were any test files modified") and said nothing
// about this one, so a run where the suite size was never checked was
// indistinguishable from a run where it was checked and held. Measured on run
// #11: the one reproducible FIXED case could not be counted in all three of its
// legs, and no reader of those pull requests could have known.
const cell = (b, a) => censusTableCell(census(b), census(a), censusHeld(census(b), census(a)));

// Two blind rounds, different providers, gave the same reason for refusing a
// single number here: our 14 cases are 11 packaging breaks and 3 API changes,
// and a figure over both is four-fifths decided by the class where success
// means least. It also moves when we author more cases while the tool stays
// identical - which makes it a fact about the suite, not the artefact.
check("the report splits the count by what broke", () => {
  const groups = [
    { repo: "a", package: "p", breakClass: "packaging", runs: 3, distinct: ["FIXED"], stable: true },
    { repo: "b", package: "q", breakClass: "packaging", runs: 3, distinct: ["NO-CHANGE"], stable: true },
    { repo: "c", package: "r", breakClass: "api", runs: 3, distinct: ["NO-CHANGE"], stable: true },
  ];
  const lines = byBreakClass(groups, [groups[0]]).join("\n");
  assert.match(lines, /\| packaging \| 1 \| 2 \|/);
  assert.match(lines, /\| api \| 0 \| 1 \|/);
});

check("the split prints counts and refuses percentages", () => {
  // At three cases a clean sweep is still consistent with a true rate below
  // half. A percentage here would be a number where there is no measurement.
  const groups = [
    { repo: "a", package: "p", breakClass: "packaging", runs: 3, distinct: ["FIXED"], stable: true },
    { repo: "c", package: "r", breakClass: "api", runs: 3, distinct: ["FIXED"], stable: true },
  ];
  const lines = byBreakClass(groups, groups).join("\n");
  assert.doesNotMatch(lines, /%/);
  assert.match(lines, /Counts, not rates/);
});

check("one class, or none labelled, prints no split at all", () => {
  // A one-row breakdown implies a comparison nobody made, and older results
  // carry no class field. Silence is the honest output.
  const one = [{ repo: "a", package: "p", breakClass: "packaging", runs: 1, distinct: ["FIXED"], stable: true }];
  assert.deepStrictEqual(byBreakClass(one, one), []);
  const none = [{ repo: "a", package: "p", runs: 1, distinct: ["FIXED"], stable: true }];
  assert.deepStrictEqual(byBreakClass(none, none), []);
});

check("a case keeps its class even when only one leg carries it", () => {
  // The three legs of a case are the same case. A leg written before the field
  // existed must not blank the class for the other two.
  const g = repeatGroups([
    { repo: "a", package: "p", version: "3", outcome: "FIXED" },
    { repo: "a", package: "p", version: "3", outcome: "FIXED", breakClass: "api" },
  ]);
  assert.strictEqual(g.length, 1);
  assert.strictEqual(g[0].breakClass, "api");
});

check("censusTableCell reports the counts when the census held", () => {
  const c = cell(JEST_GREEN, JEST_GREEN);
  assert.match(c, /^held —/);
  assert.match(c, /1085 of 1085/);
  assert.match(c, /jest/);
});

check("censusTableCell distinguishes an uncountable baseline from an uncountable final run", () => {
  // Different failures, and the second is the one run #11 kept hitting. Reporting
  // them with one sentence would hide which half of the comparison was missing.
  const noBefore = cell("mystery", MOCHA_GREEN);
  const noAfter = cell(MOCHA_GREEN, "mystery");
  assert.match(noBefore, /^did not run —/);
  assert.match(noBefore, /never established/);
  assert.match(noAfter, /^incomplete —/);
  assert.match(noAfter, /18 passing before the fix \(mocha\)/);
  assert.notStrictEqual(noBefore, noAfter);
});

check("censusTableCell is never blank, whatever it is handed", () => {
  // A blank cell is the bug this row exists to fix: it reads as a check that
  // passed. Nothing - not a missing verdict, not a null count - may produce one.
  for (const c of [
    cell("mystery", "mystery"),
    censusTableCell(null, null, null),
    censusTableCell(census(JEST_GREEN), census(JEST_GREEN), undefined),
  ]) {
    assert.ok(c.trim().length > 0, "the cell must say something: " + JSON.stringify(c));
    assert.doesNotMatch(c, /undefined|null|NaN/);
  }
});

check("censusTableCell answers for a shrunken suite even though a PR never shows it", () => {
  // ok:false reverts and opens nothing, so this cell cannot reach a pull request
  // today. It is written anyway: the function must be total, so that a later
  // caller which reports before deciding cannot print a blank.
  const c = cell(JEST_GREEN, "Tests:       5 passed, 5 total\n");
  assert.match(c, /^blocked —/);
  assert.match(c, /suite got smaller/);
});

// censusHeld returns a tri-state and benchmarkOutcome read it as a boolean, so
// "I could not count" printed as nothing at all: the row said "tests green
// again" and looked exactly like one where the census was taken and held. That
// is the half of FIXED this file's own header calls "and the same tests are
// green" going unproven and unmentioned.
//
// The OUTCOME is deliberately still FIXED - changing it moves the case across
// the denominator line the founder is still deciding. What must not happen is
// it being silent about why.
// actionSummary is a shared channel. On a real stall it carries guard.mjs's
// timeoutReason, written by fail(), which also sets outcome `failed`. On an
// ordinary unproductive run it carries the MODEL's own closing message. An
// unanchored search of that field let the model move its own failed case out of
// the denominator by describing a stall in prose.
// deadline() always knew which brake closed - budgetReason() says "The model was
// answering - this is not a stall" in as many words - but both exits called
// fail() with the default outcome, so both arrived as `failed` and were filed
// NO-CHANGE: "Patchery had nothing to offer". Five legs of run #11 were that,
// and on 102045049614 the agent had already written the named-import migration
// and said it was about to verify when the clock cut it.
// From benchmark #11's log, verbatim: "Discarding 2 unverified change(s):
// jest.config.js, through2-shim.cjs". Forty-five minutes of work, deleted. The
// reviewer's blocking path had saved its patch since the beginning, for the
// reason its own comment gives - a gate whose failure mode is destroying work
// gets switched off by the first person it burns - and the cap and stall paths
// reverted the same way while saving nothing.
// The turn budget was always legible - "turns: 37" against a cap of 45 - and the
// clock was not. That asymmetry decided an experiment: with only a binary
// outcome no affordable design can tell whether a ceiling binds, and the
// distance to it can. through2's one success used 37 of 45 turns while its two
// failures stopped exactly at the cap; the clock had no equivalent sentence.
check("budgetUsage reports the distance to the ceiling, not just the time", () => {
  const u = budgetUsage(20 * 60 * 1000, 45);
  assert.strictEqual(u.minutes, 20);
  assert.strictEqual(u.budget, 45);
  assert.strictEqual(u.percent, 44);
  assert.match(budgetUsageLine(u), /20m of 45m \(44%\)/);
});

check("budgetUsage returns nothing when there is no ceiling to be a fraction of", () => {
  // 0 means the ceiling was removed. A percentage of no ceiling is not zero, it
  // is nothing - and printing 0% would read as "used none of its budget", which
  // is the opposite of "had no budget".
  assert.strictEqual(budgetUsage(60000, 0), null);
  assert.strictEqual(budgetUsage(60000, null), null);
  assert.strictEqual(budgetUsageLine(null), "");
});

check("budgetUsage does not invent a number from a broken clock", () => {
  assert.strictEqual(budgetUsage(-1, 45), null);
  assert.strictEqual(budgetUsage(NaN, 45), null);
  assert.strictEqual(budgetUsage("later", 45), null);
});

check("budgetUsage says over 100 rather than clamping", () => {
  // A run that overran its budget is exactly the row worth seeing. Clamping to
  // 100% would hide the overrun inside the ordinary case.
  assert.strictEqual(budgetUsage(50 * 60 * 1000, 45).percent, 111);
});

check("gapStats splits model time from local work", () => {
  // The first version called every gap "waiting" and the dry run showed why that
  // was wrong: 1889s of it in a 1920s run, because the gap before a tool result
  // is the tool RUNNING and this suite takes minutes. Real number, false label.
  const s = gapStats([
    { ms: 90000, kind: "assistant" },
    { ms: 240000, kind: "user" },
    { ms: 1000, kind: "assistant" },
  ]);
  assert.strictEqual(s.count, 3);
  assert.strictEqual(s.modelSec, 91);
  assert.strictEqual(s.localSec, 240);
  assert.strictEqual(s.longestSec, 240);
  assert.strictEqual(s.slow, 1, "only model waits count as slow - a long test run is not a slow provider");
  assert.match(gapStatsLine(s), /model: 91s, local: 240s/);
});

check("gapStats does not call a long local step a slow provider", () => {
  // The whole point of the split. A four-minute test run must not be reported as
  // the model taking four minutes to answer.
  const s = gapStats([{ ms: 600000, kind: "user" }]);
  assert.strictEqual(s.modelSec, 0);
  assert.strictEqual(s.slow, 0);
  assert.strictEqual(s.localSec, 600);
});

check("gapStats says nothing when no message ever arrived", () => {
  assert.strictEqual(gapStats([]), null);
  assert.strictEqual(gapStats(null), null);
  assert.strictEqual(gapStatsLine(null), "");
});

check("gapStats drops unreadable gaps instead of counting them as zero", () => {
  // Zero is a measurement: a gap of no time. Reading a missing one as zero would
  // make a stalling provider look responsive.
  const s = gapStats([{ ms: 1000, kind: "assistant" }, { ms: NaN }, { ms: -5 }, { ms: "x" }, { ms: 3000, kind: "user" }]);
  assert.strictEqual(s.count, 2);
  assert.strictEqual(s.totalSec, 4);
});

check("patchNote says where the work went AND that it is unverified", () => {
  const n = patchNote(true, "/tmp/sma-capped.patch", "The partial work");
  assert.match(n, /\/tmp\/sma-capped\.patch/);
  // Both halves, always. A saved patch that reads like a fix is worse than no
  // patch: on this path the tests were never run against it, which is why the
  // run failed.
  assert.match(n, /unverified/);
  assert.match(n, /git apply/);
});

check("patchNote does not call a patch untested when the tests rejected it", () => {
  // The default sentence is true of a stall or a cap and false of the path where
  // the re-run happened and failed. poison-red printed it that way once.
  const n = patchNote(
    true,
    "/tmp/sma-unverified.patch",
    "The change that did not hold",
    "It is not a fix: your tests were run against it and they failed."
  );
  assert.match(n, /run against it and they failed/);
  assert.doesNotMatch(n, /never run against it/);
});

check("patchNote admits a save that did not happen instead of claiming one", () => {
  const n = patchNote(false, "/tmp/sma-capped.patch", "The partial work");
  assert.match(n, /could not be saved/);
  assert.doesNotMatch(n, /git apply/);
});

check("untrackedHunk emits headers git apply actually needs", () => {
  // Without `diff --git` and an `@@` range, git apply exits 0 and restores
  // NOTHING. Verified on a real repository: the command reported success and the
  // created file stayed missing - which would have made our own sentence,
  // "recover it with `git apply`", false in the case that matters most.
  // through2-shim.cjs, the file benchmark #11 lost, was created from scratch.
  const h = untrackedHunk("through2-shim.cjs", "const a = 1;\nmodule.exports = a;\n");
  assert.match(h, /^diff --git a\/through2-shim\.cjs b\/through2-shim\.cjs$/m);
  assert.match(h, /^new file mode 100644$/m);
  assert.match(h, /^--- \/dev\/null$/m);
  assert.match(h, /^@@ -0,0 \+1,2 @@$/m);
  assert.match(h, /^\+const a = 1;$/m);
});

check("untrackedHunk counts the lines it claims in the range header", () => {
  // A wrong count is the difference between a patch that applies and one git
  // rejects, and nothing else in the file would notice.
  for (const [body, n] of [["a\n", 1], ["a\nb\n", 2], ["a\n\nb\n", 3], ["a", 1]]) {
    assert.match(untrackedHunk("f", body), new RegExp("@@ -0,0 \\+1," + n + " @@"));
  }
});

check("untrackedHunk records a missing final newline", () => {
  // Applied without the marker the file comes back byte-different from what the
  // agent wrote, which is not the recovery we promised.
  assert.match(untrackedHunk("f", "a\nb"), /\\ No newline at end of file/);
  assert.doesNotMatch(untrackedHunk("f", "a\nb\n"), /No newline/);
});

check("untrackedHunk marks every line, including blank ones", () => {
  const body = untrackedHunk("x.js", "a\n\nb\n").split("\n");
  const hunk = body.slice(body.findIndex((l) => l.startsWith("@@")) + 1).filter((l) => l !== "");
  for (const line of hunk) {
    assert.ok(line.startsWith("+"), "unmarked line in patch body: " + JSON.stringify(line));
  }
});

check("deadlineOutcome separates the clock we set from the model going quiet", () => {
  assert.strictEqual(deadlineOutcome("budget"), "run-budget-exhausted");
  assert.strictEqual(deadlineOutcome("stall"), "failed");
});

check("deadlineOutcome does not invent a budget stop out of an unknown brake", () => {
  // Anything that is not explicitly the budget keeps the old outcome. Guessing
  // the other way would move runs INTO the flattering column, which is the one
  // direction this file is not allowed to guess in.
  for (const odd of [null, undefined, "", "other", "BUDGET "]) {
    assert.strictEqual(deadlineOutcome(odd), "failed");
  }
});

check("a wall-clock stop lands as EXHAUSTED, not NO-CHANGE", () => {
  const r = benchmarkOutcome({
    baselineExit: "0", brokenExit: "1", finalExit: "1", changed: "false",
    actionOutcome: "run-budget-exhausted",
    stepOutcome: "failure",
  });
  assert.strictEqual(r.outcome, "EXHAUSTED");
  assert.match(r.detail, /wall-clock budget/);
});

check("EXHAUSTED says which budget ended, because they need different fixes", () => {
  const turns = benchmarkOutcome({
    baselineExit: "0", brokenExit: "1", finalExit: "1", changed: "false",
    actionOutcome: "error_max_turns", stepOutcome: "failure",
  });
  assert.strictEqual(turns.outcome, "EXHAUSTED");
  assert.match(turns.detail, /turn budget/);
  assert.doesNotMatch(turns.detail, /wall-clock/);
});

check("a plain failure is still not EXHAUSTED", () => {
  // The whole change rests on the outcome slug being distinct. If `failed` began
  // matching, every crash would be credited as a run we cut short.
  const r = benchmarkOutcome({
    baselineExit: "0", brokenExit: "1", finalExit: "1", changed: "false",
    actionOutcome: "failed", stepOutcome: "failure",
  });
  assert.notStrictEqual(r.outcome, "EXHAUSTED");
});

check("a real stall is UNANSWERED - counted, and not confused with our setup", () => {
  const r = benchmarkOutcome({
    baselineExit: "0", brokenExit: "1", finalExit: "1", changed: "false",
    actionOutcome: "failed",
    actionSummary: "the agent produced nothing for 20 minutes and was stopped. This is a stalled request, not a slow one",
  });
  // Was BLOCKED. The model going quiet is not our container failing to start,
  // and both blind rounds gave the same reason for never dropping it silently:
  // outages fall hardest on the longest attempts, so deleting them flatters
  // exactly the runs that were going worst.
  assert.strictEqual(r.outcome, "UNANSWERED");
  assert.notStrictEqual(r.outcome, "BLOCKED");
});

check("BLOCKED still means our setup, and the branches that mean it are untouched", () => {
  // Narrowing must not empty the column. These are the real exclusions: the
  // case never started green, and the version we asked for is not the one that
  // landed. Both say the measurement never happened, not that the tool failed.
  const red = benchmarkOutcome({ baselineExit: "1" });
  assert.strictEqual(red.outcome, "BLOCKED");
  const wrongVersion = benchmarkOutcome({
    baselineExit: "0", brokenExit: "1", finalExit: "0", changed: "false",
    version: "3", installed: "2.0.1",
  });
  assert.strictEqual(wrongVersion.outcome, "BLOCKED");
});

check("the model describing a stall in its own summary cannot leave the denominator", () => {
  const r = benchmarkOutcome({
    baselineExit: "0", brokenExit: "1", finalExit: "1", changed: "false",
    actionOutcome: "no-changes",
    actionSummary:
      "**What the agent concluded.**\n\nI tried three approaches. The second one was " +
      "a stalled request against the registry, so I gave up.",
  });
  // NO-CHANGE is in the denominator. BLOCKED is not, and BLOCKED is the
  // flattering answer here, which is why this direction is the one to pin.
  assert.strictEqual(r.outcome, "NO-CHANGE");
});

check("a FIXED row whose census could not be counted says so", () => {
  const r = benchmarkOutcome({
    baselineExit: "0", brokenExit: "1", finalExit: "0", changed: "true",
    before: { total: 100, passed: 100 }, after: null,
  });
  assert.strictEqual(r.outcome, "FIXED");
  assert.match(r.detail, /no final count/);
});

check("an unreadable baseline is named too, not just an unreadable final count", () => {
  const r = benchmarkOutcome({
    baselineExit: "0", brokenExit: "1", finalExit: "0", changed: "true",
    before: null, after: { total: 100, passed: 100 },
  });
  assert.match(r.detail, /no baseline count/);
});

check("a census that was taken and held still reads as before", () => {
  // The regression guard on the other side: adding the caveat must not put one
  // on rows that earned their number.
  const r = benchmarkOutcome({
    baselineExit: "0", brokenExit: "1", finalExit: "0", changed: "true",
    before: { total: 100, passed: 100 }, after: { total: 100, passed: 100 },
  });
  assert.match(r.detail, /100 of 100 baseline tests still pass/);
  assert.doesNotMatch(r.detail, /not recognized/);
});

check("the rendered block names an uncounted after-census instead of omitting it", () => {
  const text = renderOutcome({
    repo: "acme/app", pkg: "p", version: "3", outcome: "FIXED", detail: "tests green again",
    before: { total: 100, passed: 100, runner: "jest" }, after: null,
  });
  // The old text stopped at "passing before the break", which reads as a
  // complete sentence and hides that the judging half is missing.
  assert.match(text, /NOT COUNTED/);
});

// ---------------------------------------------------------------------------
// Benchmark outcomes: the row that ends up in front of investors.
// ---------------------------------------------------------------------------

check("outcome BLOCKED when the case never started green", () => {
  const r = benchmarkOutcome({ baselineExit: "1" });
  assert.strictEqual(r.outcome, "BLOCKED");
});

check("outcome FIXED when the tests are green and the suite is intact", () => {
  const r = benchmarkOutcome({
    baselineExit: "0", brokenExit: "1", finalExit: "0", changed: "true",
    before: census(JEST_GREEN), after: census(JEST_GREEN),
  });
  assert.strictEqual(r.outcome, "FIXED");
});

// A green suite that shrank must never be credited, and the census is asked
// before the exit code precisely so that it cannot be.
check("outcome WRONG when the tests are green but fewer of them ran", () => {
  const shrunk = "Tests:       0 skipped, 900 passed, 900 total\n";
  const r = benchmarkOutcome({
    baselineExit: "0", brokenExit: "1", finalExit: "0", changed: "true",
    before: census(JEST_GREEN), after: census(shrunk),
  });
  assert.strictEqual(r.outcome, "WRONG");
  assert.match(r.detail, /got smaller/);
});

check("outcome WRONG when a change shipped and the tests are still red", () => {
  const r = benchmarkOutcome({
    baselineExit: "0", brokenExit: "1", finalExit: "1", changed: "true",
    before: census(JEST_GREEN), after: census(JEST_RED),
  });
  assert.strictEqual(r.outcome, "WRONG");
});

// REFUSED is the product's claim, not a failure. It has to be countable
// separately or the table measures somebody else's product.
check("outcome REFUSED is kept apart from NO-CHANGE", () => {
  const refused = benchmarkOutcome({
    baselineExit: "0", brokenExit: "1", finalExit: "1", changed: "false",
    actionOutcome: "refused: the reviewer refuted the fix",
    before: census(JEST_GREEN), after: census(JEST_RED),
  });
  assert.strictEqual(refused.outcome, "REFUSED");

  const nothing = benchmarkOutcome({
    baselineExit: "0", brokenExit: "1", finalExit: "1", changed: "false",
    actionOutcome: "the agent made no edits",
    before: census(JEST_GREEN), after: census(JEST_RED),
  });
  assert.strictEqual(nothing.outcome, "NO-CHANGE");
});

check("a refuted review counts as REFUSED even when the outcome is quiet", () => {
  const r = benchmarkOutcome({
    baselineExit: "0", brokenExit: "1", finalExit: "1", changed: "false", review: "refuted",
    before: census(JEST_GREEN), after: census(JEST_RED),
  });
  assert.strictEqual(r.outcome, "REFUSED");
});

check("parseArgs turns a missing flag into an empty string, not undefined", () => {
  const a = parseArgs(["--repo", "a/b", "--changed"]);
  assert.strictEqual(a.repo, "a/b");
  assert.strictEqual(a.changed, "");
});


// A run where the break never installed is not a fact about Patchery. The first
// benchmark run ended green and was filed as NO-CHANGE, from a container whose
// dependency may never have been upgraded at all.
check("outcome BLOCKED when the requested version is not what installed", () => {
  const r = benchmarkOutcome({
    baselineExit: "0", brokenExit: "1", finalExit: "0", changed: "false",
    version: "3", installed: "1.0.0",
  });
  assert.strictEqual(r.outcome, "BLOCKED");
  assert.match(r.detail, /the break was not present/);
});

check("a matching major is not treated as a mismatch", () => {
  const r = benchmarkOutcome({
    baselineExit: "0", brokenExit: "1", finalExit: "1", changed: "false",
    version: "3", installed: "3.0.1", actionOutcome: "refused",
  });
  assert.strictEqual(r.outcome, "REFUSED");
});

check("an unknown installed version does not block the run", () => {
  const r = benchmarkOutcome({
    baselineExit: "0", brokenExit: "1", finalExit: "1", changed: "false", version: "3", installed: "",
  });
  assert.strictEqual(r.outcome, "NO-CHANGE");
});


// The version probe. It was written the obvious way first - resolving
// `<pkg>/package.json` - and the obvious way is blind to exactly the packages
// this benchmark exists to measure: an ESM-only major declares an `exports` map
// that makes every path but its entry point unreachable, so the probe threw and
// the run reported the upgrade as never installed.
const fakeFs = (files) => ({
  exists: (p) => norm(p) in files,
  readFile: (p) => files[norm(p)],
});
// Windows resolves "/w/case" to "C:\w\case", so the fake filesystem has to
// speak both dialects: separators normalised and any drive letter dropped.
const norm = (p) => String(p).split("\\").join("/").replace(/^[A-Za-z]:/, "");

check("findInstalled reads the version from node_modules", () => {
  const r = findInstalled(
    "content-disposition",
    "/w/case",
    fakeFs({ "/w/case/node_modules/content-disposition/package.json": '{"version":"3.0.0"}' })
  );
  assert.strictEqual(r.version, "3.0.0");
});

// A hoisted dependency in a monorepo lives above the workspace member, so
// reading only the target directory would call an installed package missing.
check("findInstalled climbs to a hoisted dependency", () => {
  const r = findInstalled(
    "pino",
    "/w/packages/server",
    fakeFs({ "/w/node_modules/pino/package.json": '{"version":"10.1.0"}' })
  );
  assert.strictEqual(r.version, "10.1.0");
});

check("findInstalled handles a scoped package", () => {
  const r = findInstalled(
    "@mui/material",
    "/w",
    fakeFs({ "/w/node_modules/@mui/material/package.json": '{"version":"9.0.0"}' })
  );
  assert.strictEqual(r.version, "9.0.0");
});

check("findInstalled reports null rather than guessing when nothing is there", () => {
  const r = findInstalled("nope", "/w/case", { exists: () => false, readFile: () => "" });
  assert.strictEqual(r.version, null);
});

// An unreadable package.json is not evidence of absence; keep climbing.
check("findInstalled steps over a corrupt package.json", () => {
  const r = findInstalled(
    "pino",
    "/w/packages/server",
    fakeFs({
      "/w/packages/server/node_modules/pino/package.json": "{not json",
      "/w/node_modules/pino/package.json": '{"version":"10.1.0"}',
    })
  );
  assert.strictEqual(r.version, "10.1.0");
});


// The break has to exist in the container doing the grading. Three benchmark
// runs handed express to Patchery with the new major installed and the suite
// green; the agent said "already passes, nothing to fix" - true, and written
// down as a fact about the product rather than about our setup.
check("outcome BLOCKED when the suite is still green after the upgrade", () => {
  const r = benchmarkOutcome({
    baselineExit: "0",
    brokenExit: "0",
    version: "3",
    installed: "3.0.0",
    changed: "false",
    actionOutcome: "nothing-to-do",
  });
  assert.strictEqual(r.outcome, "BLOCKED");
  assert.match(r.detail, /no break in this container/);
});

check("outcome BLOCKED when the run never checked whether the break was there", () => {
  const r = benchmarkOutcome({ baselineExit: "0", brokenExit: "", changed: "false" });
  assert.strictEqual(r.outcome, "BLOCKED");
});

// A red suite is the precondition, not the finding: once it is met, the agent's
// own behaviour is what gets graded.
check("a confirmed break lets the agent be graded normally", () => {
  const r = benchmarkOutcome({
    baselineExit: "0",
    brokenExit: "1",
    version: "3",
    installed: "3.0.0",
    changed: "false",
    actionOutcome: "refused: the reviewer refuted the fix",
  });
  assert.strictEqual(r.outcome, "REFUSED");
});


// Which Node the tests run on decides what "the tests pass" means, and a wrong
// answer is invisible - green run, clean summary, wrong version. It has gone
// wrong in both directions: too low made a healthy repository look broken, too
// high made a confirmed break disappear.
check("lowestMajor takes the major, not the lowest digit", () => {
  assert.strictEqual(lowestMajor(">=22.0.0"), "22");
  assert.strictEqual(lowestMajor("^20 || ^22"), "20");
  assert.strictEqual(lowestMajor(">=18.17.0 <21"), "18");
  assert.strictEqual(lowestMajor("20.x"), "20");
});

// ">=22.0.0" read as bare digits gives 22, 0, 0 - and setup-node installs Node
// 0.12.18 from 2015, which fails two steps later inside corepack, naming nothing.
check("lowestMajor never returns zero", () => {
  assert.notStrictEqual(lowestMajor(">=22.0.0"), "0");
  assert.strictEqual(lowestMajor("0.0.0"), null);
});

check("lowestMajor refuses a range with no numbers", () => {
  assert.strictEqual(lowestMajor("*"), null);
  assert.strictEqual(lowestMajor(""), null);
  assert.strictEqual(lowestMajor(undefined), null);
});

check("fromNvmrc strips the v and the newline", () => {
  assert.strictEqual(fromNvmrc("v22.11.0\n"), "22.11.0");
  assert.strictEqual(fromNvmrc("18\n"), "18");
  assert.strictEqual(fromNvmrc("lts/hydrogen\n"), null);
});

const fakeDir = (files) => ({
  exists: (p) => norm2(p) in files,
  readFile: (p) => files[norm2(p)],
});
const norm2 = (p) => String(p).split("\\").join("/").replace(/^[A-Za-z]:/, "");

// The action asked PATH which Node was "the runner's own" and PATH answered with
// the caller's. Six legs of run #11 started Patchery's own code on Node 16.20.2
// and died in 6.1-8.6 seconds; the comment guarding against it had named this
// exact package years-deep in advance. These check the sentence that replaces
// nine seconds of silence.
check("ourNodeReason passes a Node this code is actually tested on", () => {
  assert.strictEqual(ourNodeReason("v20.20.2"), null);
  assert.strictEqual(ourNodeReason("v22.19.0"), null);
  assert.strictEqual(ourNodeReason("v" + OUR_NODE_FLOOR + ".0.0"), null);
});

check("ourNodeReason refuses the version that actually killed six legs", () => {
  const why = ourNodeReason("v16.20.2");
  assert.match(why, /Node 16/);
  assert.match(why, /needs 18 or newer/);
  // The message has to say which Node it is talking about. "Wrong Node version"
  // sends the reader to their .nvmrc, which is not the file at fault.
  assert.match(why, /not the Node your tests run on/);
});

check("ourNodeReason treats an unreadable version as a failure, never as a pass", () => {
  // Reading a missing version as 0 would refuse everything; reading it as fine
  // is how the original line was written. Both are wrong, and only one is quiet.
  for (const bad of ["", null, undefined, "node", "vNOT RESOLVABLE", "  "]) {
    assert.ok(ourNodeReason(bad), "must refuse: " + JSON.stringify(bad));
  }
});

check("decideNodeVersion prefers .nvmrc", () => {
  const r = decideNodeVersion("/w", fakeDir({ "/w/.nvmrc": "v22.11.0\n", "/w/package.json": '{"engines":{"node":">=18"}}' }));
  assert.strictEqual(r.version, "22.11.0");
  assert.strictEqual(r.source, ".nvmrc");
});

check("decideNodeVersion falls back to engines.node", () => {
  const r = decideNodeVersion("/w", fakeDir({ "/w/package.json": '{"engines":{"node":">=22.0.0"}}' }));
  assert.strictEqual(r.version, "22");
  assert.strictEqual(r.source, "engines.node");
});

// A project that says nothing gets a stated fallback, and the summary says the
// project said nothing - so the assumption is visible rather than inferred.
check("decideNodeVersion names its source when the project is silent", () => {
  const r = decideNodeVersion("/w", fakeDir({ "/w/package.json": "{}" }));
  assert.strictEqual(r.version, FALLBACK);
  assert.match(r.source, /does not say/);
});

check("decideNodeVersion steps over an unusable .nvmrc", () => {
  const r = decideNodeVersion("/w", fakeDir({ "/w/.nvmrc": "lts/*\n", "/w/package.json": '{"engines":{"node":"^20"}}' }));
  assert.strictEqual(r.version, "20");
});


// The break classifier. Its whole reason to exist is that Node states the kind
// of failure in its own error code, and the agent was spending turns
// rediscovering what the first line of the log already said.
// KINDS is precedence-ordered and the first kind matching ANY line wins, so
// `engine` sitting above `not-a-function` meant one npm warning anywhere in the
// log rewrote a fixable API break as "no code change fixes this". Measured on
// 2026-09-08: identical TypeError, `not-a-function` without the warning and
// `engine` with it.
//
// It matters because of the direction. `engine` carries inScope: false, the only
// gate that opens NEEDS-DECISION, and that outcome does not count against us -
// so a warning was moving cases out of the failure column.
check("a package manager warning does not outrank the actual failure", () => {
  const withWarning =
    "npm warn EBADENGINE Unsupported engine {node:'>=22'}\n  TypeError: ct.parse is not a function";
  const withoutWarning = "  TypeError: ct.parse is not a function";
  assert.strictEqual(classifyFailure(withWarning).kind, "not-a-function");
  assert.strictEqual(classifyFailure(withoutWarning).kind, "not-a-function");
  // yarn words it differently and must be read the same way.
  assert.strictEqual(
    classifyFailure('warning pkg@1: The engine "node" appears to be invalid.\n  TypeError: x is not a function').kind,
    "not-a-function"
  );
});

// Demoted, not deleted. Sometimes the warning really is the only clue - a project
// on an old Node installs a package needing a new one and the visible failure is
// downstream and strange - so a warning still decides when nothing else spoke.
check("a warning still classifies when the log says nothing else", () => {
  const only = "npm warn EBADENGINE Unsupported engine {node:'>=22'}\nnpm warn deprecated foo@1";
  assert.strictEqual(classifyFailure(only).kind, "engine");
  assert.strictEqual(classifyFailure(only).inScope, false);
});

check("a real engine error is still an engine break", () => {
  assert.strictEqual(classifyFailure("npm error code EBADENGINE\nnpm error Unsupported engine").kind, "engine");
  assert.strictEqual(classifyFailure("Error: Unsupported engine: requires Node 22").kind, "engine");
});

check("classifyFailure recognises the ESM boundary, from express's real output", () => {
  const real =
    " Exception during run: Error [ERR_REQUIRE_ESM]: require() of ES Module " +
    "/home/runner/work/case/node_modules/content-disposition/dist/index.js from " +
    "/home/runner/work/case/lib/response.js not supported.";
  const c = classifyFailure(real);
  assert.strictEqual(c.kind, "esm-require");
  assert.strictEqual(c.inScope, "partial");
  assert.match(c.evidence, /ERR_REQUIRE_ESM/);
});

check("classifyFailure recognises a removed subpath", () => {
  const c = classifyFailure("Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: Package subpath './lib' is not defined");
  assert.strictEqual(c.kind, "exports-blocked");
  assert.strictEqual(c.inScope, true);
});

// The one class Patchery must NOT try to fix: no call-site edit raises the
// project's Node version, and pretending otherwise ships a change that cannot work.
check("classifyFailure marks an engine requirement as out of scope", () => {
  const c = classifyFailure("npm warn EBADENGINE Unsupported engine { required: { node: '>=22' } }");
  assert.strictEqual(c.kind, "engine");
  assert.strictEqual(c.inScope, false);
  assert.match(c.strategy, /not a code break/);
});

check("classifyFailure recognises the ordinary migration case", () => {
  const c = classifyFailure("TypeError: parse is not a function");
  assert.strictEqual(c.kind, "not-a-function");
  assert.strictEqual(c.inScope, true);
});

check("classifyFailure recognises a changed return shape", () => {
  const c = classifyFailure("TypeError: Cannot read properties of undefined (reading 'value')");
  assert.strictEqual(c.kind, "shape-change");
});

// A module that will not load reports itself before any call inside it can
// fail, so the loading problem has to win - and the classification has to be
// repeated after each fix, because one wall hides the next.
check("a loading failure outranks a call failure in the same log", () => {
  const both = ["TypeError: parse is not a function", "Error [ERR_REQUIRE_ESM]: require() of ES Module x"].join("\n");
  assert.strictEqual(classifyFailure(both).kind, "esm-require");
});

check("classifyFailure sees through terminal colour", () => {
  const coloured = "[31mError [ERR_REQUIRE_ESM]: require() of ES Module x[39m";
  assert.strictEqual(classifyFailure(coloured).kind, "esm-require");
});

// Refusing to guess is the point. An unrecognised failure gives the agent no
// briefing at all, which is exactly where it stood before this existed.
check("classifyFailure returns a null kind rather than guessing", () => {
  const c = classifyFailure("Something nobody has taught us about\nDone in 4.2s");
  assert.strictEqual(c.kind, null);
  assert.strictEqual(c.inScope, null);
  assert.strictEqual(briefing(c), "");
});

check("the briefing says the classification can be overruled by the code", () => {
  const b = briefing(classifyFailure("Error [ERR_REQUIRE_ESM]: require() of ES Module x"));
  assert.match(b, /advisory/);
  assert.match(b, /believe the code/);
});


// "Stop" must never mean "go quiet". A run that cannot edit its way out still
// owes the maintainer the analysis it paid for - which of their decisions would
// unblock the upgrade, and what was checked to be sure.
check("an out-of-scope strategy still demands a recommendation", () => {
  for (const src of ["Error [ERR_REQUIRE_ESM]: require() of ES Module x", "npm warn EBADENGINE Unsupported engine"]) {
    const c = classifyFailure(src);
    assert.match(c.strategy, /write the recommendation/);
    assert.match(c.strategy, /which/);
  }
});

check("the escape hatches are named and refused", () => {
  const c = classifyFailure("Error [ERR_REQUIRE_ESM]: require() of ES Module x");
  assert.match(c.strategy, /do not re-implement it/);
  assert.match(c.strategy, /not pin/);
});


// Reading the CI workflow, from the two real files that motivated it.
check("ciNodeVersions reads a matrix list", () => {
  const express = "        node-version: [18, 19, 20, 21, 22, 23, 24, 25, 26]\n";
  assert.deepStrictEqual(ciNodeVersions(express), [18, 19, 20, 21, 22, 23, 24, 25, 26]);
});

check("ciNodeVersions reads a single pinned version", () => {
  assert.deepStrictEqual(ciNodeVersions("        node-version: [22.x]\n"), [22]);
});

// `${{ matrix.node-version }}` names a version without stating one; counting it
// as data would put whatever digits appear in the expression into the answer.
check("ciNodeVersions skips expressions and non-numeric values", () => {
  const mixed = [
    "          node-version: ${{ matrix.node-version }}",
    "          node-version: 'lts/*'",
    "          node-version: latest",
    "        node-version: [20]",
  ].join("\n");
  assert.deepStrictEqual(ciNodeVersions(mixed), [20]);
});

const fakeRepo = (files, dirs = {}) => ({
  exists: (p) => normC(p) in files,
  readFile: (p) => files[normC(p)],
  listDir: (p) => dirs[normC(p)] || [],
});
const normC = (p) => String(p).split("\\").join("/").replace(/^[A-Za-z]:/, "");

// The failure this whole source exists for: knex declares `>=16` as its runtime
// floor, its CI runs 22, and Node 16 could not even load a devDependency - so
// the batch reported "already failing at this commit" about knex, for our choice.
check("decideNodeVersion prefers CI over engines.node", () => {
  const r = decideNodeVersion(
    "/w",
    fakeRepo(
      {
        "/w/package.json": '{"engines":{"node":">=16"}}',
        "/w/.github/workflows/coverage.yml": "        node-version: [22.x]\n",
      },
      { "/w/.github/workflows": ["coverage.yml"] }
    )
  );
  assert.strictEqual(r.version, "22");
  assert.match(r.source, /CI/);
});

// The lowest version CI runs is the floor the maintainers commit to, so a break
// there is a real break for them. Taking the highest would have hidden the
// express ESM case, which only appears below Node 22.
check("decideNodeVersion takes the lowest version CI runs, not the highest", () => {
  const r = decideNodeVersion(
    "/w",
    fakeRepo(
      { "/w/.github/workflows/ci.yml": "        node-version: [18, 20, 22, 24]\n" },
      { "/w/.github/workflows": ["ci.yml"] }
    )
  );
  assert.strictEqual(r.version, "18");
});

// A codeql or release workflow can name a Node that has nothing to do with the
// test suite, and would quietly become the answer.
check("decideNodeVersion prefers a test-shaped workflow over the others", () => {
  const r = decideNodeVersion(
    "/w",
    fakeRepo(
      {
        "/w/.github/workflows/codeql.yml": "          node-version: 14\n",
        "/w/.github/workflows/ci.yml": "        node-version: [20, 22]\n",
      },
      { "/w/.github/workflows": ["codeql.yml", "ci.yml"] }
    )
  );
  assert.strictEqual(r.version, "20");
});

check(".nvmrc still wins over the CI files", () => {
  const r = decideNodeVersion(
    "/w",
    fakeRepo(
      { "/w/.nvmrc": "v22.11.0\n", "/w/.github/workflows/ci.yml": "        node-version: [18]\n" },
      { "/w/.github/workflows": ["ci.yml"] }
    )
  );
  assert.strictEqual(r.version, "22.11.0");
});

check("decideNodeVersion falls back to engines.node when there is no CI to read", () => {
  const r = decideNodeVersion("/w", fakeRepo({ "/w/package.json": '{"engines":{"node":">=22.0.0"}}' }));
  assert.strictEqual(r.version, "22");
  assert.strictEqual(r.source, "engines.node");
});


// Suites that need something the container does not have. Every string here is
// the real `scripts.test` of a repository whose verdict came back "already
// failing at this commit" when it was in fact perfectly healthy.
// Both lists were written from the flags that had already bitten, and the
// spelling that bit is not the only spelling. Measured 2026-09-08: `jest -u` was
// refused while `jest --updateSnapshot` was accepted, and `--watch` refused while
// `--watchAll` was accepted - the long forms being the ones people actually write
// in a package.json.
//
// A rewriting script is the quieter of the two failures: it makes "the tests
// pass" mean nothing, because the run edited the thing judging it.
// isHarnessConfig recognised .mocharc.json and settingValues could not read a
// single key inside it, because the pattern went from the key straight to the
// colon and JSON puts a closing quote in between. Measured 2026-09-08: narrowing
// `spec` in .mocharc.json returned null while the identical narrowing in
// .mocharc.js was refused.
//
// Worse than an unprotected file. An unprotected file is a gap someone can see;
// this looked like protection and was not, and .mocharc.json is the form the
// mocha docs show first.
check("a judged setting is read in JSON syntax as well as JS", () => {
  assert.ok(harnessConfigReason('{"spec":"test/**/*.js"}', '{"spec":"test/only.js"}'));
  assert.ok(harnessConfigReason('module.exports={spec:"test/**/*.js"}', 'module.exports={spec:"test/only.js"}'));
  assert.ok(harnessConfigReason('{"testMatch":["**/*.test.js"]}', '{"testMatch":["**/one.test.js"]}'));
  assert.ok(harnessConfigReason('{"spec":"test/**"}', '{"spec":"test/**","bail":true}'));
});

// The other half of the same rule: changing how a dependency is COMPILED is a
// legitimate migration and must still pass. A fix that refuses everything is not
// a fix.
check("a legitimate transform change is still allowed in JSON", () => {
  assert.strictEqual(harnessConfigReason('{"spec":"test/**"}', '{"spec":"test/**"}'), null);
  assert.strictEqual(
    harnessConfigReason('{"transform":{"^.+\\.js$":"babel-jest"}}', '{"transform":{"^.+\\.m?js$":"babel-jest"}}'),
    null
  );
});

// scriptsTamperReason stops `"test": "jest"` becoming `"test": "echo ok"`, and
// has nothing to say about `"test": "make test"` - where the definition of
// passing lives in a Makefile no rule covered. Refused by name because these
// files are never a call site of a JavaScript dependency migration.
check("the task runner a test script delegates to is protected", () => {
  for (const p of ["Makefile", "makefile", "GNUmakefile", "sub/Makefile", "Taskfile.yml", "justfile", "Rakefile"]) {
    assert.match(String(protectedReason(p)), /task runner file/, p + " is editable");
  }
});

check("a source file that merely mentions a task runner is not protected", () => {
  for (const p of ["lib/utils.js", "src/makefile-parser.js", "docs/Makefile.md"]) {
    assert.strictEqual(protectedReason(p), null, p + " was refused");
  }
});

check("a snapshot-rewriting test script never enters the pool", () => {
  for (const s of [
    "jest --updateSnapshot",
    "jest -u",
    "jest --update-snapshot",
    "vitest --update",
    "vitest -u",
    "prettier --write .",
    "eslint --fix .",
  ]) {
    const r = testScriptUsable(s);
    assert.strictEqual(r.ok, false, s + " was accepted");
    assert.match(r.why, /rewrites files/);
  }
});

check("a watching test script never enters the pool", () => {
  for (const s of ["jest --watch", "jest --watchAll", "mocha --watch-files test", "jest --watch=true"]) {
    const r = testScriptUsable(s);
    assert.strictEqual(r.ok, false, s + " was accepted");
    assert.match(r.why, /watches/);
  }
});

check("an ordinary test script still passes", () => {
  for (const s of ["mocha test/", "jest --ci --coverage", "vitest run", "npm run build && mocha"]) {
    assert.strictEqual(testScriptUsable(s).ok, true, s + " was refused");
  }
});

// The cost of matching these as prefixes, recorded rather than hidden: a flag
// that spells out NOT doing the thing is refused too. The bias is deliberate and
// the same one isProductWorkspace takes - excluding a candidate costs one row out
// of 133, while admitting a script that rewrites its own judge costs a benchmark
// row that looks real and measures nothing.
check("the prefix match over-excludes, and that is the chosen direction", () => {
  assert.strictEqual(testScriptUsable("jest --updateSnapshotIfNeeded=false").ok, false);
});

check("testScriptUsable rejects a suite that needs a browser", () => {
  for (const script of [
    "node run-tests.js && phantomjs tests/browser.js",
    "cypress run",
    "playwright test",
    "karma start --single-run",
    "wdio run wdio.conf.js",
  ]) {
    const r = testScriptUsable(script);
    assert.strictEqual(r.ok, false, script);
    assert.match(r.why, /browser or a container/);
  }
});

check("testScriptUsable rejects a suite that needs a container", () => {
  const r = testScriptUsable("docker-compose up -d && mocha test/");
  assert.strictEqual(r.ok, false);
});

// knex's `npm test` runs its integration suite against postgres, mysql and
// mariadb. The container has none of them.
check("testScriptUsable rejects an integration suite", () => {
  const r = testScriptUsable("npm run test:integration");
  assert.strictEqual(r.ok, false);
  assert.match(r.why, /integration/);
});

// The filter has to stay narrow: these are ordinary unit suites and every one
// of them produced a usable verdict.
check("testScriptUsable still accepts the suites that worked", () => {
  for (const script of [
    "mocha --require test/support/env --reporter spec --check-leaks test/ test/acceptance/",
    "jest --maxWorkers=50%",
    "vitest run",
    "node --test",
    "nyc mocha",
  ]) {
    assert.strictEqual(testScriptUsable(script).ok, true, script);
  }
});

// A word that merely contains one of the names is not evidence.
check("testScriptUsable does not reject on a coincidental substring", () => {
  assert.strictEqual(testScriptUsable("jest test/integrations-of-ours.test.js").ok, true);
  assert.strictEqual(testScriptUsable("mocha test/dockerfile-parser.test.js").ok, true);
});


// "Ran out of turns" is not "had no idea". The first benchmark filed seven runs
// as NO-CHANGE when every one of them was mid-investigation when the budget ended.
check("outcome EXHAUSTED when the turn budget ran out", () => {
  for (const said of ["inconclusive", "error_max_turns", "the agent used all 25 turns"]) {
    const r = benchmarkOutcome({
      baselineExit: "0", brokenExit: "1", changed: "false", actionOutcome: said,
    });
    assert.strictEqual(r.outcome, "EXHAUSTED", said);
  }
});

check("outcome NO-CHANGE stays for a run that simply produced nothing", () => {
  const r = benchmarkOutcome({
    baselineExit: "0", brokenExit: "1", changed: "false", actionOutcome: "no-changes",
  });
  assert.strictEqual(r.outcome, "NO-CHANGE");
});

// A refusal is the product working and must not be reclassified as a budget
// problem, whichever word the action happened to use.
check("a refusal is still REFUSED, not EXHAUSTED", () => {
  const r = benchmarkOutcome({
    baselineExit: "0", brokenExit: "1", changed: "false",
    actionOutcome: "refused: the reviewer refuted the fix",
  });
  assert.strictEqual(r.outcome, "REFUSED");
});


// Edge cases in the binding detector, found by probing it rather than by reading
// it. It feeds the check that asks whether a "migration" quietly stopped using
// the package, so a blind spot here is a removal that ships.

// Commenting an import out is the most ordinary way to stop using something, and
// the text left behind still said `require('pkg')`.
check("packageBindings ignores a commented-out import", () => {
  const r = packageBindings("// const x = require('pkg')\nlocalGo()", "pkg");
  assert.strictEqual(r.count, 0);
  assert.deepStrictEqual(r.bindings, []);
});

check("packageBindings ignores a block-commented import", () => {
  const r = packageBindings("/*\nimport x from 'pkg'\n*/\nlocalGo()", "pkg");
  assert.strictEqual(r.count, 0);
});

// A `//` in the middle of a line is far more often a URL than a comment, and
// eating the rest of that line would hide real code - a worse failure than the
// one the comment-stripping fixes.
check("packageBindings does not mistake a URL for a comment", () => {
  const r = packageBindings("const u = 'https://x.dev'; const x = require('pkg'); x.go()", "pkg");
  assert.strictEqual(r.count, 1);
  assert.deepStrictEqual(r.bindings, ["x"]);
});

// `import 'pkg'` binds nothing, so it counted as nothing - and a polyfill or a
// registration import could be deleted with no reason raised.
check("packageBindings counts a side-effect import as a use", () => {
  const r = packageBindings("import 'pkg'\ndoWork()", "pkg");
  assert.strictEqual(r.count, 1);
  assert.deepStrictEqual(r.bindings, []);
});

check("dependencyMisuseReasons catches a deleted side-effect import", () => {
  const out = dependencyMisuseReasons({
    packageName: "pkg",
    files: [{ relPath: "a.js", beforeText: "import 'pkg'\ndoWork()", afterText: "doWork()" }],
  });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].kind, "removal");
});

// The forms that must keep working, including the one an ESM migration produces.
check("packageBindings still reads every ordinary import form", () => {
  const cases = [
    ["const x = require('pkg')\nx.go()", ["x"]],
    ["import x from 'pkg'\nx.go()", ["x"]],
    ["import { a, b as c } from 'pkg'\na();c()", ["a", "c"]],
    ["import * as ns from 'pkg'\nns.go()", ["ns"]],
    ["const m = await import('pkg')\nm.go()", []],
    ["export * from 'pkg'", []],
  ];
  for (const [text, bindings] of cases) {
    const r = packageBindings(text, "pkg");
    assert.ok(r.count > 0, text);
    assert.deepStrictEqual(r.bindings, bindings, text);
  }
});

// A package whose name is a prefix of another must not answer for it.
check("packageBindings does not match a longer package name", () => {
  assert.strictEqual(packageBindings("const x = require('pkg-other')\nx.go()", "pkg").count, 0);
});

check("packageBindings reads scoped packages and their subpaths", () => {
  assert.deepStrictEqual(packageBindings("import { Button } from '@mui/material'\nButton()", "@mui/material").bindings, [
    "Button",
  ]);
  assert.strictEqual(packageBindings("import x from '@mui/material/Button'\nx()", "@mui/material").count, 1);
});


// Credentials inside a URL. Every other pattern looks for a token shaped like a
// token; this is a password that can be shaped like anything, and only its
// position marks it. `anthropic-base-url` is exactly where one would appear.
check("redactSecrets removes credentials embedded in a URL", () => {
  const out = redactSecrets("endpoint https://user:supersecret@api.example.com/v1 ok");
  assert.ok(!out.includes("supersecret"), out);
  assert.ok(!out.includes("user:"), out);
});

// The scheme and host stay: a log that says which endpoint was called is worth
// having, and neither of them is the secret.
check("redactSecrets keeps the scheme and host of a redacted URL", () => {
  const out = redactSecrets("https://user:supersecret@api.example.com/v1");
  assert.match(out, /^https:\/\//);
  assert.ok(out.includes("api.example.com"), out);
});

check("redactSecrets leaves an ordinary URL alone", () => {
  const url = "https://api.example.com/v1/messages";
  assert.strictEqual(redactSecrets("calling " + url), "calling " + url);
});

// A colon in a URL is usually a port, not a password.
check("redactSecrets does not mistake a port for a credential", () => {
  const url = "http://localhost:3000/health";
  assert.strictEqual(redactSecrets("calling " + url), "calling " + url);
});

// The signature normaliser exists so a re-run of the same failure compares equal.
// A duration printed in brackets was surviving it, so an identical failure could
// be reported as a different one.
check("failureSignature ignores a duration wherever it appears", () => {
  const a = failureSignature("Tests: 1 failed, 5 passed");
  const b = failureSignature("Tests: 1 failed, 5 passed (2.3s)");
  assert.deepStrictEqual(a, b);
});

check("failureSignature still separates genuinely different failures", () => {
  const a = failureSignature("TypeError: parse is not a function");
  const b = failureSignature("TypeError: format is not a function");
  assert.notDeepStrictEqual(a, b);
});


// The most important rule in the guard is "never edit a test", and it had a
// spelling that turned it off. On macOS and Windows these are the same file as
// their lowercase form; on Linux they can differ, and refusing both is the safe
// direction - declining to edit `Tests/foo.Test.js` costs nothing.
check("protectedReason is not fooled by capitalisation", () => {
  for (const f of ["TEST/A.TEST.JS", "Tests/foo.Test.js", "src/__TESTS__/a.js", "A.SPEC.TS"]) {
    assert.ok(protectedReason(f), f + " should be protected");
  }
});

check("a setup file is refused whatever its capitalisation", () => {
  for (const f of ["src/setupTests.ts", "src/SetupTests.ts", "Vitest.Setup.TS"]) {
    assert.match(protectedReason(f) || "", /setup file/, f);
  }
});

check("harness config is recognised whatever its capitalisation", () => {
  for (const f of ["Jest.Config.js", "vitest.config.ts", "Karma.Conf.JS"]) {
    assert.ok(isHarnessConfig(f), f);
  }
});

// Capitalisation must not start protecting ordinary source.
check("protectedReason leaves ordinary source alone whatever its case", () => {
  for (const f of ["src/a.js", "Src/Components/Button.tsx", "lib/Latest.js", "src/contest.js"]) {
    assert.strictEqual(protectedReason(f), null, f);
  }
});

// `src/../../etc/passwd` starts with `src/`, so a prefix check called it inside
// the target directory while it pointed two levels above the repository. Git does
// not produce such a path today - which is exactly the reasoning that stops being
// true without anyone noticing.
check("outOfScopeReason resolves .. before deciding", () => {
  assert.ok(outOfScopeReason("src/../../etc/passwd", "src", []));
  assert.ok(outOfScopeReason("src/../lib/a.js", "src", []));
});

check("outOfScopeReason still allows .. that stays inside", () => {
  assert.strictEqual(outOfScopeReason("src/a/../b.js", "src", []), null);
  assert.strictEqual(outOfScopeReason("./src/a.js", "src", []), null);
  assert.strictEqual(outOfScopeReason("src//a.js", "src", []), null);
});

// An allowed path must not become a way back in either.
check("allowed paths cannot be escaped with ..", () => {
  assert.ok(outOfScopeReason("shared/../../secrets.env", "src", ["shared"]));
  assert.strictEqual(outOfScopeReason("shared/x.js", "src", ["shared"]), null);
});


// A check that rewrites the code is not a check. `lint: "eslint . --fix"` is an
// ordinary way to write it, and running it during verification would edit the
// diff under judgement - the lint's own changes arriving in the pull request as
// the agent's work, and a lint failure fixing itself into a pass.
check("detectExtraChecks skips a check that rewrites files", () => {
  for (const body of ["eslint . --fix", "prettier --write .", "jest -u", "eslint . --fix --cache"]) {
    const found = detectExtraChecks(JSON.stringify({ scripts: { lint: body } }));
    assert.deepStrictEqual(found, [], body);
  }
});

check("detectExtraChecks still finds the read-only ones", () => {
  const found = detectExtraChecks(JSON.stringify({ scripts: { typecheck: "tsc --noEmit", lint: "eslint ." } }));
  assert.deepStrictEqual(
    found.map((c) => c.name),
    ["typecheck", "lint"]
  );
});

// A flag that merely contains the letters must not disable a good check.
check("detectExtraChecks is not fooled by a lookalike flag", () => {
  const found = detectExtraChecks(JSON.stringify({ scripts: { lint: "eslint . --fix-type problem --max-warnings 0" } }));
  assert.deepStrictEqual(found.map((c) => c.name), ["lint"]);
});

// Every way of neutering the judge, taken from what an agent could plausibly try.
check("scriptsTamperReason catches every way of softening the test command", () => {
  const before = JSON.stringify({ scripts: { test: "jest", lint: "eslint ." } });
  const attacks = [
    { test: "echo ok", lint: "eslint ." },
    { test: "jest --passWithNoTests", lint: "eslint ." },
    { test: "jest || true", lint: "eslint ." },
    { test: "jest; exit 0", lint: "eslint ." },
    { test: "jest --testPathIgnorePatterns=broken", lint: "eslint ." },
    { lint: "eslint ." },
    { test: "jest", lint: "eslint . || true" },
    { test: "jest", lint: "eslint .", posttest: "echo done" },
  ];
  for (const scripts of attacks) {
    assert.ok(scriptsTamperReason(before, JSON.stringify({ scripts })), JSON.stringify(scripts));
  }
});

check("scriptsTamperReason stays quiet when the scripts are untouched", () => {
  const same = JSON.stringify({ scripts: { test: "jest", lint: "eslint ." } });
  assert.strictEqual(scriptsTamperReason(same, same), null);
});


// Calling the dependency and throwing the answer away, while something else
// produces the result. Corpus case bad-11, previously only the reviewing model's
// job - and reviewing models cleared this class as readily as correct work.
check("dependencyMisuseReasons catches a result that is now discarded", () => {
  const out = dependencyMisuseReasons({
    packageName: "fake-lib",
    files: [
      {
        relPath: "app.js",
        beforeText: "const { formatPrice } = require('fake-lib')\nreturn `Total: ${formatPrice(a)}`",
        afterText: "const { formatPrice } = require('fake-lib')\nformatPrice(a, 'USD');\nreturn `Total: $${a.toFixed(2)}`",
      },
    ],
  });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].kind, "removal");
  assert.match(out[0].reason, /no longer uses what it returns/);
});

// Stated as a regression, never as an opinion about what a call is for. A library
// that was always called for its side effects must not trip a check that blocks
// and reverts.
check("a call that never returned anything useful is left alone", () => {
  const side = "const { register } = require('fake-lib')\nregister();\ndoWork()";
  const out = dependencyMisuseReasons({
    packageName: "fake-lib",
    files: [{ relPath: "a.js", beforeText: side, afterText: side + "\nmore()" }],
  });
  assert.deepStrictEqual(out, []);
});

// Still consumed somewhere is still consumed.
check("one discarded call among used ones is not a removal", () => {
  const out = dependencyMisuseReasons({
    packageName: "fake-lib",
    files: [
      {
        relPath: "a.js",
        beforeText: "const { f } = require('fake-lib')\nconst x = f(1)",
        afterText: "const { f } = require('fake-lib')\nf(1);\nconst x = f(2)",
      },
    ],
  });
  assert.deepStrictEqual(out, []);
});

// A call spanning lines does not match the bare form, and counts as consumed -
// the safe direction for a check that blocks and reverts.
check("a multi-line call is treated as consumed", () => {
  const out = dependencyMisuseReasons({
    packageName: "fake-lib",
    files: [
      {
        relPath: "a.js",
        beforeText: "const { f } = require('fake-lib')\nconst x = f(1)",
        afterText: "const { f } = require('fake-lib')\nconst x = f(\n  1,\n  'USD'\n)",
      },
    ],
  });
  assert.deepStrictEqual(out, []);
});


// A provider that stopped answering is not a product result. Four cases in the
// second benchmark read "no fix produced: failed" - an agent with no ideas - when
// the logs said the model had produced nothing for twenty minutes.
check("a stall is separated from 'no fix produced', and now counted", () => {
  const r = benchmarkOutcome({
    baselineExit: "0",
    brokenExit: "1",
    changed: "false",
    actionOutcome: "failed",
    actionSummary:
      "the fixing agent produced nothing for 20 minutes and was stopped. This is a stalled request, not a slow one",
  });
  // The separation is the original point and still holds: "no fix produced" is
  // an agent with no ideas, and this was a model that never replied. What
  // changed is the side of the denominator it lands on - the model is part of
  // what we ship, so a run nobody got an answer from is a failed run for
  // whoever was waiting.
  assert.strictEqual(r.outcome, "UNANSWERED");
  assert.notStrictEqual(r.outcome, "NO-CHANGE");
  assert.match(r.detail, /stopped answering/);
});

// It must not swallow the results that ARE about the product.
// From a real cancelled batch: four legs killed seven minutes in came out
// "NO-CHANGE - no fix produced", and the table said "0 fixed of 4 cases it was
// able to attempt" about runs that had attempted none of them.
check("a cancelled run is BLOCKED, not an agent with no ideas", () => {
  const base = { baselineExit: "0", finalExit: "1", brokenExit: "1", changed: "", actionOutcome: "" };
  for (const stepOutcome of ["cancelled", "Cancelled", "skipped"]) {
    const r = benchmarkOutcome({ ...base, stepOutcome });
    assert.strictEqual(r.outcome, "BLOCKED", stepOutcome);
    assert.match(r.detail, /nothing here is about the fix/);
  }
});

check("an action that wrote no outputs at all is BLOCKED too", () => {
  // Every path out of agent.mjs writes its outputs, its error path included, so
  // nothing at all means the process was stopped before it got there.
  const r = benchmarkOutcome({ baselineExit: "0", finalExit: "1", brokenExit: "1", changed: "", actionOutcome: "" });
  assert.strictEqual(r.outcome, "BLOCKED");
  assert.match(r.detail, /never reported an outcome/);
});

// The line between the two: "false" is an answer, "" is a silence.
check("changed:false is a reported result, not a missing one", () => {
  const r = benchmarkOutcome({ baselineExit: "0", finalExit: "1", brokenExit: "1", changed: "false", actionOutcome: "" });
  assert.strictEqual(r.outcome, "NO-CHANGE");
});

check("a review verdict alone proves the action ran", () => {
  const r = benchmarkOutcome({ baselineExit: "0", finalExit: "1", brokenExit: "1", changed: "", actionOutcome: "", review: "refuted" });
  assert.strictEqual(r.outcome, "REFUSED");
});

// `review` is the review-status output, an enum, and an unanchored /refut/ read
// the reviewer's APPROVAL as its refusal: "not-refuted" contains "refut". The
// run was then filed REFUSED, detail "a fix was written and then withheld:
// not-refuted" - crediting a run the reviewer was happy with as a principled
// refusal, in the column this product is proudest of.
check("not-refuted is the reviewer approving, and must not read as REFUSED", () => {
  const r = benchmarkOutcome({
    baselineExit: "0", finalExit: "1", brokenExit: "1", changed: "false",
    actionOutcome: "", review: "not-refuted",
  });
  assert.strictEqual(r.outcome, "NO-CHANGE");
});

check("every review status that is not a refusal stays out of REFUSED", () => {
  // The full vocabulary reviewOutcome can emit. Anything new added there and
  // not thought about here should show up as a failure, not as a free REFUSED.
  for (const review of ["not-refuted", "concerns", "not-reviewed", "unavailable", ""]) {
    const r = benchmarkOutcome({
      baselineExit: "0", finalExit: "1", brokenExit: "1", changed: "false",
      actionOutcome: "", review,
    });
    assert.strictEqual(r.outcome, "NO-CHANGE", "review=" + JSON.stringify(review));
  }
});

check("a refusal still counts however it is spaced or cased", () => {
  const r = benchmarkOutcome({
    baselineExit: "0", finalExit: "1", brokenExit: "1", changed: "false",
    actionOutcome: "", review: "  REFUTED  ",
  });
  assert.strictEqual(r.outcome, "REFUSED");
});

// The guard catching a bad fix is the product working, and it was landing in the
// column that says the product had no ideas. Seen on body-parser: the agent
// defined a local contentType where the file used to import one, so the calls
// resolved, the tests passed, and the package was never reached. Reverted - and
// filed NO-CHANGE.
check("a change the guard reverted is REFUSED, not NO-CHANGE", () => {
  const r = benchmarkOutcome({
    baselineExit: "0", finalExit: "1", brokenExit: "1", changed: "false",
    actionOutcome: "blocked-by-guard",
    actionSummary: "Blocked and reverted, no PR will be opened. lib/read.js defines a local contentType",
  });
  assert.strictEqual(r.outcome, "REFUSED");
});

// The word the agent emits and the word the benchmark looks for have to stay
// joined; they live in different files and nothing else connects them.
check("the outcome the agent emits for a guard block is one REFUSED matches", () => {
  const emitted = "blocked-by-guard";
  assert.match(emitted, /refus|reject|block/i);
  assert.strictEqual(
    benchmarkOutcome({ baselineExit: "0", finalExit: "1", brokenExit: "1", changed: "false", actionOutcome: emitted }).outcome,
    "REFUSED"
  );
});

// treeherder: a source file of 38,424 tokens against the SDK's 25,000 limit. The
// agent never read the code, and the row said Patchery had nothing to offer.
check("the agent runtime stopping is CRASHED, not NO-CHANGE", () => {
  const r = benchmarkOutcome({
    baselineExit: "0", finalExit: "1", brokenExit: "1", changed: "false",
    actionOutcome: "harness-error",
    actionSummary: "MaxFileReadTokenExceededError: File content (38424 tokens) exceeds maximum allowed tokens (25000)",
  });
  // Both treeherder legs of run #11 were this, and calling it "a limit of our
  // harness" put it outside the denominator. It is not a limit we imposed on the
  // measurement - it is the agent reading a whole file when it should grep, which
  // this repository's own open questions already call a prompt problem. The
  // separation from NO-CHANGE was always right; the exclusion was not.
  assert.strictEqual(r.outcome, "CRASHED");
  assert.notStrictEqual(r.outcome, "NO-CHANGE");
});

// The two look alike and belong in different columns: one is a limit of the
// harness, the other is a budget we chose, on a run that really happened.
check("running out of turns is not a harness error", () => {
  const r = benchmarkOutcome({
    baselineExit: "0", finalExit: "1", brokenExit: "1", changed: "false",
    actionOutcome: "inconclusive - max turns reached",
  });
  assert.strictEqual(r.outcome, "EXHAUSTED");
});

check("a genuine crash is still not a refusal", () => {
  const r = benchmarkOutcome({
    baselineExit: "0", finalExit: "1", brokenExit: "1", changed: "false",
    actionOutcome: "failed", actionSummary: "npm install exploded",
  });
  assert.notStrictEqual(r.outcome, "REFUSED");
});

check("a real NO-CHANGE still reads as NO-CHANGE", () => {
  const r = benchmarkOutcome({
    baselineExit: "0", finalExit: "1", brokenExit: "1", changed: "false",
    actionOutcome: "no-changes", actionSummary: "the agent found nothing to change",
  });
  assert.strictEqual(r.outcome, "NO-CHANGE");
});

check("a shipped fix is judged even if the step outcome is missing", () => {
  const r = benchmarkOutcome({
    baselineExit: "0", finalExit: "0", brokenExit: "1", changed: "true",
    actionOutcome: "", before: 10, after: 10,
  });
  assert.notStrictEqual(r.outcome, "BLOCKED");
});

check("an ordinary failure is still not blamed on the provider", () => {
  const r = benchmarkOutcome({
    baselineExit: "0",
    brokenExit: "1",
    changed: "false",
    actionOutcome: "no-changes",
    actionSummary: "The agent finished and made no edits.",
  });
  assert.strictEqual(r.outcome, "NO-CHANGE");
});

check("a refusal survives a summary that mentions minutes", () => {
  const r = benchmarkOutcome({
    baselineExit: "0",
    brokenExit: "1",
    changed: "false",
    actionOutcome: "refused: the reviewer refuted the fix",
    actionSummary: "Reviewed in 3 minutes and refuted.",
  });
  assert.strictEqual(r.outcome, "REFUSED");
});


// The most common outcome, and the one that was saying least. A run that changes
// nothing has still read the changelog and the call sites; the row should carry
// what it concluded, not just the word "no-changes".
check("a NO-CHANGE row carries the reason when there is one", () => {
  const r = benchmarkOutcome({
    baselineExit: "0",
    brokenExit: "1",
    changed: "false",
    actionOutcome: "no-changes",
    actionSummary:
      "The agent finished without changing any files. It was looking at an `esm-require` break - the package now ships only as an ES module.",
  });
  assert.strictEqual(r.outcome, "NO-CHANGE");
  assert.match(r.detail, /esm-require/);
});

check("a NO-CHANGE row still says something when there is no summary", () => {
  const r = benchmarkOutcome({
    baselineExit: "0",
    brokenExit: "1",
    changed: "false",
    actionOutcome: "no-changes",
  });
  assert.strictEqual(r.outcome, "NO-CHANGE");
  assert.match(r.detail, /no-changes/);
});


// A step written for whoever has to decide, separate from the strategy written
// to steer the model mid-run. Pasting "do not go looking for a renamed function"
// at a maintainer is talking past them.
check("every classified break offers a human-facing next step", () => {
  for (const src of [
    "Error [ERR_REQUIRE_ESM]: require() of ES Module x",
    "Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: Package subpath './lib'",
    "Cannot find module 'x'",
    "npm warn EBADENGINE Unsupported engine",
    "TypeError: parse is not a function",
    "TypeError: Cannot read properties of undefined (reading 'x')",
    "error TS2554: expected 2 arguments",
  ]) {
    const c = classifyFailure(src);
    assert.ok(c.kind, src);
    assert.ok(c.next && c.next.length > 40, "no next step for " + c.kind);
    // The two must not be the same text - one addresses a model, the other a person.
    assert.notStrictEqual(c.next, c.strategy, c.kind);
  }
});

// The switch that makes the briefing measurable rather than assumed.
console.log("\nclassify-break.normalizeBriefing");

check("on by default, and the obvious words for both sides", () => {
  assert.strictEqual(normalizeBriefing("").on, true);
  assert.strictEqual(normalizeBriefing(undefined).on, true);
  assert.strictEqual(normalizeBriefing(null).on, true);
  for (const v of ["on", "true", "yes", "1", " ON "]) assert.strictEqual(normalizeBriefing(v).on, true, v);
  for (const v of ["off", "false", "no", "0", "none", " Off "]) assert.strictEqual(normalizeBriefing(v).on, false, v);
});

// A typo that silently means "on" would make the experiment measure nothing
// while looking like it measured something - the same rule as verify-mode.
check("an unrecognised value is an error, not a guess", () => {
  const r = normalizeBriefing("of");
  assert.ok(r.error, "no error for 'of'");
  assert.match(r.error, /briefing must be on or off/);
  assert.match(r.error, /"of"/);
});

// The out-of-scope class has to say plainly that the decision is not ours.
check("the engine class hands the decision back explicitly", () => {
  const c = classifyFailure("npm warn EBADENGINE Unsupported engine");
  assert.strictEqual(c.inScope, false);
  assert.match(c.next, /No code change fixes this/);
  assert.match(c.next, /yours/);
});

check("an unrecognised failure offers no next step rather than a guess", () => {
  const c = classifyFailure("something nobody has taught us about");
  assert.strictEqual(c.kind, null);
  assert.strictEqual(c.next, "");
});

// ---------------------------------------------------------------------------
// The rule we now apply to ourselves.
//
// Every failure in the benchmark pipeline came from JavaScript embedded in a
// workflow's `run:` block, and none from a script with a test. These three
// scripts are that logic, moved out - so the last thing to check is that the
// move actually happened and stays happened.
// ---------------------------------------------------------------------------

console.log("\ncheck-workflows.inlineNodeBlocks");

check("a long inline block is flagged, with its line number", () => {
  const yaml = ["jobs:", "  a:", "    steps:", '      - run: node -e "', "  const a = 1;", "  const b = 2;", "  const c = 3;", "  console.log(a + b + c);", '        "'].join("\n");
  const found = inlineNodeBlocks(yaml);
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].line, 4);
  assert.ok(found[0].lines > 3);
});

check("a short one-liner is left alone - the rule is about logic, not shelling out", () => {
  assert.deepStrictEqual(inlineNodeBlocks(`- run: node -e "console.log(1)"`), []);
  assert.deepStrictEqual(inlineNodeBlocks(`- run: node -p "require('./p.json').version"`), []);
});

check("a run: block with no node -e at all is clean", () => {
  assert.deepStrictEqual(inlineNodeBlocks("- run: npm test\n- run: echo hi"), []);
});

// The gate lives in the pre-push hook, but a hook can be skipped and a hook is
// not installed for anyone who clones this repository. The suite cannot be.
check("our own workflows carry no buried logic", () => {
  const dir = path.join(root, ".github", "workflows");
  const offenders = [];
  for (const f of fs.readdirSync(dir)) {
    if (!/\.ya?ml$/i.test(f)) continue;
    for (const b of inlineNodeBlocks(fs.readFileSync(path.join(dir, f), "utf8"))) {
      offenders.push(f + ":" + b.line + " (" + b.lines + " lines)");
    }
  }
  for (const f of ["action.yml"]) {
    const p = path.join(root, f);
    if (!fs.existsSync(p)) continue;
    for (const b of inlineNodeBlocks(fs.readFileSync(p, "utf8"))) {
      offenders.push(f + ":" + b.line + " (" + b.lines + " lines)");
    }
  }
  assert.deepStrictEqual(offenders, [], "move these into scripts/ and give them a test");
});

console.log("\ncheck-workflows.shellInterpolations - a value pasted into a script is a program");

check("an expression inside a run: block is flagged, with its line", () => {
  const yaml = ["jobs:", "  a:", "    steps:", "      - run: |", "          echo ${{ inputs.name }}"].join("\n");
  const found = shellInterpolations(yaml);
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].line, 5);
  assert.strictEqual(found[0].expr, "inputs.name");
});

check("a one-line run: counts too - the shape does not change the hole", () =>
  assert.strictEqual(shellInterpolations("      - run: echo ${{ inputs.name }}").length, 1)
);

check("two on one line are two findings, not one", () =>
  assert.strictEqual(
    shellInterpolations("      - run: |\n          echo ${{ inputs.a }}-${{ inputs.b }}").length,
    2
  )
);

// This is the whole point of the rule: env: is where they belong, so finding
// them there would make the check unusable and it would be turned off.
check("the same expression under env: is not a finding", () => {
  const yaml = [
    "      - run: |",
    "          echo \"$NAME\"",
    "        env:",
    "          NAME: ${{ inputs.name }}",
    "        with:",
    "          x: ${{ inputs.x }}",
  ].join("\n");
  assert.deepStrictEqual(shellInterpolations(yaml), []);
});

check("if: and working-directory: are left alone as well", () => {
  const yaml = [
    "      - name: x",
    "        if: ${{ steps.a.outputs.b == '1' }}",
    "        working-directory: case/${{ inputs.target-dir }}",
    "        run: npm test",
  ].join("\n");
  assert.deepStrictEqual(shellInterpolations(yaml), []);
});

// benchmark-batch.yml has a job called `run`. Reading it as a step would flag
// every expression in the job and the rule would be abandoned in a week.
check("a job named run is not a run: block", () => {
  const yaml = ["jobs:", "  run:", "    with:", "      repo: ${{ matrix.case.repo }}"].join("\n");
  assert.deepStrictEqual(shellInterpolations(yaml), []);
});

check("the block ends where the indentation does", () => {
  const yaml = [
    "      - run: |",
    "          echo hi",
    "",
    "          echo still inside ${{ inputs.a }}",
    "      - name: next",
    "        with:",
    "          x: ${{ inputs.b }}",
  ].join("\n");
  const found = shellInterpolations(yaml);
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].expr, "inputs.a");
});

check("CRLF files are read the same as LF ones", () =>
  assert.strictEqual(shellInterpolations("      - run: |\r\n          echo ${{ inputs.a }}\r\n").length, 1)
);

// The gate lives in the pre-push hook, and a hook can be skipped and is not
// installed for anyone who clones this repository. The suite cannot be. 91
// occurrences of 24 distinct expressions were moved to env: in one pass; this
// is what stops the twenty-fifth from arriving.
check("our own workflows paste nothing into a shell", () => {
  const offenders = [];
  const scan = (label, p) => {
    for (const s of shellInterpolations(fs.readFileSync(p, "utf8"))) {
      offenders.push(label + ":" + s.line + "  ${{ " + s.expr + " }}");
    }
  };
  const dir = path.join(root, ".github", "workflows");
  for (const f of fs.readdirSync(dir)) {
    if (/\.ya?ml$/i.test(f)) scan(f, path.join(dir, f));
  }
  const action = path.join(root, "action.yml");
  if (fs.existsSync(action)) scan("action.yml", action);
  assert.deepStrictEqual(offenders, [], "bind these under env: and use $NAME in the script");
});

console.log("\ncheck-claims - one claim, five surfaces, nothing but attention holding them together");

const SITE = [
  '<meta name="description" content="Dependabot tells you a dependency changed. Patchery works out what that means for your code, and will not claim a fix it cannot prove. A GitHub Action that runs in your own CI.">',
  '<meta property="og:description" content="Dependabot tells you a dependency changed. Patchery works out what that means for your code.">',
  '<meta property="og:image:alt" content="Patchery — Dependabot tells you a dependency changed. Patchery works out what that means for your code.">',
  '<meta name="twitter:description" content="Dependabot tells you a dependency changed. Patchery works out what that means for your code.">',
  '<h1 class="display display--hero">',
  "  Dependabot tells you a dependency changed.",
  "  Patchery works out what that <em>means</em> for your code.",
  "</h1>",
].join("\n");
const README = "<strong>Dependabot tells you a dependency changed. Patchery works out what that means for your code &mdash; and will not claim a fix it cannot prove.</strong>";
const ACTION = "name: \"Patchery\"\ndescription: >-\n  Dependabot tells you a dependency changed. Patchery works out what that means\n  for your code: it reproduces the break and verifies the fix.\nauthor: \"ugursku\"\n";

check("the surfaces as they stand today agree", () =>
  assert.deepStrictEqual(taglineDrift(taglineSurfaces({ readme: README, action: ACTION, site: SITE })), [])
);

// The same claim is punctuated three ways across these files, and none of those
// is a difference in what is being said. A check that called them drift would
// be switched off in a week.
check("a full stop, a comma and a dash are the same claim", () => {
  const core = "Dependabot tells you a dependency changed. Patchery works out what that means for your code";
  assert.strictEqual(taglineCore("Dependabot tells you a dependency changed. Patchery works out what that means for your code."), core);
  assert.strictEqual(taglineCore("Dependabot tells you a dependency changed. Patchery works out what that means for your code, and will not claim a fix it cannot prove."), core);
  assert.strictEqual(taglineCore("Dependabot tells you a dependency changed. Patchery works out what that means for your code — and will not claim a fix it cannot prove."), core);
});

check("markup and entities are not part of the claim", () =>
  assert.strictEqual(
    taglineCore("Dependabot tells you a dependency changed. Patchery works out what that <em>means</em> for your code&trade;."),
    taglineCore("Dependabot tells you a dependency changed. Patchery works out what that means for your code.")
  )
);

// The share card names the product first. That label is not one of the claims -
// reading it as one would put every other surface in the wrong.
check("the share card's product label is not a claim", () =>
  assert.strictEqual(
    taglineCore("Patchery — Dependabot tells you a dependency changed. Patchery works out what that means for your code."),
    taglineCore("Dependabot tells you a dependency changed. Patchery works out what that means for your code.")
  )
);

// 8bf6916, exactly: the positioning changed and the share card kept the old
// pitch. Found by a person reading two files side by side.
check("one forgotten surface is named, with what the others say", () => {
  const stale = SITE.replace(
    'content="Patchery — Dependabot tells you a dependency changed. Patchery works out what that means for your code."',
    'content="Patchery — The fastest way to migrate a breaking dependency."'
  );
  const drift = taglineDrift(taglineSurfaces({ readme: README, action: ACTION, site: stale }));
  assert.strictEqual(drift.length, 1);
  assert.strictEqual(drift[0].name, "site og:image:alt");
  assert.match(drift[0].expected, /^Dependabot tells you/);
});

check("with no majority, every surface is reported rather than guessed at", () => {
  const half = "<strong>A different pitch entirely.</strong>";
  const twoSurfaces = taglineSurfaces({ readme: half, action: ACTION, site: "" });
  const drift = taglineDrift(twoSurfaces);
  assert.strictEqual(drift.length, 2);
  assert.ok(drift.every((d) => d.expected === null));
});

// The trap this check would otherwise walk into: finding nobody to disagree and
// calling that agreement. CRLF alone was enough to do it.
check("a surface we cannot read is not a surface that agrees", () => {
  const surfaces = taglineSurfaces({ readme: "<p>no bold sentence here</p>", action: ACTION, site: SITE });
  const readme = surfaces.find((s) => s.name === "README.md");
  assert.strictEqual(readme.found, false);
  assert.deepStrictEqual(taglineDrift(surfaces), [], "an unreadable surface is not drift, it is reported separately");
});

check("CRLF files are read the same as LF ones", () => {
  const surfaces = taglineSurfaces({ readme: README, action: ACTION.replace(/\n/g, "\r\n"), site: SITE });
  const action = surfaces.find((s) => s.name === "action.yml");
  assert.strictEqual(action.found, true);
  assert.match(action.core, /^Dependabot tells you/);
});

// The whole point, over the real files: five surfaces went out of step four
// times in one evening, every time by hand.
check("our own surfaces say the same thing", () => {
  const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
  const surfaces = taglineSurfaces({
    readme: read("README.md"),
    action: read("action.yml"),
    site: read(path.join("docs", "index.html")),
  });
  assert.deepStrictEqual(surfaces.filter((s) => !s.found).map((s) => s.name), [], "this surface states the tagline and could not be read");
  assert.deepStrictEqual(taglineDrift(surfaces), []);
  assert.ok(surfaces.length >= 6, "found only " + surfaces.length + " surfaces");
});



console.log("\ncheck-claims - the offline-check count, which has drifted six times");

check("the README's stated count is read, commas and all", () => {
  assert.strictEqual(statedCheckCount("The engine has 554 offline checks covering the guard."), 554);
  assert.strictEqual(statedCheckCount("has 1,204 offline checks"), 1204);
  // CRLF is how this file family actually arrives on Windows, and a pattern
  // anchored to a bare newline is how check-claims lost a surface once already.
  assert.strictEqual(statedCheckCount("line\r\nThe engine has 554 offline checks\r\n"), 554);
});

check("a README that states no count is null, never zero", () => {
  // The distinction the whole file exists for: "it says nothing" and "it says
  // none" are different answers, and zero would make the gate compare against
  // a suite that had vanished and call it agreement.
  assert.strictEqual(statedCheckCount("no numbers here at all"), null);
  assert.strictEqual(statedCheckCount(""), null);
  assert.strictEqual(statedCheckCount(undefined), null);
});

check("the suite's own last line is read the same way", () => {
  assert.strictEqual(reportedCheckCount("  ok  something\n\n559 checks passed.\n"), 559);
  assert.strictEqual(reportedCheckCount("1,004 checks passed."), 1004);
});

check("a suite whose last line changed shape reports null, not a number", () => {
  // If someone rewords the summary line, the gate must fail loudly rather than
  // silently stop comparing - the failure mode that let the number drift.
  assert.strictEqual(reportedCheckCount("all good"), null);
  assert.strictEqual(reportedCheckCount(""), null);
});

console.log("\ncheck-claims.releaseTagWarnings - the surface that is not a file");

check("a tag behind the tree is named, with what it actually installs", () => {
  const w = releaseTagWarnings({ tag: "v0", behind: 112, tagCore: "same", headCore: "same" });
  assert.strictEqual(w.length, 1);
  assert.match(w[0], /v0 is 112 commit\(s\) behind/);
  // The point of the sentence: a reader must connect it to `uses: ...@v0`.
  assert.match(w[0], /@v0/);
});

check("a tag making a different claim is a separate warning from being behind", () => {
  // These are genuinely different failures. A tag can be far behind and still
  // say the same thing; it can be one commit behind and say something wrong.
  // Only the second puts a false sentence in front of a reader.
  const w = releaseTagWarnings({ tag: "v0", behind: 112, tagCore: "old pitch", headCore: "new pitch" });
  assert.strictEqual(w.length, 2);
  const level = releaseTagWarnings({ tag: "v0", behind: 0, tagCore: "old pitch", headCore: "new pitch" });
  assert.strictEqual(level.length, 1);
  assert.match(level[0], /different claim/);
});

check("a tag level with the tree and saying the same thing warns about nothing", () => {
  assert.deepStrictEqual(releaseTagWarnings({ tag: "v0", behind: 0, tagCore: "x", headCore: "x" }), []);
});

check("no tag at all is silence, not a complaint", () => {
  // A fresh clone without tags, or a repository before its first release, must
  // not be told it has a stale one.
  assert.deepStrictEqual(releaseTagWarnings({ tag: "", behind: 9, tagCore: "a", headCore: "b" }), []);
});

check("an unreadable tag description does not invent a disagreement", () => {
  // Empty means "could not read it", and this file's whole rule is that
  // "I could not look" must never render as either agreement or drift.
  assert.deepStrictEqual(releaseTagWarnings({ tag: "v0", behind: 0, tagCore: "", headCore: "new pitch" }), []);
});

console.log("\nbatch-plan.planBatch");

const ROWS = [
  { repo: "expressjs/express", package: "content-disposition" },
  { repo: "expressjs/express", package: "content-type" },
  { repo: "sindresorhus/got", package: "p-cancelable" },
  { repo: "vercel/next.js", package: "express" },
];

check("no filter runs everything", () => {
  const { picked, dropped } = planBatch(ROWS, {});
  assert.strictEqual(picked.length, 4);
  assert.strictEqual(dropped, 0);
});

check("the filter matches the repo or the package, case-insensitively", () => {
  assert.strictEqual(planBatch(ROWS, { only: "EXPRESS" }).picked.length, 3);
  assert.strictEqual(planBatch(ROWS, { only: "content-type" }).picked.length, 1);
  assert.strictEqual(planBatch(ROWS, { only: "  got " }).picked.length, 1);
});

check("an empty filter is not a filter - a blank input box means all", () => {
  assert.strictEqual(planBatch(ROWS, { only: "" }).picked.length, 4);
  assert.strictEqual(planBatch(ROWS, { only: "   " }).picked.length, 4);
});

check("a filter matching nothing yields nothing, not everything", () => {
  assert.strictEqual(planBatch(ROWS, { only: "nonesuch" }).picked.length, 0);
});

// The whole point of returning `dropped`: a truncation nobody announced reads
// as "we measured everything", which is the exact failure this pipeline exists
// to prevent - and here it would also mean a quietly smaller bill.
check("what the cap dropped is counted, not swallowed", () => {
  const { picked, dropped } = planBatch(ROWS, { cap: 2 });
  assert.strictEqual(picked.length, 2);
  assert.strictEqual(dropped, 2);
});

check("the caller's limit applies, but never above the hard cap", () => {
  assert.strictEqual(planBatch(ROWS, { limit: 3, cap: 50 }).picked.length, 3);
  assert.strictEqual(planBatch(ROWS, { limit: 99, cap: 2 }).picked.length, 2);
  assert.strictEqual(planBatch(ROWS, { limit: 0, cap: 50 }).picked.length, 4);
});

check("filter first, then cap - not the other way round", () => {
  const { picked } = planBatch(ROWS, { only: "express", limit: 2 });
  assert.strictEqual(picked.length, 2);
  assert.ok(picked.every((r) => (r.repo + r.package).includes("express")));
});

// Still deepStrictEqual on the whole return rather than on two fields: the
// shape is what a caller destructures, and this check is what caught `cases`
// and `repeats` being added. Widened deliberately, not loosened.
check("no rows at all is a plan, not a crash", () => {
  assert.deepStrictEqual(planBatch([], {}), { picked: [], dropped: 0, cases: 0, repeats: 1 });
  assert.deepStrictEqual(planBatch(null, {}), { picked: [], dropped: 0, cases: 0, repeats: 1 });
});

console.log("\nbatch-report.renderReport");

const BENCH = [
  { outcome: "BLOCKED", repo: "b/b", package: "p", version: "2", detail: "npm died" },
  { outcome: "WRONG", repo: "w/w", package: "p", version: "2", detail: "suite shrank" },
  { outcome: "FIXED", repo: "a/a", package: "p", version: "2", detail: "green", model: "glm-5.3" },
  { outcome: "REFUSED", repo: "r/r", package: "p", version: "2", detail: "could not prove it" },
];

check("the outcomes are ordered, best-understood first", () => {
  assert.deepStrictEqual(
    sortRows(BENCH, "benchmark").map((r) => r.outcome),
    ["FIXED", "REFUSED", "WRONG", "BLOCKED"]
  );
});

check("BLOCKED is named but kept out of the denominator", () => {
  const text = renderReport(BENCH, { kind: "benchmark", queued: 4 });
  // 4 rows, 1 of them ours - the product was asked 3 questions, not 4.
  assert.match(text, /1 fixed of 3 cases/);
  assert.match(text, /blocked by our setup \(not counted\) \| 1/);
});

check("a wrong fix is the one line nobody can skim past", () => {
  const text = renderReport(BENCH, { kind: "benchmark", queued: 4 });
  assert.match(text, /\*\*shipped something wrong\*\* \| \*\*1\*\*/);
});

check("REFUSED and WRONG stay separate lines - the product lives in that gap", () => {
  const text = renderReport(BENCH, { kind: "benchmark", queued: 4 });
  assert.match(text, /refused to ship an unproven fix \| 1/);
  assert.ok(!/refused.*wrong/i.test(text.split("\n").find((l) => /refused/.test(l))));
});

check("the fixer is named, so a rate cannot be read as model-independent", () => {
  assert.match(renderReport(BENCH, { kind: "benchmark" }), /Fixer: glm-5\.3/);
  assert.match(renderReport([{ outcome: "FIXED", repo: "a/a", package: "p", version: "2" }], { kind: "benchmark" }), /Fixer: the repository default/);
});

// "0 wrong" reads as "the agent produced no bad fixes". It means none escaped.
// In the first two runs the agent produced four, all the same escape, and the
// table could not show any of them.
// The count alone would have shown "4" for the first two runs and lost the only
// interesting part: all four were the same escape.
check("the breakdown says which rule caught each one", () => {
  const g = (repo, reason) => ({
    outcome: "REFUSED", repo, package: "p", version: "3",
    actionOutcome: "blocked-by-guard", guardReason: reason,
  });
  const text = renderReport(
    [g("a/a", "dependency-misuse"), g("b/b", "dependency-misuse"), g("c/c", "census-shrunk"),
     { outcome: "FIXED", repo: "d/d", package: "p", version: "3", actionOutcome: "fixed" }],
    { kind: "benchmark", queued: 4 }
  );
  assert.match(text, /bad fixes caught by the guard \| 3/);
  assert.match(text, /\| dependency-misuse \| 2 \|/);
  assert.match(text, /\| census-shrunk \| 1 \|/);
});

// A batch collected before the slug existed would otherwise show a total of 3
// above a breakdown adding to 1, which reads as a bug in the table.
check("catches recorded before the reason existed are named, not dropped", () => {
  const text = renderReport(
    [
      { outcome: "REFUSED", repo: "a/a", package: "p", version: "3", actionOutcome: "blocked-by-guard", guardReason: "dependency-misuse" },
      { outcome: "REFUSED", repo: "b/b", package: "p", version: "3", actionOutcome: "blocked-by-guard" },
    ],
    { kind: "benchmark", queued: 2 }
  );
  assert.match(text, /bad fixes caught by the guard \| 2/);
  assert.match(text, /recorded before the reason was\) \| 1/);
});

check("no breakdown at all when the guard never fired", () => {
  const text = renderReport(
    [{ outcome: "FIXED", repo: "a/a", package: "p", version: "3", actionOutcome: "fixed" }],
    { kind: "benchmark" }
  );
  assert.ok(!/which rule caught it/.test(text));
});

check("legs that reported nothing are stated, not implied away", () => {
  const text = renderReport(BENCH, { kind: "benchmark", queued: 7 });
  assert.match(text, /\*\*3 case\(s\) reported nothing\*\*/);
  // And when everything reported, the line must not appear at all.
  assert.ok(!/reported nothing/.test(renderReport(BENCH, { kind: "benchmark", queued: 4 })));
});

// The guard is the product's central claim and the table never counted it. The
// number has to come from `blocked-by-guard`, which only the guard writes - not
// from REFUSED, which also holds every change the reviewer refuted.
const GUARDED = [
  { outcome: "REFUSED", actionOutcome: "blocked-by-guard", repo: "g/g", package: "p", version: "2", detail: "abandoned the package" },
  { outcome: "REFUSED", actionOutcome: "inconclusive", review: "refuted", repo: "v/v", package: "p", version: "2", detail: "reviewer refuted it" },
  { outcome: "WRONG", actionOutcome: "changed", repo: "w/w", package: "p", version: "2", detail: "suite shrank" },
  { outcome: "FIXED", actionOutcome: "changed", repo: "a/a", package: "p", version: "2", detail: "green" },
];

check("the guard's catches and the ones that got past it are both on the table", () => {
  const text = renderReport(GUARDED, { kind: "benchmark" });
  assert.match(text, /\| bad fixes caught by the guard \| 1 \|/);
  assert.match(text, /\| \*\*bad fixes that reached a PR\*\* \| \*\*1\*\* \|/);
});

check("the count comes from blocked-by-guard, not from REFUSED", () => {
  // Two REFUSED rows, one guard revert and one reviewer refutation. Reading
  // REFUSED would say 2 and credit the guard with the reviewer's work.
  assert.strictEqual(GUARDED.filter((r) => r.outcome === "REFUSED").length, 2);
  assert.strictEqual(guardCaught(GUARDED), 1);
});

check("only the guard's own word counts - a lookalike outcome does not", () => {
  assert.strictEqual(guardCaught([{ actionOutcome: "blocked by our setup" }]), 0);
  assert.strictEqual(guardCaught([{ actionOutcome: "harness-error" }]), 0);
  assert.strictEqual(guardCaught([{ actionOutcome: " BLOCKED-BY-GUARD " }]), 1);
});

// Same rule as the node column, for the same reason: 0 and "nobody recorded it"
// are different facts, and the table must not print the first when it means the
// second.
check("a batch from before the field existed shows no guard lines at all", () => {
  const old = [{ outcome: "FIXED", repo: "a/a", package: "p", version: "2", detail: "green" }];
  assert.strictEqual(guardVisible(old), false);
  const text = renderReport(old, { kind: "benchmark" });
  assert.ok(!/caught by the guard/.test(text));
  assert.ok(!/reached a PR/.test(text));
});

check("a guard that caught nothing on a recorded batch still says 0", () => {
  const text = renderReport([{ outcome: "FIXED", actionOutcome: "changed", repo: "a/a", package: "p", version: "2" }], { kind: "benchmark" });
  assert.match(text, /\| bad fixes caught by the guard \| 0 \|/);
});

// express with content-type@3: 1255 of 1255 passing, and the independent
// reviewer objected to the fix. "1 fixed" alone is true and incomplete, and the
// incompleteness is all in our favour.
const REVIEWED = [
  { outcome: "FIXED", review: "refuted", repo: "expressjs/express", package: "content-type", version: "3", detail: "tests green again" },
  { outcome: "FIXED", review: "not-refuted", repo: "a/a", package: "p", version: "2", detail: "tests green again" },
  { outcome: "NO-CHANGE", review: "", repo: "b/b", package: "p", version: "2", detail: "nothing to offer" },
];

check("an objection to a shipped fix is in the headline, not in a detail cell", () => {
  const text = renderReport(REVIEWED, { kind: "benchmark" });
  assert.match(text.split("\n")[0], /2 fixed of 3 cases it was able to attempt — the reviewer objected to 1 of them/);
});

// The point of putting it in the headline instead of splitting the taxonomy:
// the suite really did go red to green, and a reviewer opinion does not undo a
// measurement.
check("FIXED stays one number - the objection is said, not subtracted", () => {
  const text = renderReport(REVIEWED, { kind: "benchmark" });
  assert.match(text, /\| fixed \| 2 \|/);
  assert.ok(!/objected \| /.test(text), "no second FIXED row");
});

check("both of the reviewer's ways of disagreeing count", () => {
  assert.strictEqual(objectedFixes([{ outcome: "FIXED", review: "refuted" }]), 1);
  assert.strictEqual(objectedFixes([{ outcome: "FIXED", review: "concerns" }]), 1);
  assert.strictEqual(objectedFixes([{ outcome: "FIXED", review: "not-refuted" }]), 0);
  // Nobody reviewed it, so nobody objected - that is not an objection.
  assert.strictEqual(objectedFixes([{ outcome: "FIXED", review: "not-reviewed" }]), 0);
  assert.strictEqual(objectedFixes([{ outcome: "FIXED", review: "unavailable" }]), 0);
  assert.strictEqual(objectedFixes([{ outcome: "FIXED" }]), 0);
});

check("an objection to something that did not ship is not a fixed-with-objection", () => {
  assert.strictEqual(objectedFixes([{ outcome: "REFUSED", review: "refuted" }]), 0);
  assert.strictEqual(objectedFixes([{ outcome: "WRONG", review: "refuted" }]), 0);
});

check("no objection means no clause - the headline stays the sentence it was", () => {
  const text = renderReport([{ outcome: "FIXED", review: "not-refuted", repo: "a/a", package: "p", version: "2" }], { kind: "benchmark" });
  assert.strictEqual(text.split("\n")[0], "## 1 fixed of 1 cases it was able to attempt");
});

// Same trip as actionOutcome: the reviewer's word has to survive from the action
// into the row, or the headline silently reports "no objections" forever.
check("the review status benchmark-outcome writes is the one the headline reads", () => {
  const src = fs.readFileSync(path.join(root, "scripts", "benchmark-outcome.mjs"), "utf8");
  assert.match(src, /review: a\.review \|\| ""/);
});


// The field has to survive the trip from the action to the table, and the two
// files are joined by nothing but its name.
check("the row benchmark-outcome writes is the row the guard lines read", () => {
  const src = fs.readFileSync(path.join(root, "scripts", "benchmark-outcome.mjs"), "utf8");
  assert.match(src, /actionOutcome: a\["action-outcome"\]/);
});


// A verdict without its runtime is not a verdict: formdata-node@6 was VALID on
// Node 12 and NOT-A-CASE on Node 16, same repo, same commit.
check("every row carries the node it was measured on", () => {
  const text = renderReport([{ verdict: "VALID", repo: "a/a", package: "p", version: "3", node: "16", detail: "red after" }], { kind: "verify" });
  assert.match(text, /\| 16 \|/);
  assert.match(text, /\| node \|/);
});

// Mixed is the case that actually happens: a batch collected after the change,
// holding one artifact written before it.
check("a row that does not know its node says ? rather than borrowing a neighbour's", () => {
  const text = renderReport(
    [
      { verdict: "VALID", repo: "a/a", package: "p", version: "3", node: "16", detail: "red after" },
      { verdict: "VALID", repo: "b/b", package: "p", version: "3", detail: "red after" },
    ],
    { kind: "verify" }
  );
  assert.match(text, /\| b\/b \| `p@3` \| \? \|/);
});

check("no column at all when nothing recorded it - a column of ? is noise", () => {
  const text = renderReport([{ outcome: "FIXED", repo: "a/a", package: "p", version: "2", detail: "green" }], { kind: "benchmark" });
  assert.ok(!/\| node \|/.test(text));
  assert.ok(!/\| \? \|/.test(text));
});

check("a pipe in a detail cannot break the table it is printed in", () => {
  const text = renderReport([{ outcome: "FIXED", repo: "a/a", package: "p", version: "2", detail: "ran a | b" }], { kind: "benchmark" });
  assert.match(text, /ran a \\\| b/);
});

check("a multi-line detail is flattened rather than splitting the row", () => {
  const text = renderReport([{ outcome: "FIXED", repo: "a/a", package: "p", version: "2", detail: "one\ntwo" }], { kind: "benchmark" });
  assert.match(text, /\| one two \|/);
});

check("the verify table counts verdicts, not outcomes", () => {
  const rows = [
    { verdict: "NOT-A-CASE", repo: "c/c", package: "p", version: "3", detail: "still green" },
    { verdict: "VALID", repo: "a/a", package: "p", version: "3", detail: "red after" },
    { verdict: "UNKNOWN", repo: "b/b", package: "p", version: "3", detail: "would not install" },
  ];
  const text = renderReport(rows, { kind: "verify", queued: 3 });
  assert.match(text, /## 1 valid case\(s\) of 3 tried/);
  assert.match(text, /1 were not cases, 1 could not be measured/);
  assert.deepStrictEqual(sortRows(rows, "verify").map((r) => r.verdict), ["VALID", "UNKNOWN", "NOT-A-CASE"]);
  // No agent ran, so no rate and no fixer belong in this table.
  assert.ok(!/Fixer:/.test(text));
});

check("an outcome nobody has taught us about sorts last instead of first", () => {
  const rows = [{ outcome: "SOMETHING-NEW", repo: "z/z", package: "p", version: "1" }, ...BENCH];
  assert.strictEqual(sortRows(rows, "benchmark").at(-1).outcome, "SOMETHING-NEW");
});

// Found by running the report against a result file written in the other
// shape: the row rendered as the literal "undefined" and still counted, so a
// case nobody had judged became a case the agent had failed.
check("a row with no outcome is named, not counted, and not printed as undefined", () => {
  const text = renderReport(
    [{ repo: "a/a", package: "p", version: "2", detail: "green" }, { outcome: "FIXED", repo: "b/b", package: "p", version: "2" }],
    { kind: "benchmark", queued: 2 }
  );
  assert.match(text, /1 fixed of 1 cases/);
  assert.ok(!/undefined/.test(text));
  assert.match(text, /carried no outcome/);
});

check("the same holds for the verify table", () => {
  const text = renderReport(
    [{ repo: "a/a", package: "p", version: "3" }, { verdict: "VALID", repo: "b/b", package: "p", version: "3" }],
    { kind: "verify", queued: 2 }
  );
  assert.match(text, /## 1 valid case\(s\) of 1 tried/);
  assert.match(text, /carried no verdict/);
});

check("an empty string counts as no verdict, not as a verdict", () => {
  const text = renderReport([{ outcome: "  ", repo: "a/a", package: "p", version: "1" }], { kind: "benchmark", queued: 1 });
  assert.match(text, /0 fixed of 0 cases/);
  assert.match(text, /carried no outcome/);
});

check("nothing about unreported rows appears when every row reported", () => {
  assert.ok(!/carried no/.test(renderReport(BENCH, { kind: "benchmark", queued: 4 })));
});

check("an empty results directory reports zero rather than claiming success", () => {
  const text = renderReport([], { kind: "benchmark", queued: 5 });
  assert.match(text, /0 fixed of 0 cases/);
  assert.match(text, /\*\*5 case\(s\) reported nothing\*\*/);
});

console.log("\nwrite-result.mjs");

check("the verdict file is written, and survives a value with quotes in it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "patchery-wr-"));
  const out = path.join(dir, "result.json");
  const r = spawnSync(process.execPath, [
    path.join(root, "scripts", "write-result.mjs"),
    out, "a/b", "pkg", "3.0.0", "deadbeef", "VALID", 'green before, red after "x"',
  ]);
  assert.strictEqual(r.status, 0, String(r.stderr));
  const parsed = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.strictEqual(parsed.repo, "a/b");
  assert.strictEqual(parsed.package, "pkg");
  assert.strictEqual(parsed.verdict, "VALID");
  assert.match(parsed.detail, /red after/);
});

check("a missing output path fails loudly instead of writing somewhere else", () => {
  const r = spawnSync(process.execPath, [path.join(root, "scripts", "write-result.mjs")]);
  assert.notStrictEqual(r.status, 0);
});

// ---------------------------------------------------------------------------
// The proof ladder.
//
// The point of these checks is the one case the product gets wrong today: a
// suite that was green before and green after proves no regression, not a fix.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The floor under "the lowest version CI runs".
//
// Found in a real batch: expressjs/cors tests every major from 0.10 to 25, so
// the lowest was Node 1, setup-node could not install it, and three candidates
// died before measuring anything - two of them express v4 -> v5.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Library or application.
//
// It decides which fix is honest. Teaching a test runner to transform an
// ES-module dependency is correct in an application and dishonest in a library,
// where it greens one CI and leaves every consumer broken. The agent refused
// that fix on express and was right; the row read NO-CHANGE.
// ---------------------------------------------------------------------------

console.log("\npool-summary.poolShape");

check("a pool is described by what it can measure, not just how big it is", () => {
  const s = poolShape([
    { repo: "a/a", _kind: "application", _apiOnly: true, _ts: true },
    { repo: "a/a", _kind: "application", _apiOnly: false, _ts: true },
    { repo: "b/b", _kind: "library", _apiOnly: false, _ts: false },
  ]);
  assert.strictEqual(s.total, 3);
  assert.strictEqual(s.repos, 2);
  assert.strictEqual(s.application, 2);
  assert.strictEqual(s.library, 1);
  assert.strictEqual(s.api, 1);
  assert.strictEqual(s.packaging, 2);
  assert.strictEqual(s.typescript, 2);
});

// Rows from before _kind existed must not be counted as either, or the split
// silently reads as "all libraries" when it is really "we did not record it".
check("rows from an older run are counted as unknown, not as libraries", () => {
  const s = poolShape([{ repo: "a/a", _apiOnly: true }]);
  assert.strictEqual(s.unknownKind, 1);
  assert.strictEqual(s.library, 0);
  assert.strictEqual(s.application, 0);
});

check("an empty pool is a shape, not a crash", () => {
  assert.strictEqual(poolShape([]).total, 0);
  assert.strictEqual(poolShape(null).total, 0);
});

check("the summary shows what moved, not only where it landed", () => {
  const text = renderShape(poolShape([{ repo: "a/a", _kind: "application" }]), poolShape([]));
  assert.match(text, /\| applications \| 1 \| 0 \| \+1 \|/);
});

console.log("\nfind-bumps.projectKind");

check("a declared entry point is a library", () => {
  assert.strictEqual(projectKind({ name: "x", main: "index.js" }), "library");
  assert.strictEqual(projectKind({ name: "x", exports: { ".": "./dist/i.js" } }), "library");
  assert.strictEqual(projectKind({ name: "x", module: "./esm/i.js" }), "library");
  assert.strictEqual(projectKind({ name: "x", types: "./i.d.ts" }), "library");
});

// The four the first version of this got wrong, with their real package.json.
check("the shapes that fooled it before now answer unknown", () => {
  // express and multer: no `main` at all, because Node defaults to index.js.
  assert.strictEqual(projectKind({}), "unknown");
  assert.strictEqual(projectKind({ name: "express" }), "unknown");
  // lodash: private at a root that ships a library from a build.
  assert.strictEqual(projectKind({ private: true, main: "lodash.js" }), "unknown");
  // A monorepo root is about its members and says nothing about them.
  assert.strictEqual(projectKind({ workspaces: ["packages/*"] }), "unknown");
  assert.strictEqual(projectKind({ private: true, workspaces: ["p/*"] }), "unknown");
});

check("private with nothing to import is the one confident application", () => {
  assert.strictEqual(projectKind({ private: true, name: "my-app" }), "application");
});

check("private: false is not private: true", () => {
  assert.strictEqual(projectKind({ private: false, main: "i.js" }), "library");
});

console.log("\nfind-bumps.capBumps - the cap must be countable, not silent");

check("what the cap left behind is returned, not discarded", () => {
  const bumps = [1, 2, 3, 4, 5].map((n) => ({ package: "p" + n }));
  const r = capBumps(bumps, 3);
  assert.strictEqual(r.picked.length, 3);
  // The whole point: a caller can say how much it did not take.
  assert.strictEqual(r.dropped, 2);
});

check("a repository under the cap drops nothing and says so", () => {
  const r = capBumps([{ package: "a" }, { package: "b" }], 3);
  assert.strictEqual(r.picked.length, 2);
  assert.strictEqual(r.dropped, 0);
});

check("the order it was handed is the order it keeps", () => {
  // The sort above the call puts API-only bumps first on purpose. A cap that
  // reordered would cut a different tail than the one the sort intended.
  const bumps = [{ package: "api" }, { package: "pkg" }, { package: "other" }];
  assert.deepStrictEqual(capBumps(bumps, 2).picked.map((b) => b.package), ["api", "pkg"]);
});

check("no usable cap takes everything rather than nothing", () => {
  // A missing or nonsense --max-per-repo must not silently empty the pool: an
  // empty candidates.json and "this repository had no breaking majors" look
  // identical from the outside, which is the failure this project keeps hitting.
  const bumps = [{ package: "a" }, { package: "b" }];
  for (const bad of [0, -1, NaN, undefined, null]) {
    const r = capBumps(bumps, bad);
    assert.strictEqual(r.picked.length, 2, String(bad));
    assert.strictEqual(r.dropped, 0, String(bad));
  }
});

check("no bumps at all is zero taken and zero dropped, never a throw", () => {
  assert.deepStrictEqual(capBumps([], 3), { picked: [], dropped: 0 });
  assert.deepStrictEqual(capBumps(undefined, 3), { picked: [], dropped: 0 });
});

console.log("\nfind-bumps.parseRepoLine");

check("a line carries the repository and, when given, its kind", () => {
  assert.deepStrictEqual(parseRepoLine("expressjs/express       library"), { repo: "expressjs/express", kind: "library" });
  assert.deepStrictEqual(parseRepoLine("  a/b   application  # note"), { repo: "a/b", kind: "application" });
});

check("an unlabelled line asks for no kind rather than inventing one", () => {
  assert.deepStrictEqual(parseRepoLine("somebody/thing"), { repo: "somebody/thing", kind: "" });
  // A word we do not recognise is not a label; it must not become one.
  assert.deepStrictEqual(parseRepoLine("a/b nonsense"), { repo: "a/b", kind: "" });
});

check("comments and blank lines are not repositories", () => {
  assert.strictEqual(parseRepoLine("# a comment"), null);
  assert.strictEqual(parseRepoLine("   "), null);
  assert.strictEqual(parseRepoLine(""), null);
});

// The list is the input to every measurement; an unlabelled line would silently
// fall back to a heuristic that answers "unknown" for most real repositories.
check("every repository in our own list carries a kind", () => {
  const text = fs.readFileSync(path.join(root, "benchmark", "repos.txt"), "utf8");
  const missing = text
    .split("\n")
    .map(parseRepoLine)
    .filter(Boolean)
    .filter((e) => !e.kind)
    .map((e) => e.repo);
  assert.deepStrictEqual(missing, [], "unlabelled: " + missing.join(", "));
});

console.log("\nnode-version.usableCiMajor");

check("a long compatibility matrix does not drag us down to Node 1", () => {
  const cors = [1, 2, 3, 4, 5, 10, 14, 16, 17, 18, 19, 20, 22, 24, 25];
  assert.strictEqual(usableCiMajor(cors), 18);
});

check("the lowest modern version still wins - a break matters most on the oldest", () => {
  assert.strictEqual(usableCiMajor([22, 20, 18]), 18);
  assert.strictEqual(usableCiMajor([24, 22]), 22);
});

// Not FALLBACK: running an old project on a newer Node can heal the very break
// being measured, which is how a real ESM failure once vanished mid-run.
check("a genuinely old project gets its own highest, not our fallback", () => {
  assert.strictEqual(usableCiMajor([14, 16]), 16);
  assert.strictEqual(usableCiMajor([8, 10, 12]), 12);
  assert.notStrictEqual(String(usableCiMajor([14, 16])), FALLBACK);
});

check("zeros and junk never become a version", () => {
  assert.strictEqual(usableCiMajor([0, 0, 20]), 20);
  assert.strictEqual(usableCiMajor([0]), null);
  assert.strictEqual(usableCiMajor([]), null);
  assert.strictEqual(usableCiMajor(null), null);
  assert.strictEqual(usableCiMajor([NaN, 18]), 18);
});

check("the floor is a real Node version, not an arbitrary number", () => {
  assert.ok(OLDEST_USABLE >= 14 && OLDEST_USABLE <= 22, "floor is " + OLDEST_USABLE);
});

console.log("\nguard.proofLevel");

check("red suite that goes green is rung 1, and the only rung that ships proud", () => {
  const l = proofLevel({ hasPatch: true, baselineRed: true, testsPassed: true });
  assert.strictEqual(l.rung, 1);
  assert.strictEqual(l.verified, true);
  assert.strictEqual(l.draft, false);
});

// The whole reason this function exists.
check("green before and green after is NOT rung 1 - it proves no regression only", () => {
  const l = proofLevel({ hasPatch: true, baselineRed: false, testsPassed: true });
  assert.strictEqual(l.rung, 3);
  assert.strictEqual(l.verified, false);
  assert.strictEqual(l.draft, true, "an unproven fix must open as a draft");
  assert.match(l.claim, /never exercised/);
});

check("a mechanical check that was red and is now green is rung 2", () => {
  const l = proofLevel({ hasPatch: true, baselineRed: false, testsPassed: true, checkWasRed: true, checkPassed: true });
  assert.strictEqual(l.rung, 2);
  assert.strictEqual(l.verified, true);
  assert.strictEqual(l.draft, false);
});

check("a check that was already red and still is does not earn rung 2", () => {
  assert.strictEqual(proofLevel({ hasPatch: true, testsPassed: true, checkWasRed: true, checkPassed: false }).rung, 3);
});

check("a check that was green all along proves nothing either", () => {
  assert.strictEqual(proofLevel({ hasPatch: true, testsPassed: true, checkWasRed: false, checkPassed: true }).rung, 3);
});

check("no patch is rung 4 - analysis, and it never claims to be a fix", () => {
  const l = proofLevel({ hasPatch: false, baselineRed: true });
  assert.strictEqual(l.rung, 4);
  assert.strictEqual(l.verified, false);
});

check("a failing suite is not a rung at all", () => {
  const l = proofLevel({ hasPatch: true, baselineRed: true, testsPassed: false });
  assert.strictEqual(l.rung, null);
  assert.strictEqual(l.verified, false);
});

check("only rungs 1 and 2 are ever verified, across every combination", () => {
  for (const hasPatch of [true, false]) {
    for (const baselineRed of [true, false]) {
      for (const testsPassed of [true, false]) {
        for (const checkWasRed of [true, false]) {
          for (const checkPassed of [true, false]) {
            const l = proofLevel({ hasPatch, baselineRed, testsPassed, checkWasRed, checkPassed });
            if (l.verified) assert.ok(l.rung === 1 || l.rung === 2, "rung " + l.rung + " claimed verification");
            // And nothing that claims verification may also be a draft.
            if (l.verified) assert.strictEqual(l.draft, false);
          }
        }
      }
    }
  }
});

check("the banner never says verified for an unproven rung", () => {
  assert.match(proofBanner(proofLevel({ hasPatch: true, baselineRed: true, testsPassed: true })), /Proof: the test suite/);
  assert.match(proofBanner(proofLevel({ hasPatch: true, testsPassed: true })), /Not verified/);
  assert.match(proofBanner(proofLevel({ hasPatch: false })), /No patch/);
  assert.match(proofBanner(proofLevel({ hasPatch: true, baselineRed: true, testsPassed: false })), /Not delivered/);
});

// ---------------------------------------------------------------------------
// target-dir.mjs — which directory of a monorepo the break lives in.
//
// The failure this guards against is not "we picked no directory" (that is
// visible and harmless), it is "we picked the wrong one": the run then measures
// a package that never imported the thing, and reports a confident verdict
// about it. So the disagreement cases below matter more than the happy path.
// ---------------------------------------------------------------------------

const MONO = [
  { dir: ".", deps: { turbo: "^1" } },
  { dir: "packages/core", deps: { "content-type": "^2", jest: "^29" } },
  { dir: "packages/cli", deps: { chalk: "^4" } },
];

check("a single-package repo is always the root", () => {
  const r = chooseTargetDir({
    packageName: "content-type",
    manifests: [{ dir: ".", deps: { "content-type": "^2" } }],
  });
  assert.strictEqual(r.dir, ".");
});

check("the one workspace that declares the package is the target", () => {
  const r = chooseTargetDir({ packageName: "content-type", manifests: MONO });
  assert.strictEqual(r.dir, "packages/core");
  assert.strictEqual(r.agreed, false, "declaration alone is one signal, not two");
});

check("a stack trace agreeing with the declaration raises confidence", () => {
  const r = chooseTargetDir({
    packageName: "content-type",
    manifests: MONO,
    output: "Error [ERR_REQUIRE_ESM]: require() of ES Module /case/packages/core/src/read.js",
  });
  assert.strictEqual(r.dir, "packages/core");
  assert.strictEqual(r.agreed, true);
});

// The exact shape of the break that dominates this benchmark. The FIRST path in
// the message is the dependency's own file, inside node_modules - taking it
// would point every single monorepo at the wrong place.
check("the node_modules path in an ERR_REQUIRE_ESM message is not our code", () => {
  const msg =
    "Error [ERR_REQUIRE_ESM]: require() of ES Module " +
    "/home/runner/work/case/node_modules/content-type/dist/index.js from " +
    "/home/runner/work/case/packages/core/lib/read.js not supported.";
  const paths = repoPathsInOutput(msg);
  assert.ok(!paths.some((p) => p.includes("node_modules")), "the dependency's own file must not count");
  assert.strictEqual(paths[0], "home/runner/work/case/packages/core/lib/read.js");
});

check("the workspace root prefix is stripped so paths are repo-relative", () => {
  const paths = repoPathsInOutput("at /home/runner/work/case/packages/cli/bin.js:3:1", "case");
  assert.strictEqual(paths[0], "packages/cli/bin.js");
});

check("several workspaces declare it, and the failure says which one broke", () => {
  const many = [
    { dir: ".", deps: {} },
    { dir: "packages/core", deps: { "content-type": "^2" } },
    { dir: "packages/http", deps: { "content-type": "^2" } },
  ];
  const r = chooseTargetDir({
    packageName: "content-type",
    manifests: many,
    output: "at Object.<anonymous> (packages/http/src/parse.js:9:11)",
  });
  assert.strictEqual(r.dir, "packages/http");
  assert.strictEqual(r.agreed, true);
});

// The whole point. Two signals that disagree mean we do not know, and a
// benchmark that guesses here produces a wrong answer that still looks right.
check("signals that disagree produce no answer at all", () => {
  const r = chooseTargetDir({
    packageName: "content-type",
    manifests: MONO,
    output: "at Object.<anonymous> (packages/cli/bin.js:3:1)",
  });
  assert.strictEqual(r.dir, null);
  assert.match(r.why, /refusing to guess/);
  assert.match(r.why, /packages\/core/, "the reason must name both candidates");
  assert.match(r.why, /packages\/cli/);
});

check("several declare it and nothing says which - still no answer", () => {
  const many = [
    { dir: "packages/core", deps: { "content-type": "^2" } },
    { dir: "packages/http", deps: { "content-type": "^2" } },
  ];
  const r = chooseTargetDir({ packageName: "content-type", manifests: many });
  assert.strictEqual(r.dir, null);
  assert.match(r.why, /refusing to guess/);
});

check("nothing to go on is null, not the root as a hopeful default", () => {
  const r = chooseTargetDir({ packageName: "left-pad", manifests: MONO, output: "boom" });
  assert.strictEqual(r.dir, null);
});

check("the deepest workspace containing a file owns it, not the root", () => {
  const dirs = [".", "packages/core", "packages/core/plugins"];
  assert.strictEqual(ownerOf("packages/core/plugins/a.js", dirs), "packages/core/plugins");
  assert.strictEqual(ownerOf("packages/core/src/a.js", dirs), "packages/core");
  assert.strictEqual(ownerOf("tools/build.js", dirs), ".");
});

check("a devDependency counts - a test-only import still breaks the tests", () => {
  const r = chooseTargetDir({
    packageName: "jest",
    manifests: MONO,
  });
  assert.strictEqual(r.dir, "packages/core");
});

check("windows separators and ./ prefixes normalise to the same directory", () => {
  assert.strictEqual(normDir("./packages\\core/"), "packages/core");
  assert.strictEqual(ownerOf("packages\\core\\src\\a.js", ["packages/core"]), "packages/core");
});

check("a missing package name never yields a directory", () => {
  assert.deepStrictEqual(workspacesDeclaring("", MONO), []);
  assert.deepStrictEqual(workspacesDeclaring(undefined, MONO), []);
});

// A dependency name that happens to match Object.prototype must not resolve
// through the prototype chain and report a declaration nobody wrote.
check("an inherited property is not a declaration", () => {
  assert.deepStrictEqual(workspacesDeclaring("constructor", [{ dir: ".", deps: {} }]), []);
});

// ---------------------------------------------------------------------------
// NEEDS-DECISION: a break with no fix in the customer's code is not our failure.
// The tests that matter here are the ones proving it cannot be claimed.
// ---------------------------------------------------------------------------

const decided = (over = {}) =>
  benchmarkOutcome({
    baselineExit: "0",
    brokenExit: "1",
    finalExit: "1",
    changed: "false",
    version: "3",
    installed: "3.0.0",
    actionOutcome: "needs-decision",
    actionSummary: "Patchery found the cause - and no code change fixes this one",
    decisionReason: "no-code-fix",
    ...over,
  });

check("a break with no fix in your code is not filed as having nothing to offer", () => {
  const r = decided();
  assert.strictEqual(r.outcome, "NEEDS-DECISION");
  assert.match(r.detail, /no code change fixes this break/);
  assert.match(r.detail, /no-code-fix/);
});

// The gate is the action's own outcome slug, which agent.mjs sets only from
// classifyFailure's regex over the test output. If prose could reach it, an agent
// that learned the phrase would have learned an excuse - and every stuck run
// would arrive dressed as a decision.
check("the summary text alone cannot buy this outcome", () => {
  const r = decided({
    actionOutcome: "no-changes",
    actionSummary: "no code change fixes this one, the decision is yours, needs-decision",
  });
  assert.strictEqual(r.outcome, "NO-CHANGE", "a model wrote that sentence, so it proves nothing");
});

check("running out of turns is still ours, however it is described", () => {
  const r = decided({ actionOutcome: "max-turns reached", decisionReason: "" });
  assert.strictEqual(r.outcome, "EXHAUSTED");
});

// The outcome must not become a place a shipped change can hide. If anything was
// written, the ordinary checks decide - including the census.
check("a run that shipped a change is judged on the change, not on its label", () => {
  assert.strictEqual(decided({ changed: "true", finalExit: "0" }).outcome, "FIXED");
  assert.strictEqual(decided({ changed: "true", finalExit: "1" }).outcome, "WRONG");
});

check("our own setup failing still outranks it - that is not the customer's break", () => {
  assert.strictEqual(decided({ baselineExit: "1" }).outcome, "BLOCKED");
  assert.strictEqual(decided({ installed: "2.0.1" }).outcome, "BLOCKED");
});

// The whole discipline in one assertion: it is a separate row, and it is inside
// the denominator. A customer whose build is still red has not been helped,
// whoever is at fault.
check("NEEDS-DECISION is counted, not excused", () => {
  const rows = [
    { outcome: "FIXED", repo: "a/b", package: "p", version: "3" },
    { outcome: "NEEDS-DECISION", repo: "c/d", package: "q", version: "3" },
    { outcome: "BLOCKED", repo: "e/f", package: "r", version: "3" },
  ];
  const text = renderReport(rows, { kind: "benchmark" });
  assert.match(text, /1 fixed of 2 cases/, "the decision row stays in the denominator; only BLOCKED leaves");
  assert.match(text, /no code fix exists; the decision is the answer \| 1/);
  assert.ok(!/could not fix/i.test(text), "the table must not describe it as our shortfall");
});

check("it is ordered as neither a success nor a failure", () => {
  const order = sortRows(
    [{ outcome: "NO-CHANGE", repo: "a" }, { outcome: "NEEDS-DECISION", repo: "b" }, { outcome: "FIXED", repo: "c" }],
    "benchmark"
  ).map((r) => r.outcome);
  assert.deepStrictEqual(order, ["FIXED", "NEEDS-DECISION", "NO-CHANGE"]);
});

// ---------------------------------------------------------------------------
// The run budget: the ceiling that making the stall clock honest took away.
// ---------------------------------------------------------------------------

check("the run budget defaults below the usual CI job limit", () => {
  assert.strictEqual(normalizeRunBudget("").minutes, 45);
  assert.strictEqual(normalizeRunBudget(undefined).minutes, 45);
  assert.ok(normalizeRunBudget("").minutes < 60, "a default at or above the job cap defeats the point");
});

check("0 removes the ceiling, for a runner that has none of its own", () => {
  assert.strictEqual(normalizeRunBudget("0").minutes, 0);
  assert.strictEqual(normalizeRunBudget("0").error, null);
});

check("a nonsense budget is named, not silently accepted", () => {
  for (const bad of ["soon", "-5", "9999"]) {
    const r = normalizeRunBudget(bad);
    assert.strictEqual(r.minutes, 45, bad + " should fall back to the default");
    assert.match(r.error, /run-budget-minutes/);
  }
});

// The two messages must not be confusable. The stall message sends the reader to
// their provider, which is exactly the wrong place to send someone whose model
// answered every time and simply had more work than time.
check("the budget message does not claim the model stopped answering", () => {
  const budget = budgetReason("fixing agent", 45);
  assert.match(budget, /45-minute budget/);
  assert.match(budget, /not a stall/);
  assert.ok(!/produced nothing for/.test(budget), "that is the stall message");
  assert.match(timeoutReason("fixing agent", 20), /produced nothing for 20 minutes/);
  assert.notStrictEqual(budget, timeoutReason("fixing agent", 45));
});

check("each message names the input that would change it", () => {
  assert.match(budgetReason("reviewer", 45), /run-budget-minutes/);
  assert.match(timeoutReason("reviewer", 20), /model-timeout-minutes/);
});

// The origin is the whole bug. A budget measured from when THIS call started
// gives the agent, the reviewer and the repair turn 45 minutes each against a
// job limit that is one number for the whole job.
check("the budget counts from the start of the run, not of the call", () => {
  const start = 1_000_000;
  const min = 45;
  assert.strictEqual(budgetDelayMs(min, start, start), 45 * 60 * 1000);
  // Thirty minutes in, a freshly armed timer must get the remaining fifteen.
  assert.strictEqual(budgetDelayMs(min, start, start + 30 * 60 * 1000), 15 * 60 * 1000);
});

check("a call that begins with the budget already spent gets no time", () => {
  const start = 1_000_000;
  assert.strictEqual(budgetDelayMs(45, start, start + 60 * 60 * 1000), 0);
  assert.ok(budgetDelayMs(45, start, start + 99 * 60 * 1000) >= 0, "never a negative delay");
});

check("no budget means no timer at all, not a zero-length one", () => {
  assert.strictEqual(budgetDelayMs(0, 1000, 2000), null);
  // 0 is the value that fires immediately - conflating the two would abort every
  // run instantly for anyone who opted out of the ceiling.
  assert.notStrictEqual(budgetDelayMs(0, 1000, 2000), 0);
});

// The real path from the first live crawl. nestjs/nest reported 49 workspaces
// and offered a demo app as a candidate, because the exclusion list said
// "examples" and nest says "sample".
check("a demo app inside a library repository is not a workspace", () => {
  assert.strictEqual(isProductWorkspace("sample/22-graphql-prisma/package.json"), false);
  assert.strictEqual(isProductWorkspace("packages/core/package.json"), true);
});

check("the excluded directory counts anywhere in the path, not only at the front", () => {
  assert.strictEqual(isProductWorkspace("packages/core/test/fixtures/package.json"), false);
  assert.strictEqual(isProductWorkspace("packages/core/e2e/package.json"), false);
  assert.strictEqual(isProductWorkspace("a/b/node_modules/c/package.json"), false);
});

// The exclusions are whole directory names. A package legitimately called
// "test-utils" or "website-builder" is the product and must survive.
check("an excluded word inside a longer directory name is not a match", () => {
  assert.strictEqual(isProductWorkspace("packages/test-utils/package.json"), true);
  assert.strictEqual(isProductWorkspace("packages/website-builder/package.json"), true);
  assert.strictEqual(isProductWorkspace("packages/documentation-parser/package.json"), true);
});

// The second live pool: storybook offered danger, @google-cloud/bigquery and
// ejs, and remix offered @octokit/request, all from a `scripts` workspace that
// really does declare a test script. Those are release plumbing. A FIXED there
// would license "we fixed a break in Storybook", which is false in the way that
// matters, so the repository's own tooling is excluded like its demos are.
check("the repository's own tooling is not the product", () => {
  assert.strictEqual(isProductWorkspace("scripts/package.json"), false);
  assert.strictEqual(isProductWorkspace("ci/package.json"), false);
  assert.strictEqual(isProductWorkspace("tools/package.json"), false);
  assert.strictEqual(isProductWorkspace("build/package.json"), false);
  assert.strictEqual(isProductWorkspace("internal/package.json"), false);
  assert.strictEqual(isProductWorkspace("packages/core/scripts/package.json"), false);
});

// Same rule as test-utils above, and it matters more here: "toolkit" and
// "build-utils" are names real published packages carry.
// storybook's sandbox storybooks, offered as react@19 by the first pool that
// excluded `scripts`. Patched by name on purpose: the broad rule that would
// catch it also deletes the two names below, which are real packages.
check("a named fixture directory is excluded without a broad test- rule", () => {
  assert.strictEqual(isProductWorkspace("test-storybooks/mcp/package.json"), false);
  assert.strictEqual(isProductWorkspace("packages/test-utils/package.json"), true);
  assert.strictEqual(isProductWorkspace("packages/test-runner/package.json"), true);
});

check("a tooling word inside a longer package name still ships", () => {
  assert.strictEqual(isProductWorkspace("packages/toolkit/package.json"), true);
  assert.strictEqual(isProductWorkspace("packages/build-utils/package.json"), true);
  assert.strictEqual(isProductWorkspace("packages/scripting/package.json"), true);
  assert.strictEqual(isProductWorkspace("packages/internal-api/package.json"), true);
});

check("the repository root itself is always the product", () => {
  assert.strictEqual(isProductWorkspace("package.json"), true);
});

check("the pool summary counts workspace candidates and signal agreement", () => {
  const s = poolShape([
    { repo: "a/b", "target-dir": ".", _dir_why: "single package", _dir_agreed: false },
    { repo: "a/b", "target-dir": "packages/core", _dir_why: "declared there", _dir_agreed: true },
    { repo: "c/d", "target-dir": "packages/cli", _dir_why: "declared there", _dir_agreed: false },
  ]);
  assert.strictEqual(s.inWorkspace, 2);
  assert.strictEqual(s.bothSignals, 1, "one signal is an answer, two agreeing is not the same thing");
});

// A pool written before target-dir was resolved carries no such field, and a 0
// there is the absence of a measurement, not a measurement of zero - the same
// mistake the node column and the guard count each had to be taught once.
check("an older pool reports null, not a zero that reads as a measurement", () => {
  const s = poolShape([{ repo: "a/b" }, { repo: "c/d" }]);
  assert.strictEqual(s.inWorkspace, null);
  assert.strictEqual(s.bothSignals, null);
  const text = renderShape(s, null);
  assert.match(text, /in a workspace, not the root \| not recorded/);
  assert.ok(!/\| 0 \| - \| -/.test(text.split("\n").find((l) => l.includes("workspace"))), "must not print 0");
});

check("a new pool compared against an old one shows no bogus difference", () => {
  const now = poolShape([{ repo: "a/b", "target-dir": "packages/core", _dir_why: "x", _dir_agreed: true }]);
  const text = renderShape(now, poolShape([{ repo: "a/b" }]));
  const line = text.split("\n").find((l) => l.includes("in a workspace"));
  assert.match(line, /\| 1 \| - \| - \|/, "1 minus 'not measured' is not +1");
});

// A run that produced nothing still spent, and "did a no-change run cost as much
// as a fix" is a question no per-exit field can answer - there are forty-two
// exits and the one that forgets is the one that matters. So the totals ride
// along in writeOutputs, and every model call goes through the accumulating
// wrapper rather than calling renderSpend directly.
//
// This check is what makes a sixth agent, added later, counted without anyone
// remembering to count it.
// The dashboard says what five days cost. It cannot say whether the runs that
// produced nothing cost as much as the ones that produced a fix, and that is the
// question worth asking - nine of fourteen cases in run #10 shipped no patch and
// every one of them wrote a long diagnosis.
check("the table says what each outcome cost, per run", () => {
  const text = renderReport(
    [
      { outcome: "FIXED", repo: "a/a", package: "p", version: "1", tokensInput: 100000, tokensOutput: 20000 },
      { outcome: "NO-CHANGE", repo: "b/b", package: "q", version: "1", tokensInput: 200000, tokensOutput: 60000 },
      { outcome: "NO-CHANGE", repo: "c/c", package: "r", version: "1", tokensInput: 100000, tokensOutput: 40000 },
    ],
    { kind: "benchmark", queued: 3 }
  );
  assert.match(text, /what it cost \| runs \| output tokens each/);
  // NO-CHANGE averages 50,000 output over two runs and must sort above FIXED's
  // 20,000 - the expensive-and-empty case is the one to see first.
  const cost = text.slice(text.indexOf("what it cost"));
  assert.ok(cost.indexOf("NO-CHANGE") < cost.indexOf("FIXED"), "the costliest outcome must come first");
  assert.match(cost, /50,000/);
});

// Absent is not zero. A batch collected before the field existed would otherwise
// report every outcome as free.
check("rows with no token count are excluded and counted, not read as zero", () => {
  const text = renderReport(
    [
      { outcome: "FIXED", repo: "a/a", package: "p", version: "1", tokensOutput: 20000 },
      { outcome: "NO-CHANGE", repo: "b/b", package: "q", version: "1" },
    ],
    { kind: "benchmark", queued: 2 }
  );
  assert.match(text, /1 row\(s\) recorded no token count/);
});

check("a batch with no token counts at all prints no cost table", () => {
  const text = renderReport([{ outcome: "FIXED", repo: "a/a", package: "p", version: "1" }], {
    kind: "benchmark",
    queued: 1,
  });
  assert.ok(!/what it cost/.test(text));
});

check("no model call reaches renderSpend without being counted", () => {
  const src = fs.readFileSync(new URL("agent.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const calls = [...src.matchAll(/renderSpend\(/g)].length;
  assert.strictEqual(calls, 1, "renderSpend is called " + calls + " times; only the spend() wrapper may call it");
  assert.match(src, /function spend\(args\)/);
});

check("every exit carries the token totals", () => {
  const src = fs.readFileSync(new URL("agent.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const writer = /function writeOutputs\(obj\) \{([\s\S]*?)\n\}/.exec(src);
  assert.ok(writer, "writeOutputs not found");
  for (const field of ["tokens_input", "tokens_output", "tokens_total"]) {
    assert.match(writer[1], new RegExp(field + ":"), field + " is not written on every exit");
  }
});

// The outcome list in action.yml is the contract a user reads, and it was wrong
// in two ways at once: it omitted blocked-by-guard, needs-decision,
// harness-error, budget and stall, and its sentence "everything except 'failed'
// exits 0" was false because harness-error goes through fail() and exits 1.
//
// Found by the gate census rather than by anyone reading the file, which is the
// point of the census - but a contract deserves a hard check, not a report.
check("action.yml documents every outcome the agent can emit, and no others", () => {
  const agentSrc = fs.readFileSync(new URL("agent.mjs", import.meta.url), "utf8");
  const actionSrc = fs.readFileSync(new URL("../action.yml", import.meta.url), "utf8");
  const emitted = emittedOutcomes(agentSrc);
  const documented = documentedOutcomes(actionSrc);
  assert.deepStrictEqual(
    emitted.filter((o) => !documented.includes(o)),
    [],
    "emitted but undocumented"
  );
  assert.deepStrictEqual(
    documented.filter((o) => !emitted.includes(o)),
    [],
    "documented but never emitted"
  );
});

check("the outcome reader refuses to check a contract against nothing", () => {
  assert.throws(() => emittedOutcomes("nothing here"), /cannot be checked blind/);
});

// vitest reads vite.config.* when vitest.config.* is absent, and both jest and
// vitest accept their whole configuration inside package.json. Neither was
// recognised, so the settings that decide which tests run lived in two files no
// rule looked at.
check("the harness config a runner actually reads is recognised", () => {
  for (const p of ["vite.config.ts", "vite.config.js", "vitest.config.ts", "package.json", ".mocharc.json"]) {
    assert.strictEqual(isHarnessConfig(p), true, p + " is not treated as harness config");
  }
});

check("narrowing the suite from inside package.json is refused", () => {
  const before = '{"name":"x","jest":{"testPathIgnorePatterns":[]}}';
  const after = '{"name":"x","jest":{"testPathIgnorePatterns":["broken.test.js"]}}';
  assert.ok(harnessConfigReason(before, after));
});

// The bump this action exists to make must still pass through the same file.
check("a dependency bump in package.json is not a harness edit", () => {
  const before = '{"name":"x","dependencies":{"content-type":"^2.0.0"}}';
  const after = '{"name":"x","dependencies":{"content-type":"^3.0.0"}}';
  assert.strictEqual(harnessConfigReason(before, after), null);
});

// The same reachability question as the gate census, asked of the wiring: an
// input a reusable workflow declares and its only caller never passes is either
// unnecessary or a bug, and `repeat` was the bug. It was added to
// benchmark-run's workflow_dispatch block and not its workflow_call block, so
// the batch could not pass it, so all three legs of a repeated case uploaded
// under one artifact name - the exact collision the input exists to prevent.
// Measured on run #11: three artifacts, all named
// benchmark-expressjs-body-parser-raw-body-v4.
//
// Neither the workflow linter nor 630 checks could see it. A silently
// unapplied edit looks identical to no edit.
console.log("\nworkflow wiring - an input nobody passes is unnecessary or a bug");

const runYml = fs.readFileSync(new URL("../.github/workflows/benchmark-run.yml", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const batchYml = fs.readFileSync(new URL("../.github/workflows/benchmark-batch.yml", import.meta.url), "utf8").replace(/\r\n/g, "\n");

// A form field's description is read by somebody with the box in front of them,
// mid-task. It has to say what to type. Rationale belongs in README.md, and put
// in the box instead it is a paragraph nobody can act on - the founder hit this
// on a real trigger: four of the fields had grown to 200-370 characters of
// reasoning and none of them said which values were allowed.
check("no workflow_dispatch input description is an essay", () => {
  const LIMIT = 120;
  const dir = new URL("../.github/workflows/", import.meta.url);
  const long = [];
  for (const file of fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))) {
    const text = fs.readFileSync(new URL(file, dir), "utf8").replace(/\r\n/g, "\n");
    const block = /workflow_dispatch:\n\s+inputs:\n([\s\S]*?)(?=\n {2}[a-z]|\n\S)/.exec(text);
    if (!block) continue;
    for (const entry of block[1].split(/\n(?= {6}[a-z][a-z0-9-]*:)/)) {
      const name = (entry.match(/^\s*([a-z][a-z0-9-]*):/) || [])[1];
      const desc = (entry.match(/description:\s*([\s\S]*?)(?=\n\s+(?:required|default|type):)/) || [])[1];
      if (!name || !desc) continue;
      const len = desc.replace(/\s+/g, " ").trim().length;
      if (len > LIMIT) long.push(file + ":" + name + " (" + len + ")");
    }
  }
  assert.deepStrictEqual(long, [], "put the reason in README.md, not the form field: " + long.join(", "));
});

check("every workflow_call input of benchmark-run is passed by the batch", () => {
  const callBlock = /workflow_call:\n\s+inputs:\n([\s\S]*?)(?=\n\S)/.exec(runYml);
  assert.ok(callBlock, "benchmark-run declares no workflow_call inputs");
  const declared = [...callBlock[1].matchAll(/^ {6}([a-z][a-z0-9-]*):/gm)].map((m) => m[1]);
  assert.ok(declared.length >= 8, "found only " + declared.length + " inputs - the parse is wrong, not the file");

  const withBlock = /^ {4}with:\n([\s\S]*?)(?=^ {2}\S)/m.exec(batchYml);
  assert.ok(withBlock, "the batch passes nothing");
  const passed = new Set([...withBlock[1].matchAll(/^ {6}([a-z][a-z0-9-]*):/gm)].map((m) => m[1]));

  const missing = declared.filter((d) => !passed.has(d));
  assert.deepStrictEqual(missing, [], "declared but never passed: " + missing.join(", "));
});

// The other direction, and the one that fails loudly on GitHub rather than
// quietly: passing an input the callee does not declare.
check("the batch passes nothing benchmark-run has not declared", () => {
  const callBlock = /workflow_call:\n\s+inputs:\n([\s\S]*?)(?=\n\S)/.exec(runYml);
  const declared = new Set([...callBlock[1].matchAll(/^ {6}([a-z][a-z0-9-]*):/gm)].map((m) => m[1]));
  const withBlock = /^ {4}with:\n([\s\S]*?)(?=^ {2}\S)/m.exec(batchYml);
  const passed = [...withBlock[1].matchAll(/^ {6}([a-z][a-z0-9-]*):/gm)].map((m) => m[1]);
  const unknown = passed.filter((p) => !declared.has(p));
  assert.deepStrictEqual(unknown, [], "passed but not declared: " + unknown.join(", "));
});

// The third link, and the one both misses actually lived on. The two checks
// above watch the batch's end of the wire, so an input declared to the FORM and
// never to workflow_call passes them both: there is nothing to pass and nothing
// passed. `repeat` shipped exactly that way and cost a repeat set to a single
// artifact name, and the comment beside run-budget-minutes says the same slip
// with a budget would be quieter - arm B silently running at arm A's clock. A
// machine label is quieter still, because both arms would sit on whatever the
// moving tag resolved to and no field in the result would say they differed.
check("no workflow offers a form field it cannot be called with", () => {
  const dir = new URL("../.github/workflows/", import.meta.url);
  const names = (block) => [...block[1].matchAll(/^ {6}([a-z][a-z0-9-]*):/gm)].map((m) => m[1]);
  const seen = [];
  const formOnly = [];
  for (const file of fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))) {
    const text = fs.readFileSync(new URL(file, dir), "utf8").replace(/\r\n/g, "\n");
    const dispatchBlock = /workflow_dispatch:\n\s+inputs:\n([\s\S]*?)(?=\n {2}[a-z]|\n\S)/.exec(text);
    const callBlock = /workflow_call:\n\s+inputs:\n([\s\S]*?)(?=\n {0,4}\S)/.exec(text);
    if (!dispatchBlock || !callBlock) continue;
    seen.push(file);
    const declared = new Set(names(callBlock));
    for (const name of names(dispatchBlock)) {
      if (!declared.has(name)) formOnly.push(file + ":" + name);
    }
  }
  // A probe that quietly stopped matching reports the same empty list as a file
  // with nothing wrong. The known hit is what separates them.
  assert.ok(
    seen.includes("benchmark-run.yml"),
    "the parse never reached benchmark-run.yml - fix the probe, not the file",
  );
  assert.deepStrictEqual(formOnly, [], "offered on the form but not callable: " + formOnly.join(", "));
});

// The runtime is the one environment fact that can differ between two legs of
// the same case with everything else held equal: when the census cannot run on
// the repository's first choice of Node the workflow falls back to its second.
// So it has to reach the row - verify-case has carried it since formdata-node@6
// read VALID on Node 12 and NOT-A-CASE on Node 16 from one commit - and it has
// to come from the step that RESOLVED the fallback. steps.node.outputs.first
// would record the version that was asked for rather than the one that
// measured, and would be right exactly when it did not matter.
check("the benchmark row records the runtime the suite was measured on", () => {
  const call = /benchmark-outcome\.mjs[\s\S]*?--out /.exec(runYml);
  assert.ok(call, "the benchmark-outcome invocation moved - fix the probe, not the file");
  assert.match(call[0], /--node "\$NODE_USED"/, "the invocation does not pass --node");
  assert.match(
    runYml,
    /NODE_USED: \$\{\{ steps\.baseline\.outputs\.node \}\}/,
    "NODE_USED must come from the baseline step - it is the only one that resolved the fallback",
  );

  const outcomeSrc = fs.readFileSync(
    new URL("../scripts/benchmark-outcome.mjs", import.meta.url),
    "utf8",
  );
  assert.match(outcomeSrc, /^\s*node: a\.node \|\| "",/m, "the row does not carry a node field");
});

// A test says a rule works on the input the test hands it. It cannot say the
// rule is REACHABLE - that a real run ever arrives at that branch - and two of
// this project's own bugs lived exactly there: NEEDS-DECISION shipped and fired
// zero times in a 14-case run, and .mocharc.json sat on the protected list while
// harnessConfigReason returned null every time. Both were invisible to the suite
// and obvious to a census.
console.log("\ngate census - a rule that never fires is unnecessary or broken");

check("the gate list is derived from the source, never typed", () => {
  const src = `
    function refuse(message, reason = "unspecified") {}
    refuse("a message about paths", "protected-path");
    refuse(
      "a message that spans lines",
      "census-shrunk"
    );
  `;
  assert.deepStrictEqual(knownGuardReasons(src), ["census-shrunk", "protected-path"]);
});

// A census over zero known gates would print "0 gates never fired" and read as a
// clean bill of health - the "0 results means the search is broken" failure this
// repository has already paid for once.
check("a census that found no gates refuses to run rather than pass", () => {
  assert.throws(() => knownGuardReasons("nothing here calls refuse"), /cannot run blind/);
});

check("a gate that never fired is named, with the sample size beside it", () => {
  const c = gateCensus({
    guardReasons: ["protected-path", "census-shrunk"],
    docOutcomes: ["fixed"],
    rows: [{ actionOutcome: "fixed", guardReason: "protected-path" }],
  });
  const text = renderCensus(c);
  assert.match(text, /\*\*census-shrunk\*\*/, "a silent gate must be marked");
  assert.match(text, /1 gate\(s\) never fired/);
  assert.match(text, /1 runs is a small sample/, "silence in a tiny sample is not a finding");
});

// The direction a documented list cannot see: an outcome the product emits that
// the action's contract never mentions. Found on the first real run -
// `harness-error`, three times, absent from action.yml.
check("an outcome that is emitted but undocumented is reported", () => {
  const c = gateCensus({ guardReasons: [], docOutcomes: ["fixed"], rows: [{ actionOutcome: "harness-error" }] });
  assert.strictEqual(c.undocumented.length, 1);
  assert.match(renderCensus(c), /not in action\.yml's list.*harness-error/s);
});

// The description names some values twice - the list, then "everything except
// 'failed'" - and the first census run printed `failed` as two gates.
check("an outcome named twice in the description is one gate", () => {
  const action = [
    "inputs:",
    "  x:",
    "    description: y",
    "outputs:",
    "  outcome:",
    "    description: >-",
    "      How it ended: 'fixed' or 'failed'. Everything except 'failed' exits 0.",
    "    value: z",
    "  changed:",
    "    description: q",
  ].join("\n");
  assert.deepStrictEqual(documentedOutcomes(action), ["failed", "fixed"]);
});

// Repeats exist because of one measurement, not a theory: body-parser +
// raw-body@4, on a single model, came back BLOCKED in run #8, FIXED in #9 and
// EXHAUSTED in #10. These checks hold the two properties that make a repeated
// batch readable - whole sets only, and a headline counted in cases.
console.log("\nrepeats - a case run once is one observation, not a rate");

check("repeats expands each case and numbers the runs", () => {
  const r = planBatch([{ repo: "a/b", package: "p" }, { repo: "a/c", package: "q" }], { repeats: 3, cap: 50 });
  assert.strictEqual(r.cases, 2);
  assert.strictEqual(r.picked.length, 6);
  assert.deepStrictEqual(r.picked.map((x) => x.repeat), ["1", "2", "3", "1", "2", "3"]);
});

// The cap counts legs, so a higher repeat count has to buy fewer cases - and it
// must buy WHOLE sets. A case run twice beside neighbours run three times makes
// the consistency column mean two things in one table.
check("the cap drops whole cases, never a partial repeat set", () => {
  const rows = [1, 2, 3].map((i) => ({ repo: "a/" + i, package: "p" }));
  const r = planBatch(rows, { repeats: 3, cap: 7 });
  assert.strictEqual(r.cases, 2, "floor(7/3) = 2 cases");
  assert.strictEqual(r.picked.length, 6);
  assert.strictEqual(r.dropped, 1);
});

check("repeats of 1 leaves the plan exactly as it was", () => {
  const rows = [{ repo: "a/b", package: "p" }];
  const r = planBatch(rows, { repeats: 1, cap: 50 });
  assert.strictEqual(r.picked.length, 1);
  assert.ok(!("repeat" in r.picked[0]), "a single run must not carry a repeat number");
});

check("the same case with different outcomes is reported as unstable", () => {
  const g = repeatGroups(
    [
      { repo: "a/b", package: "p", version: "4", outcome: "FIXED" },
      { repo: "a/b", package: "p", version: "4", outcome: "EXHAUSTED" },
    ],
    "benchmark"
  );
  assert.strictEqual(g.length, 1);
  assert.strictEqual(g[0].runs, 2);
  assert.strictEqual(g[0].stable, false);
  assert.ok(hasRepeats(g));
});

// The rule the whole feature exists to enforce: a fix that happened once out of
// three is not a fix. Counting legs would report it as one.
check("a case fixed in only some runs does not count as fixed", () => {
  const text = renderReport(
    [
      { repo: "a/b", package: "p", version: "4", outcome: "FIXED" },
      { repo: "a/b", package: "p", version: "4", outcome: "EXHAUSTED" },
      { repo: "a/b", package: "p", version: "4", outcome: "BLOCKED" },
    ],
    { kind: "benchmark", queued: 3 }
  );
  assert.match(text, /^## 0 fixed of 1 cases, every time \(3 runs each\)/m);
  assert.match(text, /fixed in some runs and not others/);
  assert.match(text, /\*\*FIXED, EXHAUSTED, BLOCKED\*\*/);
});

check("a batch with no repeats keeps the old headline word for word", () => {
  const text = renderReport([{ repo: "a/b", package: "p", version: "4", outcome: "FIXED" }], {
    kind: "benchmark",
    queued: 1,
  });
  assert.match(text, /^## 1 fixed of 1 cases it was able to attempt/m);
  assert.ok(!/every time/.test(text), "the repeat headline must not appear for a single run");
});

// `mode: scan` is a second behaviour inside a published action, and the danger
// is not that scan is wrong - it is that adding it changes what happens to
// everyone already running the old one. These checks read action.yml itself and
// pin the compatibility rather than trusting that it was preserved.
//
// The typo case is the one that would hurt most quietly: every fixing step tests
// `mode != 'scan'`, so "sacn" would skip the scan and run the full model pass on
// a repository whose owner asked for a read-only report.
console.log("\naction.yml - adding scan mode must not move anyone already on fix");

// Normalised for the same reason check-claims.mjs does it: the file is CRLF on a
// Windows checkout, and every anchored pattern below would miss without ever
// saying why.
const actionSrc = fs.readFileSync(new URL("../action.yml", import.meta.url), "utf8").replace(/\r\n/g, "\n");

check("mode defaults to fix, so an existing workflow behaves exactly as before", () => {
  const block = /^ {2}mode:\n([\s\S]*?)(?=^ {2}\S)/m.exec(actionSrc);
  assert.ok(block, "action.yml declares no mode input");
  assert.match(block[1], /^ {4}default: "fix"$/m);
  assert.match(block[1], /^ {4}required: false$/m);
});

check("every step that spends money or writes is off in scan mode", () => {
  // Split on step boundaries and read each one's name and condition together, so
  // a step added later without a condition fails here rather than in a customer's
  // scheduled run.
  const steps = actionSrc
    .split(/^ {4}- name: /m)
    .slice(1)
    .map((s) => ({ name: s.split("\n")[0].trim(), cond: (/^ {6}if: (.+)$/m.exec(s) || [])[1] || "" }));
  const spends = steps.filter((s) => /Install agent dependencies|Run the agent/.test(s.name));
  assert.strictEqual(spends.length, 2, "the two steps that install the SDK and call the model must both exist");
  for (const s of spends) assert.strictEqual(s.cond, "inputs.mode != 'scan'", s.name + " runs in scan mode");
  const scan = steps.find((s) => /Report the upgrades/.test(s.name));
  assert.strictEqual(scan?.cond, "inputs.mode == 'scan'", "the scan step must not run in fix mode");
});

check("an unrecognised mode stops the run instead of falling through to fix", () => {
  assert.match(actionSrc, /case "\$IN_MODE" in\n\s*fix\|scan\) ;;\n\s*\*\)/);
  assert.match(actionSrc, /::error::mode must be 'fix' or 'scan'/);
});

// The sentinel's first half: what a repository has not upgraded yet, read from
// its own package.json rather than over the API. The rule these checks exist to
// hold is that every declared dependency leaves in exactly one list - a name
// that silently vanishes is the "0 results" failure this project has already
// paid for once.
console.log("\nscan-deps - the upgrades this repository has not taken");

check("a dependency with a newer major becomes a candidate", () => {
  const { candidates } = pendingMajors(
    { dependencies: { "content-type": "^2.0.0" } },
    { "content-type": "3.0.0" }
  );
  assert.strictEqual(candidates.length, 1);
  assert.strictEqual(candidates[0].package, "content-type");
  assert.strictEqual(candidates[0].from, 2);
  assert.strictEqual(candidates[0].to, 3);
  assert.strictEqual(candidates[0]["breaking-version"], "3");
  assert.strictEqual(candidates[0].runtime, true);
});

check("a dependency already on the newest major is not a candidate", () => {
  const r = pendingMajors({ dependencies: { express: "^5.1.0" } }, { express: "5.2.1" });
  assert.strictEqual(r.candidates.length, 0);
  assert.match(r.skipped[0].why, /already on the newest major/);
});

check("every declared dependency leaves in exactly one list", () => {
  const pkg = {
    dependencies: { a: "^1.0.0", b: "workspace:*" },
    devDependencies: { jest: "^29.0.0", c: "^2.0.0" },
  };
  const r = pendingMajors(pkg, { a: "2.0.0", c: null });
  const seen = [...r.candidates.map((c) => c.package), ...r.skipped.map((s) => s.name)].sort();
  assert.deepStrictEqual(seen, ["a", "b", "c", "jest"]);
});

// Each of these would otherwise be reported to a customer as an upgrade to make.
check("an unreadable range is skipped by name, never guessed", () => {
  const r = pendingMajors({ dependencies: { x: "workspace:*", y: "github:a/b" } }, { x: "9.0.0", y: "9.0.0" });
  assert.strictEqual(r.candidates.length, 0);
  assert.strictEqual(r.skipped.length, 2);
  for (const s of r.skipped) assert.match(s.why, /cannot read the version range/);
});

// A package npm could not be asked about is NOT the same as one with no new
// major, and merging them would let a broken network read as a clean report.
check("a package npm did not answer for is skipped, not cleared", () => {
  const r = pendingMajors({ dependencies: { a: "^1.0.0" } }, { a: null });
  assert.strictEqual(r.candidates.length, 0);
  assert.match(r.skipped[0].why, /npm did not answer/);
});

check("test and build tooling stays out, as it does in find-bumps", () => {
  const r = pendingMajors(
    { devDependencies: { jest: "^29.0.0", eslint: "^8.0.0", "@types/node": "^20.0.0" } },
    { jest: "30.0.0", eslint: "9.0.0", "@types/node": "24.0.0" }
  );
  assert.strictEqual(r.candidates.length, 0);
  assert.strictEqual(r.skipped.length, 3);
});

check("a devDependency is a candidate but is marked as one", () => {
  const r = pendingMajors({ devDependencies: { ejs: "^3.0.0" } }, { ejs: "6.0.1" });
  assert.strictEqual(r.candidates.length, 1);
  assert.strictEqual(r.candidates[0].runtime, false);
});

// The rendered text is what a person reads, and "6 upgrades pending" must not
// arrive sounding like "6 problems": the last sweep across 55 repositories found
// most pending majors upgraded without turning anything red.
// Impact, and the line between impact and risk. Three files importing a package
// are three places a change lands; none of them is evidence that the change
// breaks anything, and a report that blurs the two turns a scan into an alarm.
check("import sites are counted from the project's own files", () => {
  const files = [
    { path: "lib/utils.js", text: "var contentType = require('content-type');" },
    { path: "lib/response.js", text: "import { parse } from 'content-type'" },
    { path: "lib/other.js", text: "const x = require('express')" },
  ];
  const r = importSites(files, "content-type");
  assert.strictEqual(r.files, 2);
  assert.deepStrictEqual(r.paths, ["lib/utils.js", "lib/response.js"]);
});

check("a package nothing imports counts zero, not missing", () => {
  const r = importSites([{ path: "a.js", text: "const x = 1" }], "content-type");
  assert.strictEqual(r.files, 0);
  assert.deepStrictEqual(r.paths, []);
});

// A subpath import is still an import of the package: `require('pkg/sub')` breaks
// when pkg's major changes exactly as `require('pkg')` does.
check("a subpath import counts as importing the package", () => {
  const r = importSites([{ path: "a.js", text: "const q = require('marked/lib/x')" }], "marked");
  assert.strictEqual(r.files, 1);
});

check("impact is attached without inventing it for packages not walked", () => {
  const out = withImpact([{ package: "a" }, { package: "b" }], { a: { files: 3, paths: ["x", "y", "z"] } });
  assert.strictEqual(out[0].files, 3);
  assert.ok(!("files" in out[1]), "a package we did not walk must not get a count");
});

// The wording is the check. "imported in at least N" is not decoration: the
// counter is the guard's regex, so `require(name)` through a variable is not
// seen, and a floor presented as a total is a number that will be wrong.
check("the count is presented as a floor and never as a risk", () => {
  const text = renderScan({
    candidates: [{ package: "content-type", from: 2, to: 3, latest: "3.0.0", runtime: true, files: 3 }],
    skipped: [],
  });
  assert.match(text, /imported in at least 3 files/);
  assert.match(text, /runtime/);
  assert.ok(!/risk|severe|critical|danger/i.test(text), "impact must not be dressed as risk");
});

check("a scan that walked no files says nothing about impact", () => {
  const text = renderScan({
    candidates: [{ package: "content-type", from: 2, to: 3, latest: "3.0.0", runtime: true }],
    skipped: [],
  });
  assert.ok(!/imported in|no file here/.test(text), "an unwalked scan must not imply a count of zero");
});

check("the report says the tests have not been run", () => {
  const text = renderScan(pendingMajors({ dependencies: { a: "^1.0.0" } }, { a: "2.0.0" }));
  assert.match(text, /nothing here ran your tests/i);
  assert.ok(!/break/i.test(text.split("\n")[0]), "the headline must not claim a break");
});

check("nothing pending says so, and says how many it checked", () => {
  const text = renderScan(pendingMajors({ dependencies: { a: "^1.0.0" } }, { a: "1.2.0" }));
  assert.match(text, /No dependency here has shipped a new major/);
  assert.match(text, /1 checked and skipped/);
});

// The founder's ruling, pinned so it survives the next rewrite of this text:
// the report Patchery hands over when no patch is possible is a FALLBACK, never
// a sales argument. "The analysis above is the deliverable" shipped anyway - in
// agent.mjs's closing line and, worse, inside the strategy prompt the model
// reads before writing its own summary, so the framing was being taught rather
// than merely printed. Both were corrected on the README and the site first and
// missed here, which is how a claim ends up true on every surface except the
// product's own mouth.
//
// This is a grep, not a behaviour test, and that is deliberate: the sentence can
// come back in any number of phrasings, but it cannot come back in these files
// without someone reading this comment.
console.log("\nThe fallback report must not be sold as the deliverable");

check("no user-facing text calls the fallback report the deliverable", () => {
  for (const file of ["agent.mjs", "classify-break.mjs", "guard.mjs"]) {
    const src = fs.readFileSync(new URL(file, import.meta.url), "utf8");
    // Only the lines that reach a user: strings, not the comments explaining why
    // the strings say what they say.
    const speech = src
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
    assert.ok(
      !/(is|as) the deliverable/i.test(speech),
      file + " tells the reader the analysis is the deliverable; it is the fallback"
    );
  }
});

check("but saying no patch was possible is still allowed to be honest", () => {
  const src = fs.readFileSync(new URL("classify-break.mjs", import.meta.url), "utf8");
  // The other half of the ruling: a break we cannot patch is not our failure, and
  // the model still needs permission to stop rather than thrash for a patch.
  assert.match(src, /it is not a failure/i);
});


// ---------------------------------------------------------------------------
// The counterexample: the reviewer's claim, settled by the terminal.
//
// Every check below exists because the alternative is a reviewer that can
// refute any patch by writing prose, which is what it could do until today.
// ---------------------------------------------------------------------------

check("counterexampleReasons passes an ordinary deterministic test", () => {
  const src = [
    'import assert from "node:assert";',
    'import { parse } from "../src/parse.js";',
    'assert.strictEqual(parse("a=1").a, "1");',
  ].join("\n");
  assert.deepStrictEqual(counterexampleReasons(src), []);
});

check("counterexampleReasons refuses an empty counterexample", () => {
  assert.deepStrictEqual(counterexampleReasons("   \n "), ["the counterexample is empty"]);
  assert.deepStrictEqual(counterexampleReasons(null), ["the counterexample is empty"]);
});

// A test that reaches the network fails for reasons that have nothing to do
// with the patch, and it can fail that way repeatably enough that the K-repeat
// rule below would not catch it. It has to be screened before it is ever run.
check("counterexampleReasons catches the network", () => {
  for (const src of [
    'const r = await fetch("https://example.com");',
    'const http = require("node:http");',
    'import got from "got";',
    "const ws = new WebSocket(url);",
  ]) {
    assert.ok(counterexampleReasons(src).length > 0, "should refuse: " + src);
  }
});

check("counterexampleReasons catches real timers, randomness and the clock", () => {
  assert.match(counterexampleReasons("setTimeout(done, 50)").join(), /real timer/);
  assert.match(counterexampleReasons("if (Math.random() > 0.5) fail()").join(), /randomness/);
  assert.match(counterexampleReasons("const t = Date.now()").join(), /wall clock/);
  assert.match(counterexampleReasons("const d = new Date()").join(), /wall clock/);
});

check("counterexampleReasons catches escapes from the test", () => {
  assert.match(
    counterexampleReasons('require("child_process").execSync("ls")').join(),
    /another process/
  );
  assert.match(counterexampleReasons("process.exit(1)").join(), /process\.exit/);
  assert.match(counterexampleReasons('fs.writeFileSync("x", "y")').join(), /writes to the filesystem/);
  assert.match(counterexampleReasons("await fs.promises.unlink(p)").join(), /writes to the filesystem/);
});

// The screen is anchored on a non-identifier character. Without that anchor it
// refuses `myFetch(` and `resetTimeout(`, which are ordinary names in ordinary
// codebases, and the reviewer would lose a sound accusation to a false match.
check("counterexampleReasons does not fire on identifiers that merely contain a keyword", () => {
  // `prefetch(` and `resetTimeout(` contain the keyword in the SAME case, which
  // is the only version of this test that bites: mutation testing removed the
  // anchor and `myFetch(` still passed, because the capital F never matched the
  // rule in the first place. A near-miss fixture proves nothing and reads as
  // though it does.
  assert.deepStrictEqual(counterexampleReasons("const x = prefetch(url);"), []);
  assert.deepStrictEqual(counterexampleReasons("const x = myFetch(url);"), []);
  assert.deepStrictEqual(counterexampleReasons("resetTimeout(handle);"), []);
  assert.deepStrictEqual(counterexampleReasons("const d = new Date(0);"), []);
});

check("counterexampleReasons refuses a counterexample that is really a rewrite", () => {
  const huge = "const x = 1;\n".repeat(2000);
  assert.match(counterexampleReasons(huge).join(), /longer than/);
});

const ceOk = (n) => Array.from({ length: n }, () => ({ exitCode: 0, output: "" }));
const ceBad = (n, out) => Array.from({ length: n }, () => ({ exitCode: 1, output: out }));

check("differentialVerdict establishes a real regression", () => {
  const r = differentialVerdict({
    oldRuns: ceOk(3),
    newRuns: ceBad(3, "TypeError: cb is not a function"),
    expectedFailure: "cb is not a function",
  });
  assert.strictEqual(r.established, true);
});

// The rule that stops the reviewer refuting everything: a test that fails on
// the original code has found its own bug, not a regression.
check("differentialVerdict rejects a counterexample that never passed on the old tree", () => {
  const r = differentialVerdict({
    oldRuns: ceBad(3, "boom"),
    newRuns: ceBad(3, "boom"),
    expectedFailure: "boom",
  });
  assert.strictEqual(r.established, false);
  assert.match(r.why, /code that worked/);
});

check("differentialVerdict rejects a patch failure that is only sometimes", () => {
  const r = differentialVerdict({
    oldRuns: ceOk(3),
    newRuns: [...ceBad(2, "boom"), { exitCode: 0, output: "" }],
    expectedFailure: "boom",
  });
  assert.strictEqual(r.established, false);
  assert.match(r.why, /only 2 of 3/);
});

// Without this the reviewer collects a refutation from a crash it caused
// itself: a typo fails on both trees, and "it failed" would have been enough.
check("differentialVerdict requires the failure the reviewer predicted", () => {
  const r = differentialVerdict({
    oldRuns: ceOk(3),
    newRuns: ceBad(3, "SyntaxError: unexpected token"),
    expectedFailure: "cb is not a function",
  });
  assert.strictEqual(r.established, false);
  assert.match(r.why, /predicted error/);
});

check("differentialVerdict says 'could not tell' rather than 'fine' when runs are missing", () => {
  assert.strictEqual(
    differentialVerdict({ oldRuns: ceOk(1), newRuns: ceBad(3, "x"), expectedFailure: "x" })
      .established,
    null
  );
  assert.strictEqual(differentialVerdict({}).established, null);
});

check("differentialVerdict will not read a missing exit code as a pass", () => {
  const r = differentialVerdict({
    oldRuns: [...ceOk(2), { exitCode: null, output: "" }],
    newRuns: ceBad(3, "x"),
    expectedFailure: "x",
  });
  assert.strictEqual(r.established, null);
  assert.match(r.why, /exit code/);
});

check("differentialVerdict will not establish a claim with nothing to look for", () => {
  const r = differentialVerdict({ oldRuns: ceOk(3), newRuns: ceBad(3, "x"), expectedFailure: "" });
  assert.strictEqual(r.established, null);
});

check("applyCounterexample raises a proven accusation to refuted", () => {
  const r = applyCounterexample({ rank: 1, verdict: { established: true, why: "w" } });
  assert.strictEqual(r.rank, 2);
});

// The whole point of the layer: an accusation that could not support itself
// stops being a block. It does NOT become a blessing - rank never goes to 0.
check("applyCounterexample lowers an accusation that did not hold, but not to zero", () => {
  const r = applyCounterexample({ rank: 2, verdict: { established: false, why: "w" } });
  assert.strictEqual(r.rank, 1);
});

check("applyCounterexample lowers an accusation whose code we refused to run", () => {
  const r = applyCounterexample({ rank: 2, verdict: null, screenReasons: ["calls fetch()"] });
  assert.strictEqual(r.rank, 1);
  assert.match(r.note, /not run/);
});

check("applyCounterexample never invents severity out of an inconclusive run", () => {
  const r = applyCounterexample({ rank: 0, verdict: { established: null, why: "w" } });
  assert.strictEqual(r.rank, 0);
});


// The search has exactly two exits, and the second one is the dangerous one:
// running out of attempts must never read as "we checked and it was fine".

check("attemptPolicy short-circuits on the first established counterexample", () => {
  const r = attemptPolicy([{ established: false }, { established: true }]);
  assert.strictEqual(r.keepTrying, false);
  assert.strictEqual(r.established, true);
  assert.strictEqual(r.exhausted, false);
});

check("attemptPolicy keeps going while attempts remain and nothing is proven", () => {
  assert.strictEqual(attemptPolicy([]).keepTrying, true);
  assert.strictEqual(attemptPolicy([{ established: false }]).keepTrying, true);
  assert.strictEqual(attemptPolicy([{ established: null }, { established: false }]).keepTrying, true);
});

check("attemptPolicy stops at the budget", () => {
  const r = attemptPolicy([{ established: false }, { established: false }, { established: null }]);
  assert.strictEqual(r.keepTrying, false);
  assert.strictEqual(r.exhausted, true);
  assert.match(r.stopReason, /all 3 attempts/);
});

// A reviewer that ran out of attempts has failed to support its accusation.
// That is not the same sentence as "the patch was examined and cleared", and
// only the guard and the project's own tests get to say the second one.
check("attemptPolicy does not turn an exhausted search into a clean bill of health", () => {
  const r = attemptPolicy([{ established: false }, { established: false }, { established: false }]);
  assert.strictEqual(r.established, null);
});

check("attemptPolicy honours a smaller budget", () => {
  assert.strictEqual(attemptPolicy([{ established: false }], 1).keepTrying, false);
});


check("candidateRecord counts a shipped patch", () => {
  const r = candidateRecord({ changedCount: 2, exit: "shipped" });
  assert.strictEqual(r.disposition, "shipped");
  assert.strictEqual(r.counted, true);
  assert.strictEqual(r.files, 2);
});

check("candidateRecord counts a patch the guard reverted", () => {
  // The body-parser catch: the agent defined a local contentType where the file
  // used to import one, the tests went green, and the package was never reached.
  // The guard reverted it - and for want of this field the row said the agent
  // had nothing to offer.
  const r = candidateRecord({ changedCount: 1, exit: "guard" });
  assert.strictEqual(r.disposition, "blocked-by-guard");
  assert.strictEqual(r.counted, true);
});

check("candidateRecord counts a patch that failed its own verification", () => {
  // Run #12 leg 3: wrote a compat shim, edited jest.config.js, Patchery ran the
  // suite itself, it was still red, everything was reverted. Recorded NO-CHANGE -
  // "Patchery had nothing to offer" - which is the opposite of what happened.
  const r = candidateRecord({ changedCount: 4, exit: "unverified" });
  assert.strictEqual(r.disposition, "unverified");
  assert.strictEqual(r.counted, true);
  assert.strictEqual(r.files, 4);
});

check("candidateRecord does NOT count partial work reverted at a ceiling", () => {
  // The agent never said it was done, so the guard was never asked. Counting
  // these is how 5 candidates turn into 48 and the claim reads stronger than it is.
  const r = candidateRecord({ changedCount: 3, exit: "ceiling" });
  assert.strictEqual(r.disposition, "unfinished");
  assert.strictEqual(r.counted, false);
});

check("candidateRecord does not count a run that wrote nothing", () => {
  const r = candidateRecord({ changedCount: 0, exit: "none" });
  assert.strictEqual(r.disposition, "none");
  assert.strictEqual(r.counted, false);
});

check("candidateRecord returns null, never false, for an exit it does not know", () => {
  // Same rule the census follows for a runner it cannot read: "we looked and it
  // was not a candidate" and "we could not tell" must not read alike.
  for (const exit of ["", "  ", "reverted", "success", null, undefined]) {
    const r = candidateRecord({ changedCount: 1, exit });
    assert.strictEqual(r.disposition, "unknown", "exit " + JSON.stringify(exit));
    assert.strictEqual(r.counted, null, "exit " + JSON.stringify(exit));
    assert.strictEqual(r.files, null);
  }
});

check("candidateRecord refuses to shrink the denominator on a contradiction", () => {
  // An exit that only happens when a patch exists, reporting no files, is a bug
  // in the caller. Filing it as "none" would quietly drop a candidate, and that
  // is the one direction this field must never fail in.
  for (const exit of ["shipped", "guard", "unverified"]) {
    const r = candidateRecord({ changedCount: 0, exit });
    assert.strictEqual(r.disposition, "unknown", exit + " with no files");
    assert.strictEqual(r.counted, null);
    assert.match(r.why, /reported no changed files/);
  }
  const backwards = candidateRecord({ changedCount: 2, exit: "none" });
  assert.strictEqual(backwards.disposition, "unknown");
  assert.strictEqual(backwards.counted, null);
});

check("candidateRecord will not read a file count it cannot trust", () => {
  for (const n of [-1, 1.5, NaN, Infinity, "two", null]) {
    const r = candidateRecord({ changedCount: n, exit: "shipped" });
    assert.strictEqual(r.counted, null, "count " + String(n));
  }
});

check("candidateOutputs writes an empty count, never a zero, for unknown", () => {
  const unknown = candidateOutputs(candidateRecord({ changedCount: 1, exit: "mystery" }));
  assert.strictEqual(unknown.candidate_disposition, "unknown");
  assert.strictEqual(unknown.candidate_files, "", "0 would read as 'we counted, and it was none'");
  const shipped = candidateOutputs(candidateRecord({ changedCount: 2, exit: "shipped" }));
  assert.strictEqual(shipped.candidate_files, "2");
  assert.strictEqual(candidateOutputs(null).candidate_disposition, "unknown");
});

check("candidateRecord reproduces run #12's denominator: one candidate in six legs", () => {
  // The shape D1 had to read out of six logs by hand. If this ever comes out as
  // 6, the field is counting ceilings; if 0, it has stopped seeing refusals.
  const legs = [
    { changedCount: 0, exit: "none" },      // run1, turn ceiling, nothing offered
    { changedCount: 0, exit: "none" },      // run2, clock ceiling
    { changedCount: 4, exit: "unverified" },// run3, wrote a fix, could not prove it
    { changedCount: 2, exit: "ceiling" },   // run4, partial work reverted
    { changedCount: 1, exit: "ceiling" },   // run5, partial work reverted
    { changedCount: 0, exit: "none" },      // run6, clock ceiling
  ].map(candidateRecord);
  assert.strictEqual(legs.filter((r) => r.counted === true).length, 1);
  assert.strictEqual(legs.filter((r) => r.counted === null).length, 0, "no leg should be unreadable");
  assert.strictEqual(legs.filter((r) => r.disposition === "unverified").length, 1);
});


check("candidateRecord will not read an absent count as zero", () => {
  // Number(null) is 0, so a ceiling exit that could not count its files was
  // reporting "we counted, and there was nothing". Caught while wiring the
  // clock exit, which is the one place the count genuinely cannot be taken.
  const r = candidateRecord({ changedCount: null, exit: "ceiling" });
  assert.strictEqual(r.counted, null);
  assert.strictEqual(r.files, null);
  assert.match(r.why, /no file count taken/);
});


// A key written to GITHUB_OUTPUT that action.yml does not declare is not an
// error. It is silence: the caller reads an empty string, the row records
// "unknown", and nothing anywhere says a name was wrong. That is the exact
// failure this field was added to end, so the contract gets a hard check and
// the names come from the function itself rather than a copy of them.
check("action.yml exposes every candidate output the run writes", () => {
  const actionSrc = fs.readFileSync(new URL("../action.yml", import.meta.url), "utf8");
  const keys = Object.keys(candidateOutputs(candidateRecord({ changedCount: 1, exit: "shipped" })));
  assert.ok(keys.length > 0, "a contract cannot be checked against nothing");
  for (const key of keys) {
    assert.match(
      actionSrc,
      new RegExp("value:\\s*\\$\\{\\{\\s*steps\\.run\\.outputs\\." + key + "\\s*\\}\\}"),
      key + " is written by the run but action.yml never exposes it"
    );
    assert.match(
      actionSrc,
      new RegExp("^  " + key.replace(/_/g, "-") + ":", "m"),
      key + " has no hyphenated output name in action.yml"
    );
  }
});


// The control asks whether the tool recognises a known-good patch. That is
// worthless if "known-good" was decided by the pipeline the control is meant to
// test, so the proof runs in verify-case and this reader imports none of the
// classifier. These checks pin the four answers apart.
check("goldenVerdict calls a patch golden only when red became green", () => {
  const r = goldenVerdict({ afterExit: "1", applyExit: "0", goldenExit: "0" });
  assert.strictEqual(r.verdict, "GOLDEN");
  assert.match(r.why, /red after the upgrade/);
});

check("goldenVerdict separates a patch that did not apply from one that did not fix", () => {
  // Same reason REFUSED and WRONG are separate columns: "we could not try" and
  // "we tried and it did not work" look alike in a table and mean opposite
  // things about the artifact.
  assert.strictEqual(goldenVerdict({ afterExit: "1", applyExit: "1", goldenExit: "" }).verdict, "NOT-APPLIED");
  assert.strictEqual(goldenVerdict({ afterExit: "1", applyExit: "0", goldenExit: "1" }).verdict, "NOT-A-FIX");
});

check("goldenVerdict refuses a case that was never red", () => {
  // A patch cannot be proved against a suite the upgrade did not break, and a
  // GOLDEN stamped there would be a control that proves nothing.
  const r = goldenVerdict({ afterExit: "0", applyExit: "0", goldenExit: "0" });
  assert.strictEqual(r.verdict, "UNKNOWN");
  assert.match(r.why, /nothing here to fix/);
});

check("goldenVerdict says UNKNOWN rather than guessing at a step that never ran", () => {
  for (const args of [
    { afterExit: "", applyExit: "0", goldenExit: "0" },
    { afterExit: "1", applyExit: "", goldenExit: "" },
    { afterExit: "1", applyExit: "0", goldenExit: "" },
    {},
  ]) {
    assert.strictEqual(goldenVerdict(args).verdict, "UNKNOWN", JSON.stringify(args));
  }
});

check("renderGolden prints the verdict as a heading verify-case can paste", () => {
  assert.match(renderGolden(goldenVerdict({ afterExit: "1", applyExit: "0", goldenExit: "0" })), /^\n### GOLDEN\n/);
});


// The control stub drives the agent without a model. Two rules in it were
// wrong on the first try and both failed silently - the run went green and did
// nothing - so they are pinned here rather than trusted.
check("the stub answers only the conversation carrying the marker", () => {
  const m = "MARKER_X";
  assert.strictEqual(classifyRequest('{"messages":[{"text":"do MARKER_X now"}]}', m), "scripted");
  assert.strictEqual(classifyRequest('{"messages":[{"text":"name this chat"}]}', m), "aside");
  // Auxiliary calls share the endpoint - one of them on a smaller model, for a
  // title - so counting requests hands a scripted turn to a summariser.
  assert.strictEqual(classifyRequest("", m), "aside");
  assert.strictEqual(classifyRequest("anything", ""), "aside");
});

check("a turn after a tool result still belongs to the conversation", () => {
  // The regression that cost an evening: tool_result was checked before the
  // marker, so the turn AFTER a tool call was answered with end_turn and the
  // second scripted step was never served. The tool ran, the file did not
  // change, and the run still reported success.
  const body = '{"messages":[{"text":"MARKER_X"},{"content":[{"type":"tool_result"}]}]}';
  assert.strictEqual(classifyRequest(body, "MARKER_X"), "scripted");
});

check("the stub serves turns in order and then stops", () => {
  const script = { turns: [{ tool: "Read", input: { a: 1 } }, { tool: "Edit", input: { b: 2 } }], finalText: "done" };
  assert.strictEqual(turnMessage(script, 0, "scripted").content[0].name, "Read");
  assert.strictEqual(turnMessage(script, 1, "scripted").content[0].name, "Edit");
  const past = turnMessage(script, 2, "scripted");
  assert.strictEqual(past.stop_reason, "end_turn");
  assert.strictEqual(past.content[0].text, "done");
});

check("an aside never gets a tool call", () => {
  const script = { turns: [{ tool: "Edit", input: {} }] };
  const aside = turnMessage(script, 0, "aside");
  assert.strictEqual(aside.stop_reason, "end_turn");
  assert.strictEqual(aside.content[0].type, "text");
});

check("the stream carries the tool input the turn asked for", () => {
  // Plain JSON was tried first and looked fine: the run reached success. It had
  // not carried out the tool call - the real request asks for a stream, and the
  // CLI quietly repeated the whole exchange unstreamed.
  const input = { file_path: "/x/app.js", old_string: "a", new_string: "b" };
  const frames = streamFrames(turnMessage({ turns: [{ tool: "Edit", input }] }, 0, "scripted"));
  for (const need of ["message_start", "content_block_start", "input_json_delta", "content_block_stop", "message_stop"]) {
    assert.ok(frames.includes(need), "stream is missing " + need);
  }
  // Parsed as frames rather than picked out with a regex: the payload is JSON
  // inside JSON, and a pattern over the escaping is the kind of cleverness that
  // fails quietly the first time a field order changes.
  const payload = frames
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice(6)))
    .find((d) => d.delta && d.delta.type === "input_json_delta");
  assert.ok(payload, "no input_json_delta frame");
  assert.deepStrictEqual(JSON.parse(payload.delta.partial_json), input);
});

check("the stub knows its three endpoints apart", () => {
  assert.strictEqual(routeOf("/v1/messages?beta=true"), "messages");
  assert.strictEqual(routeOf("/v1/messages/count_tokens?beta=true"), "count_tokens");
  assert.strictEqual(routeOf("/api/event_logging/batch"), "other");
});

// ---------------------------------------------------------------------------
// The poison controls, checked offline: is the bad patch actually bad?
//
// A control that plants a bad patch is worthless if the patch is not bad, and
// nothing in the run itself would say so - a pipeline that rejects a harmless
// edit looks exactly like a pipeline that rejects a dangerous one. These two
// checks are the control's own control, and they are pure: no run, no model.
// ---------------------------------------------------------------------------

const FIXTURE_BEFORE =
  'const { formatPrice } = require("fake-lib");\n\n' +
  "function renderCartTotal(amount) {\n" +
  "  return `Total: ${formatPrice(amount)}`;\n" +
  "}\n\nmodule.exports = { renderCartTotal };\n";

function fixtureAfter(kind) {
  const s = scriptFor(kind, "/work");
  const e = s.turns.find((t) => t.tool === "Edit");
  assert.ok(e, kind + ": no Edit turn");
  assert.ok(FIXTURE_BEFORE.includes(e.input.old_string), kind + ": the edit does not match the fixture");
  return FIXTURE_BEFORE.replace(e.input.old_string, e.input.new_string);
}

check("poison-green really does abandon the package the run was sent to migrate", () => {
  const after = fixtureAfter("poison-green");
  // The import still stands - that is the point. A check that only asked
  // "is the package still imported?" would wave this through.
  assert.match(after, /require\("fake-lib"\)/);
  assert.doesNotMatch(after, /formatPrice\(/);
  const reasons = dependencyMisuseReasons({
    packageName: "fake-lib",
    files: [{ relPath: "app.js", beforeText: FIXTURE_BEFORE, afterText: after }],
  });
  assert.strictEqual(reasons.length, 1, "the guard has nothing to say about the poison");
  assert.match(reasons[0].reason, /never uses it/);
});

check("golden is not poison, so a guard that blocks everything would be caught", () => {
  const after = fixtureAfter("golden");
  const reasons = dependencyMisuseReasons({
    packageName: "fake-lib",
    files: [{ relPath: "app.js", beforeText: FIXTURE_BEFORE, afterText: after }],
  });
  assert.deepStrictEqual(reasons, [], "the guard blocks the known-good fix too");
});

// ---------------------------------------------------------------------------
// callSiteScan - the count that would have contradicted a model's claim.
// ---------------------------------------------------------------------------

check("callSiteScan finds the one real import among nine English words", () => {
  // The measured case. yargs at the benchmarked commit mentions "which" in nine
  // files as ordinary English and imports it in exactly one - and the agent
  // reported "there are none".
  const files = [
    { path: "lib/parser.js", text: "// decide which branch to take\nconst n = 1;" },
    { path: "docs/guide.md", text: "import which from 'which'" },
    { path: "test/integration.mjs", text: "import which from 'which'\nwhich('node');" },
  ];
  const s = callSiteScan({ packageName: "which", files });
  // The markdown file is not source and is not searched; the comment is stripped.
  assert.strictEqual(s.searched, 2);
  assert.strictEqual(s.hits, 1);
  assert.deepStrictEqual(s.where.map((w) => w.path), ["test/integration.mjs"]);
});

check("callSiteScan says null, never zero, when it could not search", () => {
  // Same contract as the test census. A scan that found nothing to look at must
  // not be readable as "the package is imported nowhere" - that reading is the
  // one that would move a leg into a column costing us nothing.
  for (const files of [null, undefined, []]) {
    const s = callSiteScan({ packageName: "which", files });
    assert.strictEqual(s.hits, null);
    assert.strictEqual(callSiteNote(s, "which"), "");
  }
  assert.strictEqual(callSiteScan({ packageName: "", files: [] }).hits, null);
});

check("callSiteNote reports zero as a location, not as a verdict", () => {
  const none = callSiteNote(callSiteScan({ packageName: "which", files: [{ path: "a.js", text: "const x=1;" }] }), "which");
  assert.match(none, /Nowhere in this project's own source/);
  // It must not tell the reader there was nothing to do - that is a judgement,
  // and this function only reports where imports are.
  assert.doesNotMatch(none, /nothing to (do|fix)|no fix|cannot be fixed/i);
  assert.match(none, /searched 1 source file/);
});

// ---------------------------------------------------------------------------
// surface-diff - the only check that does not wait for a test suite to go red.
// ---------------------------------------------------------------------------

check("publicNames reads the shapes a published package actually uses", () => {
  const cjs = publicNames("module.exports = { a, b: impl, c };\nexports.d = 1;\nmodule.exports.e = 2;");
  assert.deepStrictEqual(cjs, ["a", "b", "c", "d", "e"]);
  const esm = publicNames(
    "export function f(){}\nexport const g = 1;\nexport class H {}\nexport { i, j as k };\nexport default z;"
  );
  assert.deepStrictEqual(esm, ["default", "f", "g", "H", "i", "k"].sort());
  assert.deepStrictEqual(publicNames("export declare function t(): void;"), ["t"]);
});

check("publicNames does not count a name that only appears in a comment", () => {
  // The same rule the guard follows. A changelog pasted into a header would
  // otherwise invent an export.
  assert.deepStrictEqual(publicNames("// module.exports = { ghost };\n/* exports.other = 1; */"), []);
});

check("a re-export entry does not read as a package that changed nothing", () => {
  // MEASURED, and this is the whole reason surfaceText exists. express\'s entry
  // file is one line - module.exports = require("./lib/express") - so a reader
  // that stops there finds zero names in BOTH versions and reports zero changes.
  // Indistinguishable from a real "nothing changed", and wrong: express 4.22.2
  // offers `query` and 5.2.1 does not, confirmed at runtime.
  const entry = 'module.exports = require("./lib/express");';
  assert.strictEqual(reexportTarget(entry), "./lib/express");
  assert.deepStrictEqual(publicNames(entry), []);

  const files = {
    "./index.js": entry,
    "./lib/express": "exports.query = require('./middleware/query');\nexports.json = 1;",
  };
  const walked = surfaceText("./index.js", (p) => files[p] ?? null);
  assert.strictEqual(walked.why, null);
  assert.deepStrictEqual(publicNames(walked.text), ["json", "query"]);
});

check("surfaceText reports a broken trail instead of returning an empty surface", () => {
  // "We found no exports" and "we could not open the file" must not look the
  // same - the first is a finding, the second is our own failure.
  const missing = surfaceText("./index.js", () => null);
  assert.match(missing.why, /file not found/);
  assert.strictEqual(missing.text, "");
  const loop = surfaceText("./a", () => 'module.exports = require("./a");');
  assert.match(loop.why, /deeper than/);
});

check("entryPath follows Node's own order, and defaults where a package declares nothing", () => {
  // express 5 declares neither main nor exports.
  assert.strictEqual(entryPath({}), "./index.js");
  assert.strictEqual(entryPath({ main: "lib/x.js" }), "./lib/x.js");
  assert.strictEqual(entryPath({ main: "m.js", exports: "./e.js" }), "./e.js");
  assert.strictEqual(entryPath({ main: "m.js", exports: { ".": { require: "./r.js" } } }), "./r.js");
});

check("packageMemberUse sees a name reached through the module object", () => {
  // The destructured form is easy. This is the one packageBindings cannot
  // answer alone: `lib` is not a name the package offers.
  const surface = ["query", "json", "static"];
  const via = packageMemberUse('const lib = require("express");\nlib.query();', "express", surface);
  assert.deepStrictEqual(via, ["query"]);
  const destructured = packageMemberUse('const { json } = require("express");\njson();', "express", surface);
  assert.deepStrictEqual(destructured, ["json"]);
  const bracket = packageMemberUse('const e = require("express");\ne["static"]();', "express", surface);
  assert.deepStrictEqual(bracket, ["static"]);
});

check("the surface report separates a removal you use from a removal you do not", () => {
  const before = "exports.query = 1;\nexports.json = 2;";
  const after = "exports.json = 2;\nexports.router = 3;";
  const uses = upgradeSurfaceReport({
    packageName: "express",
    beforeText: before,
    afterText: after,
    files: [{ path: "server.js", text: 'const e = require("express");\ne.query();' }],
  });
  assert.deepStrictEqual(uses.removed, ["query"]);
  assert.deepStrictEqual(uses.added, ["router"]);
  assert.strictEqual(uses.atRisk.length, 1);
  assert.match(renderSurfaceReport(uses), /removed something your code uses/);

  const doesNot = upgradeSurfaceReport({
    packageName: "express",
    beforeText: before,
    afterText: after,
    files: [{ path: "server.js", text: 'const e = require("express");\ne.json();' }],
  });
  assert.strictEqual(doesNot.atRisk.length, 0);
  const text = renderSurfaceReport(doesNot);
  // And it must NOT say the upgrade is safe. That sentence is the Express
  // finding turned into a lie.
  assert.match(text, /That is where we looked, not a verdict/);
  assert.doesNotMatch(text, /safe to upgrade|you can upgrade|no risk/i);
});

check("the report always carries the boundary sentence", () => {
  const r = upgradeSurfaceReport({
    packageName: "p",
    beforeText: "exports.a = 1;",
    afterText: "exports.b = 1;",
    files: [],
  });
  const text = renderSurfaceReport(r);
  assert.match(text, /it does not run anything/);
  // New names are reported, and kept apart from the alarming half.
  assert.match(text, /New in this version/);
});

check("surfaceDiff is empty when nothing moved, and says so as an empty report", () => {
  const same = "exports.a = 1;\nexports.b = 2;";
  const d = surfaceDiff(same, same);
  assert.deepStrictEqual(d.removed, []);
  assert.deepStrictEqual(d.added, []);
  assert.deepStrictEqual(d.kept, ["a", "b"]);
  assert.strictEqual(
    renderSurfaceReport(upgradeSurfaceReport({ packageName: "p", beforeText: same, afterText: same, files: [] })),
    ""
  );
});

// ---------------------------------------------------------------------------
// sentinel - the two earlier moments, and the sentence that may not drift.
// ---------------------------------------------------------------------------

check("bumpFromTitle reads what the bump bots actually write", () => {
  const shapes = [
    ["Bump express from 4.18.2 to 5.0.0", "express", "4.18.2", "5.0.0"],
    ["chore(deps): bump express from 4.18.2 to 5.0.0", "express", "4.18.2", "5.0.0"],
    ["build(deps-dev): Bump @types/node from 20.1.0 to 22.0.0", "@types/node", "20.1.0", "22.0.0"],
    ["Update express requirement from ^4.18.2 to ^5.0.0", "express", "4.18.2", "5.0.0"],
  ];
  for (const [title, name, from, to] of shapes) {
    assert.deepStrictEqual(bumpFromTitle(title), { package: name, from, to }, title);
  }
});

check("bumpFromTitle refuses a grouped bump instead of picking one of them", () => {
  // A bot that moves several packages at once would otherwise have one of them
  // installed on its behalf, which is a version nobody asked for.
  assert.strictEqual(bumpFromTitle("Bump the aws-sdk group with 3 updates"), null);
  assert.strictEqual(bumpFromTitle("Bump express from 4 to 5 and 2 other packages"), null);
  assert.strictEqual(bumpFromTitle("Merge pull request #12 from x/y"), null);
  assert.strictEqual(bumpFromTitle(""), null);
});

check("isMajorMove says null for a version it cannot read, never false", () => {
  assert.strictEqual(isMajorMove("4.18.2", "5.0.0"), true);
  assert.strictEqual(isMajorMove("4.18.2", "4.19.0"), false);
  // Same rule as the range reader: unreadable is not "no".
  assert.strictEqual(isMajorMove("workspace:*", "5.0.0"), null);
  assert.strictEqual(isMajorMove("4.0.0", "latest"), null);
});

check("an unrunnable suite is reported as unknown, never as a pass", () => {
  // The worst available lie. A suite that could not run says nothing about the
  // upgrade, and "green" there would be a claim we never measured.
  assert.strictEqual(sentinelVerdict({ suite: "unknown" }), "could-not-run-your-tests");
  assert.strictEqual(sentinelVerdict({ suite: "red" }), "breaks-your-tests");
  assert.strictEqual(sentinelVerdict({ suite: "green", atRisk: 0 }), "your-tests-did-not-object");
  assert.strictEqual(sentinelVerdict({ suite: "green", atRisk: 2 }), "green-but-a-name-you-use-is-gone");
});

check("a green suite is never rendered as permission to upgrade", () => {
  // This is the Express finding turned into a rule. Four projects took Express 5
  // and no suite went red; a report that reads "safe to upgrade" off that is a
  // lie the whole brand is built on not telling.
  const green = renderSentinel({
    packageName: "express",
    from: "4.18.2",
    to: "5.0.0",
    verdict: "your-tests-did-not-object",
  });
  assert.match(green, /This is not "safe to upgrade"/);
  assert.match(green, /Express 5 into four projects/);
  assert.doesNotMatch(green, /you can safely|no risk|good to go/i);
});

check("every sentinel verdict renders, and an unknown one renders nothing", () => {
  for (const v of ["breaks-your-tests", "green-but-a-name-you-use-is-gone", "your-tests-did-not-object", "could-not-run-your-tests"]) {
    const out = renderSentinel({ packageName: "p", from: "1", to: "2", verdict: v });
    assert.ok(out.length > 40, v);
    assert.match(out, /`p` 1 -> 2/);
  }
  assert.strictEqual(renderSentinel({ verdict: "invented" }), "");
});

check("deprecatedNames reads the tag a real package actually writes", () => {
  // Taken from mocha, which annotates its legacy plugin errors exactly this way
  // and names the replacement in an {@link}.
  const src =
    "/**\n * **DEPRECATED**.  Use {@link createInvalidLegacyPluginError} instead\n" +
    " * @deprecated\n * @param {string} message\n */\nexports.createInvalidPluginError = function(){};\n" +
    "\n/** ordinary */\nexports.fine = 1;\n";
  const found = deprecatedNames(src);
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].name, "createInvalidPluginError");
  // The author's own sentence is carried through, because it usually names the
  // replacement and a summary of it would be us inventing a migration.
  assert.match(found[0].note, /createInvalidLegacyPluginError/);
});

check("deprecatedNames finds the declaration shapes packages use", () => {
  const shapes = [
    ["/** @deprecated */\nexport function a(){}", "a"],
    ["/** @deprecated */\nmodule.exports.b = 1;", "b"],
    ["/** @deprecated */\nconst c = 1;", "c"],
    ["/** @deprecated */\nexport declare const d: number;", "d"],
    ["module.exports = {\n  /** @deprecated */\n  e: 1,\n};", "e"],
  ];
  for (const [src, name] of shapes) {
    assert.deepStrictEqual(deprecatedNames(src).map((x) => x.name), [name], src);
  }
  assert.deepStrictEqual(deprecatedNames("/** ordinary */\nexports.f = 1;"), []);
});

check("a deprecated name you use is reported, and kept apart from a removed one", () => {
  // surfaceDiff cannot see this case at all - nothing disappeared. That is the
  // whole reason the deprecation half exists, and it is also the earlier warning:
  // there is a whole major left to move.
  const before = "exports.parse = 1;\nexports.format = 2;\nexports.legacy = 3;";
  const after =
    "/**\n * @deprecated use formatAsync instead\n */\nexports.format = 2;\n" +
    "exports.parse = 1;\nexports.formatAsync = 4;";
  const r = upgradeSurfaceReport({
    packageName: "content-type",
    beforeText: before,
    afterText: after,
    files: [{ path: "app.js", text: 'const ct = require("content-type");\nct.format({});\nct.legacy();' }],
  });
  assert.deepStrictEqual(r.atRisk, [{ path: "app.js", names: ["legacy"] }]);
  assert.strictEqual(r.fading.length, 1);
  assert.strictEqual(r.fading[0].name, "format");
  const text = renderSurfaceReport(r);
  // Two different urgencies, said as two different things.
  assert.match(text, /removed something your code uses/);
  assert.match(text, /Still there, but marked deprecated/);
  assert.match(text, /Nothing breaks today/);
});

check("a deprecation the OLD version already carried is not reported as news", () => {
  // Attaching an old warning to a new decision would make every upgrade look
  // like it introduced something it did not.
  const both = "/**\n * @deprecated\n */\nexports.old = 1;";
  const r = upgradeSurfaceReport({
    packageName: "p",
    beforeText: both,
    afterText: both,
    files: [{ path: "a.js", text: 'const p = require("p");\np.old();' }],
  });
  // It IS reported - the name is deprecated in the version being offered, and a
  // reader deciding whether to take that version needs to know. What must not
  // happen is a removal claim, and there is none.
  assert.strictEqual(r.fading.length, 1);
  assert.deepStrictEqual(r.removed, []);
  assert.deepStrictEqual(r.atRisk, []);
});

console.log("\n" + pass + " checks passed.\n");
