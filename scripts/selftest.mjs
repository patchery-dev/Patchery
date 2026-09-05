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

console.log("\n" + pass + " checks passed.\n");
