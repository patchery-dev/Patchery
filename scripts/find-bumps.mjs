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

import { chooseTargetDir, normDir } from "./target-dir.mjs";

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

/**
 * Whether a break is about the API or about how the package is delivered.
 *
 * Both are real breaks and both deserve fixing, but they are not the same work
 * and the benchmark was accidentally full of one of them: eight of the first
 * eleven confirmed cases were packaging. Nobody chose that - most new majors in
 * 2026 are ESM migrations, so a finder that asks only "is there a new major"
 * collects them.
 *
 * The signal is cheap. If the version the project has and the version npm now
 * publishes are both CommonJS, delivery did not change - so whatever broke is in
 * the API, which is the class this tool most directly claims.
 */
/**
 * Is this repository something other people import, or something that runs?
 *
 * The distinction decides which fixes are honest, and it took a real benchmark
 * result to see it. Told that `content-disposition@3` had gone ES-module-only,
 * the agent could have taught express's own test runner to transform it - the
 * config is not off limits any more. It refused, and it was right: express is a
 * library, so that change would paint one CI green and leave every consumer
 * broken. The run was filed as NO-CHANGE, which reads as an agent with no ideas
 * and was in fact an agent with judgement.
 *
 * In an application the same fix is simply correct. Nobody imports you, so there
 * is nobody to break. And an application is who pays: the private repositories
 * this is priced for are companies' products, not their libraries.
 *
 * Thirteen of the first fourteen confirmed cases were libraries, because the
 * recognizable npm packages are libraries. The pool measured the population that
 * structurally cannot take the fix.
 *
 * The test is whether anything can `import` you: consumers mean the harness fix
 * is off the table, and no consumers mean it is simply correct. A `bin` does not
 * count - a CLI's callers spawn it, they do not load its modules.
 *
 * And it is a JUDGEMENT, not a field. The first version of this read it off
 * package.json and got express, multer, lodash and zod all wrong:
 *
 *   express, multer   no `main` at all - because Node defaults to index.js when
 *                     it is absent, so "no declared entry point" does not mean
 *                     "nothing can import you"
 *   lodash, zod       `private: true` at the repository root - which means "do
 *                     not publish THIS package", and is what a monorepo or a
 *                     build-from-source project writes while shipping a library
 *
 * So the authority is the label in repos.txt, where we are already choosing the
 * repositories and can say what we know. This function is only the fallback for
 * an unlabelled line, and it answers "unknown" wherever the signals are the ones
 * that fooled it before. An unknown row is excluded from the split rather than
 * quietly counted on one side of it.
 */
export function projectKind(pkg) {
  const p = pkg || {};
  const declared = p.main || p.exports || p.module || p.types || p.typings || p.browser;

  // A monorepo root is about its members, and says nothing about them.
  if (p.workspaces) return "unknown";
  // `private` with an entry point is the lodash shape: published from a build,
  // so the root is not the product and the root's flag is not the answer.
  if (p.private === true) return declared ? "unknown" : "application";
  if (declared) return "library";
  // Not private, and no entry point declared - which is either an application or
  // a library relying on Node's implicit index.js. Both are common; guessing
  // between them is how express became an "application".
  return "unknown";
}

/**
 * A repos.txt line: `owner/name` with an optional kind after it.
 *
 *   expressjs/express       library
 *   excalidraw/excalidraw   application
 *   somebody/something                  <- falls back to projectKind
 */
/**
 * The per-repository cap, applied so that what it dropped is countable.
 *
 * A repository can offer more breaking majors than we take. Taking the first
 * few is a deliberate cost control, but until now it was a bare `slice` and the
 * pool carried no trace of it - so "133 candidates from 55 repositories" read
 * as the population, when it is a sample with the tail cut off. The sort above
 * this call puts API-only bumps first, which means the tail that gets cut is
 * disproportionately the packaging ones, and the pool's own class split is a
 * property of the cap as much as of the repositories.
 *
 * Same shape as planBatch in batch-plan.mjs, and for the same stated reason:
 * "a truncation nobody announced reads as 'we ran everything'".
 *
 * @param {object[]} bumps  already sorted into the order we want to keep
 * @param {number} max
 * @returns {{picked: object[], dropped: number}}
 */
export function capBumps(bumps, max) {
  const list = bumps || [];
  const ceiling = Number.isFinite(max) && max > 0 ? max : list.length;
  return { picked: list.slice(0, ceiling), dropped: Math.max(0, list.length - ceiling) };
}

