#!/usr/bin/env node
/**
 * Patchery before the build breaks.
 *
 * The rest of this product starts when your tests go red. That is the right
 * moment to FIX something and the wrong moment to LEARN it: by then the upgrade
 * is already in your branch, and - measured - a great many upgrades never turn
 * anything red at all. Express 5 went into four projects that depend on it and
 * not one suite noticed.
 *
 * So there are two earlier moments, and they answer different questions.
 *
 *   ON THE BUMP PULL REQUEST (level 2). Dependabot or Renovate opens "bump X
 *   from 4 to 5". The new version is right there, unmerged. Install it in that
 *   checkout, run the suite, and answer before a human reads the PR. Nothing is
 *   wasted: this only runs when a version actually moved.
 *
 *   ON A SCHEDULE (level 3). For a repository with no bump bot, or one that
 *   wants longer notice: take each dependency with a newer major, install it in
 *   a throwaway copy, and report. Weekly is a defensible default because majors
 *   arrive a few times a year - a daily check buys the same answer seven times.
 *
 * BOTH OF THOSE STILL ASK THE TEST SUITE. The third question does not, and it
 * is the one the Express measurement forced: surface-diff.mjs compares what the
 * two versions export and tells you what disappeared that your code uses. No
 * suite is involved, so a suite that never exercises the path cannot hide it.
 *
 * THE SENTENCE THAT MAY NOT DRIFT. A green suite after an upgrade is not
 * permission to upgrade. It is "your tests did not object", and this file says
 * that in as many words every single time, because the entire brand is built on
 * not overstating - and this is the exact place a product like ours would start.
 *
 * No model is called here. Installing a package and running its tests is
 * arithmetic, not judgement; the model is only worth paying for once something
 * is actually broken and needs repairing.
 */

/**
 * Which package moved, and between which versions.
 *
 * Bump bots put it in the title and they do not agree on the wording:
 *
 *   Bump express from 4.18.2 to 5.0.0
 *   chore(deps): bump express from 4.18.2 to 5.0.0
 *   build(deps-dev): Bump @types/node from 20.1.0 to 22.0.0
 *   Update express requirement from ^4.18.2 to ^5.0.0
 *
 * Returns null rather than guessing. A wrong package name here would install
 * something nobody asked for, so an unreadable title is a reason to do nothing -
 * the same rule the version-range reader follows.
 */
export function bumpFromTitle(title = "") {
  const text = String(title || "").trim();
  const bump = /\b(?:bump|update)\s+(@?[\w.-]+(?:\/[\w.-]+)?)\s+(?:requirement\s+)?from\s+\D*([\d][\w.-]*)\s+to\s+\D*([\d][\w.-]*)/i.exec(
    text
  );
  if (!bump) return null;
  const [, name, from, to] = bump;
  // A bot that bumps several packages at once writes "the X group" or a list,
  // and this reader must not pick one of them and call it the change.
  if (/\bgroup\b|\band\b\s+\d+\s+other/i.test(text)) return null;
  return { package: name, from, to };
}

/** Is this a major move? Only a major can remove a name. */
export function isMajorMove(from = "", to = "") {
  const major = (v) => {
    const m = /^(\d+)/.exec(String(v || "").trim());
    return m ? Number(m[1]) : null;
  };
  const a = major(from);
  const b = major(to);
  if (a === null || b === null) return null;
  return b > a;
}

/**
 * What the sentinel found, in the only two shapes it can honestly take.
 *
 * `suite` is "red" | "green" | "unknown". Unknown is a real answer - a project
 * whose tests could not be run tells you nothing about the upgrade, and saying
 * "green" there would be the worst available lie.
 */
export function sentinelVerdict({ suite = "unknown", atRisk = 0 } = {}) {
  if (suite === "red") return "breaks-your-tests";
  if (suite === "unknown") return "could-not-run-your-tests";
  return atRisk > 0 ? "green-but-a-name-you-use-is-gone" : "your-tests-did-not-object";
}

/**
 * The report a maintainer reads.
 *
 * Four verdicts, four sentences, and the boundary is attached to the two that
 * would otherwise be read as approval. `surfaceText` is whatever
 * renderSurfaceReport produced, or "".
 */
