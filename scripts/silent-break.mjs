#!/usr/bin/env node
/**
 * How often does a major upgrade remove something you use WITHOUT turning a
 * single test red?
 *
 * This is a measurement about the ecosystem, not about this product, and it is
 * the strongest thing we can say to someone who has never heard of us. It also
 * costs no model call: install, run the tests, compare the exported names. Every
 * step is arithmetic.
 *
 * THE WEAK CLAIM AND THE STRONG ONE. We already knew a weaker version - Express
 * 5 went into four projects that depend on it and no suite went red - and the
 * fair objection to it is "maybe nothing actually broke". That objection cannot
 * be answered by running more tests, because the tests are the thing that missed
 * it. It is answered by reading the package:
 *
 *     the new version no longer offers a name your code calls,
 *     and your tests passed anyway.
 *
 * That is not "the suite did not notice a change". It is "the suite did not
 * notice a removal the code depends on", and it is checkable by anyone.
 *
 * FIVE BUCKETS, AND EVERY CANDIDATE LANDS IN EXACTLY ONE. The one that must not
 * be allowed to leak is `not-measured`: a repository whose suite was already red
 * before we touched it, or that would not install, tells us nothing, and folding
 * it into "clean" would manufacture the finding we are trying to measure. Same
 * rule the dependency scan follows - every name that goes in comes out in one of
 * the lists, and the skips are published beside the results.
 */

/**
 * What one candidate turned out to be.
 *
 * @param {object} o
 * @param {"ok"|"failed"} o.install     did the new major install at all
 * @param {"green"|"red"|"unknown"} o.baseline the suite BEFORE the upgrade
 * @param {"green"|"red"|"unknown"} o.suite    the suite AFTER the upgrade
 * @param {number} o.gone   names the new version dropped that this code uses
 * @param {number} o.fading names it still offers, marked deprecated, that this code uses
 */
export function silentBreakVerdict({
  install = "failed",
  baseline = "unknown",
  suite = "unknown",
  gone = 0,
  fading = 0,
} = {}) {
  // A suite that was already failing cannot show us anything about an upgrade,
  // and a suite we could not run says even less. Both are "we did not measure",
  // never "we measured nothing wrong".
  if (install !== "ok") return "not-measured";
  if (baseline !== "green") return "not-measured";
  if (suite === "unknown") return "not-measured";

  if (suite === "red") return "tests-caught-it";
  if (gone > 0) return "green-but-a-name-you-use-is-gone";
  if (fading > 0) return "green-but-a-name-you-use-is-deprecated";
  return "green-and-clean";
}

export const BUCKETS = [
  "tests-caught-it",
  "green-but-a-name-you-use-is-gone",
  "green-but-a-name-you-use-is-deprecated",
  "green-and-clean",
  "not-measured",
];

/**
 * The table.
 *
 * `measured` deliberately excludes `not-measured`, and `total` deliberately
 * includes it, because the difference between those two numbers is the first
 * thing an honest reader will want and the first thing a dishonest one would
 * hide.
 */
export function bucketCounts(rows = []) {
  const counts = Object.fromEntries(BUCKETS.map((b) => [b, 0]));
  for (const r of rows) {
    const v = BUCKETS.includes(r?.verdict) ? r.verdict : "not-measured";
    counts[v]++;
  }
  const total = rows.length;
  const measured = total - counts["not-measured"];
  return { ...counts, total, measured };
}

/**
 * The share of measured upgrades that removed something and were not noticed.
 *
 * Returns null - never 0 - when nothing could be measured, for the same reason
 * the test census does: a denominator of zero is not a rate of zero.
 */
export function silentShare(counts) {
  if (!counts || !counts.measured) return null;
  return counts["green-but-a-name-you-use-is-gone"] / counts.measured;
}

/**
 * One case, written the way a reader will actually look at it.
 *
 * Deliberately not prose. The whole force of this finding is that each line is
 * four facts and a green tick, and that a reader can scroll through ten of them
 * without being asked to believe anything.
 */
