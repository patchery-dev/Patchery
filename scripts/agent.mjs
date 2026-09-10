#!/usr/bin/env node
/**
 * Patchery - agent orchestrator
 *
 * What it does, in order:
 *   1. Runs the project's tests   -> is it actually broken? If not, do nothing.
 *   2. Runs the AI agent (Claude Agent SDK) -> migrate the broken call sites.
 *   3. Reads what changed via git -> if a protected file was touched, revert everything.
 *   4. Runs the tests again itself -> never trusts the agent's "tests pass" claim.
 *   5. Asks a second, read-only agent to REFUTE the fix -> advisory, never raises trust.
 *  5b. Optionally gives an actionable concern back for ONE repair turn, then re-runs
 *      the guard, the tests and the review, so the published verdict matches the diff.
 *   6. Writes results to GITHUB_OUTPUT / GITHUB_STEP_SUMMARY and a ready-made PR body.
 *
 * Everything is configured through environment variables (action.yml fills them in).
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { classifyFailure, briefing, normalizeBriefing } from "./classify-break.mjs";
import { census, censusHeld, censusTableCell } from "./test-census.mjs";
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
  normalizeVerifyMode,
  normalizeVerifyTools,
  reviewPassPlan,
  renderSpend,
  agentFinishedLine,
  tokenTotals,
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
  harnessCrash,
  shouldReview,
  buildReviewEvidence,
  parseReview,
  reviewOutcome,
  renderReviewSection,
  REVIEW_SCHEMA,
  REVIEW_SYSTEM_PROMPT,
  REVIEW_NO_TOOLS_NOTE,
  scriptsTamperReason,
  isHarnessConfig,
  harnessConfigReason,
  dependencyMisuseReasons,
  callSiteScan,
  callSiteNote,
  truncateEvidence,
  failureChanged,
  chainedFailureMessage,
  actionableConcerns,
  buildRepairPrompt,
  detectExtraChecks,
  extraCheckRegressions,
  buildDiagnosis,
  proofLevel,
  proofBanner,
} from "./guard.mjs";
import { createStderrSink, stderrNote } from "./sdk-stderr.mjs";

// ------------------------------------------------------------------ config

const env = (name, fallback = "") => (process.env[name] ?? "").trim() || fallback;
const bool = (name, fallback) => {
  const v = env(name).toLowerCase();
  if (v === "") return fallback;
  return v === "true" || v === "1" || v === "yes";
};

const WORKSPACE = path.resolve(env("SMA_WORKSPACE", process.cwd()));
const TARGET_DIR = path.resolve(WORKSPACE, env("SMA_TARGET_DIR", "."));

// Git runs from the directory we were told to fix, not from the workspace root.
//
// In the ordinary case they are the same and this changes nothing. They come
// apart when the repository being fixed sits inside the workspace rather than
// being it - a benchmark run that checks out somebody else's repository next to
// Patchery, a job that checks out with `path:`, a submodule. The workspace root
// is then not a git repository at all, and the run stopped with "Not a git
// repository" while a perfectly good checkout sat one directory down.
//
// Asking from the target directory is also simply more correct: the repository
// we must diff is the one containing the code we were asked to change. Porcelain
// and diff output stay root-relative regardless of where git is invoked, so
// every path in the guard keeps meaning what it meant before.
const GIT_CWD = fs.existsSync(TARGET_DIR) ? TARGET_DIR : WORKSPACE;
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
// A migration changes how a dependency is called; it does not stop calling it.
// Measured over 23 labelled changes: four of the six wrong migrations the reviewing
// models cleared were exactly this - the package dropped, shadowed, patched, or
// imported and then ignored - and they were cleared with the same confidence the
// models use to clear correct work. What code can decide, code decides.
const ALLOW_DEP_REMOVAL = bool("SMA_ALLOW_DEPENDENCY_REMOVAL", false);
const STALL_REPEATS = Math.max(2, Number(env("SMA_STALL_REPEATS", "3")) || 3);
// A turn that opens a file, runs a command or makes a search it has not made before
// is progress, even before anything has been edited. Only repeating work already
// done counts against this. Measured on three real runs against dwmkerr/terminal-ai:
// every research turn was a different, meaningful step, and the old "no edit yet"
// rule cut all three off in the turn before the edit.
const STALL_STALE_TURNS = Math.max(2, Number(env("SMA_STALL_STALE_TURNS", "5")) || 5);
// Legacy hard ceiling on research, off by default. NOTE: this must NOT be wrapped in
// Math.max(2, ...) the way the others are - that would silently turn the "0" (off)
// default into 2 and kill every run on its second turn.
const rawNoEdit = Number(env("SMA_STALL_NO_EDIT_TURNS", "0"));
const STALL_NO_EDIT_TURNS = Number.isFinite(rawNoEdit) && rawNoEdit >= 2 ? Math.floor(rawNoEdit) : 0;

// Independent review. Advisory by default: a false "this is bad" destroys a correct,
// tested fix and the author never sees the diff, which is the expensive direction for
// a tool whose adoption depends on believing it does something.
const verifyMode = normalizeVerifyMode(env("SMA_VERIFY_MODE"));
const VERIFY_MODE = verifyMode.mode;
// Whether the reviewer may open the repository. `auto` tries, and falls back to a
// no-tools pass if the model spends every turn investigating and never answers -
// then remembers that for the rest of the run, so a second review does not pay the
// same discovery cost twice. Set it explicitly once you know your reviewer model.
// A wall-clock brake, separate from the turn brake. See guard.mjs for why both are
// needed: a provider that stops answering never spends a turn.
const modelTimeout = normalizeModelTimeout(env("SMA_MODEL_TIMEOUT_MINUTES"));
const MODEL_TIMEOUT_MIN = modelTimeout.minutes;

// And a ceiling on the whole run, which the stall clock above is not. See
// normalizeRunBudget: making the stall clock measure silence took away the
// accidental ceiling it used to provide, and a run that kept answering ran until
// the CI job limit killed it - writing nothing at all.
const runBudget = normalizeRunBudget(env("SMA_RUN_BUDGET_MINUTES"));
const RUN_BUDGET_MIN = runBudget.minutes;
const RUN_STARTED_AT = Date.now();

/**
 * Give one model call a deadline. Returns the abortController to hand to the SDK
 * and a done() that must be called so a finished call does not leave a timer -
 * and, more importantly, does not abort the NEXT call.
 *
 * The clock measures SILENCE, not total runtime, and the difference cost a whole
 * benchmark run to find.
 *
 * It used to be one timer started before the loop and never touched again, so a
 * multi-turn run was killed at twenty minutes of wall clock however productive
 * it had been - and the message it printed said "the model stopped answering",
 * which sent everyone to the provider. Nine of fourteen cases died that way in
 * one run, and the reason the better model died MORE often is that it wrote 2.5x
 * the output of the cheap one: more work, more wall clock, more likely to hit a
 * wall that was never meant to be there.
 *
 * `touch()` resets it. Called on every message, the timer only ever fires after a
 * genuine gap - which is what the input has always claimed to measure.
 */
function deadline(label) {
  if (!MODEL_TIMEOUT_MIN && !RUN_BUDGET_MIN) {
    return {
      abortController: undefined,
      done: () => {},
      expired: () => false,
      reason: () => "",
      touch: () => {},
    };
  }
  const ac = new AbortController();
  let firedBy = null;
  let stallTimer = null;
  let budgetTimer = null;

  const reasonFor = (why) =>
    why === "budget" ? budgetReason(label, RUN_BUDGET_MIN) : timeoutReason(label, MODEL_TIMEOUT_MIN);

  const stop = (why) => {
    if (firedBy) return;
    firedBy = why;
    log("[timeout] " + reasonFor(why));
    ac.abort();
  };

  const armStall = () => {
    if (!MODEL_TIMEOUT_MIN) return;
    stallTimer = setTimeout(() => stop("stall"), MODEL_TIMEOUT_MIN * 60 * 1000);
  };

  // The budget is measured from the start of the RUN, not of this call. Three
  // calls each given the full budget would be three times the ceiling, and the
  // job limit this exists to stay under is a single number for the whole job.
  // A call that begins with the budget already spent gets a zero-length timer
  // and stops immediately, which is correct: there is no time left to give it.
  const left = budgetDelayMs(RUN_BUDGET_MIN, RUN_STARTED_AT, Date.now());
  if (left !== null) budgetTimer = setTimeout(() => stop("budget"), left);
  armStall();

  return {
    abortController: ac,
    done: () => {
      clearTimeout(stallTimer);
      clearTimeout(budgetTimer);
    },
    expired: () => Boolean(firedBy),
    // Which brake, as a value rather than only inside the prose. Both exits used
    // to call fail() with the default outcome, so a run WE stopped at its budget
    // and a model that stopped answering arrived downstream identically.
    firedBy: () => firedBy,
    // Which brake closed, in the caller's words. Reporting a budget stop as "the
    // model stopped answering" would send the reader to their provider over a
    // model that answered perfectly well.
    reason: () => (firedBy ? reasonFor(firedBy) : ""),
    // Anything arriving from the model is proof it has not stopped answering -
    // but it is not proof there is time left, so only the stall timer resets.
    touch: () => {
      if (firedBy) return;
      clearTimeout(stallTimer);
      armStall();
    },
  };
}