export function parseRepoLine(line) {
  const clean = String(line || "").replace(/#.*/, "").trim();
  if (!clean) return null;
  const [repo, kind] = clean.split(/\s+/);
  if (!repo) return null;
  const known = kind === "library" || kind === "application";
  return { repo, kind: known ? kind : "" };
}

function moduleFormat(manifest) {
  if (!manifest) return "unknown";
  if (manifest.type === "module") return "esm";
  // An `exports` map with no `require` condition is ESM-only in practice, whatever
  // `type` says.
  const e = manifest.exports;
  if (e && typeof e === "object" && !Array.isArray(e)) {
    const flat = JSON.stringify(e);
    if (/"import"/.test(flat) && !/"require"/.test(flat)) return "esm";
  }
  return "cjs";
}

async function latestMajor(pkg, haveMajor) {
  const meta = await api("https://registry.npmjs.org/" + encodeURIComponent(pkg).replace("%40", "@"), {
    raw: true,
  });
  const latest = meta["dist-tags"]?.latest;
  if (!latest) return null;

  const after = moduleFormat(meta.versions?.[latest]);
  // The newest release of the major the project is actually on, so the comparison
  // is between what they have and what they would get.
  let before = "unknown";
  const onTheirMajor = Object.keys(meta.versions || {})
    .filter((v) => rangeMajor(v) === haveMajor)
    .sort()
    .pop();
  if (onTheirMajor) before = moduleFormat(meta.versions[onTheirMajor]);

  return {
    major: rangeMajor(latest),
    version: latest,
    format: after,
    formatChanged: before !== "unknown" && after !== "unknown" && before !== after,
    apiOnly: before === "cjs" && after === "cjs",
  };
}

/** How many workspace manifests are worth fetching before the crawl is the cost. */
const MAX_MANIFESTS = 60;

/**
 * Directories whose package.json is not the product.
 *
 * Found by running the crawl rather than by imagining it: nestjs/nest reported
 * 49 workspaces, and the candidate it produced was `sample/22-graphql-prisma` -
 * a demo application shipped inside a library repository. It passed every gate
 * honestly (it declares prisma, it has a real jest script), and it is still
 * worthless: nobody maintains it, and fixing a dependency there says nothing
 * about nest. The original list had `examples` and missed `sample`, which is the
 * kind of near-miss a word list always has - hence a test rather than a guess.
 *
 * The bias is deliberately toward excluding: a missed workspace costs one
 * candidate out of a pool of 135, while a demo app admitted as a candidate costs
 * a whole benchmark row that looks real and measures nothing.
 */
const NOT_THE_PRODUCT = new Set([
  "node_modules",
  "__fixtures__", "fixtures", "fixture",
  "example", "examples",
  "sample", "samples",
  "demo", "demos",
  "test", "tests", "__tests__", "e2e", "integration",
  "benchmark", "benchmarks", "bench",
  "template", "templates", "scaffold",
  "playground", "sandbox",
  "website", "docs", "doc", "documentation",
  // The repository's own plumbing. Storybook and remix both declare a real
  // `scripts` workspace with a real test script, and the first pool built with
  // monorepo support duly offered `danger`, `@google-cloud/bigquery` and
  // `@octokit/request` from them. Upgrading a release bot proves nothing about
  // Storybook, and a FIXED there would license the sentence "we fixed a break in
  // Storybook" - which would be false in the way that matters.
  "scripts", "script", "ci",
  "tools", "tool", "tooling",
  "build", "internal",
  // One repository's invented name, patched rather than generalised. A rule for
  // "anything starting with test-" would catch this and also delete test-utils
  // and test-runner, which are packages people actually install. The two errors
  // are not symmetric: a fixture we wrongly keep shows up in the pool and gets
  // caught by eye, while a real package we wrongly drop never appears at all.
  // Keep the mistakes on the visible side.
  "test-storybooks",
]);

/**
 * Is this package.json part of the thing the repository is for?
 *
 * Any excluded segment anywhere in the path disqualifies it - a manifest under
 * `packages/core/test/` belongs to the tests whatever sits above it.
 */
export function isProductWorkspace(path) {
  const segs = String(path || "").split("/");
  // The last segment is "package.json" itself; the rest are directories.
  return !segs.slice(0, -1).some((s) => NOT_THE_PRODUCT.has(s.toLowerCase()));
}

/**
 * Every package.json in the repository, one HTTP call for the listing plus one
 * per file.
 *
 * Without this a monorepo is read from its root alone, and a root package.json
 * is a coordinator: it declares turbo and eslint, not the library whose new
 * major breaks the build. That is why the recognizable repositories - the ones
 * worth measuring - produced the least interesting candidates.
 *
 * Excluded: node_modules (not the project's code), and fixtures/examples, whose
 * package.json files exist to be broken on purpose and would each look like a
 * workspace.
 */
async function workspaceManifests(full, sha) {
  let tree;
  try {
    tree = await api("https://api.github.com/repos/" + full + "/git/trees/" + sha + "?recursive=1");
  } catch {
    return { manifests: [], truncated: true };
  }
  const found = (tree.tree || [])
    .filter((n) => n.type === "blob" && n.path.endsWith("/package.json"))
    .map((n) => n.path);
  const paths = found
    .filter(isProductWorkspace)
    .sort((a, b) => a.split("/").length - b.split("/").length);
  // Counted and reported, never silently dropped. The exclusion list is a
  // judgement call about what a repository is for, and a judgement that leaves
  // no trace is one nobody can check - "9 workspace(s) read" beside a repo with
  // 30 of them would read as a complete scan.
  const excluded = found.length - paths.length;

  // A tree GitHub itself truncated, or one deeper than the cap, means the list
  // below is incomplete - and an incomplete manifest list makes "only one
  // workspace declares it" a claim we have not earned. Say so rather than let
  // the caller read a short list as a whole one.
  const truncated = Boolean(tree.truncated) || paths.length > MAX_MANIFESTS;

  const manifests = [];
  for (const p of paths.slice(0, MAX_MANIFESTS)) {
    try {
      const file = await api("https://api.github.com/repos/" + full + "/contents/" + p + "?ref=" + sha);
      const json = JSON.parse(Buffer.from(file.content, "base64").toString("utf8"));
      manifests.push({
        dir: p.slice(0, -"/package.json".length),
        deps: { ...(json.dependencies || {}), ...(json.devDependencies || {}) },
        runtime: new Set(Object.keys(json.dependencies || {})),
        test: json.scripts?.test || "",
      });
    } catch {
      // One unreadable member does not invalidate the rest, but it does mean the
      // list is short - and short lists are exactly what `truncated` is for.
    }
    await sleep(80);
  }
  return {
    manifests,
    excluded,
    truncated: truncated || manifests.length < Math.min(paths.length, MAX_MANIFESTS),
  };
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

  // The root counts as a workspace like any other - a monorepo that declares a
  // dependency at its root really does own it there.
  const manifests = [
    {
      dir: ".",
      deps: { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) },
      runtime: new Set(Object.keys(pkg.dependencies || {})),
      test: pkg.scripts?.test || "",
    },
  ];

  if (pkg.workspaces) {
    const found = await workspaceManifests(full, out.commit);
    manifests.push(...found.manifests);
    out.workspaces = found.manifests.length;
    out.manifestsTruncated = found.truncated;
    out.note =
      found.manifests.length
        ? "monorepo - " + found.manifests.length + " workspace(s) read" +
          (found.excluded ? ", " + found.excluded + " skipped as not the product" : "") +
          (found.truncated ? ", list incomplete" : "")
        : "monorepo - could not read its workspaces";
  }

  // Which population this row belongs to. See projectKind for why it decides
  // whether the harness fix is honest.
  out.kind = projectKind(pkg);
  out.typescript = Boolean((pkg.devDependencies || {}).typescript || (pkg.dependencies || {}).typescript);

  const byDir = new Map(manifests.map((m) => [normDir(m.dir) || ".", m]));
  const names = [...new Set(manifests.flatMap((m) => Object.keys(m.deps)))];
  const bumps = [];
  for (const name of names) {
    const skip = isOutOfScope(name);
    if (skip) continue;

    // Where this dependency lives, from the one signal available before anything
    // has run: who declares it. The second signal - what the failure points at -
    // does not exist yet, so a package several workspaces declare stays
    // unresolved here and is carried forward for verify-case to settle.
    let target = chooseTargetDir({ packageName: name, manifests });

    // Running in a workspace means running THAT workspace's tests. A root
    // "npm test" that fans out through turbo or lerna measures the whole
    // repository, and a red suite there says nothing about this one package.
    const runnable = (m) => (normDir(m.dir) || ".") === "." || testScriptUsable(m.test).ok;

    // Several workspaces declaring the same dependency is the ordinary case in a
    // monorepo, and dropping all of them would leave almost nothing. Where only
    // one of the candidates has a suite we could run at all, that is not a guess
    // between equals - the others were never measurable. Where more than one is,
    // it stays unresolved: verify-case sees the stack trace, which we do not.
    if (!target.dir) {
      const declaring = manifests.filter((m) => name in m.deps).filter(runnable);
      if (declaring.length === 1) {
        const only = normDir(declaring[0].dir) || ".";
        target = { dir: only, agreed: false, why: only + " is the only one of them we can run tests in" };
      }
    }

    const owner = target.dir ? byDir.get(target.dir) : null;
    if (!owner || !runnable(owner)) continue;
    const range = owner.deps[name];
    if (!range) continue;

    const have = rangeMajor(range);
    if (!have) continue;
    let latest;
    try {
      latest = await latestMajor(name, have);
    } catch {
      continue;
    }
    if (!latest || !latest.major || latest.major <= have) continue;
    bumps.push({
      package: name,
      from: have,
      to: latest.major,
      version: latest.version,
      runtime: owner.runtime.has(name),
      format: latest.format,
      apiOnly: latest.apiOnly,
      dir: target.dir,
      dirWhy: target.why,
      dirAgreed: target.agreed,
    });
    await sleep(120);
  }

  // API-only breaks first. Eight of the first eleven confirmed cases turned out
  // to be packaging - nobody chose that, it is what "has a new major" collects in
  // 2026 - and the class this tool most directly claims was left untested. A bump
  // where the package was CommonJS before and after cannot be a delivery problem,
  // so whatever broke is the API.
  //
  // Then runtime dependencies, whose breaks land in the project's own source, and
  // then the biggest version jump, on the theory that the further apart the
  // majors the more likely a signature moved somewhere between them.
  bumps.sort(
    (a, b) =>
      Number(b.apiOnly) - Number(a.apiOnly) ||
      Number(b.runtime) - Number(a.runtime) ||
      b.to - b.from - (a.to - a.from)
  );
  const capped = capBumps(bumps, MAX_PER_REPO);
  out.bumps = capped.picked;
  out.bumpsDropped = capped.dropped;
  if (!out.bumps.length) return { ...out, reject: "every dependency is already on its latest major" };
  return out;
}