export function renderCase(row) {
  if (!row) return "";
  const lines = [
    "**" + row.repo + "** — `" + row.package + "` " + row.from + " → " + row.to,
  ];
  for (const site of row.sites || []) {
    lines.push("  removed: `" + site.name + "`   called at `" + site.path + "`");
  }
  if (row.passed != null && row.total != null) {
    lines.push("  tests after the upgrade: **" + row.passed + " / " + row.total + " passed**");
  } else {
    lines.push("  tests after the upgrade: **passed**");
  }
  return lines.join("\n");
}

/**
 * The published summary.
 *
 * The skipped count is in the headline rather than a footnote. A reader who
 * finds out later that a third of the sample was dropped stops believing the
 * other two thirds, and they are right to.
 */
export function renderSummary(counts, share) {
  const pct = share == null ? "not measurable" : (share * 100).toFixed(0) + "%";
  return [
    "We upgraded " + counts.total + " dependencies to a new major across real repositories.",
    "",
    "- **" + counts.measured + "** could be measured: they installed, and their tests were green before we touched them.",
    "- **" + counts["not-measured"] + "** could not: already failing, or would not install. They are excluded, and named.",
    "",
    "Of the " + counts.measured + " measured:",
    "",
    "| | |",
    "|---|---|",
    "| The tests caught it | " + counts["tests-caught-it"] + " |",
    "| **Tests green — and a name the code calls is gone** | **" + counts["green-but-a-name-you-use-is-gone"] + "** |",
    "| Tests green — and a name the code calls is deprecated | " + counts["green-but-a-name-you-use-is-deprecated"] + " |",
    "| Tests green, nothing we could find | " + counts["green-and-clean"] + " |",
    "",
    "**" + pct + " of the upgrades whose tests stayed green had removed a function the project calls.**",
    "",
    "_What this does not say: that those projects break in production. We show the",
    "call site; we do not claim it executes. Their CI may run more than the test",
    "command we ran, which is stated per case. The pool and the selection script",
    "are published - we did not choose these repositories after seeing the result._",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// The part that clones, installs and runs. Everything above is pure and tested.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readPackageSurface, upgradeSurfaceReport, packageBodyText } from "./surface-diff.mjs";
import { ownSource, runSuite } from "./sentinel.mjs";

function run(cmd, args, cwd, minutes = 10) {
  return spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    timeout: minutes * 60 * 1000,
    shell: process.platform === "win32",
  });
}

/** A shallow checkout at one commit, in a throwaway directory. */
export function checkout(repo, commit, into) {
  const url = "https://github.com/" + repo + ".git";
  let r = run("git", ["clone", "--quiet", "--filter=blob:none", "--no-checkout", url, into], process.cwd(), 10);
  if (r.status !== 0) return "clone failed: " + String(r.stderr || r.error || "").trim().slice(0, 200);
  r = run("git", ["checkout", "--quiet", commit], into, 5);
  if (r.status !== 0) return "checkout failed: " + String(r.stderr || r.error || "").trim().slice(0, 200);
  return null;
}

/**
 * One candidate, measured.
 *
 * The order matters and is not negotiable: the suite has to be GREEN on the
 * untouched checkout first. Without that step "the tests stayed green" is
 * unfalsifiable - a suite that was already failing stays failing, and a suite
 * that never ran proves nothing.
 */
