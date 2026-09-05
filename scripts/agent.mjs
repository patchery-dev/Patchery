#!/usr/bin/env node
/**
 * self-maintaining-action - agent orchestrator
 *
 * What it does, in order:
 *   1. Runs the project's tests   -> is it actually broken? If not, do nothing.
 *   2. Runs the AI agent (Claude Agent SDK) -> migrate the broken call sites.
 *   3. Reads what changed via git -> if a protected file was touched, revert everything.
 *   4. Runs the tests again itself -> never trusts the agent's "tests pass" claim.
 *   5. Writes results to GITHUB_OUTPUT / GITHUB_STEP_SUMMARY and a ready-made PR body.
 *
 * Everything is configured through environment variables (action.yml fills them in).
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { protectedReason, parsePorcelain } from "./guard.mjs";

// ------------------------------------------------------------------ config

const env = (name, fallback = "") => (process.env[name] ?? "").trim() || fallback;
const bool = (name, fallback) => {
  const v = env(name).toLowerCase();
  if (v === "") return fallback;
  return v === "true" || v === "1" || v === "yes";
};

const WORKSPACE = path.resolve(env("SMA_WORKSPACE", process.cwd()));
const TARGET_DIR = path.resolve(WORKSPACE, env("SMA_TARGET_DIR", "."));
const PACKAGE = env("SMA_PACKAGE");
const CHANGELOG = env("SMA_CHANGELOG");
const TEST_COMMAND = env("SMA_TEST_COMMAND", "npm test");
const MAX_TURNS = Number(env("SMA_MAX_TURNS", "25"));
const EXTRA = env("SMA_EXTRA_INSTRUCTIONS");
const REQUIRE_RED = bool("SMA_REQUIRE_FAILING_BASELINE", true);
const DRY_RUN = bool("SMA_DRY_RUN", false);

// ----------------------------------------------------------------- helpers

const log = (...a) => console.log(...a);
const group = (title) => log("\n" + "=".repeat(8) + " " + title + " " + "=".repeat(8));

function writeOutputs(obj) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  const lines = Object.entries(obj).map(([k, v]) => {
    const delimiter = "__sma_" + k + "_" + Date.now() + "__";
    return k + "<<" + delimiter + "\n" + String(v) + "\n" + delimiter;
  });
  fs.appendFileSync(file, lines.join("\n") + "\n");
}

function writeStepSummary(md) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) fs.appendFileSync(file, md + "\n");
}

function fail(message) {
  console.error("\n[ERROR] " + message);
  writeOutputs({ changed: "false", tests_passed: "false", summary: message });
  writeStepSummary("### self-maintaining-action\n\nFailed: " + message);
  process.exit(1);
}

function git(args, cwd = WORKSPACE) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function runTests() {
  const r = spawnSync(TEST_COMMAND, {
    cwd: TARGET_DIR,
    shell: true,
    encoding: "utf8",
    env: { ...process.env, CI: "true" },
    timeout: 15 * 60 * 1000,
  });
  const output = (r.stdout ?? "") + (r.stderr ?? "");
  return { ok: r.status === 0, code: r.status, output: output.trim() };
}

/** `git status --porcelain` -> the set of changed paths (new and deleted included). */
function workingTreeFiles() {
  return parsePorcelain(git(["status", "--porcelain", "-uall", "--no-renames"]));
}

// -------------------------------------------------------------------- flow

if (!PACKAGE) {
  fail("SMA_PACKAGE is empty. Refusing to run an agent without knowing which package broke.");
}
if (!fs.existsSync(TARGET_DIR)) {
  fail("Target directory does not exist: " + TARGET_DIR);
}

group("0. Environment");
// "Custom endpoint" means anything other than Anthropic's own host. Some
// environments already set ANTHROPIC_BASE_URL to the official URL; that is not custom.
const baseUrl = env("ANTHROPIC_BASE_URL");
const usingCustomEndpoint = !!baseUrl && !/(^|\.)anthropic\.com/i.test(baseUrl);
log("workspace    : " + WORKSPACE);
log("target dir   : " + TARGET_DIR);
log("package      : " + PACKAGE);
log("test command : " + TEST_COMMAND);
log("model        : " + env("ANTHROPIC_MODEL", "(default)"));
log("endpoint     : " + (baseUrl || "(Anthropic default)") + (usingCustomEndpoint ? "  [custom]" : ""));

if (!env("ANTHROPIC_AUTH_TOKEN") && !env("ANTHROPIC_API_KEY")) {
  fail("Neither ANTHROPIC_AUTH_TOKEN nor ANTHROPIC_API_KEY is set. Check your GitHub Secrets.");
}

