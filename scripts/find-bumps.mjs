#!/usr/bin/env node
/**
 * Turns a list of repositories into a list of upgrades worth trying.
 *
 * The earlier finder (`find-cases.mjs`) searched history for migrations somebody
 * had already done, so their fix could be the answer key. That constraint turned
 * out to cost more than it bought: repositories that write "migrate to x v4" in a
 * commit message are hobby projects, and the recognizable ones write "chore(deps):
 * bump x" - the two never arrive together.
 *
 * And the answer key was never the standard. Patchery is judged by whether the
 * tests go from red to green, not by whether its diff matches a person's. The
 * repository's own suite is the harder judge, and it is available without any
 * history search at all.
 *
 * So: pick repositories for being real and well tested, read what they depend on,
 * and ask npm which of those has since shipped a new major. Every such pair is a
 * break that a person on that repository will meet the day they upgrade. Which of
 * them actually breaks the tests is not guessed here - that is measured, by the
 * verify-case workflow.
 *
 * Usage:
 *   node scripts/find-bumps.mjs repos.txt > benchmark/candidates.json
 *   node scripts/find-bumps.mjs --repo expressjs/express
 *
 * A GITHUB_TOKEN in the environment raises the rate limit from 60/hr to 5000/hr.
 */

const argv = process.argv.slice(2);
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
const ONE = flagValue("--repo");
const MAX_PER_REPO = Number(flagValue("--max-per-repo") || 3);

function flagValue(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(url, { raw = false } = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "patchery-find-bumps",
        Accept: raw ? "application/json" : "application/vnd.github+json",
        ...(TOKEN && !raw ? { Authorization: "Bearer " + TOKEN } : {}),
      },
    });
    // A silently dropped rate-limited request looks exactly like "nothing found",
    // which is the worst failure a search can have: it reads as a finding.
    if (res.status === 403 || res.status === 429) {
      const wait = Math.min(60, 5 * Math.pow(2, attempt));
      console.error("  rate limited, waiting " + wait + "s...");
      await sleep(wait * 1000);
      continue;
    }
    if (!res.ok) throw new Error(res.status + " on " + url);
    return res.json();
  }
  throw new Error("rate limited, gave up on " + url);
}

/**
 * The major a range resolves to today. "^7.13.2" -> 7, "~4.0" -> 4, "20.x" -> 20.
 *
 * Deliberately not a semver parser: anything without a leading number (a git url,
 * "workspace:*", "latest") returns null and the dependency is skipped, because we
 * cannot say what it is pinned to and guessing would put a fictional row in the
 * benchmark.
 */
export function rangeMajor(range) {
  const m = String(range || "").match(/(\d+)(?:\.\d+)*/);
  return m ? Number(m[1]) : null;
}

/**
 * Test scripts we cannot use, each for a reason that killed a real attempt.
 *
 *   placeholder   `npm test` that exits 1 with "no test specified" - no signal
 *   watching      -w / --watch never exits, and burns the job's whole timeout
 *   writing       -u / --fix rewrites the files under us, so "before" and "after"
 *                 are no longer the same experiment
 */
export function testScriptUsable(script) {
  if (!script) return { ok: false, why: "no test script" };
  if (/no test specified|exit 1\s*$/.test(script)) return { ok: false, why: "placeholder test script" };
  if (/(^|\s)(-w|--watch)(\s|$)/.test(script)) return { ok: false, why: "test script watches: " + script };
  if (/(^|\s)(-u|--update-snapshot|--fix)(\s|$)/.test(script)) {
    return { ok: false, why: "test script rewrites files: " + script };
  }

  // A suite that needs something the container does not have cannot tell us
  // anything, and it does not fail in a way that says so: it fails looking
  // exactly like a broken repository. Twelve of thirty-three verdicts read
  // "already failing at this commit" and were nothing of the kind -
  //
  //   knex        please upgrade node: mariadb requires at least version 20
  //   nunjucks    test failed. phantomjs exit code: 1
  //   pa11y-ci    Error: 1 === 0            (a browser it could not start)
  //   typeorm     Cannot find ormconfig.json file in the root of the project
  //   jsdom       Host entries not present for web platform tests
  //
  // Each is a healthy project whose tests need a database, a browser or a
  // machine set up beforehand. Excluding them up front is honest; recording them
  // as failures is not.
  const NEEDS_A_SERVICE =
    /(^|\s|\/)(phantomjs|selenium|chromedriver|geckodriver|cypress|playwright|puppeteer|karma|testcontainers|docker(-compose)?|wdio|webdriver)(\s|$|\/)/i;
  if (NEEDS_A_SERVICE.test(script)) {
    return { ok: false, why: "test script needs a browser or a container: " + script };
  }
  // "integration" in a test command means a database or a live service often
  // enough that the cases it costs are cheaper than the verdicts it corrupts.
  if (/(^|\s|:)integration/i.test(script)) {
    return { ok: false, why: "test script runs integration tests: " + script };
  }
  return { ok: true };
}

/**
 * Dependencies whose major bump cannot produce the kind of break we fix.
 *
 * `@types/*` changes types, not runtime behaviour, so a test suite either never
 * sees it or sees it as a typecheck failure - a different signal we do not read
 * yet. The rest are tooling whose major bumps break configuration files rather
 * than call sites, and Patchery edits call sites. Keeping them would inflate the
 * benchmark with breaks the product does not claim to fix.
 */
