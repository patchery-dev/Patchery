#!/usr/bin/env node
/**
 * Which Node a repository says it needs.
 *
 * This exists because the answer decides what "the tests pass" means, and a
 * wrong answer is invisible: the run is green, the summary is clean, and the
 * only thing wrong is that the tests were never run on the version the project
 * actually uses.
 *
 * That happened, twice, in opposite directions:
 *
 *   Guessing too low. `mozilla/treeherder` was verified on Node 20 because 20
 *   was the default in the form. Its suite calls Set.prototype.intersection,
 *   which arrives in 22, so the verdict came back "already broken at this
 *   commit" - a sentence about our runner that reads as a finding about the
 *   repository, and quietly drops a good candidate.
 *
 *   Guessing too high. The action set up Node 22 by default while the benchmark
 *   had pinned express to the Node 18 its own package.json asks for. On 22,
 *   `require()` of an ES module works; on 18 it throws. So the break the
 *   benchmark had just installed and confirmed vanished the moment the action
 *   started, and Patchery correctly reported that there was nothing to fix.
 *   Three runs were spent on that, and both logs looked complete.
 *
 * A project's own declaration is the only non-arbitrary answer, but "declaration"
 * turned out to mean two different things, and the wrong one wrecked a batch.
 *
 * `engines.node` is the runtime floor the LIBRARY supports. It is not the Node
 * its own test suite runs on, and the gap can be enormous: knex declares
 * `>=16`, so the benchmark ran its suite on Node 16, where a devDependency
 * refused to load - "please upgrade node: mariadb requires at least version
 * 20.0.0". The verdict came back "already failing at this commit", blaming knex
 * for our choice. Knex's own CI runs on 22.
 *
 * So the CI workflow is asked before `engines`: it names the versions the
 * maintainers actually run the tests on. Among those, the LOWEST - that is the
 * compatibility floor they commit to, so a break there is a real break for them.
 * Taking the highest would hide breaks that only appear on older runtimes, which
 * is precisely how the express ESM case disappeared once already.
 *
 * Order: `.nvmrc`, then the lowest version the CI actually runs, then the lowest
 * major in `engines.node`, then a stated fallback.
 */

import fs from "node:fs";
import path from "node:path";

export const FALLBACK = "20";

/**
 * The oldest Node a measurement can honestly be made on.
 *
 * "The lowest version CI runs" is the right instinct - a break matters most on
 * the oldest environment the project supports - and it is wrong on the tail.
 * expressjs/cors runs its suite on every major from 0.10 to 25, so the lowest is
 * Node 1 (2015). setup-node cannot install it, the leg died before measuring
 * anything, and the batch lost three candidates that way - two of them the
 * express v4 -> v5 cases the whole pool was rebuilt to find.
 *
 * A matrix that long is a compatibility smoke test, not the suite the
 * maintainers develop against. Below 18, npm and the rest of the toolchain stop
 * working well enough that a red run says more about our runner than about the
 * break - and a measurement about our own setup is exactly what this pipeline
 * exists to avoid reporting as a finding.
 */
export const OLDEST_USABLE = 18;

/**
 * Where `require()` of an ES module stopped throwing, per release line.
 *
 * This is the single most consequential line in the runtime for the breaks this
 * corpus is made of, and it does not fall on a major boundary. `require(esm)`
 * was unflagged in 20.19.0 and 22.12.0, so "Node 20" names two different
 * experiments: on 20.18 a packaging break reproduces, on 20.19 it does not.
 *
 * Every layer above this asks for a MAJOR - node-version.mjs resolves one,
 * setup-node installs whatever is latest within it, and the benchmark row
 * records the major it asked for. Which means a row saying "node: 20" cannot be
 * read: nobody can tell from it which side of this line the suite ran on, and
 * the two sides are different results.
 *
 * The policy is not to pick a side here - that is a decision about what the
 * corpus measures, and it belongs to whoever fixes the denominator. The policy
 * is that no run may be silent about which side it landed on.
 */