export function renderSentinel({ packageName = "", from = "", to = "", verdict = "", surfaceText = "" } = {}) {
  const move = "`" + packageName + "` " + from + " -> " + to;
  const head = {
    "breaks-your-tests":
      "### " + move + " breaks your tests\n\nInstalled it and ran your suite: it went red. " +
      "This is the case Patchery exists for - the repair pass can take it from here.",
    "green-but-a-name-you-use-is-gone":
      "### " + move + " - your tests stayed green, and something you use is gone\n\n" +
      "Read both halves. The suite did not object, AND the new version no longer " +
      "offers a name your code reaches for. Those are not in conflict: a suite only " +
      "objects to what it exercises.",
    "your-tests-did-not-object":
      "### " + move + " - your tests did not object\n\n" +
      "Installed it and ran your suite: it stayed green, and we found no name your " +
      "code uses that the new version dropped.\n\n" +
      "**This is not \"safe to upgrade\".** It is the two things we checked, and both " +
      "are bounded: your suite only objects to what it exercises, and we compared " +
      "exported names, not behaviour. We installed Express 5 into four projects that " +
      "depend on it and not one suite went red.",
    "could-not-run-your-tests":
      "### " + move + " - we could not run your tests\n\n" +
      "So this says nothing about the upgrade. Reported as unknown rather than as a " +
      "pass, because an unrunnable suite and a passing suite are not the same thing.",
  }[verdict];
  if (!head) return "";
  return surfaceText ? head + "\n\n" + surfaceText : head;
}

// ---------------------------------------------------------------------------
// The part that touches disk. Everything above is pure and tested; everything
// below installs, runs and prints, and is deliberately thin for that reason.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readPackageSurface, upgradeSurfaceReport, renderSurfaceReport } from "./surface-diff.mjs";
import { pendingMajors } from "./scan-deps.mjs";
import { breakingKey } from "./find-bumps.mjs";

/** Fetch one version of one package into a throwaway directory. */
export function fetchVersion(name, version, npm = "npm") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "patchery-surface-"));
  const r = spawnSync(
    npm,
    ["install", "--prefix", dir, "--no-save", "--no-audit", "--no-fund", "--ignore-scripts", "--loglevel=error", name + "@" + version],
    { encoding: "utf8", shell: process.platform === "win32" }
  );
  const installed = path.join(dir, "node_modules", ...name.split("/"));
  if (r.status !== 0 || !fs.existsSync(installed)) {
    return { dir: null, why: (r.stderr || r.stdout || "npm install failed").trim().slice(0, 400) };
  }
  return { dir: installed, why: null };
}

/** The project's own source. Never node_modules - that is where the break lives, not the call. */
export function ownSource(root) {
  const files = [];
  const walk = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (["node_modules", ".git", "dist", "build", "coverage"].includes(e.name)) continue;
        walk(full);
      } else if (/\.(?:js|mjs|cjs|jsx|ts|tsx|mts|cts)$/i.test(e.name)) {
        try {
          files.push({ path: path.relative(root, full).replace(/\\/g, "/"), text: fs.readFileSync(full, "utf8") });
        } catch {}
      }
    }
  };
  walk(root);
  return files;
}

/**
 * Run the suite and say which of three things happened.
 *
 * "unknown" is not a hedge. A command that does not exist, or a runner that
 * cannot start, tells you nothing about the upgrade - and calling that green
 * would be the one lie this whole file is built to avoid.
 */
export function runSuite(command, cwd) {
  if (!command) return { suite: "unknown", why: "no test command given", output: "" };
  const r = spawnSync(command, { cwd, shell: true, encoding: "utf8" });
  const output = ((r.stdout || "") + (r.stderr || "")).slice(-4000);
  if (r.error || r.status === null) return { suite: "unknown", why: String(r.error || "the runner did not exit"), output };
  if (/not recognized as an internal|command not found|ENOENT/i.test(output) && r.status !== 0) {
    return { suite: "unknown", why: "the test command does not exist here", output };
  }
  return { suite: r.status === 0 ? "green" : "red", why: null, output };
}

/**
 * The newest version npm knows about, or null.
 *
 * null is not "no new version" - it is "we could not ask", and the caller has to
 * keep those apart or a registry outage reads as a clean bill of health.
 */
