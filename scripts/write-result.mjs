#!/usr/bin/env node
/**
 * Writes one verify-case verdict to a JSON file the report can collect.
 *
 * A seven-line inline script, moved out for the same reason as the longer ones:
 * it runs on whatever Node the candidate repository needs, and nothing in YAML
 * would have told us if it could not parse there. That is not hypothetical - a
 * `??` in a sibling script failed to load on node-fetch's Node 12 and three
 * cases finished with no result at all.
 *
 * Written in the plainest syntax on purpose, for the same reason.
 *
 * Usage:
 *   node scripts/write-result.mjs /tmp/result.json <repo> <package> <version> <commit> <verdict> <detail>
 */

import fs from "node:fs";

const [out, repo, pkg, version, commit, verdict, detail] = process.argv.slice(2);

if (!out) {
  console.error("write-result: no output path given");
  process.exit(1);
}

fs.writeFileSync(
  out,
  JSON.stringify({
    repo: repo || "",
    package: pkg || "",
    version: version || "",
    commit: commit || "",
    verdict: verdict || "",
    detail: detail || "",
    run: process.env.GITHUB_RUN_ID || "",
  })
);