const verifyTools = normalizeVerifyTools(env("SMA_VERIFY_TOOLS"));
const VERIFY_TOOLS = verifyTools.tools;
const VERIFY_MODEL = env("SMA_VERIFY_MODEL");
// A different provider is the strongest independence lever there is: two models from
// the same family share training data and idioms, and a model is least likely to flag
// its own preferred way of getting something wrong.
//
// It is also a real privacy expansion, and that must be said out loud rather than
// buried: pointing the reviewer at a second endpoint means a second party sees the
// diff of the code under review. That is a decision for whoever runs this, not a
// default - both inputs are empty unless someone sets them deliberately.
const VERIFY_BASE_URL = env("SMA_VERIFY_BASE_URL");
const VERIFY_AUTH_TOKEN = env("SMA_VERIFY_AUTH_TOKEN");
// Give the reviewer's findings back to the fixer for one more turn. Off by default
// because most of what a reviewer raises is "I could not verify this" rather than
// "this is wrong", and acting on that invites changes to working code - so this only
// ever fires on concerns tied to a check that actually found something. It also costs
// a second fixer turn plus a second review, and the review already costs more than
// the fix does.
const VERIFY_REPAIR = bool("SMA_VERIFY_REPAIR", false);
const VERIFY_REPAIR_TURNS = Math.max(1, Number(env("SMA_VERIFY_REPAIR_TURNS", "8")) || 8);
// Measured, not guessed: at 6 the reviewer spent every turn reading - one Glob, two
// Greps for other call sites, five Reads - and ran out before it could answer, which
// scores as "unavailable" and wastes the whole call.
const VERIFY_MAX_TURNS = Math.max(1, Number(env("SMA_VERIFY_MAX_TURNS", "12")) || 12);
const VERIFY_MAX_DIFF_BYTES = Math.max(0, Number(env("SMA_VERIFY_MAX_DIFF_BYTES", "60000")) || 0);
const VERIFY_MIN_CONFIDENCE = Math.max(0, Math.min(100, Number(env("SMA_VERIFY_MIN_CONFIDENCE", "0")) || 0));
// Read-only. No Bash: it is both code execution and a write vector (sed -i, a
// redirect). No WebFetch: no egress channel with the customer's diff in context.
const REVIEW_TOOLS = ["Read", "Grep", "Glob"];

// A project that type-checks or lints is telling you what it considers correct, and a
// migration that satisfies the tests while breaking tsc is not finished. Measured
// against the baseline, never against "is it clean": plenty of real repositories have
// a lint error sitting in main already, and refusing to fix those would be useless.
const EXTRA_CHECKS_INPUT = env("SMA_EXTRA_CHECKS", "auto");

// ----------------------------------------------------------------- helpers

// Literal values that must never reach a log or a PR body, whatever the
// pattern matcher thinks. The run's own credentials are the obvious case.
// The reviewer's own credential belongs here too. It is a second key, on a path no
// pattern would recognise, and everything this script prints ends up in a public
// Actions log or a public PR body.
const SECRET_VALUES = [
  env("ANTHROPIC_AUTH_TOKEN"),
  env("ANTHROPIC_API_KEY"),
  VERIFY_AUTH_TOKEN,
  // The endpoints too. They are passed as secrets, they can carry credentials in
  // the URL itself, and which provider a run went to is not always something the
  // repository owner wants in a public log.
  env("ANTHROPIC_BASE_URL"),
  VERIFY_BASE_URL,
].filter(Boolean);
const clean = (text) => redactSecrets(text, SECRET_VALUES);

// Everything printed goes through redaction: test output and agent chatter are
// the two places a stray key from a .env or an error message shows up.
const log = (...a) => console.log(...a.map((x) => (typeof x === "string" ? clean(x) : x)));
const group = (title) => log("\n" + "=".repeat(8) + " " + title + " " + "=".repeat(8));

/**
 * Everything every model call in this run has cost, in tokens.
 *
 * Kept at module scope and added to writeOutputs rather than to each exit,
 * because there are forty-two exits and the one that forgets is the one that
 * matters: a run that produced nothing still spent, and "did a no-change run
 * cost as much as a fix" is exactly the question a per-exit field would fail to
 * answer.
 *
 * Tokens, not money. The SDK's own total_cost_usd prices with Anthropic's table
 * whatever endpoint served the request - it was wrong by a factor of 195 once -
 * so the true figure has to come from the provider's dashboard. What is recorded
 * here is the quantity that dashboard charges for, which is the half we can
 * measure honestly.
 */
const SPEND = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };

/**
 * Accumulate, then render. Every model call in this file goes through here, and
 * a check pins that no call site reaches renderSpend directly - so a sixth agent
 * added later is counted without anyone remembering to count it.
 */
function spend(args) {
  const t = tokenTotals(args?.modelUsage);
  SPEND.input += t.input;
  SPEND.output += t.output;
  SPEND.cacheRead += t.cacheRead;
  SPEND.cacheCreation += t.cacheCreation;
  return renderSpend(args);
}

// Filled by announceRun, which every exit path calls before writeOutputs. Kept
// module-level rather than threaded through six call sites: the alternative is
// six places to forget it, and the last time a measurement depended on one call
// site remembering, 13 legs of 42 lost their turn count.
let runTelemetry = {};

/**
 * What became of the patch the agent produced, carried to whichever exit ends
 * the run so the row can count it.
 *
 * `files` lists what SHIPPED, so a patch the guard reverted and a run that never
 * wrote a line arrive in the table as the same empty string. Answering how often
 * the tool had a patch it could have shipped wrongly meant reading six logs by
 * hand, and for the run before that it could not be answered at all.
 *
 * Starts empty on purpose: unset means unknown, not "nothing was written". A run
 * that dies before anything measures the tree should say so.
 */
let candidateExit = "";
let candidateCount = 0;
const noteCandidate = (exit, count) => {
  candidateExit = exit;
  if (count !== undefined) candidateCount = count;
};

/** Count the tree without letting a failure here end a run that was ending anyway. */
const safeChangedCount = () => {
  try {
    return agentChangedEntries().length;
  } catch {
    return null;
  }
};

function writeOutputs(obj) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  obj = {
    ...obj,
    ...runTelemetry,
    ...candidateOutputs(candidateRecord({ changedCount: candidateCount, exit: candidateExit })),
    tokens_input: String(SPEND.input),
    tokens_output: String(SPEND.output),
    tokens_cache_read: String(SPEND.cacheRead),
    tokens_total: String(SPEND.input + SPEND.output + SPEND.cacheRead + SPEND.cacheCreation),
  };
  const lines = Object.entries(obj).map(([k, v]) => {
    const delimiter = "__sma_" + k + "_" + Date.now() + "__";
    return k + "<<" + delimiter + "\n" + clean(String(v)) + "\n" + delimiter;
  });
  fs.appendFileSync(file, lines.join("\n") + "\n");
}

/**
 * The reviewer's own confidence, as an output, or "" when no review produced one.
 *
 * Published for one reason: `verify-min-confidence` ships as a round number nobody
 * has measured, and it can only stop being a guess if the numbers real runs produce
 * are visible somewhere. Empty rather than 0 when there is no review - 0 is a
 * confidence, and a workflow comparing against it must not be handed a fake one.
 */
function reviewConfidenceOutput() {
  const c = reviewOutcomeResult?.confidence;
  return Number.isFinite(c) ? String(c) : "";
}

function writeStepSummary(md) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) fs.appendFileSync(file, clean(md) + "\n");
}

/**
 * Say what the run cost, exactly once, on whichever way out it takes.
 *
 * `result` is only set when the SDK loop runs to completion. A stall breaks out
 * of it, the deadline throws out of it, and a dead child process never gets
 * there - so the three exits that most need explaining were the three with no
 * record. Called from fail/refuse/stop, which every one of them goes through.
 */
let telemetrySaid = false;
function announceRun() {
  if (telemetrySaid) return;
  telemetrySaid = true;
  // fail() is reachable long before `result` and `stallDetector` are declared -
  // a red baseline exits through it - and reading a `let` before its declaration
  // throws, `typeof` included. So both are read defensively: an exit that
  // happens before the agent existed has no turns to report, which is the truth.
  let turns = null;
  try {
    turns = result?.num_turns ?? stallDetector.inspect().toolTurns;
  } catch {
    turns = null;
  }
  // SPEND is what the run has actually totalled so far - the reviewer and the
  // classifier report through it too. When the fixer never reported, that figure
  // is real but short, and saying so is the point.
  const anySpend = SPEND.input || SPEND.output || SPEND.cacheRead || SPEND.cacheCreation;
  // Tokens only, no money: renderSpend's dollar figure is Anthropic's list price
  // whatever endpoint served the request - wrong by 195x once - and on this path
  // there is no cost figure to report at all. Quantities are the honest half.
  const n = (v) => Number(v).toLocaleString("en-US");
  const bits = [n(SPEND.input) + " in"];
  if (SPEND.cacheRead) bits.push(n(SPEND.cacheRead) + " cached");
  if (SPEND.cacheCreation) bits.push(n(SPEND.cacheCreation) + " cache-write");
  bits.push(n(SPEND.output) + " out");
  let subtype = "";
  let haveResult = false;
  try {
    subtype = result?.subtype || "";
    haveResult = Boolean(result);
  } catch {
    subtype = "";
  }
  // The clock and the waiting, on the same line as the turns. All three are
  // continuous, all three exist whatever the outcome was, and that is the point:
  // a binary result cannot say whether a ceiling binds, and these can.
  const usage = budgetUsage(Date.now() - RUN_STARTED_AT, RUN_BUDGET_MIN);
  let gaps = null;
  try {
    gaps = gapStats(agentGaps);
  } catch {
    gaps = null;
  }
  log(
    agentFinishedLine({
      subtype,
      turns,
      spend: anySpend ? bits.join(" · ") + " tokens" : "",
      partial: !haveResult,
    }) + budgetUsageLine(usage) + gapStatsLine(gaps)
  );
  runTelemetry = {
    clock_minutes: usage ? String(usage.minutes) : "",
    clock_percent: usage ? String(usage.percent) : "",
    model_wait_seconds: gaps ? String(gaps.modelSec) : "",
    local_work_seconds: gaps ? String(gaps.localSec) : "",
  };
}

function fail(message, outcome = "failed") {
  announceRun();
  console.error("\n[ERROR] " + clean(message));
  writeOutputs({ outcome, changed: "false", tests_passed: "false", summary: message });
  writeStepSummary("### Patchery\n\nFailed: " + message);
  process.exit(1);
}

/**
 * The guard stopped a change and reverted it. Not the same thing as a failure.
 *
 * Both used to exit through fail(), so both reported `outcome: failed`, and the
 * benchmark could not tell them apart: a run where the guard caught an agent
 * abandoning the dependency it was sent to migrate came out as NO-CHANGE -
 * "Patchery had nothing to offer". It had something to offer and correctly
 * refused to ship it, which is the entire product.
 *
 * Seen on body-parser with content-type@3: the agent defined a local
 * `contentType` where the file used to import one, so the calls still resolved,
 * the tests still passed, and the package was no longer reached at all. A green
 * suite proving nothing. The guard reverted it - and the row said the agent had
 * no ideas.
 *
 * The name matters beyond this repository: benchmark-outcome.mjs reads it and
 * files anything matching refuse/reject/block as REFUSED, which is the column
 * this belongs in.
 *
 * Exits 0, for the same reason stop() does: this is an intended outcome, not an
 * error. Routed through fail() it exited 1, and a run where the guard did its
 * job painted a red cross in the run list beside runs where the tool actually
 * broke. Nothing downstream reads the exit code - the pull request step is gated
 * on `changed` - so the only thing the 1 communicated was alarm, at the moment
 * the product was working.
 *
 * The `reason` is a slug, not prose, because it has to be counted. The first two
 * benchmark runs blocked four patches and all four were the same escape - the
 * agent replacing an imported name with a local reimplementation, so the calls
 * still resolve, the tests still pass, and the package is never reached. That is
 * a finding, and it was only visible because somebody read three summaries by
 * hand. A slug makes it a number.
 */
