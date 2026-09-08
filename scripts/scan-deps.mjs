#!/usr/bin/env node
/**
 * The upgrades a repository has not taken yet.
 *
 * find-bumps.mjs answers the same question from the outside: it reads someone
 * else's package.json over the GitHub API so we can build a benchmark pool. This
 * answers it from the inside, for the repository the action is installed in, and
 * that difference is the whole point of a sentinel - a customer's own checkout is
 * already on disk, already installable, and already green, which is exactly the
 * half of the measurement we lose when we scan a stranger's repository.
 *
 * What it does NOT do is decide whether the upgrade breaks anything. That is not
 * knowable from a version number and this file refuses to guess it: every
 * candidate here is "a new major exists", and only running the tests turns that
 * into "and it breaks you". Keeping the two apart is the same rule the benchmark
 * has always had - the pool is candidates, the verdict is measured.
 *
 * Usage:
 *   node scripts/scan-deps.mjs                      # ./package.json
 *   node scripts/scan-deps.mjs path/to/package.json
 *   node scripts/scan-deps.mjs --json               # machine-readable
 */

import { rangeMajor, isOutOfScope } from "./find-bumps.mjs";

/**
 * Which dependencies have a newer major than the one this project is on.
 *
 * Pure: the caller supplies what npm said, so the whole decision is testable
 * without a network. `latestByName` maps a package name to its current latest
 * version string, or to null when the registry could not be asked.
 *
 * Returns candidates AND skips. The skips are not noise - a dependency dropped
 * without a reason is indistinguishable from one that had no new major, and this
 * project has already paid once for a search whose "0 results" meant "the search
 * was broken". Every name that goes in comes out in exactly one of the two lists.
 */
export function pendingMajors(pkg = {}, latestByName = {}) {
  const declared = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const runtime = new Set(Object.keys(pkg.dependencies || {}));
  const candidates = [];
  const skipped = [];

  for (const name of Object.keys(declared).sort()) {
    const range = declared[name];

    const outOfScope = isOutOfScope(name);
    if (outOfScope) {
      skipped.push({ name, why: outOfScope });
      continue;
    }

    // A range we cannot read is skipped by name, never guessed. "workspace:*",
    // a git url and "latest" all mean we do not know what is installed, and a
    // guess here would put a fictional upgrade in front of a customer.
    const have = rangeMajor(range);
    if (have === null) {
      skipped.push({ name, why: "cannot read the version range: " + String(range) });
      continue;
    }

    const latest = latestByName[name];
    if (latest === null || latest === undefined) {
      skipped.push({ name, why: "npm did not answer for this package" });
      continue;
    }

    const to = rangeMajor(latest);
    if (to === null) {
      skipped.push({ name, why: "cannot read the published version: " + String(latest) });
      continue;
    }

    if (to <= have) {
      skipped.push({ name, why: "already on the newest major (" + have + ")" });
      continue;
    }

    candidates.push({
      package: name,
      from: have,
      to,
      "breaking-version": String(to),
      latest,
      runtime: runtime.has(name),
    });
  }

  return { candidates, skipped };
}

/**
 * The one-paragraph answer a person actually reads.
 *
 * Deliberately says "your tests have not been run yet". A scan that reports "6
 * upgrades pending" beside a product whose whole claim is proof would invite the
 * reader to hear "6 problems", and six pending majors is not six problems - the
 * last measurement across 55 repositories put roughly a quarter of them in that
 * category and the rest upgraded without turning anything red.
 */
export function renderScan({ candidates = [], skipped = [] } = {}) {
  if (!candidates.length) {
    return "No dependency here has shipped a new major. " + skipped.length + " checked and skipped.";
  }
  const lines = [
    candidates.length + " dependenc" + (candidates.length === 1 ? "y has" : "ies have") + " shipped a new major:",
    "",
  ];
  for (const c of candidates) {
    lines.push("  " + c.package + "  " + c.from + " -> " + c.to + "  (" + c.latest + ")" + (c.runtime ? "" : "  [dev]"));
  }
  lines.push(
    "",
    "Whether any of these breaks this project is not known yet: nothing here ran " +
      "your tests. " + skipped.length + " other dependenc" + (skipped.length === 1 ? "y was" : "ies were") + " skipped."
  );
  return lines.join("\n");
}

const isMain = process.argv[1] && process.argv[1].endsWith("scan-deps.mjs");
if (isMain) {
  const fs = await import("node:fs");
  const argv = process.argv.slice(2);
  const asJson = argv.includes("--json");
  const file = argv.find((a) => !a.startsWith("--")) || "package.json";

  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    console.error("cannot read " + file + ": " + err.message);
    process.exit(2);
  }

  const names = Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) });
  const latestByName = {};
  let asked = 0;
  let answered = 0;
  for (const name of names) {
    if (isOutOfScope(name)) continue;
    asked++;
    try {
      const res = await fetch("https://registry.npmjs.org/" + encodeURIComponent(name).replace("%40", "@") + "/latest");
      latestByName[name] = res.ok ? (await res.json()).version ?? null : null;
      if (latestByName[name]) answered++;
    } catch {
      latestByName[name] = null;
    }
    await new Promise((r) => setTimeout(r, 40));
  }

  // A registry that answered nothing looks exactly like a project with no
  // pending majors, and the second is a result while the first is a broken run.
  // Exit non-zero rather than print a reassuring zero.
  if (asked > 0 && answered === 0) {
    console.error("npm answered for none of the " + asked + " packages asked - this is not a result");
    process.exit(3);
  }

  const scan = pendingMajors(pkg, latestByName);
  if (asJson) {
    console.log(JSON.stringify(scan, null, 2));
  } else {
    console.log(renderScan(scan));
  }
}