let repoRoot;
try {
  repoRoot = git(["rev-parse", "--show-toplevel"]);
} catch {
  fail("Not a git repository. Without git I cannot verify what the agent changed, so I stop here.");
}
log("git root     : " + repoRoot);

const filesBefore = workingTreeFiles();
if (filesBefore.size > 0) {
  log("note: working tree is already dirty (" + filesBefore.size + " files) - those are not counted as the agent's work.");
}

group("1. Run the tests first (is it really broken?)");
const baseline = runTests();
log(baseline.output.slice(-4000) || "(no output)");
log("\n-> baseline: " + (baseline.ok ? "PASS" : "FAIL (exit " + baseline.code + ")"));

if (baseline.ok && REQUIRE_RED) {
  const msg = "`" + TEST_COMMAND + "` already passes - nothing to fix. The agent was not run.";
  log("\n" + msg);
  writeStepSummary("### self-maintaining-action\n\n" + msg);
  writeOutputs({ changed: "false", tests_passed: "true", files: "", summary: msg });
  process.exit(0);
}

if (DRY_RUN) {
  const msg = "SMA_DRY_RUN=true - only the baseline was measured, the agent was not run.";
  log("\n" + msg);
  writeOutputs({ changed: "false", tests_passed: String(baseline.ok), files: "", summary: msg });
  process.exit(0);
}

group("2. Run the agent");

const changelogLine = CHANGELOG
  ? "Read the changelog / migration notes first: " + CHANGELOG
  : "Find the package's changelog or migration notes first - usually node_modules/" +
    PACKAGE +
    "/CHANGELOG.md or its README.";

const prompt = [
  "You are an automated dependency-upgrade agent running inside CI.",
  "",
  'The package "' + PACKAGE + '" introduced a breaking change in this project, and the',
  "project's own source no longer works against it.",
  "",
  changelogLine,
  "",
  "Your job:",
  "1. Read the changelog and understand exactly what changed in the API.",
  "2. Find every place in this project's OWN source files that uses the affected API.",
  "3. Update those call sites to match the new API. Keep the change as small as possible.",
  '4. Run "' + TEST_COMMAND + '" to confirm the fix works.',
  "5. Report which file(s) you changed and why, and the final test output.",
  "",
  "Hard rules - breaking any of these makes your whole run be discarded:",
  "- NEVER edit test files (*.test.*, *.spec.*, anything under test/, tests/, __tests__/).",
  "  The tests define correct behaviour. If a test fails, the source is wrong, not the test.",
  "- NEVER edit anything inside node_modules/.",
  "- NEVER edit .github/ or lockfiles.",
  "- Do not 'fix' the failure by deleting code, skipping assertions, or catching and",
  "  swallowing the error. Migrate the call sites properly.",
  EXTRA ? "\nAdditional instructions from the repository owner:\n" + EXTRA + "\n" : "",
  "Work only inside: " + TARGET_DIR,
].join("\n");

const agentText = [];
let result = null;

try {
  for await (const message of query({
    prompt,
    options: {
      cwd: TARGET_DIR,
      allowedTools: ["Read", "Edit", "Write", "Bash", "Glob", "Grep"],
      permissionMode: "bypassPermissions",
      maxTurns: MAX_TURNS,
    },
  })) {
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "text" && block.text.trim()) {
          agentText.push(block.text);
          log("\n[agent] " + block.text);
        } else if (block.type === "tool_use") {
          log("[tool] " + block.name + " " + JSON.stringify(block.input).slice(0, 180));
        }
      }
    } else if (message.type === "result") {
      result = message;
    }
  }
} catch (err) {
  fail("The agent crashed: " + (err?.message ?? err));
}

if (!result) {
  fail("The agent returned no result message (likely a connectivity or authentication problem).");
}

const modelsUsed = Object.keys(result.modelUsage ?? {});
log(
  "\n-> agent finished: " +
    result.subtype +
    " | turns: " +
    result.num_turns +
    " | cost: $" +
    (result.total_cost_usd ?? 0)
);
log("-> model(s) used: " + (modelsUsed.join(", ") || "(unknown)"));

// Warn when a custom endpoint was requested but an Anthropic model was reported:
// that usually means the run silently fell back to the default provider.
if (usingCustomEndpoint && modelsUsed.some((m) => /^claude-/.test(m))) {
  log(
    '\n[WARNING] ANTHROPIC_BASE_URL points at a custom endpoint, but the model used looks like "' +
      modelsUsed.join(", ") +
      '". The run may have silently fallen back to Anthropic - check the model name and secrets.'
  );
}

