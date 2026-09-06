#!/usr/bin/env node
/**
 * What does `verify-min-confidence` actually buy?
 *
 * The action ships that input at 60. Nobody measured 60. It is a round number, and
 * a round number sitting on a safety path is a claim nobody has checked - so this
 * checks it.
 *
 * The method: take a corpus of changes whose correctness is already known, run the
 * REAL reviewer over each one - the same prompt, the same schema, the same evidence
 * builder the action uses - and count what every threshold from 0 to 100 would have
 * done to the verdicts that came back. `confidenceThresholdReport` in guard.mjs does
 * the counting and is unit-tested offline; this script's only job is to produce
 * honest samples to feed it.
 *
 * Every case in the corpus passes the tests. That is deliberate: a wrong migration
 * that fails the tests is already caught by the test re-run, for free, before a
 * reviewer is paid. The population a confidence threshold is applied to is exactly
 * the one here - changes that pass, some right and some wrong.
 *
 *   node scripts/calibrate.mjs                 # every case, reviewer without tools
 *   node scripts/calibrate.mjs --tools         # give the reviewer the repository
 *   node scripts/calibrate.mjs --only good-01  # one case, for debugging the harness
 *   node scripts/calibrate.mjs --out r.json    # where to write the raw samples
 *
 * Needs ANTHROPIC_AUTH_TOKEN (and honours ANTHROPIC_BASE_URL / ANTHROPIC_MODEL).
 * It costs one review per case: with 23 cases, roughly what 23 runs of the action's
 * review step cost. Nothing is written outside the temp directory and --out.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import {
  buildReviewEvidence,
  parseReview,
  confidenceThresholdReport,
  tokenTotals,
  redactSecrets,
  REVIEW_SCHEMA,
  REVIEW_SYSTEM_PROMPT,
  REVIEW_NO_TOOLS_NOTE,
} from "./guard.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const FIXTURE = path.join(ROOT, "test-fixture");
// Deliberately NOT inside test-fixture/. The demo run points the agent at that
// directory, and a folder of correct migrations sitting next to the broken file is
// an answer key: the agent would copy one and the demo would prove nothing.
const CORPUS_DIR = path.join(ROOT, "calibration");

const argv = process.argv.slice(2);
const flag = (name) => argv.includes("--" + name);
const value = (name, fallback) => {
  const i = argv.indexOf("--" + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const USE_TOOLS = flag("tools");
// Everything except the model call: builds the repository, runs the tests, produces
// the diff and assembles the evidence, then stops. This is how the harness itself
// gets checked - and how you see exactly what the reviewer would be shown - without
// paying for a single review.
const DRY_RUN = flag("dry-run");
const ONLY = value("only", "");
const OUT = path.resolve(value("out", path.join(CORPUS_DIR, "results.json")));
const MAX_TURNS = Number(value("max-turns", "12")) || 12;

if (!DRY_RUN && !process.env.ANTHROPIC_AUTH_TOKEN && !process.env.ANTHROPIC_API_KEY) {
  console.error(
    "No ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY. This script pays for real reviews.\n" +
      "Use --dry-run to exercise everything but the model call."
  );
  process.exit(1);
}

// Imported only when a model will actually be called, so --dry-run needs no SDK
// installed. That is what lets CI run this harness on every push.
const query = DRY_RUN ? null : (await import("@anthropic-ai/claude-agent-sdk")).query;

const corpus = JSON.parse(fs.readFileSync(path.join(CORPUS_DIR, "corpus.json"), "utf8"));
const cases = corpus.cases.filter((c) => !ONLY || c.file.includes(ONLY));
if (!cases.length) {
  console.error("No cases matched --only " + ONLY);
  process.exit(1);
}

// ------------------------------------------------------------------ scaffold

// A real git repository, so the diff is produced the same way the action produces
// it and so --tools has something to Read and Grep. Built once; each case is a
// commit-and-revert on top of it.
const work = fs.mkdtempSync(path.join(os.tmpdir(), "patchery-calibrate-"));
const git = (args, opts = {}) =>
  execFileSync("git", args, { cwd: work, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });

// Only the fixture. The corpus lives outside it precisely so that neither a
// reviewer with --tools nor the demo agent can read the answer key.
fs.cpSync(FIXTURE, work, { recursive: true });
// The file under review is normalised to LF before the baseline commit, and every
// case is written the same way below. Otherwise a Windows checkout hands the
// reviewer a whole-file rewrite instead of the four lines that changed, and the
// measurement would be of a different diff on every platform.
const writeLf = (dest, text) => fs.writeFileSync(dest, text.replace(/\r\n/g, "\n"), "utf8");
const targetPath = path.join(work, corpus.target);
writeLf(targetPath, fs.readFileSync(targetPath, "utf8"));

git(["init", "-q"]);
git(["config", "user.email", "calibrate@localhost"]);
git(["config", "user.name", "calibrate"]);
// The corpus files are LF. Without this, git on Windows warns about a line-ending
// rewrite for every one of them and buries the actual output.
git(["config", "core.autocrlf", "false"]);
git(["add", "-A"]);
git(["commit", "-q", "-m", "fixture, broken as committed"]);

const runTests = () => {
  const r = spawnSync(corpus.testCommand, {
    cwd: work,
    shell: true,
    encoding: "utf8",
    env: { ...process.env, CI: "true" },
    timeout: 5 * 60 * 1000,
  });
  return { ok: r.status === 0, output: ((r.stdout ?? "") + (r.stderr ?? "")).trim() };
};

const baseline = runTests();
if (baseline.ok) {
  console.error("The fixture passes. The corpus assumes it is broken - nothing to migrate.");
  process.exit(1);
}

let changelogText = "";
try {
  changelogText = fs.readFileSync(path.join(work, corpus.changelog), "utf8");
} catch {}

// ------------------------------------------------------------------- reviews

const REVIEW_TOOLS = USE_TOOLS ? ["Read", "Grep", "Glob"] : [];

async function reviewOne(kase) {
  const source = path.join(CORPUS_DIR, "cases", kase.file);
  writeLf(targetPath, fs.readFileSync(source, "utf8"));

  const after = runTests();
  // A case that does not pass is not in the population this threshold applies to,
  // and silently reviewing it would put a sample in the report that means something
  // else. Say so and drop it.
  if (!after.ok) {
    git(["checkout", "-q", "--", corpus.target]);
    return { id: kase.file, label: kase.label, error: "the case does not pass the tests" };
  }

  const diffText = git(["diff", "--unified=6", "--", corpus.target]);
  const evidence = buildReviewEvidence({
    packageName: corpus.package,
    targetRel: ".",
    testCommand: corpus.testCommand,
    changedEntries: [{ path: corpus.target, status: " M" }],
    diffText,
    changelogText,
    baselineTail: baseline.output.slice(-2000),
    afterTail: after.output.slice(-2000),
    maxDiffBytes: 60000,
  });

  if (DRY_RUN) {
    git(["checkout", "-q", "--", corpus.target]);
    return {
      id: kase.file,
      label: kase.label,
      dryRun: true,
      diffLines: diffText.split("\n").length,
      evidenceBytes: Buffer.byteLength(evidence.text, "utf8"),
      truncated: evidence.truncated,
    };
  }

  const options = {
    cwd: work,
    systemPrompt: REVIEW_SYSTEM_PROMPT,
    settingSources: [],
    tools: REVIEW_TOOLS,
    allowedTools: REVIEW_TOOLS,
    permissionMode: "dontAsk",
    maxTurns: MAX_TURNS,
    outputFormat: { type: "json_schema", schema: REVIEW_SCHEMA },
  };

  const text = [];
  let result = null;
  let error = null;
  try {
    const prompt = USE_TOOLS ? evidence.text : evidence.text + REVIEW_NO_TOOLS_NOTE;
    for await (const message of query({ prompt, options })) {
      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "text" && block.text.trim()) text.push(block.text);
        }
      } else if (message.type === "result") {
        result = message;
      }
    }
  } catch (err) {
    error = String(err?.message ?? err);
  }

  git(["checkout", "-q", "--", corpus.target]);

  if (!error && result && result.subtype !== "success") error = result.subtype;
  if (error) return { id: kase.file, label: kase.label, error };

  const parsed = parseReview(result?.structured_output ?? text.join("\n"));
  if (!parsed.ok) return { id: kase.file, label: kase.label, error: parsed.reason };

  return {
    id: kase.file,
    label: kase.label,
    verdict: parsed.review.verdict,
    confidence: parsed.review.confidence,
    concerns: parsed.review.concerns.length,
    costUsd: result?.total_cost_usd ?? 0,
    tokens: tokenTotals(result?.modelUsage).total,
    // From telemetry, not from what we asked for. A confidence threshold is a
    // per-model number, so a results file that names the requested model rather
    // than the one that answered would be a measurement of the wrong thing - and
    // ANTHROPIC_MODEL does get remapped when the DEFAULT_* tiers disagree.
    modelUsed: Object.keys(result?.modelUsage ?? {}).join(", "),
  };
}

// ---------------------------------------------------------------------- main

console.log(
  (DRY_RUN ? "Dry run over " : "Reviewing ") +
    cases.length +
    " case(s), tools " +
    (USE_TOOLS ? "on" : "off") +
    ".\n"
);

const samples = [];
for (const kase of cases) {
  const sample = await reviewOne(kase);
  samples.push(sample);
  const detail = sample.error
    ? "ERROR " + sample.error
    : sample.dryRun
      ? "dry run - " + sample.diffLines + " diff lines, " + sample.evidenceBytes + " bytes of evidence"
      : sample.verdict + " @ " + sample.confidence +
        "  " + (sample.tokens || 0).toLocaleString("en-US") + " tok";
  console.log("  " + sample.label.padEnd(5) + " " + sample.id.padEnd(34) + " " + detail);
}

fs.rmSync(work, { recursive: true, force: true });

if (DRY_RUN) {
  const broken = samples.filter((s) => s.error);
  console.log(
    "\nHarness ran. " + (samples.length - broken.length) + " case(s) built a diff and passed " +
      "the tests" + (broken.length ? ", " + broken.length + " did not" : "") + "."
  );
  for (const s of broken) console.log("  " + s.id + ": " + s.error);
  process.exit(broken.length ? 1 : 0);
}

// The endpoint is recorded as a hostname, never the full URL. Which provider a
// number was measured on is the point of recording it; a path or query string is
// not, and this file is uploaded as a CI artifact, where GitHub's secret masking
// does not reach. The token is redacted on top of that, belt and braces.
let endpointHost = "(Anthropic default)";
try {
  if (process.env.ANTHROPIC_BASE_URL) endpointHost = new URL(process.env.ANTHROPIC_BASE_URL).host;
} catch {
  endpointHost = "(unparseable)";
}

const usable = samples.filter((s) => !s.error);
const report = confidenceThresholdReport(usable);
const tokens = samples.reduce((n, s) => n + (s.tokens || 0), 0);
const anthropicList = samples.reduce((n, s) => n + (s.costUsd || 0), 0);

console.log("\n" + "=".repeat(72));
console.log("Before any threshold - how often the reviewer was simply right:");
console.log("  bad diffs refuted        : " + report.caught + " / " + (report.caught + report.missed));
console.log("  good diffs left alone    : " + report.cleared + " / " + (report.cleared + report.doubted));
const g = report.confidence.good;
const b = report.confidence.bad;
if (g) console.log("  confidence on good       : min " + g.min + "  median " + g.median + "  max " + g.max);
if (b) console.log("  confidence on bad        : min " + b.min + "  median " + b.median + "  max " + b.max);

console.log("\nWhat each threshold would do (helped - falseAlarm - defused = net):");
console.log("  thr | helped | falseAlarm | defused |  net");
for (const row of report.rows) {
  if (!row.helped && !row.falseAlarms && !row.defused && row.threshold !== 0) continue;
  console.log(
    "  " + String(row.threshold).padStart(3) +
    " | " + String(row.helped).padStart(6) +
    " | " + String(row.falseAlarms).padStart(10) +
    " | " + String(row.defused).padStart(7) +
    " | " + String(row.net).padStart(4)
  );
}

console.log("\nRecommended verify-min-confidence: " + report.recommended + " (net " + report.net + ")");
if (report.net <= 0) {
  console.log(
    "A net of 0 or less means the reviewer's confidence number separated nothing on\n" +
    "this corpus. That is a result, not a failure: the honest setting is then 0, and\n" +
    "the verdict itself carries whatever signal there is."
  );
}
// Tokens, not dollars. The SDK prices with Anthropic's own table whatever endpoint
// served the request: this harness reported $5.8532 for a 23-case run while the
// provider's console showed $0.03 for the same 301,555 tokens - a factor of 195.
// Tokens are true either way, and the provider's rate card turns them into money.
console.log("\nSamples: " + usable.length + " usable, " + (samples.length - usable.length) +
  " errored. Tokens: " + tokens.toLocaleString("en-US") +
  " (Anthropic's list price for these would be $" + anthropicList.toFixed(4) +
  "; your provider charges its own rate).");

// Named loudly, because the number above means nothing without it: a threshold
// calibrated on one model does not transfer to another, not even to a smaller
// variant of the same family.
const modelsSeen = [...new Set(usable.map((s) => s.modelUsed).filter(Boolean))];
console.log(
  "Measured on: " + (modelsSeen.join(", ") || process.env.ANTHROPIC_MODEL || "(unknown)") +
  " via " + endpointHost + ". This recommendation applies to that model and no other."
);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(
  OUT,
  redactSecrets(
    JSON.stringify(
      {
        model: process.env.ANTHROPIC_MODEL || "(default)",
        endpoint: endpointHost,
        tools: USE_TOOLS,
        maxTurns: MAX_TURNS,
        samples,
        report,
      },
      null,
      2
    ),
    [process.env.ANTHROPIC_AUTH_TOKEN, process.env.ANTHROPIC_API_KEY].filter(Boolean)
  ) + "\n",
  "utf8"
);
console.log("Raw samples written to: " + OUT);
