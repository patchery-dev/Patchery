#!/usr/bin/env node
/**
 * Reports which version of a package is actually installed, by reading the file.
 *
 * The obvious way, `require('<pkg>/package.json').version`, is wrong for exactly
 * the packages this benchmark cares about. A modern package declares an
 * `exports` map, and a map that lists only its entry point makes every other
 * path - `package.json` included - unreachable by resolution. `content-disposition@3`
 * publishes `"exports": "./dist/index.js"`, so the probe threw and the run reported
 * "NOT RESOLVABLE", which then read as "the upgrade never installed".
 *
 * That is a false negative aimed at the one class of dependency we most need to
 * measure: the ESM-only majors that are causing the breaks in the first place.
 * The probe was blind precisely where the subject lives.
 *
 * Reading the file from node_modules has no such opinion. Resolution rules are
 * about what code may import; we are not importing anything, we are asking what
 * is on disk.
 */

import fs from "node:fs";
import path from "node:path";

/**
 * Walks up from `dir` looking for `node_modules/<pkg>/package.json`.
 *
 * Climbing matters for a monorepo, where the target is a workspace member and
 * the dependency is hoisted to the root - reading only the target's own
 * node_modules would report "not installed" for a package that is installed and
 * in use one level up.
 */
export function findInstalled(pkg, dir, { readFile, exists } = {}) {
  const read = readFile || ((p) => fs.readFileSync(p, "utf8"));
  const has = exists || ((p) => fs.existsSync(p));
  let here = path.resolve(dir || ".");
  for (;;) {
    const candidate = path.join(here, "node_modules", ...pkg.split("/"), "package.json");
    if (has(candidate)) {
      try {
        const version = JSON.parse(read(candidate)).version;
        if (version) return { version, path: candidate };
      } catch {
        // A package.json we cannot parse is not a version we can report. Keep
        // climbing rather than claiming the package is missing.
      }
    }
    const up = path.dirname(here);
    if (up === here) return { version: null, path: null };
    here = up;
  }
}

const isMain = process.argv[1] && process.argv[1].endsWith("installed-version.mjs");
if (isMain) {
  const [pkg, dir] = process.argv.slice(2);
  const found = findInstalled(pkg || "", dir || process.cwd());
  process.stdout.write((found.version || "NOT INSTALLED") + "\n");
}