export function latestVersion(name, npm = "npm") {
  const r = spawnSync(npm, ["view", name, "version"], {
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (r.status !== 0) return null;
  const v = String(r.stdout || "").trim();
  return /^\d/.test(v) ? v : null;
}

/**
 * The scheduled rehearsal: every dependency that has a newer major than the one
 * this project declares.
 *
 * Bounded on purpose. A repository with two hundred dependencies would otherwise
 * install two hundred packages twice on every run, and the answer to "which
 * majors are you behind on" does not change fast enough to be worth that. What
 * is dropped is SAID, because a silently shortened list is the same failure as a
 * silently trimmed one.
 */
export function scanTargets(pkgJson, latestByName, cap = 10) {
  const found = pendingMajors(pkgJson, latestByName);
  // `from` is the breaking LINE the range sits on, not a full version - that is
  // all a range gives us, and asking npm for "express@4" resolves to the newest
  // 4.x, which is the honest comparison anyway: what you would be on today
  // versus what is offered.
  //
  // The LINE, not the major, because on 0.x they differ: a project on ^0.1.77
  // reported as "0" reads as though it had never moved, and this repository is
  // the case that showed it.
  const targets = found.candidates.map((c) => {
    const line = breakingKey(String(c.range ?? "") || String(c.from));
    return {
      package: c.package,
      from: line ? line.label : String(c.from),
      to: String(c.latest),
    };
  });
  return {
    targets: targets.slice(0, cap),
    dropped: Math.max(0, targets.length - cap),
    skipped: found.skipped,
  };
}

/**
 * One dependency, one answer. Shared by the pull-request path and the scan, so
 * the two can never drift into saying different things about the same finding.
 *
 * The surface half runs even when the suite cannot, because it is the half that
 * does not need the suite - which is the entire reason it exists.
 */
export function checkOne(bump, root, testCommand) {
  let surfaceText = "";
  let atRisk = 0;
  const before = fetchVersion(bump.package, bump.from);
  const after = fetchVersion(bump.package, bump.to);
  if (before.why || after.why) {
    surfaceText =
      "_The surface comparison could not run: " + (before.why || after.why) + ". " +
      "Reported as not done rather than as nothing found._";
  } else {
    const a = readPackageSurface(before.dir);
    const b = readPackageSurface(after.dir);
    if (a.why || b.why) {
      surfaceText = "_The surface comparison could not read one of the versions: " + (a.why || b.why) + "._";
    } else {
      const report = upgradeSurfaceReport({
        packageName: bump.package,
        beforeText: a.text,
        afterText: b.text,
        files: ownSource(root),
      });
      surfaceText = renderSurfaceReport(report);
      atRisk = report.atRisk.length;
    }
  }
  const suite = runSuite(testCommand, root);
  const verdict = sentinelVerdict({ suite: suite.suite, atRisk });
  const out = renderSentinel({ packageName: bump.package, from: bump.from, to: bump.to, verdict, surfaceText });
  return suite.why ? out + "\n\n_Why the suite is unknown: " + suite.why + "._" : out;
}
if (process.argv[1] && process.argv[1].endsWith("sentinel.mjs")) {
  const title = process.env.SENTINEL_TITLE || process.argv[2] || "";
  const root = path.resolve(process.env.SENTINEL_DIR || ".");
  const testCommand = process.env.SENTINEL_TEST_COMMAND || "";
  const summaryFile = process.env.GITHUB_STEP_SUMMARY || "";
  const say = (text) => {
    console.log(text);
    if (summaryFile) {
      try {
        fs.appendFileSync(summaryFile, text + "\n");
      } catch {}
    }
  };

  // --scan is the scheduled rehearsal. It answers the same question as the pull
  // request path, for a repository where no bot has opened one yet.
  if (process.argv.includes("--scan")) {
    let pkgJson = {};
    try {
      pkgJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    } catch (e) {
      say("Patchery sentinel: no readable package.json in " + root + ". Nothing to check.");
      process.exit(0);
    }
    const names = Object.keys({ ...(pkgJson.dependencies || {}), ...(pkgJson.devDependencies || {}) });
    const latestByName = {};
    for (const n of names) latestByName[n] = latestVersion(n);
    const plan = scanTargets(pkgJson, latestByName);
    if (plan.targets.length === 0) {
      say("Patchery sentinel: no dependency has a newer major than the one declared here.");
      process.exit(0);
    }
    say("## Patchery sentinel\n\n" + plan.targets.length + " dependency(ies) have a newer major." +
      (plan.dropped ? " " + plan.dropped + " more were not checked this run - the list is capped at 10." : ""));
    for (const target of plan.targets) {
      say("\n---\n");
      say(checkOne(target, root, testCommand));
    }
    process.exit(0);
  }

  const bump = bumpFromTitle(title);
  if (!bump) {
    // Not an error. Most pull requests are not dependency bumps, and a sentinel
    // that guessed here would install a version nobody asked for.
    say("Patchery sentinel: no single dependency bump found in the title. Nothing to check.");
    process.exit(0);
  }
  const major = isMajorMove(bump.from, bump.to);
  if (major === false) {
    say("Patchery sentinel: `" + bump.package + "` " + bump.from + " -> " + bump.to + " is not a major. Only a major can remove a name, so this check has nothing to add.");
    process.exit(0);
  }

  say(checkOne(bump, root, testCommand));
  // Always zero. This reports; it does not gate a pull request, and a sentinel
  // that turned a check red would be making the maintainer's decision for them.
  process.exit(0);
}