export function isOutOfScope(name) {
  if (/^@types\//.test(name)) return "types-only package";
  if (/^@tsconfig\//.test(name)) return "shared tsconfig - not code";

  // Test frameworks, assertion and mocking libraries. Their majors DO change call
  // sites, but the call sites are inside the test files - the one place an agent
  // must not be turned loose, because editing the test that judges you is the
  // shortest path to a green run that proves nothing.
  const TEST_TOOLING =
    /^(jest|vitest|@vitest\/|mocha|jasmine|ava|karma|qunit|tape|chai|sinon|nock|fetch-mock|msw|supertest|@testing-library\/|enzyme|cypress|playwright|@playwright\/|puppeteer|@stryker-mutator\/|c8|nyc|codecov|testcontainers|tstyche|expect-type)/;
  if (TEST_TOOLING.test(name)) return "test tooling - its call sites live in the tests";

  // Build, lint and release tooling. A major here breaks a config file, and
  // Patchery edits source, not build configuration. Keeping these would fill the
  // benchmark with breaks the product does not claim to fix - the react-router v8
  // ESM finding is the same class, arriving by accident.
  const BUILD_TOOLING =
    /^(eslint|@eslint\/|@typescript-eslint\/|prettier|typescript|tslint|xo|gts|standard|webpack|@webpack|rollup|@rollup\/|vite|@vitejs\/|esbuild|parcel|@rspack\/|babel|@babel\/|swc|@swc\/|terser|husky|lint-staged|semantic-release|@semantic-release\/|size-limit|@size-limit\/|typedoc|@docsearch\/|rimraf|del-cli|cpy-cli|copyfiles|concurrently|cross-env|npm-run-all|nodemon|ts-node|tsx|tsup|microbundle)/;
  if (BUILD_TOOLING.test(name)) return "build or lint tooling - breaks configuration, not call sites";

  return null;
}

async function latestMajor(pkg) {
  const meta = await api("https://registry.npmjs.org/" + encodeURIComponent(pkg).replace("%40", "@"), {
    raw: true,
  });
  const latest = meta["dist-tags"]?.latest;
  return latest ? { major: rangeMajor(latest), version: latest } : null;
}

async function inspectRepo(full) {
  const out = { repo: full };
  const repo = await api("https://api.github.com/repos/" + full);
  if (repo.archived) return { ...out, reject: "archived" };
  out.stars = repo.stargazers_count ?? 0;
  out.pushed = (repo.pushed_at || "").slice(0, 10);

  const head = await api("https://api.github.com/repos/" + full + "/commits/" + repo.default_branch);
  out.commit = head.sha;

  let pkg;
  try {
    const file = await api(
      "https://api.github.com/repos/" + full + "/contents/package.json?ref=" + out.commit
    );
    pkg = JSON.parse(Buffer.from(file.content, "base64").toString("utf8"));
  } catch {
    return { ...out, reject: "no package.json at the repository root" };
  }

  const usable = testScriptUsable(pkg.scripts?.test);
  if (!usable.ok) return { ...out, reject: usable.why };
  out.test = pkg.scripts.test;

  // A workspaces root runs its members' tests through a tool we have not told the
  // workflow about. Flagged rather than rejected: `target-dir` exists for this,
  // and the recognizable repositories are mostly monorepos.
  if (pkg.workspaces) out.note = "monorepo - may need target-dir";

  const runtime = new Set(Object.keys(pkg.dependencies || {}));
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const bumps = [];
  for (const [name, range] of Object.entries(deps)) {
    const skip = isOutOfScope(name);
    if (skip) continue;
    const have = rangeMajor(range);
    if (!have) continue;
    let latest;
    try {
      latest = await latestMajor(name);
    } catch {
      continue;
    }
    if (!latest || !latest.major || latest.major <= have) continue;
    bumps.push({ package: name, from: have, to: latest.major, version: latest.version, runtime: runtime.has(name) });
    await sleep(120);
  }

  // Runtime dependencies first: those are the ones the repository's own source
  // calls, so a break in them lands where Patchery works. Then biggest jump, on
  // the theory that the further apart the majors, the more likely a signature
  // changed somewhere in between.
  bumps.sort((a, b) => Number(b.runtime) - Number(a.runtime) || b.to - b.from - (a.to - a.from));
  out.bumps = bumps.slice(0, MAX_PER_REPO);
  if (!out.bumps.length) return { ...out, reject: "every dependency is already on its latest major" };
  return out;
}

// The pure functions above are imported by the self-test. Everything below is
// the command-line run, and importing this file must not start a GitHub crawl.
const isMain = process.argv[1] && process.argv[1].endsWith("find-bumps.mjs");
if (isMain) {
  const repos = ONE
    ? [ONE]
    : (await import("node:fs")).readFileSync(argv[0], "utf8")
        .split("\n")
        .map((l) => l.replace(/#.*/, "").trim())
        .filter(Boolean);

  const cases = [];
  const rejected = [];

  for (const full of repos) {
    console.error("· " + full);
    try {
      const r = await inspectRepo(full);
      if (r.reject) {
        rejected.push(r);
        console.error("  skipped: " + r.reject);
        continue;
      }
      for (const b of r.bumps) {
        cases.push({
          repo: r.repo,
          commit: r.commit,
          package: b.package,
          "breaking-version": String(b.to),
          "test-command": "npm test",
          "target-dir": ".",
          "node-version": "auto",
          _stars: r.stars,
          _bump: b.package + " v" + b.from + " -> v" + b.to,
          _note: r.note || "",
          _runtime: b.runtime,
        });
      }
      console.error("  " + r.bumps.length + " bump(s): " + r.bumps.map((b) => b.package + " " + b.from + "->" + b.to).join(", "));
    } catch (err) {
      rejected.push({ repo: full, reject: err.message });
      console.error("  error: " + err.message);
    }
    await sleep(300);
  }

  console.error("\n" + cases.length + " candidate upgrade(s) from " + repos.length + " repositories");
  for (const r of rejected) console.error("  skipped " + r.repo + ": " + r.reject);

  process.stdout.write(JSON.stringify(cases, null, 2) + "\n");

}