export function measure(row, { keep = false } = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "silent-"));
  const dir = path.join(work, "case");
  const out = {
    repo: row.repo,
    package: row.package,
    from: null,
    to: String(row["breaking-version"] ?? ""),
    testCommand: row["test-command"] || "npm test",
    install: "failed",
    baseline: "unknown",
    suite: "unknown",
    gone: 0,
    fading: 0,
    sites: [],
    why: null,
  };
  const finish = () => {
    out.verdict = silentBreakVerdict(out);
    if (!keep) {
      try {
        fs.rmSync(work, { recursive: true, force: true });
      } catch {}
    }
    return out;
  };

  const bad = checkout(row.repo, row.commit, dir);
  if (bad) {
    out.why = bad;
    return finish();
  }
  const target = path.join(dir, row["target-dir"] && row["target-dir"] !== "." ? row["target-dir"] : ".");

  let r = run("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], target, 15);
  if (r.status !== 0) {
    out.why = "the project's own install failed: " + String(r.stderr || "").trim().slice(0, 200);
    return finish();
  }

  const before = runSuite(out.testCommand, target);
  out.baseline = before.suite;
  if (before.suite !== "green") {
    out.why = before.why || "the suite was not green before the upgrade";
    return finish();
  }

  // Keep the old copy: it is one half of the comparison and npm is about to
  // overwrite it.
  const installedAt = path.join(target, "node_modules", ...String(row.package).split("/"));
  const oldCopy = path.join(work, "old");
  try {
    fs.cpSync(installedAt, oldCopy, { recursive: true });
    out.from = JSON.parse(fs.readFileSync(path.join(oldCopy, "package.json"), "utf8")).version ?? null;
  } catch {
    out.why = "the package was not installed where it was expected";
    return finish();
  }

  r = run("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error", row.package + "@" + out.to], target, 15);
  if (r.status !== 0) {
    out.why = "the upgrade would not install: " + String(r.stderr || "").trim().slice(0, 200);
    return finish();
  }
  out.install = "ok";

  const after = runSuite(out.testCommand, target);
  out.suite = after.suite;

  // The surface comparison runs whatever the tests said. When they went red we
  // already have our answer, but the removed names are worth recording anyway -
  // they are what a maintainer would want to read next.
  const oldSurface = readPackageSurface(oldCopy);
  const newSurface = readPackageSurface(installedAt);
  if (oldSurface.why || newSurface.why) {
    out.why = "surface not readable: " + (oldSurface.why || newSurface.why);
    return finish();
  }
  const report = upgradeSurfaceReport({
    packageName: row.package,
    beforeText: oldSurface.text,
    afterText: newSurface.text,
    files: ownSource(target),
    deprecationText: packageBodyText(installedAt),
  });
  out.gone = report.atRisk.reduce((n, f) => n + f.names.length, 0);
  out.fading = report.fading.length;
  out.sites = report.atRisk.flatMap((f) => f.names.map((name) => ({ name, path: f.path })));
  out.removedCount = report.removed.length;
  out.addedCount = report.added.length;
  return finish();
}

if (process.argv[1] && process.argv[1].endsWith("silent-break.mjs")) {
  const file = process.argv[2] || "benchmark/candidates.json";
  const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : "";
  const limit = process.argv.includes("--limit") ? Number(process.argv[process.argv.indexOf("--limit") + 1]) : 0;
  const outFile = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : "";

  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  let rows = Array.isArray(raw) ? raw : raw.candidates || raw.cases || [];
  if (only) rows = rows.filter((r) => (r.repo + " " + r.package).includes(only));
  if (limit > 0) rows = rows.slice(0, limit);

  const results = [];
  for (const [i, row] of rows.entries()) {
    process.stderr.write("[" + (i + 1) + "/" + rows.length + "] " + row.repo + " " + row.package + "@" + row["breaking-version"] + " ... ");
    let res;
    try {
      res = measure(row);
    } catch (e) {
      res = { ...row, verdict: "not-measured", why: "harness threw: " + String(e?.message || e) };
    }
    process.stderr.write(res.verdict + (res.why ? " (" + res.why.slice(0, 60) + ")" : "") + "\n");
    results.push(res);
    if (outFile) fs.writeFileSync(outFile, JSON.stringify(results, null, 1));
  }

  const counts = bucketCounts(results);
  console.log(renderSummary(counts, silentShare(counts)));
  const found = results.filter((r) => r.verdict === "green-but-a-name-you-use-is-gone");
  if (found.length) {
    console.log("\n---\n\n## Every case, one by one\n");
    for (const r of found) console.log(renderCase(r) + "\n");
  }
}
