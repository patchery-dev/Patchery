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
 * A project's own declaration is the only non-arbitrary answer. `.nvmrc` first,
 * because it is unambiguous and usually what CI uses; then the lowest major in
 * `engines.node`, because that is the version the author promises the code works
 * on, and the lowest one is the one that has to keep working.
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
 * Returns `{ version, source }`. The source is not decoration: it goes in the
 * run summary, so the assumption can be argued with instead of inferred.
 */
export function decideNodeVersion(dir, { readFile, exists } = {}) {
  const read = readFile || ((p) => fs.readFileSync(p, "utf8"));
  const has = exists || ((p) => fs.existsSync(p));
  const at = (name) => path.join(dir || ".", name);

  if (has(at(".nvmrc"))) {
    try {
      const v = fromNvmrc(read(at(".nvmrc")));
      if (v) return { version: v, source: ".nvmrc" };
    } catch {
      // Unreadable is not authoritative; fall through and ask package.json.
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

const isMain = process.argv[1] && process.argv[1].endsWith("node-version.mjs");
if (isMain) {
  const asked = (process.argv[2] || "auto").trim();
  const dir = process.argv[3] || process.cwd();
  if (asked && asked !== "auto") {
    process.stdout.write(asked + "\n");
    process.stderr.write("node " + asked + " (asked for)\n");
  } else {
    const { version, source } = decideNodeVersion(dir);
    process.stdout.write(version + "\n");
    process.stderr.write("node " + version + " (" + source + ")\n");
  }
}
