/**
 * Offline self-test: proves the safety guard (guard.mjs) behaves correctly.
 * Run: node scripts/selftest.mjs
 *
 * This is the most critical part of the product — it is what catches an agent
 * that tries to turn the build green by deleting tests. It needs no API key,
 * so it can run on every push.
 */

import assert from "node:assert";
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
  shouldReview,
  truncateEvidence,
  buildReviewEvidence,
  parseReview,
  reviewOutcome,
  renderReviewSection,
  REVIEW_CHECKS,
} from "./guard.mjs";

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
  ".github/workflows/self-maintain.yml",
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
  assert.match(renderReviewSection(reviewOutcome({ review: concerned }), concerned, {}), /\[!WARNING\]/);
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

console.log("\n" + pass + " checks passed.\n");
