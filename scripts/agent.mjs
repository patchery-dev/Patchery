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
import {
  protectedReason,
  parsePorcelainEntries,
  outOfScopeReason,
  parsePathList,
  testCommandLooksUnavailable,
  looksLikeDependencyConflict,
  redactSecrets,
  createStallDetector,
  baselinePassedMessage,
} from "./guard.mjs";

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
// How many extra times a failing baseline is re-run before we believe it. A test
// that fails once but passes on a retry is flaky, not broken.
const BASELINE_RETRIES = Math.max(0, Number(env("SMA_BASELINE_RETRIES", "2")) || 0);
// Paths outside target-dir the agent is nonetheless allowed to touch (a monorepo
// often needs the root manifest), and whether deleting a tracked file is allowed.
const ALLOWED_PATHS = parsePathList(env("SMA_ALLOWED_PATHS"));
const ALLOW_DELETIONS = bool("SMA_ALLOW_DELETIONS", false);
const STALL_REPEATS = Math.max(2, Number(env("SMA_STALL_REPEATS", "3")) || 3);
// Deliberately generous: a careful agent legitimately spends 8-10 turns reading
// the changelog, the call sites and the tests before it edits anything. Measured
// on a real run - a threshold of 8 cut off an agent that was about to fix the bug.
const STALL_NO_EDIT_TURNS = Math.max(2, Number(env("SMA_STALL_NO_EDIT_TURNS", "15")) || 15);

// ----------------------------------------------------------------- helpers

// Literal values that must never reach a log or a PR body, whatever the
// pattern matcher thinks. The run's own credentials are the obvious case.
const SECRET_VALUES = [env("ANTHROPIC_AUTH_TOKEN"), env("ANTHROPIC_API_KEY")].filter(Boolean);
const clean = (text) => redactSecrets(text, SECRET_VALUES);

// Everything printed goes through redaction: test output and agent chatter are
// the two places a stray key from a .env or an error message shows up.
const log = (...a) => console.log(...a.map((x) => (typeof x === "string" ? clean(x) : x)));
const group = (title) => log("\n" + "=".repeat(8) + " " + title + " " + "=".repeat(8));

function writeOutputs(obj) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  const lines = Object.entries(obj).map(([k, v]) => {
    const delimiter = "__sma_" + k + "_" + Date.now() + "__";
    return k + "<<" + delimiter + "\n" + clean(String(v)) + "\n" + delimiter;
  });
  fs.appendFileSync(file, lines.join("\n") + "\n");
}

function writeStepSummary(md) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) fs.appendFileSync(file, clean(md) + "\n");
}

function fail(message) {
  console.error("\n[ERROR] " + clean(message));
  writeOutputs({ outcome: "failed", changed: "false", tests_passed: "false", summary: message });
  writeStepSummary("### Patchery\n\nFailed: " + message);
  process.exit(1);
}

/**
 * A run that produced nothing but is not an error: nothing was broken, the agent
 * got stuck, or a human needs to look. Exits 0 so the workflow stays green - the
 * PR step is gated on `changed`, not on the exit code.
 */
function stop(outcome, message, extra = {}) {
  log("\n" + message);
  writeStepSummary("### Patchery\n\n" + message);
  writeOutputs({ outcome, changed: "false", files: "", summary: message, ...extra });
  process.exit(0);
}