export const REQUIRE_ESM_UNFLAGGED = { 20: "20.19.0", 22: "22.12.0" };

/**
 * Which side of that line a concrete runtime fell on.
 *
 * Takes a full version, never a major, because a major cannot answer it - which
 * is the entire point. Returns "above", "below", or null when the version is
 * unreadable, and null must not be read as either side.
 *
 * @param {string} version e.g. "v20.19.4", "22.11.0"
 * @returns {"above"|"below"|null}
 */
export function requireEsmSide(version) {
  const m = String(version || "").match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  // Lines with no boundary of their own: everything before 20 is below it,
  // everything after 22 shipped with it already unflagged.
  if (major < 20) return "below";
  if (major > 22 || major === 21 || major === 23) return major >= 23 ? "above" : "below";
  const [bMajor, bMinor, bPatch] = REQUIRE_ESM_UNFLAGGED[major].split(".").map(Number);
  if (major !== bMajor) return null;
  if (minor !== bMinor) return minor > bMinor ? "above" : "below";
  return patch >= bPatch ? "above" : "below";
}

/**
 * The CI major to actually measure on: the lowest at or above the floor, and if
 * every version CI names is older than that, the highest of them.
 *
 * The fallback is deliberately the project's own highest rather than FALLBACK.
 * A repository whose CI tops out at 16 is genuinely old, and running its suite
 * on 20 instead can heal the very break being measured - which has happened:
 * `require()` of an ES module throws on 18 and works on 22, so a real break
 * vanished and the run reported, correctly and uselessly, that there was
 * nothing to fix.
 */
export function usableCiMajor(majors) {
  const list = (majors || []).filter((n) => Number.isFinite(n) && n > 0);
  if (!list.length) return null;
  const modern = list.filter((n) => n >= OLDEST_USABLE);
  return modern.length ? Math.min(...modern) : Math.max(...list);
}

/**
 * The lowest major named in a range like ">=22.0.0", "^20 || ^22", ">=18.17 <21".
 *
 * Matches whole version strings and takes the leading number of each. Matching
 * bare digits instead reads ">=22.0.0" as 22, 0 and 0 and picks the zero, and
 * `actions/setup-node` will happily install Node 0.12.18 from 2015 - which it
 * did, and surfaced two steps later as a syntax error inside corepack, naming
 * nothing.
 */
export function lowestMajor(range) {
  const found = String(range || "").match(/[0-9]+(?:\.[0-9]+)*/g);
  const majors = (found || []).map((v) => parseInt(v, 10)).filter((n) => n > 0);
  return majors.length ? String(Math.min(...majors)) : null;
}

/** `.nvmrc` is a bare version, sometimes with a leading v and always with a newline. */
export function fromNvmrc(text) {
  const cleaned = String(text || "").trim().replace(/^v/i, "");
  return /^\d/.test(cleaned) ? cleaned : null;
}

/**
 * Every Node version a workflow file names, as majors.
 *
 * Regex rather than a YAML parse, deliberately: the shapes that matter are few
 * and stable (`node-version: 22.x`, `node-version: [18, 20, 22]`), a parser is a
 * dependency this file does not otherwise need, and anything unrecognised simply
 * contributes nothing rather than throwing.
 *
 * Non-numeric values are skipped, not guessed at: `lts/*`, `latest`, and
 * `${{ matrix.node }}` all name a version without stating one.
 */
