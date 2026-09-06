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
    if (majors.length) {
      return { version: String(Math.min(...majors)), source: "the versions CI runs the tests on" };
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

  for (const major of [...new Set(majors)].sort((a, b) => a - b)) {
    if (seen.has(String(major))) continue;
    seen.add(String(major));
    out.push({ version: String(major), source: "also run by CI" });
  }

  // Somewhere to land when a project's own declarations are all unusable.
  if (!seen.has(FALLBACK)) out.push({ version: FALLBACK, source: "fallback" });
  return out;
}

const isMain = process.argv[1] && process.argv[1].endsWith("node-version.mjs");
if (isMain) {
  const asked = (process.argv[2] || "auto").trim();
  const dir = process.argv[3] || process.cwd();
  // --list prints every version worth trying, in order, for a caller that
  // retries rather than trusting one guess.
  const pinned = asked && asked !== "auto";
  if (process.argv.includes("--list")) {
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