function git(args, { trim = true } = {}) {
  const out = execFileSync("git", args, { cwd: WORKSPACE, encoding: "utf8" });
  // Porcelain output must NOT be trimmed: its first column is a status field
  // that is often a leading space (" M path"). Trimming eats it, and then the
  // fixed-width parse silently chops the first character off the path.
  return trim ? out.trim() : out.replace(/\r?\n+$/, "");
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

/** `git status --porcelain` -> changed entries, status included (new and deleted too). */
function workingTreeEntries() {
  return parsePorcelainEntries(git(["status", "--porcelain", "-uall", "--no-renames"], { trim: false }));
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

const filesBefore = new Set(workingTreeEntries().map((e) => e.path));
if (filesBefore.size > 0) {
  log("note: working tree is already dirty (" + filesBefore.size + " files) - those are not counted as the agent's work.");
}

// Where the agent was told to work, relative to the repo root. "" means the
// whole repository, which is the default and makes the scope rule a no-op.
const targetRel = path.relative(repoRoot, TARGET_DIR).replace(/\\/g, "/");

/** What the agent changed, with status. Anything already dirty before the run does not count. */
function agentChangedEntries() {
  return workingTreeEntries()
    .filter((e) => !filesBefore.has(e.path))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** Just the paths, for the places that only need names. */
function agentChangedFiles() {
  return agentChangedEntries().map((e) => e.path);
}

/** Undo the agent's work: restore tracked files, delete ones it created. */
function revertPaths(paths) {
  for (const f of paths) {
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

group("1. Run the tests first (is it really broken?)");
const baseline = runTests();
log(baseline.output.slice(-4000) || "(no output)");
log("\n-> baseline: " + (baseline.ok ? "PASS" : "FAIL (exit " + baseline.code + ")"));

// A command that does not exist is a setup mistake, not a broken project. Saying
// "baseline FAIL" here would send a paid agent after a typo.
if (!baseline.ok) {
  const unavailable = testCommandLooksUnavailable(baseline.output, baseline.code);
  if (unavailable) {
    fail(
      "`" +
        TEST_COMMAND +
        "` did not run: " +
        unavailable +
        ". This is not a broken dependency - either the test command is wrong for this " +
        "target, or this target has no tests. Patchery needs a command that actually " +
        "runs the tests, because that command is the only thing proving a fix is correct. " +
        "Fix `test-command` (or point `target-dir` at a package that has tests) and run again."
    );
  }
}

// A test that fails once but passes on a retry is flaky, not broken. Believing
// the first failure sends the agent after a problem that is not there.
if (!baseline.ok && BASELINE_RETRIES > 0) {
  log("\nRe-running the tests " + BASELINE_RETRIES + "x to rule out a flaky failure...");
  for (let attempt = 1; attempt <= BASELINE_RETRIES; attempt++) {
    const retry = runTests();
    log("   attempt " + (attempt + 1) + ": " + (retry.ok ? "PASS" : "FAIL (exit " + retry.code + ")"));
    if (retry.ok) {
      stop(
        "flaky",
        "`" +
          TEST_COMMAND +
          "` failed once but passed on retry, so this is a flaky test, not a broken " +
          "dependency. The agent was not run. Stabilise the test, or re-run Patchery once " +
          "the suite is reliable.",
        { tests_passed: "true" }
      );
    }
  }
  log("   -> consistently failing, this is a real break.");
}

if (baseline.ok && REQUIRE_RED) {
  // Pointed at a documented break but the tests pass? Say so, instead of letting a
  // runtime-hidden failure look identical to "there was never anything wrong".
  stop(
    "nothing-to-do",
    baselinePassedMessage({
      testCommand: TEST_COMMAND,
      changelog: CHANGELOG,
      nodeVersion: process.version,
    }),
    { tests_passed: "true" }
  );
}

if (DRY_RUN) {
  stop("dry-run", "SMA_DRY_RUN=true - only the baseline was measured, the agent was not run.", {
    tests_passed: String(baseline.ok),
  });
}

group("2. Run the agent");

const changelogLine = CHANGELOG
  ? "Read the changelog / migration notes first: " + CHANGELOG
  : "Find the package's changelog or migration notes first - usually node_modules/" +
    PACKAGE +
    "/CHANGELOG.md or its README.";

// When the baseline already passes (only reachable with SMA_REQUIRE_FAILING_BASELINE=false),
// this is a proactive migration, not a break-fix. Telling the agent "this no longer works"
// when it demonstrably does causes it to burn its whole turn budget trying to reconcile a
// false premise with what it actually observes, instead of just doing the migration.
const situationLines = baseline.ok
  ? [
      'The package "' + PACKAGE + '" has a documented migration path away from the API this',
      "project currently uses. The project's tests currently pass - this is a proactive",
      "modernization, not a bug fix. Do not spend turns trying to prove something is broken;",
      "it may not be. Trust the changelog, make the migration, and confirm tests still pass.",
    ]
  : [
      'The package "' + PACKAGE + '" introduced a breaking change in this project, and the',
      "project's own source no longer works against it.",
    ];

const prompt = [
  "You are an automated dependency-upgrade agent running inside CI.",
  "",
  ...situationLines,
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
  "- NEVER delete a file. This migration edits call sites; it does not remove files.",
  "- NEVER change anything outside the directory named below, even to tidy up." +
    (ALLOWED_PATHS.length ? " The only exceptions are: " + ALLOWED_PATHS.join(", ") + "." : ""),
  "- Do not 'fix' the failure by deleting code, skipping assertions, or catching and",
  "  swallowing the error. Migrate the call sites properly.",
  EXTRA ? "\nAdditional instructions from the repository owner:\n" + EXTRA + "\n" : "",
  "Work only inside: " + TARGET_DIR,
].join("\n");

const agentText = [];
let result = null;
let stalledReason = null;
const stallDetector = createStallDetector({
  repeats: STALL_REPEATS,
  noEditTurns: STALL_NO_EDIT_TURNS,
});

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
      const toolUses = [];
      for (const block of message.message.content) {
        if (block.type === "text" && block.text.trim()) {
          agentText.push(block.text);
          log("\n[agent] " + block.text);
        } else if (block.type === "tool_use") {
          log("[tool] " + block.name + " " + JSON.stringify(block.input).slice(0, 180));
          toolUses.push({ name: block.name, input: block.input });
        }
      }

      // Stop a run that is going in circles instead of letting it eat the whole
      // turn budget. Breaking the loop ends the iteration and shuts the agent down.
      stalledReason = stallDetector.observeTurn(toolUses);
      if (stalledReason) {
        log("\n[STALLED] " + stalledReason + " - stopping early.");
        break;
      }
    } else if (message.type === "result") {
      result = message;
    }
  }
} catch (err) {
  fail("The agent crashed: " + (err?.message ?? err));
}

// Stopped early because it was going in circles. Anything it half-changed is
// unverified, so throw it away and hand the problem to a human.
if (stalledReason) {
  const partial = agentChangedFiles();
  if (partial.length > 0) {
    log("Discarding " + partial.length + " unverified change(s): " + partial.join(", "));
    revertPaths(partial);
  }
  stop(
    "inconclusive",
    "Inconclusive, needs human review: " +
      stalledReason +
      ". Patchery stopped early rather than spending the rest of its turn budget, and " +
      "reverted the unverified changes. Nothing was delivered.",
    { tests_passed: "false" }
  );
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
    " | cost (Anthropic-pricing estimate): $" +
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

// Running out of turns is not a crash - it is the agent failing to reach a
// conclusion, which is exactly the "needs human review" outcome.
if (result.subtype === "error_max_turns") {
  const partial = agentChangedFiles();
  if (partial.length > 0) {
    log("Discarding " + partial.length + " unverified change(s): " + partial.join(", "));
    revertPaths(partial);
  }
  stop(
    "inconclusive",
    "Inconclusive, needs human review: the agent used all " +
      MAX_TURNS +
      " turns without producing a verified fix. Either the migration is bigger than one " +
      "run, or the premise is wrong (the code may not actually be broken). Any partial " +
      "changes were reverted.",
    { tests_passed: "false" }
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
const changedEntries = agentChangedEntries();
const changed = changedEntries.map((e) => e.path);

if (changed.length === 0) {
  stop("no-changes", "The agent changed no files. Nothing to open a PR for.", {
    tests_passed: "false",
  });
}

log(changed.map((f) => "  " + f).join("\n"));

const revertAll = () => revertPaths(changed);

/** A short, readable diff for one path - so a human can judge the change, not just its name. */
function diffSummary(file, maxLines = 40) {
  let body = "";
  try {
    body = git(["diff", "--", file]);
  } catch {}
  if (!body.trim()) {
    // Untracked files have no diff; show the head of the file instead.
    try {
      body = fs.readFileSync(path.join(repoRoot, file), "utf8");
    } catch {
      return "(no diff available)";
    }
  }
  const lines = body.split("\n");
  const head = lines.slice(0, maxLines).join("\n");
  return lines.length > maxLines ? head + "\n... (" + (lines.length - maxLines) + " more lines)" : head;
}

/**
 * Every reason a change must not be delivered.
 *
 * A dependency migration edits call sites inside the directory it was pointed
 * at. Anything else - a protected file, a file outside that directory, or a
 * tracked file deleted outright - is either the agent exceeding its brief or
 * something else dirtying the tree mid-run. Both look identical from here, and
 * neither belongs in a pull request the operator did not ask for.
 */
function violationReason(entry) {
  const byPath = protectedReason(entry.path);
  if (byPath) return byPath;

  const byScope = outOfScopeReason(entry.path, targetRel, ALLOWED_PATHS);
  if (byScope) return byScope;

  if (entry.deleted && !ALLOW_DELETIONS) {
    return "deletes a tracked file (migrations edit call sites, they do not delete files)";
  }
  return null;
}

const violations = changedEntries.map((e) => [e.path, violationReason(e)]).filter(([, reason]) => reason);
if (violations.length > 0) {
  log("\n[SAFETY] The agent produced changes that must not be delivered:");
  for (const [f, reason] of violations) log("  - " + f + " (" + reason + ")");

  // Show WHAT it did to them, not just that it did. The guard still blocks the
  // run either way - this only lets a human tell a malicious test edit from a
  // migration that legitimately needed one.
  log("\nWhat it changed in those files (blocked, shown for review):");
  const violationDiffs = [];
  for (const [f] of violations) {
    const d = diffSummary(f);
    violationDiffs.push("--- " + f + " ---\n" + d);
    log("\n--- " + f + " ---\n" + d);
  }

  log("\nReverting every change...");
  revertAll();

  // A lockfile in the blocked set plus a resolver error in the test output is a
  // specific, common dead end - not generic misbehaviour.
  const lockfileBlocked = violations.some(([, reason]) => reason === "lockfile");
  const conflict =
    looksLikeDependencyConflict(baseline.output) || looksLikeDependencyConflict(agentText.join("\n"));

  if (lockfileBlocked && conflict) {
    writeStepSummary(
      "### Patchery\n\nBlocked: peer-dependency conflict.\n\n```\n" +
        violationDiffs.join("\n\n").slice(0, 4000) +
        "\n```"
    );
    fail(
      "This is a peer-dependency conflict, not a code problem: resolving it requires " +
        "updating a lockfile, and lockfiles are protected so the agent cannot touch them. " +
        "Patchery cannot fix this class of break - resolve the dependency conflict by hand " +
        "(e.g. update the lockfile yourself), then run Patchery again for the code migration."
    );
  }

  // Point at the specific escape hatch, so a legitimate case is one input away
  // rather than a dead end. Only mention the ones that actually apply.
  const hints = [];
  if (violations.some(([, r]) => r.startsWith("outside the target directory"))) {
    hints.push(
      "If those paths are a legitimate part of this migration (a monorepo root manifest, " +
        "say), list them in `allowed-paths`."
    );
  }
  if (violations.some(([, r]) => r.startsWith("deletes a tracked file"))) {
    hints.push(
      "If this migration is genuinely supposed to delete files, set `allow-deletions: true`."
    );
  }
  if (violations.some(([, r]) => r === "test file" || r === "inside a test directory")) {
    hints.push(
      "Test files stay protected with no override: they are the only evidence a fix is " +
        "correct. If the migration truly requires a test change, make that change yourself " +
        "first, then run Patchery."
    );
  }

  writeStepSummary(
    "### Patchery\n\nBlocked: changes that must not be delivered.\n\n" +
      violations.map(([f, reason]) => "- `" + f + "` - " + reason).join("\n") +
      "\n\n```diff\n" +
      violationDiffs.join("\n\n").slice(0, 4000) +
      "\n```\n\n" +
      hints.join(" ")
  );
  fail(
    "Blocked and reverted, no PR will be opened. " +
      violations.map(([f, reason]) => f + " - " + reason).join("; ") +
      ". The diffs above show exactly what was changed, so you can tell a legitimate " +
      "migration apart from an agent going outside its brief. " +
      hints.join(" ")
  );
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
  "This PR was opened by **[Patchery](https://github.com/patchery-dev/Patchery)**. An AI agent read the",
  (baseline.ok ? "migration notes" : "breaking change") + " for `" + PACKAGE + "`, migrated the call sites" +
    " to the new API, and ran the tests.",
  "",
  "### Verification",
  "",
  "| Step | Result |",
  "| --- | --- |",
  "| `" + TEST_COMMAND + "` before the fix | " +
    (baseline.ok ? "passed (proactive migration, not a bug fix)" : "failed (exit " + baseline.code + ")") +
    " |",
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
    " - cost estimate (Anthropic pricing; actual cost may differ if a different provider was used): $" +
    (result.total_cost_usd ?? 0).toFixed(4),
  "",
  "> Needs human review. This PR was opened automatically, but it is never merged automatically.",
  "",
  "Generated with [Patchery](https://github.com/patchery-dev/Patchery) — catches breaking changes, migrates call sites, and verifies against your tests.",
].join("\n");

// Never write the PR body into the working tree: create-pull-request would
// commit it. Prefer the runner's temp dir, otherwise just outside the repo.
const prBodyDir = env("RUNNER_TEMP", path.join(repoRoot, ".."));
const prBodyPath = path.join(prBodyDir, "sma-pr-body.md");
// Redact before writing: this file becomes a public pull request body, and it
// embeds raw test output and whatever the agent chose to quote.
fs.writeFileSync(prBodyPath, clean(prBody), "utf8");

writeStepSummary(
  "### Patchery\n\nFixed `" +
    PACKAGE +
    "`, `" +
    TEST_COMMAND +
    "` passes.\n\n" +
    changed.map((f) => "- `" + f + "`").join("\n")
);
writeOutputs({
  outcome: "fixed",
  changed: "true",
  tests_passed: "true",
  files: changed.join("\n"),
  pr_body_file: prBodyPath,
  summary: "Fixed " + PACKAGE + " (" + changed.length + " file(s)), tests pass.",
});

log("\nChanged files: " + changed.join(", "));
log("PR body written to: " + prBodyPath);
log("\nDone.");
