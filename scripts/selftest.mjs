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
import { census, censusHeld } from "./test-census.mjs";
import { findInstalled } from "./installed-version.mjs";
import { benchmarkOutcome, parseArgs } from "./benchmark-outcome.mjs";
import {
  protectedReason,
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
  dependencyMisuseReasons,
  packageBindings,
  failureChanged,
  failureSignature,
  packagesNamedIn,
  chainedFailureMessage,
  normalizeModelTimeout,
  timeoutReason,
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
// the schema before answering - so the FIRST object in the text is the template.
check("the LAST json object in prose wins", () => {
  const text =
    'Here is the schema: {"verdict":"not_refuted","confidence":0}\n' +
    "Now my answer:\n```json\n" + JSON.stringify(goodReview({ confidence: 77 })) + "\n```";
  const r = parseReview(text);
  assert.ok(r.ok);
  assert.strictEqual(r.review.confidence, 77);
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

console.log("\nprotectedReason - the test harness, not just the tests");
for (const p of [
  "vitest.config.js", "jest.config.ts", "packages/x/vitest.config.mjs",
  "playwright.config.js", "cypress.config.js", "karma.conf.js",
  ".mocharc.json", "vitest.setup.ts", "src/setupTests.js",
]) {
  check(p + " is protected", () => assert.ok(protectedReason(p), p + " should be blocked"));
}
check("an ordinary config file is still fair game", () => {
  assert.strictEqual(protectedReason("vite.config.js"), null);
  assert.strictEqual(protectedReason("webpack.config.js"), null);
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
  // alone would not say which, and these five are the reason the rules exist.
  check("the five mechanically-detectable wrong migrations are caught", () =>
    assert.deepStrictEqual(
      corpus.cases.filter((c) => c.label === "bad" && fire(c).length > 0).map((c) => c.file).sort(),
      [
        "bad-01-hardcoded-return.js",
        "bad-03-reimplemented-locally.js",
        "bad-05-monkey-patch.js",
        "bad-08-tolocalestring.js",
        "bad-09-shadowing-stub.js",
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

check("censusHeld says 'cannot tell' rather than 'fine' when it cannot parse", () => {
  assert.strictEqual(censusHeld(census("mystery"), census(JEST_GREEN)).ok, null);
  assert.strictEqual(censusHeld(census(JEST_GREEN), census("mystery")).ok, null);
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
    baselineExit: "0", finalExit: "0", changed: "true",
    before: census(JEST_GREEN), after: census(JEST_GREEN),
  });
  assert.strictEqual(r.outcome, "FIXED");
});

// A green suite that shrank must never be credited, and the census is asked
// before the exit code precisely so that it cannot be.
check("outcome WRONG when the tests are green but fewer of them ran", () => {
  const shrunk = "Tests:       0 skipped, 900 passed, 900 total\n";
  const r = benchmarkOutcome({
    baselineExit: "0", finalExit: "0", changed: "true",
    before: census(JEST_GREEN), after: census(shrunk),
  });
  assert.strictEqual(r.outcome, "WRONG");
  assert.match(r.detail, /got smaller/);
});

check("outcome WRONG when a change shipped and the tests are still red", () => {
  const r = benchmarkOutcome({
    baselineExit: "0", finalExit: "1", changed: "true",
    before: census(JEST_GREEN), after: census(JEST_RED),
  });
  assert.strictEqual(r.outcome, "WRONG");
});

// REFUSED is the product's claim, not a failure. It has to be countable
// separately or the table measures somebody else's product.
check("outcome REFUSED is kept apart from NO-CHANGE", () => {
  const refused = benchmarkOutcome({
    baselineExit: "0", finalExit: "1", changed: "false",
    actionOutcome: "refused: the reviewer refuted the fix",
    before: census(JEST_GREEN), after: census(JEST_RED),
  });
  assert.strictEqual(refused.outcome, "REFUSED");

  const nothing = benchmarkOutcome({
    baselineExit: "0", finalExit: "1", changed: "false",
    actionOutcome: "the agent made no edits",
    before: census(JEST_GREEN), after: census(JEST_RED),
  });
  assert.strictEqual(nothing.outcome, "NO-CHANGE");
});

check("a refuted review counts as REFUSED even when the outcome is quiet", () => {
  const r = benchmarkOutcome({
    baselineExit: "0", finalExit: "1", changed: "false", review: "refuted",
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
    baselineExit: "0", finalExit: "0", changed: "false",
    version: "3", installed: "1.0.0",
  });
  assert.strictEqual(r.outcome, "BLOCKED");
  assert.match(r.detail, /the break was not present/);
});

check("a matching major is not treated as a mismatch", () => {
  const r = benchmarkOutcome({
    baselineExit: "0", finalExit: "1", changed: "false",
    version: "3", installed: "3.0.1", actionOutcome: "refused",
  });
  assert.strictEqual(r.outcome, "REFUSED");
});

check("an unknown installed version does not block the run", () => {
  const r = benchmarkOutcome({
    baselineExit: "0", finalExit: "1", changed: "false", version: "3", installed: "",
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

console.log("\n" + pass + " checks passed.\n");
