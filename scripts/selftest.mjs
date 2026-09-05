/**
 * Offline self-test: proves the safety guard (guard.mjs) behaves correctly.
 * Run: node scripts/selftest.mjs
 *
 * This is the most critical part of the product — it is what catches an agent
 * that tries to turn the build green by deleting tests. It needs no API key,
 * so it can run on every push.
 */

import assert from "node:assert";
import { protectedReason, parsePorcelain } from "./guard.mjs";

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

console.log("\n" + pass + " checks passed.\n");