function refuse(message, reason = "unspecified") {
  // The count was taken when the diff appeared; only the verdict changes here.
  noteCandidate("guard");
  announceRun();
  console.error("\n[BLOCKED] " + clean(message));
  writeOutputs({
    outcome: "blocked-by-guard",
    guard_reason: reason,
    changed: "false",
    tests_passed: "false",
    summary: message,
  });
  writeStepSummary("### Patchery\n\nBlocked by the guard (" + reason + "): " + message);
  process.exit(0);
}

/**
 * A run that produced nothing but is not an error: nothing was broken, the agent
 * got stuck, or a human needs to look. Exits 0 so the workflow stays green - the
 * PR step is gated on `changed`, not on the exit code.
 */
function stop(outcome, message, extra = {}) {
  announceRun();
  log("\n" + message);
  writeStepSummary("### Patchery\n\n" + message);
  writeOutputs({ outcome, changed: "false", files: "", summary: message, ...extra });
  process.exit(0);
}

function git(args, { trim = true } = {}) {
  // execFileSync defaults to a 1 MB buffer and THROWS when output exceeds it. Every
  // caller here reads a diff or a file list, and on a large migration a 1 MB diff is
  // ordinary - the default turned "big change" into "command failed", which callers
  // then quietly treated as "no change".
  const out = execFileSync("git", args, { cwd: GIT_CWD, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
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

/**
 * Write down what a run that produced nothing had learned, and return the path.
 *
 * Deliberately a FILE and nothing more: opening an issue or a draft PR in someone's
 * repository is the workflow's decision, not this action's - the same split that
 * keeps pr-body-file separate from create-pull-request.
 */
function writeDiagnosis(fields) {
  try {
    const file = path.join(env("RUNNER_TEMP", path.join(repoRoot, "..")), "sma-diagnosis.md");
    fs.writeFileSync(file, clean(buildDiagnosis(fields)), "utf8");
    log("Diagnosis written to: " + file);
    return file;
  } catch (err) {
    log("could not write the diagnosis: " + (err?.message ?? err));
    return "";
  }
}

/** Run one extra check (a lint or a type-check) and report only whether it passed. */
function runCheck(command) {
  const r = spawnSync(command, {
    cwd: TARGET_DIR,
    shell: true,
    encoding: "utf8",
    env: { ...process.env, CI: "true" },
    timeout: 15 * 60 * 1000,
  });
  return { ok: r.status === 0, output: ((r.stdout ?? "") + (r.stderr ?? "")).trim() };
}

/** Run every configured extra check and return [{name, ok}]. */
function runExtraChecks(checks, label) {
  if (!checks.length) return [];
  const results = [];
  for (const c of checks) {
    const r = runCheck(c.command);
    log("   " + label + " " + c.name + ": " + (r.ok ? "PASS" : "FAIL"));
    results.push({ name: c.name, ok: r.ok, output: r.output });
  }
  return results;
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
// Both normalisers report a typo rather than guessing, for the same reason: someone
// who wrote `verify-mode: blcok` believes they are gated and is not. Refusing to
// start is the only answer that cannot leave them believing it.
if (verifyMode.error) fail(verifyMode.error);
if (verifyTools.error) fail(verifyTools.error);
if (modelTimeout.error) fail(modelTimeout.error);
if (runBudget.error) fail(runBudget.error);

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
  fail(
    "Not a git repository: " +
      GIT_CWD +
      ". Without git I cannot verify what the agent changed, so I stop here."
  );
}
log("git root     : " + repoRoot);

const filesBefore = new Set(workingTreeEntries().map((e) => e.path));
if (filesBefore.size > 0) {
  log("note: working tree is already dirty (" + filesBefore.size + " files) - those are not counted as the agent's work.");
}

// Where the agent was told to work, relative to the repo root. "" means the
// whole repository, which is the default and makes the scope rule a no-op.
const targetRel = path.relative(repoRoot, TARGET_DIR).replace(/\\/g, "/");

/** The package.json that governs the test command, or null if there is not one. */
function readTargetPackageJson() {
  try {
    return fs.readFileSync(path.join(TARGET_DIR, "package.json"), "utf8");
  } catch {
    return null;
  }
}

// Snapshotted before the agent runs: this is the definition of "passing" that step 4
// is measured against, so it has to be pinned from the start.
const packageJsonBefore = readTargetPackageJson();

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

/**
 * Photograph the working tree before anything reverts it.
 *
 * The reviewer's blocking path already did this, and its comment says why: a
 * gate whose failure mode is destroying work gets switched off by the first
 * person it burns. The turn cap and the stall detector revert exactly the same
 * way and saved nothing, so a run that hit the ceiling mid-migration deleted
 * the migration. From benchmark #11's own log, verbatim:
 *
 *   Discarding 2 unverified change(s): jest.config.js, through2-shim.cjs
 *
 * Those two files were the work of forty-five minutes and are gone.
 *
 * Saving is not shipping, and this deliberately does not make it one. The patch
 * is unverified - the tests were never re-run against it - so it must never
 * reach a pull request or be counted as a fix. It is written where a human can
 * pick it up, and the run still reports that nothing was delivered.
 */
function savePatch(entries, name) {
  const out = { saved: false, path: path.join(env("RUNNER_TEMP", path.join(repoRoot, "..")), name) };
  if (!entries.length) return out;
  try {
    let text = "";
    const tracked = entries.filter((e) => !e.status.includes("?")).map((e) => e.path);
    if (tracked.length) text += git(["diff", "--"].concat(tracked));
    // An untracked file has no diff and would be silently absent from the patch -
    // which is how a saved patch can be verified as "written" while missing the
    // file the agent actually created. Rendered as all-additions instead.
    for (const e of entries.filter((x) => x.status.includes("?"))) {
      try {
        const body = fs.readFileSync(path.join(repoRoot, e.path), "utf8");
        text += untrackedHunk(e.path, body);
      } catch {}
    }
    if (!text.trim()) return out;
    fs.writeFileSync(out.path, text, "utf8");
    // Verified, not assumed: the revert below deletes the only other copy, and
    // claiming a save that did not happen is worse than admitting it did not.
    out.saved = fs.statSync(out.path).size > 0;
  } catch (err) {
    log("could not save the unverified change: " + (err?.message ?? err));
  }
  return out;
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

// What kind of break this is, from the runner's own error code. Free, and it
// answers a question the agent otherwise spends turns on: the express run spent
// roughly half its budget establishing what Node had already stated in the first
// line of the failure. A null kind means we could not tell, and the agent is
// told nothing rather than guessed at.
const briefingMode = normalizeBriefing(env("SMA_BRIEFING"));
if (briefingMode.error) fail(briefingMode.error);
const classification = classifyFailure(baseline.output);
if (!briefingMode.on && classification.kind) {
  log("[EXPERIMENT] briefing is off - the agent gets the failure output and nothing else. " +
      "Classified mechanically as " + classification.kind + ", not shown.");
}
if (classification.kind) {
  log("-> break looks like: " + classification.kind + " - " + classification.what);
  if (classification.inScope === false) {
    log("   this class is not fixable by editing call sites; the agent is told to report and stop");
  }
}

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

// Measured before the agent touches anything, because the only question worth
// asking afterwards is "did this change break it", not "is this project clean".
const extraChecks = detectExtraChecks(packageJsonBefore, EXTRA_CHECKS_INPUT);
let checksBefore = [];
if (extraChecks.length) {
  log("\nExtra checks this project declares: " + extraChecks.map((c) => c.name).join(", "));
  checksBefore = runExtraChecks(extraChecks, "baseline");
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
  "   Where the new API needs a value the old one did not - a currency, a locale, a",
  "   region, a model name - look for one this project already uses (config files,",
  "   environment variables, nearby call sites, the tests) before choosing one. An",
  "   invented default that happens to satisfy the tests is the most common way one of",
  "   these migrations is quietly wrong.",
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
  // Last, so it is the freshest thing in the prompt, and only when the failure
  // named itself. It says what the error code already means and where the
  // boundary of a legitimate fix is - not to narrow the agent's judgement, but
  // to stop it spending turns rediscovering the diagnosis, and to stop it
  // inventing a way around a decision that is not ours to make.
  classification.kind && briefingMode.on ? "\n" + briefing(classification) + "\n" : "",
  "Work only inside: " + TARGET_DIR,
].join("\n");

const agentText = [];
let result = null;
// Declared beside `result` and read by announceRun, which can run before either
// exists - a red baseline exits through fail() long before this line. The reads
// there are guarded for exactly that.
const agentGaps = [];
let lastMessageAt = Date.now();
let stalledReason = null;
const stallDetector = createStallDetector({
  repeats: STALL_REPEATS,
  staleTurns: STALL_STALE_TURNS,
  noEditTurns: STALL_NO_EDIT_TURNS,
  root: TARGET_DIR.replace(/\\/g, "/"),
});

const agentDeadline = deadline("fixing agent");
// Without this the SDK opens its child's stderr as "ignore" and the operating
// system discards whatever the runtime says on its way out. See sdk-stderr.mjs.
const agentStderr = createStderrSink({ label: "agent", write: (line) => log(line) });
try {
  for await (const message of query({
    prompt,
    options: {
      cwd: TARGET_DIR,
      allowedTools: ["Read", "Edit", "Write", "Bash", "Glob", "Grep"],
      permissionMode: "bypassPermissions",
      maxTurns: MAX_TURNS,
      abortController: agentDeadline.abortController,
      stderr: agentStderr.onData,
    },
  })) {
    // Proof the model is still answering. Without this the deadline is a budget
    // on the whole run rather than a stall detector, and a productive agent is
    // killed for being productive.
    //
    // The same tick is where waiting becomes measurable. The gap since the last
    // message is the closest thing to provider latency we can see from outside
    // the SDK, and it separates two runs that were previously identical in every
    // recorded field: one that spent its budget working and one that spent it
    // waiting. With the machine deliberately left varying, that is the
    // attribution which would otherwise be missing.
    // Tagged by what ended the gap. A gap closed by an assistant message is the
    // model thinking; a gap closed by anything else is a tool running locally,
    // and running this project's suite takes minutes. Untagged, the first
    // version of this reported 1889s of "waiting" in a 1920s run.
    agentGaps.push({ ms: Date.now() - lastMessageAt, kind: message.type });
    lastMessageAt = Date.now();
    agentDeadline.touch();
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
      // Naming what was new this turn is the observability whose absence made the
      // false-positive stall take three paid runs to diagnose. It costs nothing.
      // Only for turns that used tools: a text-only turn leaves `lastNew` alone,
      // and printing it again would just repeat the previous turn's discoveries.
      if (toolUses.length > 0) {
        for (const key of stallDetector.inspect().lastNew) log("  [new] " + key);
      }
      if (stalledReason) {
        log("\n[STALLED] " + stalledReason + " - stopping early.");
        break;
      }
    } else if (message.type === "result") {
      result = message;
    }
  }
} catch (err) {
  // A child that dies at startup dies mid-line. Release the buffer before
  // reading it, or the one line worth having is the one still held here.
  agentStderr.flush();
  // An abort surfaces here as an ordinary throw. Say which it was: "the agent
  // crashed" sends someone reading a stack trace, "it stopped answering" sends
  // them to the provider.
  // The wall clock and the model going quiet are different results and were
  // reported as the same one. Ours is EXHAUSTED, for the reason the turn budget
  // already is: we chose the number and the run did happen.
  if (agentDeadline.expired()) {
    // The clock fires out of a catch, before anything has enumerated the tree.
    // Count it here or the most common exit there is reports nothing at all.
    noteCandidate("ceiling", safeChangedCount());
    fail(agentDeadline.reason(), deadlineOutcome(agentDeadline.firedBy()));
  }
  // A dead child process is our runtime, not the agent declining to answer. Filed
  // as a plain failure it became NO-CHANGE - "Patchery had nothing to offer" - for
  // three runs where the agent never got to have an offer.
  const runtimeDeath = harnessCrash(err);
  // The cause, if the runtime left one. Appended to the message rather than
  // only logged, because the log is 4000 lines and the summary is the field a
  // benchmark row carries: run #13 crashed seven times and every row said
  // `process exited with code 1`, which named the symptom in all seven.
  const said = stderrNote(agentStderr);
  // Joined here rather than in the call, because the outcome census reads these
  // call sites with a regex that stops at the first `)` - an expression in the
  // argument list makes `harness-error` invisible to the contract check that
  // exists to keep action.yml honest. Selftest caught exactly that.
  const deathMessage = said ? runtimeDeath + " " + said : runtimeDeath;
  if (runtimeDeath) fail(deathMessage, "harness-error");
  const crashMessage = "The agent crashed: " + (err?.message ?? err) + (said ? ". " + said : "");
  fail(crashMessage);
} finally {
  // Also on the way out of a healthy run: a warning the runtime printed without
  // a trailing newline is still a warning.
  agentStderr.flush();
  agentDeadline.done();
}

// Stopped early because it was going in circles. Anything it half-changed is
// unverified, so throw it away and hand the problem to a human.
if (stalledReason) {
  const partialEntries = agentChangedEntries();
  const partial = partialEntries.map((e) => e.path);
  let stallPatch = { saved: false, path: "" };
  if (partial.length > 0) {
    stallPatch = savePatch(partialEntries, "sma-stalled.patch");
    log(
      "Discarding " + partial.length + " unverified change(s): " + partial.join(", ") + " - " +
        patchNote(stallPatch.saved, stallPatch.path, "the partial work")
    );
    noteCandidate("ceiling", partial.length);
    revertPaths(partial);
  }
  // The counters matter to whoever reads this: "it looped" and "it explored and I
  // cut it off" are different problems with different fixes, and the message alone
  // does not tell them apart.
  const s = stallDetector.inspect();
  const diagnosisFile = writeDiagnosis({
    packageName: PACKAGE,
    targetRel: targetRel || ".",
    testCommand: TEST_COMMAND,
    reason: stalledReason,
    outcome: "inconclusive",
    baselineOutput: baseline.output,
    changelog: CHANGELOG,
    turns: s.toolTurns,
    edits: s.edits,
    discovered: s.keys,
    classification,
    agentNotes: agentText.length ? agentText[agentText.length - 1].trim() : "",
  });
  stop(
    "inconclusive",
    "Inconclusive, needs human review: " +
      stalledReason +
      ". Patchery stopped early rather than spending the rest of its turn budget, and " +
      "reverted the unverified changes. Nothing was delivered. (" +
      s.toolTurns + " tool turns, " + s.discovered + " distinct things discovered, " +
      s.edits + " edit(s).)",
    { tests_passed: "false", diagnosis_file: diagnosisFile, salvaged_patch: stallPatch.saved ? stallPatch.path : "" }
  );
}

if (!result) {
  fail("The agent returned no result message (likely a connectivity or authentication problem).");
}

const modelsUsed = Object.keys(result.modelUsage ?? {});
// The happy path keeps its own richer line - it has the cost figure and the
// model list, which the exit paths cannot know. Marked as said so announceRun()
// does not print a second, poorer one on the way out.
telemetrySaid = true;
log(
  "\n-> agent finished: " +
    result.subtype +
    " | turns: " +
    result.num_turns +
    " | spend: " +
    spend({
      modelUsage: result.modelUsage,
      costUsd: result.total_cost_usd,
      customEndpoint: usingCustomEndpoint,
    }) +
    // The same two continuous measures the exit paths report. A run that
    // succeeded at 82% of its clock and one that succeeded at 20% are the same
    // row today, and they are not the same result - through2's one success used
    // 37 of 45 turns while its two failures stopped exactly at the cap.
    budgetUsageLine(budgetUsage(Date.now() - RUN_STARTED_AT, RUN_BUDGET_MIN)) +
    gapStatsLine(gapStats(agentGaps))
);
{
  const u = budgetUsage(Date.now() - RUN_STARTED_AT, RUN_BUDGET_MIN);
  const g = gapStats(agentGaps);
  runTelemetry = {
    clock_minutes: u ? String(u.minutes) : "",
    clock_percent: u ? String(u.percent) : "",
    model_wait_seconds: g ? String(g.modelSec) : "",
    local_work_seconds: g ? String(g.localSec) : "",
  };
}
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
  const partialEntries = agentChangedEntries();
  const partial = partialEntries.map((e) => e.path);
  let capPatch = { saved: false, path: "" };
  if (partial.length > 0) {
    capPatch = savePatch(partialEntries, "sma-capped.patch");
    log(
      "Discarding " + partial.length + " unverified change(s): " + partial.join(", ") + " - " +
        patchNote(capPatch.saved, capPatch.path, "the partial work")
    );
    noteCandidate("ceiling", partial.length);
    revertPaths(partial);
  }
  const s = stallDetector.inspect();
  const diagnosisFile = writeDiagnosis({
    packageName: PACKAGE,
    targetRel: targetRel || ".",
    testCommand: TEST_COMMAND,
    reason: "the agent used all " + MAX_TURNS + " turns without producing a verified fix",
    outcome: "inconclusive",
    baselineOutput: baseline.output,
    changelog: CHANGELOG,
    turns: s.toolTurns,
    edits: s.edits,
    spend: spend({
      modelUsage: result.modelUsage,
      costUsd: result.total_cost_usd,
      customEndpoint: usingCustomEndpoint,
    }),
    discovered: s.keys,
    classification,
    agentNotes: agentText.length ? agentText[agentText.length - 1].trim() : "",
  });
  // A run that produced no fix still produced a diagnosis, and on the express
  // run that diagnosis was correct and had cost twenty minutes to reach - then
  // was summarised as "inconclusive" and thrown away. What was learned goes in
  // the sentence, not only in a file nobody is told to open.
  stop(
    "inconclusive",
    [
      "Inconclusive, needs human review: the agent used all " +
        MAX_TURNS +
        " turns without producing a verified fix. Any partial changes were reverted.",
      // The run that hit the ceiling mid-migration used to say only that its work
      // was discarded. Where it went belongs in the sentence, not just the log -
      // and so does the fact that it is unverified, so nobody applies it thinking
      // it passed something.
      capPatch.saved
        ? "The partial work was saved to " + capPatch.path + " before the revert - it is " +
          "unverified, the tests were never run against it, and it is not a fix."
        : "",
      classification.kind
        ? "It was working on a `" + classification.kind + "` break - " + classification.what + "."
        : "",
      classification.inScope === false
        ? "That class cannot be fixed by editing call sites, so no run of this agent will fix it."
        : "",
      "It read " +
        s.keys.filter((k) => k.startsWith("read:")).length +
        " file(s) and made " +
        s.edits +
        " edit(s) over " +
        s.toolTurns +
        " turn(s). The full account is in the diagnosis file.",
    ]
      .filter(Boolean)
      .join(" "),
    { tests_passed: "false", diagnosis_file: diagnosisFile, salvaged_patch: capPatch.saved ? capPatch.path : "" }
  );
}

// The SDK stopped before the agent reached a conclusion. Its own outcome,
// because it is our harness failing rather than the agent having nothing.
//
// On mozilla/treeherder this was MaxFileReadTokenExceededError: a source file of
// 38,424 tokens against a 25,000 limit, three times over. The agent never got to
// think about the break. Filed as a plain failure it became NO-CHANGE in the
// benchmark - "Patchery had nothing to offer" - about a run that was never
// allowed to start. Running out of turns is handled above and is a different
// thing: that is a budget WE set, and it stays in the denominator.
if (result.subtype !== "success") {
  fail(
    "The agent did not finish successfully: " +
      result.subtype +
      (result.errors ? " - " + result.errors.join("; ") : ""),
    "harness-error"
  );
}

group("3. What changed? (verified independently with git)");
// Reassignable: a repair turn can add or change files, and everything downstream -
// the PR body, the files output, add-paths - must describe what is actually there.
let changedEntries = agentChangedEntries();
let changed = changedEntries.map((e) => e.path);
// A diff exists and nothing has proved it yet. Every exit below either upgrades
// this to shipped or hands it to the guard - and a run that dies in between is
// then described as what it was: a patch nobody proved.
if (changed.length > 0) noteCandidate("unverified", changed.length);

if (changed.length === 0) {
  // The most common outcome, and until now the least useful one. A run that
  // finishes without editing anything has still read the changelog, opened the
  // call sites and formed a view - on express it spent twenty-six turns doing
  // exactly that - and all of it was thrown away with one sentence about there
  // being no PR to open.
  //
  // Nothing here changes the decision: no files changed, so nothing ships. It
  // decides what is handed back.
  const s = stallDetector.inspect();
  const notes = agentText.length ? agentText[agentText.length - 1].trim() : "";
  const diagnosisFile = writeDiagnosis({
    packageName: PACKAGE,
    targetRel: targetRel || ".",
    testCommand: TEST_COMMAND,
    reason: "the agent finished without changing any files",
    outcome: "no-changes",
    baselineOutput: baseline.output,
    changelog: CHANGELOG,
    turns: s.toolTurns,
    edits: s.edits,
    spend: spend({
      modelUsage: result.modelUsage,
      costUsd: result.total_cost_usd,
      customEndpoint: usingCustomEndpoint,
    }),
    discovered: s.keys,
    agentNotes: notes,
    classification,
  });
  // Written as a handover, not a status line. Whoever reads this is now the one
  // who has to decide something, and everything they need to decide it was in
  // this run: what broke, why the obvious fix does not apply, what the agent
  // concluded in its own words, and which choice is theirs to make. Pointing at
  // a file for the important half wastes the run.
  const readCount = s.keys.filter((k) => k.startsWith("read:")).length;
  // A run that ends without a patch is not the same as a run that ends with
  // nothing, and this block used to say both in the same words.
  //
  // In benchmark #9 the body-parser case produced the best output this project
  // has ever seen from an agent: it classified the break, found the single call
  // site and the two lines that use it, noticed that a sibling package escaped
  // the same break only because it resolved to its own nested CommonJS copy,
  // reproduced it on the exact Node version, and named the two decisions that
  // unblock it. The banner over all of that read "Patchery found no change it
  // could make ... Nothing was delivered because nothing could be proved."
  //
  // That is real work, described as an absence. Worse, it is ambiguous in the
  // direction that costs most: a reader cannot tell whether the tool found
  // nothing or was not able to do it - and "not able to do it" is the reading
  // people default to.
  //
  // The correction is to stop calling it a failure, NOT to start calling it the
  // product. The founder's ruling, and it is binding: the report is a fallback,
  // never a sales argument. A patch is what was promised; when none is possible
  // the run says so and hands over what it found, without promoting the
  // consolation into the headline.
  //
  // So the two cases are separated. The test is what actually came out of the
  // run - a break class from classifyFailure, which is a regex over the test
  // output rather than the model's opinion, plus notes the agent actually wrote.
  // Neither is something a stuck agent can award itself.
  // And it leads with what was FOUND, never with what was not produced. The
  // first draft of this said "an analysis, not a patch", which is accurate and
  // still weak: opening on a negation invites the reader to supply the missing
  // half themselves, and the half people supply is "it could not do it".
  //
  // Nothing here is softened to achieve that. Where classifyFailure's regex has
  // established that no code change can fix the break, saying so plainly is both
  // stronger and more true than reporting it as our shortfall - the tool that
  // "fixes" an EBADENGINE is either lying or breaking the project's own users.
  // Where that is not established, the header claims only the work that was
  // actually done: the break was traced.
  // Where the package is actually imported, counted rather than asserted.
  //
  // A run #11 leg told its reader "Every call site in this project's own source:
  // there are none" about a repository that imports the package in
  // test/integration.mjs. Nothing in the run was in a position to disagree with
  // the model about a fact git can settle in a second.
  //
  // Tracked files only: node_modules is where the break lives, not where the
  // project calls it from, and an untracked scratch file is not this project's
  // source either. A failure to list them yields null, and null prints nothing -
  // an empty search must never reach a reader as "no call sites".
  const callSites = (() => {
    try {
      const listed = git(["ls-files", "--", targetRel || "."], { trim: false })
        .split("\n")
        .map((p) => p.trim())
        .filter(Boolean);
      const files = [];
      for (const rel of listed) {
        try {
          files.push({ path: rel, text: fs.readFileSync(path.join(repoRoot, rel), "utf8") });
        } catch {
          // Unreadable is not empty. Skipping it lowers `searched`, which is
          // reported, rather than silently counting it as a file with no imports.
        }
      }
      return callSiteScan({ packageName: PACKAGE, files });
    } catch {
      return callSiteScan({ packageName: PACKAGE, files: null });
    }
  })();

  const isVerdict = Boolean(classification.kind) && Boolean(notes);
  const handover = [
    !isVerdict
      ? "### Patchery found no change it could make"
      : classification.inScope === false
      ? "### Patchery found the cause - and no code change fixes this one"
      : "### Patchery traced the break to its call sites",
    "",
  ];
  if (classification.kind) {
    handover.push("**What broke.** " + classification.what + ".");
    if (classification.evidence) handover.push("", "```", classification.evidence, "```");
    handover.push("");
  }
  {
    // Placed before the agent's own words, deliberately: a reader who is about to
    // be told where the call sites are should already know what the machine
    // counted.
    const line = callSiteNote(callSites, PACKAGE);
    if (line) handover.push(line, "");
  }
  if (classification.inScope === false) {
    handover.push(
      "**This is not a call-site problem.** No run of this agent will fix it, however many turns it is given.",
      ""
    );
  }
  if (notes) {
    // Announced, not silent. Caught in a live benchmark leg: the agent had listed
    // the transitive callers of a broken module and the list stopped mid-word, at
    // "lib/type", with nothing saying it had been cut. A reader has no way to tell
    // a truncated list from a complete one, and this project has a rule about that
    // - evidence is never trimmed silently - with a function already written for it.
    const said = truncateEvidence(notes, 1500, "this summary");
    handover.push("**What the agent concluded.**", "", said.text, "");
  }
  if (classification.next) handover.push("**What would unblock it.** " + classification.next, "");
  // The closing line is where the old wording did the most damage, because it is
  // the last thing read: "Nothing was delivered because nothing could be proved"
  // sat under a page of delivered analysis.
  //
  // "The analysis above is the deliverable" stood here and had to go. It is the
  // sales argument the founder ruled out: it promotes the fallback to the thing
  // promised, and a reader who wanted a patch is told they got the better item.
  // Saying no patch was possible is honest; saying the consolation was the point
  // is not, and a product that does it once is not believed the next time.
  //
  // What survives is the part that is true in both directions: no patch shipped,
  // here is why, and here is the limit of what is above. A fix is machine-checked
  // - the suite went red to green and the census held - and an analysis is not
  // checked at all, so it is handed over as a diagnosis to be read rather than a
  // result to be trusted. Stating that limit is what makes the rest worth
  // believing.
  // Three endings, because there are three runs here and two of them used to
  // share a sentence.
  //
  // "A patch would encode a decision that is yours" is true where the
  // classification says no code change fixes the break. It was printed on every
  // leg that wrote notes, including one whose own line four rows above read
  // "This is an ordinary migration and should be fixable". One sentence said the
  // run fell short and the other said it was right to stop, on the same screen,
  // and a reader had no way to choose. The ending now follows the same
  // classification the line above it follows.
  const tail =
    "Above is the reasoning that got there. Unlike a fix, none of it has been machine-checked: " +
    "read it as a diagnosis and check its claims.";
  const read = "It read " + readCount + " file(s) over " + s.toolTurns + " turn(s) ";
  handover.push(
    !isVerdict
      ? read + "and changed none. Nothing was delivered because nothing could be proved."
      : classification.inScope === false
      ? read + "and shipped no patch, because on this break a patch would encode a decision " +
        "that is yours, in a place you would not look for it. " + tail
      : read + "and shipped no patch. This break is the kind that is normally fixable at the " +
        "call site, so read what follows as a run that stopped short of one rather than as a " +
        "verdict that none exists. " + tail
  );
  const message = handover.join("\n");
  log("\n" + message);
  // A run that ends because no code change CAN fix the break is not the same
  // result as a run that ends because this agent found nothing, and until now
  // both wrote "no-changes" - which the benchmark reads as "Patchery had nothing
  // to offer". That sentence is false about a run that returned the right
  // answer, and it is false in the direction that costs us: it files a correct
  // verdict as our shortfall.
  //
  // The gate is `classification.inScope === false`, which comes from a regex over
  // the test output (EBADENGINE and friends), NOT from anything the model says.
  // That matters more than the wording: an outcome that reads better than
  // "nothing to offer" is exactly what a stuck agent would learn to reach for, so
  // it must be unreachable by claiming it. The model cannot set this flag.
  //
  // Deliberately NOT implemented: the second reason we know exists - a fix that
  // was found but needs the owner's consent, because it would break the
  // consumers of a published library. It is real, it is arguably the more
  // valuable case, and there is no mechanical signal for it today. Adding it on
  // the model's say-so would hand back the escape hatch this gate exists to
  // close. It stays NO-CHANGE, understating us, until something deterministic
  // can tell a library from an application at run time.
  noteCandidate("none", 0);
  const noCodeFix = isVerdict && classification.inScope === false;
  stop(noCodeFix ? "needs-decision" : "no-changes", message, {
    tests_passed: "false",
    diagnosis_file: diagnosisFile,
    ...(noCodeFix ? { decision_reason: "no-code-fix" } : {}),
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
  refuse(
    "Blocked and reverted, no PR will be opened. " +
      violations.map(([f, reason]) => f + " - " + reason).join("; ") +
      ". The diffs above show exactly what was changed, so you can tell a legitimate " +
      "migration apart from an agent going outside its brief. " +
      hints.join(" "),
    "protected-path"
  );
}

// Checked BEFORE the tests are re-run, because a run that rewrote `scripts.test`
// would make that re-run prove nothing at all. package.json is deliberately not a
// protected path - a migration legitimately bumps a dependency version in it - so
// the field that decides what "passing" means is protected by content instead.
{
  const scriptsReason = scriptsTamperReason(packageJsonBefore, readTargetPackageJson());
  if (scriptsReason) {
    log("\n[SAFETY] " + scriptsReason);
    revertAll();
    refuse(
      "Blocked and reverted, no PR will be opened: " + scriptsReason + ". Everything else " +
        "in package.json - dependencies, version - is still fair game; only the scripts are " +
        "frozen for the length of a run, because they are the definition of correct that " +
        "the rest of this pipeline is measured against.",
      "scripts-tamper"
    );
  }
}

// The same question one level out: the runner's configuration is no longer refused
// by path, because teaching a runner to transform an ES-module dependency is often
// the only legitimate fix - and forbidding the file while instructing the agent to
// consider that fix sent it looking for worse ideas. What is refused is the part
// that decides which tests run.
//
// Before the re-run, for the same reason as the scripts: a suite narrowed here
// would make the re-run prove nothing.
for (const entry of changedEntries) {
  if (entry.deleted || !isHarnessConfig(entry.path)) continue;
  let before = "";
  try {
    before = git(["show", "HEAD:" + entry.path], { trim: false });
  } catch {
    // A config file this run created has no "before", and every setting in it is
    // therefore something this run added.
    before = "";
  }
  let now = "";
  try {
    now = fs.readFileSync(path.join(repoRoot, entry.path), "utf8");
  } catch {
    continue;
  }
  const reason = harnessConfigReason(before, now);
  if (!reason) continue;
  log("\n[SAFETY] " + entry.path + ": " + reason);
  revertAll();
  refuse(
    "Blocked and reverted, no PR will be opened. `" + entry.path + "` - " + reason +
      " Changing how a dependency is compiled is a legitimate migration and is allowed; " +
      "changing what the runner looks at is not.",
    "harness-config"
  );
}

// Checked here, before the tests: these are all changes that PASS the tests. That is
// the point of them - the test re-run cannot see any of this, because from its side
// nothing is wrong.
{
  // The WHOLE change, in one call. A legitimate migration can move a call site out of
  // one file and into a new one, and asking each file on its own would read that as a
  // removal and destroy a correct, tested change. New files are included for exactly
  // that reason: they have no "before", but they are where the call site may have gone.
  const depFiles = [];
  for (const entry of changedEntries) {
    if (entry.deleted) continue;
    let beforeText = "";
    try {
      beforeText = git(["show", "HEAD:" + entry.path], { trim: false });
    } catch {
      // Untracked. No "before" is not the same as nothing to say.
      beforeText = "";
    }
    let afterText = "";
    try {
      afterText = fs.readFileSync(path.join(repoRoot, entry.path), "utf8");
    } catch {
      continue;
    }
    depFiles.push({ relPath: entry.path, beforeText, afterText });
  }
  const depReasons = dependencyMisuseReasons({
    packageName: PACKAGE,
    files: depFiles,
    // Subversion has no legitimate form and this never reaches it - patching the
    // module or shadowing its exports is refused whatever the input says.
    allowRemoval: ALLOW_DEP_REMOVAL,
  }).map((r) => r.reason);
  if (depReasons.length > 0) {
    for (const r of depReasons) log("[SAFETY] " + r);
    revertAll();
    refuse(
      "Blocked and reverted, no PR will be opened. " + depReasons.join(" ") + " " +
        "These changes pass your tests - that is why they are checked here rather than " +
        "left to the test run - and a reviewing model cleared this class of change as " +
        "often as it cleared correct work, which is why it is a rule and not an opinion.",
      "dependency-misuse"
    );
  }
}

group("4. Run the tests again myself (do not trust the agent's word)");
const after = runTests();
log(after.output.slice(-4000) || "(no output)");
log("\n-> after the fix: " + (after.ok ? "PASS" : "FAIL (exit " + after.code + ")"));

// How many tests ran, before and after.
//
// A green suite is not proof. The one failure a green light cannot catch is a
// suite made to agree - a spec excluded by a config pattern, a describe block
// renamed out of a match, a file that no longer matches. Every one of those ends
// in "all tests passed", and the count is where it shows.
//
// This lived only in the benchmark until now, which meant the product shipped
// without the check its own benchmark relied on. It also decides what the agent
// is allowed to touch: build and test configuration can only be opened up where
// this comparison is possible, so the permission and the protection arrive
// together.
// Read what this "before" actually is, because it is not what the name suggests
// and the limit is structural rather than a bug to be fixed here.
//
// `baseline` is step 1: the run that establishes the repository IS broken. So
// the suite being counted has already been broken by the upgrade, and when the
// break stops the specs from loading at all - a packaging break, which is 11 of
// our 14 verified cases - the runner prints no summary and there is nothing to
// count. That is why the product could not count three of the four legs that
// shipped anything in run #11, all of them body-parser, while the benchmark
// counted the same legs without trouble: the benchmark counts BEFORE it installs
// the break, and the action never sees that state.
//
// Nothing here can conjure a healthy baseline; the action is invoked on a
// repository that is already red. What it can do is say so, which the pull
// request table now does in every state rather than leaving a blank.
const censusBefore = census(baseline.output);
const censusAfter = census(after.output);
const censusVerdict = censusHeld(censusBefore, censusAfter);
if (censusBefore.total != null) {
  log(
    "\n-> tests counted: " + censusBefore.passed + " passing before, " +
      (censusAfter.total != null ? censusAfter.passed + " passing after" : "after not countable") +
      " (" + censusBefore.runner + ")"
  );
}

if (!after.ok) {
  // Same failure, or a different one? Until now both ended here identically, and the
  // difference is most of what the run learned: a NEW failure means the migration was
  // right as far as it went and a second breakage was sitting behind it. The change is
  // reverted either way - this decides what to say, never what to keep.
  const diff = failureChanged(baseline.output, after.output);
  // Saved before the revert deletes the only copy, the way the stall, cap and
  // reviewer paths already do. This one did not, and it is the path the
  // product's own claim turns on.
  //
  // Five outside readings of this exact case disagreed on what to call it -
  // "found a fix it could not prove" or "had nothing to offer" - and the one
  // that dissolved the disagreement pointed out that the observable run is
  // identical either way. What separates them is whether this patch would have
  // passed an independent check, and that question cannot be asked of a patch
  // that no longer exists. It is why the refusal column has never once fired on
  // this path: not bad luck, no evidence.
  //
  // Saving is not shipping. The tests were just run against this and they
  // failed; it goes where a human or a later check can pick it up, and the run
  // still reports that nothing was delivered.
  const unverified = savePatch(changedEntries, "sma-unverified.patch");
  log("\nTests still fail. Reverting every change...");
  revertAll();
  if (diff.changed) {
    const message = chainedFailureMessage({ packageName: PACKAGE, testCommand: TEST_COMMAND, diff });
    log("\n" + message);
    const s = stallDetector.inspect();
    writeDiagnosis({
      packageName: PACKAGE,
      targetRel: targetRel || ".",
      testCommand: TEST_COMMAND,
      reason: message,
      outcome: "inconclusive",
      baselineOutput: baseline.output,
      changelog: CHANGELOG,
      turns: s.toolTurns,
      edits: s.edits,
      discovered: s.keys,
    classification,
      agentNotes: agentText.length ? agentText[agentText.length - 1].trim() : "",
    });
  }
  // Three outcomes, not two. `changed` deliberately means "the original complaint
  // stopped and a new one took its place" - progress. But a run where the old
  // failure is still there AND new ones appeared is the opposite of progress, and
  // it was being reported in the same words as a run that changed nothing at all.
  // The change is reverted in every case; this only decides what is said.
  const alsoBroke = !diff.changed && (diff.appeared || []).length > 0;
  if (alsoBroke) {
    log("\nThe original failure is still there, and these are new:");
    for (const line of diff.appeared.slice(0, 5)) log("  - " + line);
  }
  fail(
    (diff.changed
      ? "Tests still fail, but not the same way they failed before. Everything was " +
          "reverted and no PR will be opened - the comparison above says what to try next."
      : alsoBroke
        ? "Tests still fail the way they did before, and the change added " +
          diff.appeared.length +
          " new failure(s) on top. Everything was reverted, no PR will be opened."
        : "Tests still fail after the fix. Everything was reverted, no PR will be opened.") +
      " " +
      patchNote(
        unverified.saved,
        unverified.path,
        "The change that did not hold",
        // Not the default sentence. The tests DID run against this one - that is
        // how we know to revert it.
        "It is not a fix: your tests were run against it and they failed."
      )
  );
}

// The tests pass. Do the same tests pass?
//
// This is the only check that can catch a green run that is green because the
// suite got smaller, and it is deliberately placed after the pass so that the
// happy path is where it applies. `ok: null` - a runner whose output we cannot
// count - does not block: refusing every project we cannot parse would be a
// large silent narrowing, and the guard's other rules still stand.
if (censusVerdict.ok === false) {
  log("\n[SAFETY] " + censusVerdict.why);
  revertAll();
  refuse(
    "Blocked and reverted, no PR will be opened. " + censusVerdict.why + " A change that " +
      "makes the suite pass by running less of it has not been proved by that suite - it has " +
      "been excused by it.",
    "census-shrunk"
  );
}
if (censusVerdict.ok === null && censusBefore.total == null) {
  log("\nnote: could not count this runner's tests, so the suite-size check did not run.");
}

/**
 * Re-run the project's own extra checks and refuse anything this change broke.
 * Returns the checks that were already failing before, which are worth reporting
 * and are nobody's fault here.
 */
function enforceExtraChecks(label) {
  if (!extraChecks.length) return [];
  log("\nRe-running the extra checks " + label + "...");
  const checksAfter = runExtraChecks(extraChecks, "after");
  const { broken, alreadyFailing } = extraCheckRegressions(checksBefore, checksAfter);
  if (broken.length) {
    log("\n[SAFETY] this change broke: " + broken.join(", "));
    revertAll();
    fail(
      "`" + broken.join("`, `") + "` passed before this change and fails after it. The tests " +
        "are not the only thing this project uses to say what correct means, so nothing was " +
        "delivered and everything was reverted. Set `extra-checks: off` to ignore them, or " +
        "name the exact commands you want checked."
    );
  }
  if (alreadyFailing.length) {
    log(
      "note: " + alreadyFailing.join(", ") + " was already failing before this run - " +
        "reported, not blamed on this change."
    );
  }
  return alreadyFailing;
}

const alreadyFailingChecks = enforceExtraChecks("against the baseline");

group("5. Independent review (a second agent, with no way to change anything)");

// Everything that produces no PR exits above this point, so a run that delivers
// nothing never pays for a review. Reviewing before the test re-run would be
// paying for opinions on diffs that are about to be reverted.
let reviewOutcomeResult = null;
let review = null;
let reviewMeta = { model: "", differentModel: false, spend: "", permissionDenials: 0 };
// Set once a tool-enabled pass has proved this model will not converge with tools.
// Scoped to the run, because there is nowhere to remember it between runs.
let toolsBurnedOut = false;

/**
 * One complete review pass over whatever is currently in the working tree.
 *
 * Takes the entries rather than reading the module-level ones because it runs
 * again after a repair, and a verdict published about a diff that has since
 * changed would be a lie in the pull request.
 */
async function runReviewPass(entries) {
  const changedEntries = entries;
  const changed = entries.map((e) => e.path);
  let diffText = "";
  let diffError = null;
  try {
    diffText = changed.length ? git(["diff", "--unified=6", "--"].concat(changed)) : "";
  } catch (err) {
    // Must never become an empty diff: a reviewer handed nothing can still answer
    // "not refuted" with high confidence, having seen not one line of the change.
    diffError = "the diff could not be read: " + (err?.message ?? err);
  }
  // An untracked file has no diff; show it as all-additions so it is not invisible.
  for (const entry of changedEntries) {
    if (!entry.status.includes("?")) continue;
    try {
      const body = fs.readFileSync(path.join(repoRoot, entry.path), "utf8");
      diffText += untrackedHunk(entry.path, body);
    } catch {}
  }

  // A change exists but nothing came out of the diff: reviewing that would be
  // reviewing a blank page and calling the result a verdict.
  if (!diffError && changed.length > 0 && !diffText.trim()) {
    diffError = "the diff came back empty even though " + changed.length + " file(s) changed";
  }

  const gate = shouldReview({
    mode: VERIFY_MODE,
    changedCount: changed.length,
    // Bytes, not UTF-16 code units: a diff full of non-ASCII would otherwise slip
    // past a byte-named threshold at up to three times the size it claims to allow.
    diffBytes: Buffer.byteLength(diffText, "utf8"),
    maxDiffBytes: VERIFY_MAX_DIFF_BYTES,
  });

  if (diffError) {
    log("cannot review: " + diffError);
    reviewOutcomeResult = reviewOutcome({ callError: diffError, mode: VERIFY_MODE });
  } else if (!gate.run) {
    log("skipped: " + gate.skipReason);
    reviewOutcomeResult = reviewOutcome({ skipReason: gate.skipReason, mode: VERIFY_MODE });
  } else {
    let changelogText = "";
    if (CHANGELOG && !/^https?:\/\//i.test(CHANGELOG)) {
      try {
        changelogText = fs.readFileSync(path.resolve(TARGET_DIR, CHANGELOG), "utf8");
      } catch {}
    }

    const evidence = buildReviewEvidence({
      packageName: PACKAGE,
      targetRel: targetRel || ".",
      testCommand: TEST_COMMAND,
      changedEntries,
      diffText,
      changelogText,
      changelogUrl: /^https?:\/\//i.test(CHANGELOG) ? CHANGELOG : "",
      baselineTail: baseline.output.slice(-2000),
      afterTail: after.output.slice(-2000),
      maxDiffBytes: VERIFY_MAX_DIFF_BYTES,
    });

    // Measured, not just requested: "the reviewer cannot change anything" is a
    // public claim, and the tool restrictions below are requests to an SDK we
    // depend on by caret range. This is the check that does not rely on it.
    const treeBefore = JSON.stringify(workingTreeEntries());

    const reviewDeadline = deadline("reviewer");
    // The reviewer is the call most likely to be pointed at a different
    // provider, which makes it the one whose failures are least like ours - and
    // it was just as silent.
    const reviewStderr = createStderrSink({ label: "review", write: (line) => log(line) });
    const reviewOpts = {
      stderr: reviewStderr.onData,
      cwd: TARGET_DIR,
      systemPrompt: REVIEW_SYSTEM_PROMPT,
      // The repository under review is third-party: its CLAUDE.md is, in the threat
      // model, attacker-controlled. Never load it.
      settingSources: [],
      tools: REVIEW_TOOLS,
      allowedTools: REVIEW_TOOLS,
      permissionMode: "dontAsk",
      maxTurns: VERIFY_MAX_TURNS,
      outputFormat: { type: "json_schema", schema: REVIEW_SCHEMA },
      abortController: reviewDeadline.abortController,
    };
    if (VERIFY_MODEL || VERIFY_BASE_URL || VERIFY_AUTH_TOKEN) {
      // Spread process.env: a partial object here wipes PATH.
      const reviewEnv = { ...process.env };
      if (VERIFY_MODEL) {
        reviewOpts.model = VERIFY_MODEL;
        // The composite action pins ANTHROPIC_MODEL and all three DEFAULT_* vars to
        // the fixer's model. Passing options.model alone gets silently remapped, and
        // then the PR claims "a different model" when none ran.
        reviewEnv.ANTHROPIC_MODEL = VERIFY_MODEL;
        reviewEnv.ANTHROPIC_DEFAULT_OPUS_MODEL = VERIFY_MODEL;
        reviewEnv.ANTHROPIC_DEFAULT_SONNET_MODEL = VERIFY_MODEL;
        reviewEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL = VERIFY_MODEL;
        reviewEnv.CLAUDE_CODE_SUBAGENT_MODEL = VERIFY_MODEL;
      }
      // A second endpoint, for the case the independence claim is actually about:
      // a different provider entirely, not just a different name on the same one.
      if (VERIFY_BASE_URL) reviewEnv.ANTHROPIC_BASE_URL = VERIFY_BASE_URL;
      if (VERIFY_AUTH_TOKEN) {
        reviewEnv.ANTHROPIC_AUTH_TOKEN = VERIFY_AUTH_TOKEN;
        // Otherwise the fixer's key is still in the environment and a provider that
        // prefers x-api-key would quietly authenticate as the wrong account.
        delete reviewEnv.ANTHROPIC_API_KEY;
      }
      reviewOpts.env = reviewEnv;
    }

    let callError = null;
    let reviewResult = null;
    let reviewText = [];
    const plan = reviewPassPlan({ setting: VERIFY_TOOLS, toolsBurnedOut });
    if (plan.note) log("review: " + plan.note);
    // Whether the reviewer could actually open the repository to check its claims.
    let sawRepository = plan.useTools;

    async function runReviewer(options, promptText) {
      const text = [];
      let res = null;
      for await (const message of query({ prompt: promptText, options })) {
        reviewDeadline.touch();
        if (message.type === "assistant") {
          for (const block of message.message.content) {
            if (block.type === "text" && block.text.trim()) text.push(block.text);
            else if (block.type === "tool_use") log("[review] " + block.name);
          }
        } else if (message.type === "result") {
          res = message;
        }
      }
      return { res, text };
    }

    const noTools = { ...reviewOpts, tools: [], allowedTools: [] };
    try {
      ({ res: reviewResult, text: reviewText } = plan.useTools
        ? await runReviewer(reviewOpts, evidence.text)
        : await runReviewer(noTools, evidence.text + REVIEW_NO_TOOLS_NOTE));
      // Reading the repository is the reviewer's highest-value move - grepping for
      // call sites the migration missed is the one check the mechanical guard cannot
      // do. But a model that investigates until its turns run out answers nothing at
      // all, which is worse than a shallower answer. Measured on GLM: 12 turns, 12
      // tool calls, no verdict; the same review with no tools converged in 4.
      // So: try it with eyes, and if it never lands, ask again without them.
      if (plan.allowFallback && reviewResult?.subtype === "error_max_turns") {
        log("the reviewer used every turn investigating and never answered - asking again without tools.");
        // Remembered for the rest of the run. A run that reviews twice - the repair
        // path does - would otherwise burn the full turn budget discovering the same
        // thing a second time, which is the whole of the waste this measures.
        toolsBurnedOut = true;
        const { res, text } = await runReviewer(noTools, evidence.text + REVIEW_NO_TOOLS_NOTE);
        if (res?.subtype === "success") {
          reviewResult = res;
          reviewText = text;
          sawRepository = false;
        }
      }
    } catch (err) {
      reviewStderr.flush();
      const said = stderrNote(reviewStderr);
      callError = reviewDeadline.expired()
        ? reviewDeadline.reason()
        : "the reviewer crashed: " + (err?.message ?? err) + (said ? ". " + said : "");
    } finally {
      reviewStderr.flush();
      reviewDeadline.done();
    }

    const tamper = treeBefore !== JSON.stringify(workingTreeEntries());
    if (tamper) {
      log("\n[SAFETY] The reviewer changed the working tree. It is not allowed to.");
      revertAll();
      fail(
        "The independent reviewer modified the working tree. It runs with no write tools, so " +
          "this should be impossible - everything was reverted and no PR will be opened. " +
          "Set `verify-mode: off` to run without it until this is understood."
      );
    }

    if (!callError && reviewResult && reviewResult.subtype !== "success") {
      callError = reviewResult.subtype;
    }
    const parsed = callError
      ? { ok: false, reason: callError }
      : parseReview(reviewResult?.structured_output ?? reviewText.join("\n"));
    if (parsed.ok) review = parsed.review;
    else callError = callError || parsed.reason;

    const reviewModels = Object.keys(reviewResult?.modelUsage ?? {});
    reviewMeta = {
      model: reviewModels.join(", ") || VERIFY_MODEL || "unknown",
      // Only claim a different model when the telemetry says one actually ran.
      differentModel: reviewModels.length > 0 && reviewModels.every((m) => !modelsUsed.includes(m)),
      // A separate claim, and a stronger one. Unlike the model, this is not visible in
      // telemetry - it is true because the run was configured to send the review
      // somewhere else, which is a fact about this process, not about the answer.
      differentProvider: !!VERIFY_BASE_URL && VERIFY_BASE_URL !== baseUrl,
      spend: spend({
        modelUsage: reviewResult?.modelUsage,
        costUsd: reviewResult?.total_cost_usd,
        customEndpoint: usingCustomEndpoint || !!VERIFY_BASE_URL,
      }),
      permissionDenials: (reviewResult?.permission_denials ?? []).length,
    };
    if (reviewMeta.permissionDenials) {
      log("note: the reviewer tried " + reviewMeta.permissionDenials + " tool call(s) it is not allowed.");
    }

    reviewOutcomeResult = reviewOutcome({
      review,
      callError,
      diffTruncated: evidence.truncated,
      sawRepository,
      minConfidence: VERIFY_MIN_CONFIDENCE,
      mode: VERIFY_MODE,
    });
    log("-> review: " + reviewOutcomeResult.status + " (" + reviewOutcomeResult.tableCell + ")");
  }
}

await runReviewPass(changedEntries);

// One repair turn, opt-in, and only for concerns the fixer can actually act on.
//
// Most of what a reviewer raises is "I could not verify this", not "this is wrong" -
// measured on real runs. Feeding those back invites the fixer to change working code
// to quiet an unfalsifiable worry, and every extra change is extra risk. So only
// concerns tied to a check that actually found something, and naming a file in the
// diff, are worth a second turn.
//
// If the repair happens, the guard and the tests run again over the new state, and
// the review runs again too: publishing the first verdict next to a diff that has
// since changed would be exactly the kind of dishonesty this step exists to prevent.
if (VERIFY_REPAIR && review) {
  const actionable = actionableConcerns(review);
  if (reviewOutcomeResult.status === "concerns" && actionable.length > 0) {
    group("5b. One repair turn (the reviewer found something the fixer can act on)");
    for (const c of actionable) log("  - " + c.file + ": " + c.claim.slice(0, 120));

    let repairFailed = null;
    const repairDeadline = deadline("repair turn");
    const repairStderr = createStderrSink({ label: "repair", write: (line) => log(line) });
    try {
      for await (const message of query({
        prompt: buildRepairPrompt({ packageName: PACKAGE, testCommand: TEST_COMMAND, concerns: actionable }),
        options: {
          cwd: TARGET_DIR,
          allowedTools: ["Read", "Edit", "Write", "Bash", "Glob", "Grep"],
          permissionMode: "bypassPermissions",
          abortController: repairDeadline.abortController,
          maxTurns: VERIFY_REPAIR_TURNS,
          stderr: repairStderr.onData,
        },
      })) {
        repairDeadline.touch();
        if (message.type === "assistant") {
          for (const block of message.message.content) {
            if (block.type === "text" && block.text.trim()) log("\n[repair] " + block.text);
            else if (block.type === "tool_use") log("[repair tool] " + block.name);
          }
        }
      }
    } catch (err) {
      repairStderr.flush();
      const said = stderrNote(repairStderr);
      repairFailed = repairDeadline.expired()
        ? repairDeadline.reason()
        : "the repair turn crashed: " + (err?.message ?? err) + (said ? ". " + said : "");
    } finally {
      repairStderr.flush();
      repairDeadline.done();
    }

    if (repairFailed) {
      // Keep the verified fix that already passed everything; just say the extra
      // turn did not happen. Never let an optional improvement cost a good result.
      log(repairFailed + " - keeping the change that already passed.");
    } else {
      group("5c. Re-verify everything the repair could have broken");
      const afterRepair = agentChangedEntries();
      const repairViolations = afterRepair
        .map((e) => [e.path, violationReason(e)])
        .filter(([, reason]) => reason);
      const scripts = scriptsTamperReason(packageJsonBefore, readTargetPackageJson());

      if (repairViolations.length > 0 || scripts) {
        const why = scripts || repairViolations.map(([f, r]) => f + " - " + r).join("; ");
        log("[SAFETY] the repair turn broke a rule: " + why);
        revertPaths(afterRepair.map((e) => e.path));
        fail(
          "The repair turn produced a change that is not allowed (" + why + "). Everything " +
            "was reverted - including the fix that had already passed - because there is no " +
            "safe way to keep half of it. Re-run with `verify-repair: false` to take the " +
            "original fix without this step."
        );
      }

      const retest = runTests();
      log(retest.output.slice(-2000) || "(no output)");
      if (!retest.ok) {
        log("the repair turn broke the tests - reverting everything.");
        revertPaths(afterRepair.map((e) => e.path));
        fail(
          "The repair turn left `" + TEST_COMMAND + "` failing, so nothing was delivered. " +
            "Re-run with `verify-repair: false` to take the original fix, which passed."
        );
      }
      log("-> still green after the repair.");
      changedEntries = afterRepair;
      changed = afterRepair.map((e) => e.path);
      if (changed.length > 0) noteCandidate("unverified", changed.length);
      // The repair can break a type-check exactly as easily as the first turn can.
      enforceExtraChecks("after the repair");

      // Re-review, so the verdict in the pull request is about the diff in it.
      group("5d. Review the repaired change");
      await runReviewPass(afterRepair);
    }
  }
}

const reviewSection = renderReviewSection(reviewOutcomeResult, review, reviewMeta);

// Blocking is opt-in, and even then only on an outright refutation. `stop()` writes
// changed=false, so every already-published workflow gates on this with no YAML edit.
if (reviewOutcomeResult.blocking) {
  // This is the promise that makes blocking safe to turn on: a gate whose failure
  // mode is destroying work gets switched off by the first person it burns. So the
  // save is verified, and if it did not happen we say so instead of claiming it did
  // - the revert below is about to delete the only copy either way.
  //
  // Shared with the cap and stall paths now, which reverted the same way and saved
  // nothing at all. Going through savePatch also closes a hole this path had on
  // its own: `git diff` omits untracked files, so a patch could be verified as
  // written while missing the file the agent created.
  const rejected = savePatch(changedEntries, "sma-rejected.patch");
  const patchPath = rejected.path;
  const patchSaved = rejected.saved;
  const rejectedNote = patchSaved
    ? "The rejected change was saved to " + patchPath + " - recover it with `git apply`."
    : "WARNING: the rejected change could NOT be saved to " + patchPath +
      ", so it is lost with the revert below. Re-run with `verify-mode: warn` to get " +
      "the change back as a pull request.";
  writeStepSummary("### Patchery\n\nBlocked by the independent review.\n\n" + reviewSection);
  revertAll();
  stop(
    "blocked-by-review",
    "The independent review refuted this fix, and verify-mode is `block`, so nothing was " +
      "delivered. " + rejectedNote + " Set `verify-mode: warn` to get the pull request anyway " +
      "and judge for yourself.\n\n" + reviewOutcomeResult.headline,
    {
      tests_passed: "true",
      review_status: reviewOutcomeResult.status,
      review_label: reviewOutcomeResult.label,
      review_confidence: reviewConfidenceOutput(),
      // Empty when the save failed: a workflow that uploads this must not be handed
      // the path of a file that is not there.
      review_patch_file: patchSaved ? patchPath : "",
    }
  );
}

group("6. Summary");

let diffstat = "";
try {
  diffstat = git(["diff", "--stat", "--"].concat(changed));
} catch {}

const explanation = agentText.length ? agentText[agentText.length - 1].trim() : "(the agent wrote no summary)";

// Which rung of the proof ladder this run actually reached. Computed here from
// facts this process observed, never asked of a model - and it is allowed to be
// less flattering than the old header, which called a green-to-green run
// "verified" when nothing had ever exercised the change.
//
// Rung 2 is deliberately not claimed yet. It needs "this check was red before
// and is green now", and today we only record which checks were ALREADY red -
// a check in that list is tolerated afterwards, not re-tested for improvement.
// Passing the wrong signal here would hand rung 2 to every run that happened to
// start with a failing lint, which is the opposite of what it means. The
// missing piece is small and comes with the watcher work; until then a run that
// the suite never exercised lands on rung 3, which is the honest answer.
const proof = proofLevel({
  hasPatch: changed.length > 0,
  baselineRed: !baseline.ok,
  testsPassed: true,
});

const prBody = [
  "## Automated dependency fix: `" + PACKAGE + "`",
  "",
  proofBanner(proof),
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
  // The sibling of the row above, and it was missing. Both gates answer the same
  // question - was this green bought by running less of the suite - and a table
  // that reported one while staying silent about the other read as complete when
  // it was not. The cell is filled in every state, including the states where the
  // check could not be applied.
  "| Did the suite stay the same size | " + censusTableCell(censusBefore, censusAfter, censusVerdict) + " |",
  "| Independent review (second agent, no write access) | " + reviewOutcomeResult.tableCell + " |",
  extraChecks.length
    ? "| " + extraChecks.map((c) => "`" + c.name + "`").join(", ") +
      " (this project's own checks) | still passing" +
      (alreadyFailingChecks.length
        ? "; " + alreadyFailingChecks.join(", ") + " was already failing before this change"
        : "") + " |"
    : "",
  "",
  // A refutation or a concern belongs above the evidence, not buried under it.
  reviewOutcomeResult.placement === "top" ? reviewSection : "",
  "### Changed files",
  "",
  changed.map((f) => "- `" + f + "`").join("\n"),
  "",
  diffstat ? "```\n" + diffstat + "\n```" : "",
  "",
  reviewOutcomeResult.placement === "after-verification" ? reviewSection : "",
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
    " - spend: " +
    spend({
      modelUsage: result.modelUsage,
      costUsd: result.total_cost_usd,
      customEndpoint: usingCustomEndpoint,
    }),
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
noteCandidate("shipped", changed.length);
writeOutputs({
  outcome: "fixed",
  review_status: reviewOutcomeResult.status,
  review_label: reviewOutcomeResult.label,
  review_confidence: reviewConfidenceOutput(),
  changed: "true",
  tests_passed: "true",
  // The rung is an output, not just prose in the body, so a workflow can act on
  // it - open rung 3 as a draft, gate a merge on rung 1, count them in a table.
  proof_rung: String(proof.rung),
  proof_name: proof.name,
  proof_verified: proof.verified ? "true" : "false",
  draft: proof.draft ? "true" : "false",
  files: changed.join("\n"),
  pr_body_file: prBodyPath,
  summary: "Fixed " + PACKAGE + " (" + changed.length + " file(s)), tests pass.",
});

log("\nChanged files: " + changed.join(", "));
log("PR body written to: " + prBodyPath);
log("\nDone.");