// The pure functions above are imported by the self-test. Everything below is
// the command-line run, and importing this file must not start a GitHub crawl.
const isMain = process.argv[1] && process.argv[1].endsWith("find-bumps.mjs");
if (isMain) {
  const repos = ONE
    ? [{ repo: ONE, kind: "" }]
    : (await import("node:fs")).readFileSync(argv[0], "utf8")
        .split("\n")
        .map(parseRepoLine)
        .filter(Boolean);

  const cases = [];
  const rejected = [];
  let cappedTotal = 0;

  for (const entry of repos) {
    const full = entry.repo;
    console.error("· " + full + (entry.kind ? "  [" + entry.kind + "]" : ""));
    try {
      const r = await inspectRepo(full);
      // The label in repos.txt is the authority; projectKind only fills a gap.
      if (entry.kind) r.kind = entry.kind;
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
          "target-dir": b.dir,
          "node-version": "auto",
          _stars: r.stars,
          _bump: b.package + " v" + b.from + " -> v" + b.to,
          _note: r.note || "",
          // Why this directory, in the row itself. A target-dir is an environment
          // assumption, and section 6 rule 4 of the project's own rules says an
          // assumption nobody wrote down gets read later as a finding.
          _dir_why: b.dirWhy,
          _dir_agreed: b.dirAgreed,
          _runtime: b.runtime,
        _format: b.format,
        _apiOnly: b.apiOnly,
          _kind: r.kind,
          _ts: r.typescript,
          // How many further breaking majors this repository had that the cap
          // left behind. Carried on the row because candidates.json is a flat
          // array with nowhere else to put it, and because anyone computing a
          // class split from this pool needs to know the tail was cut.
          _capped: r.bumpsDropped || 0,
        });
      }
      cappedTotal += r.bumpsDropped || 0;
      console.error(
        "  " + r.bumps.length + " bump(s): " + r.bumps.map((b) => b.package + " " + b.from + "->" + b.to).join(", ") +
          (r.bumpsDropped ? "  (+" + r.bumpsDropped + " not taken, cap " + MAX_PER_REPO + "/repo)" : "")
      );
    } catch (err) {
      rejected.push({ repo: full, reject: err.message });
      console.error("  error: " + err.message);
    }
    await sleep(300);
  }

  console.error("\n" + cases.length + " candidate upgrade(s) from " + repos.length + " repositories");
  // Never silent, the same rule batch-plan.mjs states: a pool that does not say
  // what it left out reads as the whole population. It is not - and because the
  // sort puts API-only bumps first, the part left out leans packaging, which is
  // exactly the class this benchmark's headline finding is about.
  if (cappedTotal > 0) {
    console.error(
      "::warning::" + cappedTotal + " further breaking major(s) not taken - cap is " +
        MAX_PER_REPO + " per repository, and the sort keeps API-only bumps first"
    );
  }
  for (const r of rejected) console.error("  skipped " + r.repo + ": " + r.reject);

  process.stdout.write(JSON.stringify(cases, null, 2) + "\n");

}