if (result.subtype !== "success") {
  fail(
    "The agent did not finish successfully: " +
      result.subtype +
      (result.errors ? " - " + result.errors.join("; ") : "")
  );
}

group("3. What changed? (verified independently with git)");
const filesAfter = workingTreeFiles();
const changed = [...filesAfter].filter((f) => !filesBefore.has(f)).sort();

if (changed.length === 0) {
  const msg = "The agent changed no files. Nothing to open a PR for.";
  log(msg);
  writeStepSummary("### self-maintaining-action\n\n" + msg);
  writeOutputs({ changed: "false", tests_passed: "false", files: "", summary: msg });
  process.exit(0);
}

log(changed.map((f) => "  " + f).join("\n"));

function revertAll() {
  for (const f of changed) {
    try {
      git(["checkout", "--", f]);
    } catch {
      // Untracked file: checkout cannot restore it, so remove it.
      try {
        fs.rmSync(path.join(repoRoot, f), { force: true });
      } catch {}
    }
  }
}

const violations = changed.map((f) => [f, protectedReason(f)]).filter(([, reason]) => reason);
if (violations.length > 0) {
  log("\n[SAFETY] The agent touched files it must never touch:");
  for (const [f, reason] of violations) log("  - " + f + " (" + reason + ")");
  log("\nReverting every change...");
  revertAll();
  fail("The agent modified protected files (tests / node_modules / CI). Everything was reverted, no PR will be opened.");
}

group("4. Run the tests again myself (do not trust the agent's word)");
const after = runTests();
log(after.output.slice(-4000) || "(no output)");
log("\n-> after the fix: " + (after.ok ? "PASS" : "FAIL (exit " + after.code + ")"));

if (!after.ok) {
  log("\nTests still fail. Reverting every change...");
  revertAll();
  fail("Tests still fail after the fix. Everything was reverted, no PR will be opened.");
}

group("5. Summary");

let diffstat = "";
try {
  diffstat = git(["diff", "--stat", "--"].concat(changed));
} catch {}

const explanation = agentText.length ? agentText[agentText.length - 1].trim() : "(the agent wrote no summary)";

const prBody = [
  "## Automated dependency fix: `" + PACKAGE + "`",
  "",
  "This PR was opened by **self-maintaining-action**. An AI agent read the breaking",
  "change in `" + PACKAGE + "`, migrated the call sites to the new API, and ran the tests.",
  "",
  "### Verification",
  "",
  "| Step | Result |",
  "| --- | --- |",
  "| `" + TEST_COMMAND + "` before the fix | failed (exit " + baseline.code + ") |",
  "| `" + TEST_COMMAND + "` after the fix | passed |",
  "| Were any test files modified | No - enforced by CI |",
  "",
  "### Changed files",
  "",
  changed.map((f) => "- `" + f + "`").join("\n"),
  "",
  diffstat ? "```\n" + diffstat + "\n```" : "",
  "",
  "### What the agent said",
  "",
  explanation,
  "",
  "### Test output after the fix",
  "",
  "<details><summary>show</summary>",
  "",
  "```",
  after.output.slice(-3000),
  "```",
  "",
  "</details>",
  "",
  "---",
  "Model: `" +
    (modelsUsed.join(", ") || "unknown") +
    "` - turns: " +
    result.num_turns +
    " - cost: $" +
    (result.total_cost_usd ?? 0).toFixed(4),
  "",
  "> Needs human review. This PR was opened automatically, but it is never merged automatically.",
].join("\n");

// Never write the PR body into the working tree: create-pull-request would
// commit it. Prefer the runner's temp dir, otherwise just outside the repo.
const prBodyDir = env("RUNNER_TEMP", path.join(repoRoot, ".."));
const prBodyPath = path.join(prBodyDir, "sma-pr-body.md");
fs.writeFileSync(prBodyPath, prBody, "utf8");

writeStepSummary(
  "### self-maintaining-action\n\nFixed `" +
    PACKAGE +
    "`, `" +
    TEST_COMMAND +
    "` passes.\n\n" +
    changed.map((f) => "- `" + f + "`").join("\n")
);
writeOutputs({
  changed: "true",
  tests_passed: "true",
  files: changed.join("\n"),
  pr_body_file: prBodyPath,
  summary: "Fixed " + PACKAGE + " (" + changed.length + " file(s)), tests pass.",
});

log("\nChanged files: " + changed.join(", "));
log("PR body written to: " + prBodyPath);
log("\nDone.");