export function ciNodeVersions(text) {
  const out = [];
  // `node-version:` is the setup-node input; a bare `node:` is what a matrix
  // usually calls the same thing. node-fetch and nunjucks both use the second
  // form, and matching only the first read their workflows as saying nothing.
  for (const m of String(text || "").matchAll(/(?:^|\s)node(?:[-_]version)?\s*:\s*(.+)/gi)) {
    const value = m[1].split("#")[0];
    if (/\$\{\{/.test(value)) continue;
    for (const v of value.match(/\d+(?:\.\d+)*/g) || []) {
      const major = parseInt(v, 10);
      if (major > 0) out.push(major);
    }
  }
  return out;
}

/** Workflows that look like they run the tests, preferred over the rest. */
function looksLikeTestWorkflow(name) {
  return /(^|[-_.])(ci|test|tests|node|build|main)\.ya?ml$/i.test(name);
}

/**
 * Returns `{ version, source }`. The source is not decoration: it goes in the
 * run summary, so the assumption can be argued with instead of inferred.
 */
export function decideNodeVersion(dir, { readFile, exists, listDir } = {}) {
  const read = readFile || ((p) => fs.readFileSync(p, "utf8"));
  const has = exists || ((p) => fs.existsSync(p));
  const list =
    listDir ||
    ((p) => {
      try {
        return fs.readdirSync(p);
      } catch {
        return [];
      }
    });
  const at = (name) => path.join(dir || ".", name);

  if (has(at(".nvmrc"))) {
    try {
      const v = fromNvmrc(read(at(".nvmrc")));
      if (v) return { version: v, source: ".nvmrc" };
    } catch {
      // Unreadable is not authoritative; fall through and ask the next source.
    }
  }

  // What the maintainers actually run the tests on. Test-shaped workflows first;
  // a codeql or release workflow can name a Node that has nothing to do with the
  // suite, and would quietly become our answer.
  const wfDir = path.join(dir || ".", ".github", "workflows");
  const files = list(wfDir).filter((f) => /\.ya?ml$/i.test(f));
  for (const group of [files.filter((f) => looksLikeTestWorkflow(f)), files]) {
    const majors = [];
    for (const f of group) {
      try {
        majors.push(...ciNodeVersions(read(path.join(wfDir, f))));
      } catch {
        // A file we cannot read contributes nothing.
      }
    }
    const pick = usableCiMajor(majors);
    if (pick !== null) {
      return { version: String(pick), source: "the versions CI runs the tests on" };
    }
  }

  if (has(at("package.json"))) {
    try {
      const engines = JSON.parse(read(at("package.json"))).engines;
      const v = lowestMajor(engines && engines.node);
      if (v) return { version: v, source: "engines.node" };
    } catch {
      // Same.
    }
  }

  return { version: FALLBACK, source: "fallback - the project does not say" };
}

/**
 * Every version worth trying, in the order to try them.
 *
 * One number cannot be right here, and the two ways of being wrong are both
 * expensive. Too low and the project's own tooling will not load - knex declares
 * `>=16`, and on 16 a devDependency refused to start, so the batch recorded
 * "already failing at this commit" about a healthy repository. Too high and the
 * break disappears - express's ESM failure exists on 18 and not on 22, and a run
 * that picked 22 reported, correctly and uselessly, that there was nothing to fix.
 *
 * A repository's CI usually names several versions and they are not
 * interchangeable: axios runs compatibility smoke jobs on Node 12 alongside a
 * real suite on 26. No static rule picks the right one from that list.
 *
 * So this does not pick. It orders - lowest first, because the lowest version a
 * project still supports is where a break matters most - and the caller tries
 * them until the suite actually runs. The guess becomes a measurement, which is
 * the only thing that has worked on this problem so far.
 */
export function nodeVersionCandidates(dir, deps = {}) {
  const chosen = decideNodeVersion(dir, deps);
  const out = [chosen];
  const seen = new Set([String(parseInt(chosen.version, 10))]);

  const read = deps.readFile || ((p) => fs.readFileSync(p, "utf8"));
  const list =
    deps.listDir ||
    ((p) => {
      try {
        return fs.readdirSync(p);
      } catch {
        return [];
      }
    });

  const wfDir = path.join(dir || ".", ".github", "workflows");
  const majors = [];
  for (const f of list(wfDir).filter((n) => /\.ya?ml$/i.test(n))) {
    try {
      majors.push(...ciNodeVersions(read(path.join(wfDir, f))));
    } catch {
      // Unreadable contributes nothing.
    }
  }

  // Same floor as the first choice: a retry on Node 1 is not a second chance,
  // it is a second way to fail before measuring anything.
  for (const major of [...new Set(majors)].filter((n) => n >= OLDEST_USABLE).sort((a, b) => a - b)) {
    if (seen.has(String(major))) continue;
    seen.add(String(major));
    out.push({ version: String(major), source: "also run by CI" });
  }

  // Somewhere to land when a project's own declarations are all unusable.
  if (!seen.has(FALLBACK)) out.push({ version: FALLBACK, source: "fallback" });
  return out;
}

/**
 * Is the Node running THIS action's own code new enough to run it?
 *
 * Everything above answers "which Node should your tests use". This answers a
 * different question that was assumed rather than checked: which Node are we
 * ourselves on. The action resolved that with `command -v node`, which returns
 * whatever is in PATH - and a caller who runs `actions/setup-node` before this
 * action, which is the ordinary way to write a workflow, puts THEIR project's
 * Node there. `benchmark-run.yml` does exactly that, and in run #11 six legs
 * started our code on Node 16.20.2 and were dead in under nine seconds.
 *
 * The protection against this was written, and its comment named this very
 * package: "node-fetch asks for Node 12, where `??` is a syntax error. The
 * agent never started; it failed to parse." It was not lost. It was bypassed,
 * because it asked PATH a question PATH cannot answer.
 *
 * The floor is 18: below it the SDK's own dependencies are not supported, and
 * the failure mode is a parse error in a file nobody here wrote - the least
 * debuggable shape a failure can take. Saying so out loud costs one line and
 * turns nine silent seconds into a sentence.
 */
export const OUR_NODE_FLOOR = 18;

export function ourNodeReason(version) {
  const m = /^v?(\d+)\./.exec(String(version || "").trim());
  // An unreadable version is not a pass. Reading it as 0 would be, and reading
  // it as "probably fine" is how the original bug was written.
  if (!m) return "could not read the Node version we are running on (" + version + ")";
  const major = Number(m[1]);
  if (major < OUR_NODE_FLOOR) {
    return (
      "Patchery's own code is running on Node " + major + ", and it needs " +
      OUR_NODE_FLOOR + " or newer. This is not the Node your tests run on - that " +
      "is chosen separately. It means the Node this action found was your " +
      "project's, not the runner's, which happens when a workflow sets up Node " +
      "before calling Patchery."
    );
  }
  return null;
}

const isMain = process.argv[1] && process.argv[1].endsWith("node-version.mjs");
if (isMain) {
  const asked = (process.argv[2] || "auto").trim();
  const dir = process.argv[3] || process.cwd();
  // --list prints every version worth trying, in order, for a caller that
  // retries rather than trusting one guess.
  const pinned = asked && asked !== "auto";
  // --check-self asks the running Node about itself, so it must be answered by
  // the very interpreter under suspicion - which is why this is a mode of this
  // script rather than a comparison done in YAML.
  if (process.argv.includes("--check-self")) {
    const reason = ourNodeReason(process.version);
    if (reason) {
      process.stderr.write("::error::" + reason + "\n");
      process.exit(1);
    }
    process.stderr.write("this action's own code runs on " + process.version + "\n");
  } else if (process.argv.includes("--list")) {
    const all = pinned ? [{ version: asked, source: "asked for" }] : nodeVersionCandidates(dir);
    process.stdout.write(all.map((c) => c.version).join(" ") + "\n");
    for (const c of all) process.stderr.write("  " + c.version + "  (" + c.source + ")\n");
  } else if (pinned) {
    process.stdout.write(asked + "\n");
    process.stderr.write("node " + asked + " (asked for)\n");
  } else {
    const { version, source } = decideNodeVersion(dir);
    process.stdout.write(version + "\n");
    process.stderr.write("node " + version + " (" + source + ")\n");
  }
}
