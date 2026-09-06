#!/usr/bin/env node
/**
 * Find candidate cases for the benchmark: real breaking changes that already
 * happened, in real repositories, where the fix is already in the history.
 *
 * Why from the past rather than the future: pinning a repository to the commit
 * BEFORE its migration answers, in advance, every question that killed the earlier
 * live attempts - is the break real, does the affected code have tests, which Node,
 * what is the right answer. All four are already settled by the repository itself.
 *
 * This does the filtering, which is where the time goes. Of ten candidates, most die
 * on one of these, and each rule is here because a real attempt died on it:
 *
 *   monorepo          activepieces - bun, workspace filters, unlinked root deps
 *   no test script    a target whose affected file had no tests at all
 *   writing tests     a `test` script carrying -u/--fix/-w rewrites files under the
 *                     agent, which the guard then reads as the agent going rogue
 *   archived/tiny     nothing to migrate, or nobody to notice
 *
 * It reports; it never decides. "Is this break real" needs a person, and the last
 * column is there for that person to fill in.
 *
 *   node scripts/find-cases.mjs "migrate to openai v4" "upgrade openai to v4"
 *
 * Unauthenticated GitHub allows ~10 searches/minute and 60 other calls/hour, which
 * is enough for one batch. Set GITHUB_TOKEN to raise it to 5000/hour.
 */
const token = (process.env.GITHUB_TOKEN || "").trim();
const headers = {
  Accept: "application/vnd.github+json",
  "User-Agent": "patchery-benchmark-candidate-finder",
  ...(token ? { Authorization: "Bearer " + token } : {}),
};

const argv = process.argv.slice(2);
const num = (flag, dflt) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : dflt;
};
// Popular and alive. A benchmark case is only worth the hour it takes to prepare if
// the repository is one a reader has heard of - and an abandoned repo proves nothing
// about whether the migration matters. The tension is real and worth naming: bigger,
// more popular projects are also likelier to be monorepos, which the filter below
// then rejects. Expect a low survival rate and do not read it as a bad search.
const MIN_STARS = num("--min-stars", 200);
const MAX_IDLE_DAYS = num("--max-idle-days", 180);
const queries = argv.filter((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));
if (queries.length === 0) {
  console.error('Usage: node scripts/find-cases.mjs "migrate to openai v4" [more phrases...]');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Waits out a rate limit rather than dropping the query. The search endpoint allows
// 30/minute even with a token, so a run over several packages WILL hit it, and the
// first version simply lost those searches - silently turning "no candidates" into
// "no candidates I bothered to look for", which is the kind of result that reads as
// evidence and is not.
async function api(url, attempt = 0) {
  const res = await fetch(url, { headers });
  if (res.status === 403 || res.status === 429) {
    const reset = Number(res.headers.get("x-ratelimit-reset") || 0) * 1000;
    const waitMs = Math.min(Math.max(reset - Date.now() + 2000, 5000), 90000);
    if (attempt < 3) {
      console.error("  rate limited, waiting " + Math.round(waitMs / 1000) + "s...");
      await sleep(waitMs);
      return api(url, attempt + 1);
    }
    throw new Error(
      "rate limited after 3 waits" + (token ? "" : " - set GITHUB_TOKEN to raise the limit")
    );
  }
  if (!res.ok) throw new Error(res.status + " " + res.statusText + " for " + url);
  return res.json();
}

/** The test script disqualifies a target when running it rewrites the working tree. */
function testScriptWrites(script = "") {
  return /(^|\s)(-u|--updateSnapshot|--fix|--write|-w)(\s|$)/.test(script);
}

/** Did this commit change code, or only the things that surround code? */
function touchesSource(files = []) {
  return (files || []).some(
    (f) =>
      /\.(m|c)?[jt]sx?$|\.vue$|\.svelte$/.test(f) &&
      !/^(package(-lock)?\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(f) &&
      !/(^|\/)\.github\//.test(f) &&
      !/(^|\/)(CHANGELOG|README)/i.test(f)
  );
}

function isPlaceholderTest(script = "") {
  return !script.trim() || /no test specified/i.test(script);
}

async function inspect(repoFullName, sha) {
  const out = { repo: repoFullName, sha, reject: null, test: "", stars: 0 };
  const repo = await api("https://api.github.com/repos/" + repoFullName);
  out.stars = repo.stargazers_count ?? 0;
  if (repo.archived) return { ...out, reject: "archived" };
  if (out.stars < MIN_STARS) return { ...out, reject: "under " + MIN_STARS + " stars" };
  const idleDays = (Date.now() - Date.parse(repo.pushed_at)) / 86400000;
  if (idleDays > MAX_IDLE_DAYS) {
    return { ...out, reject: "no push in " + Math.round(idleDays) + " days" };
  }
  out.pushed = (repo.pushed_at || "").slice(0, 10);
  if (repo.fork) return { ...out, reject: "fork" };

  // The parent of the migration commit IS the case: the repository as it was the
  // moment before someone fixed it.
  const commit = await api("https://api.github.com/repos/" + repoFullName + "/commits/" + sha);
  const parent = commit.parents?.[0]?.sha;
  if (!parent) return { ...out, reject: "no parent commit (root commit)" };
  out.before = parent;
  out.date = commit.commit?.author?.date?.slice(0, 10) || "";
  out.files = (commit.files || []).map((f) => f.filename);

  let pkg;
  try {
    const file = await api(
      "https://api.github.com/repos/" + repoFullName + "/contents/package.json?ref=" + parent
    );
    pkg = JSON.parse(Buffer.from(file.content, "base64").toString("utf8"));
  } catch {
    return { ...out, reject: "no package.json at the parent commit" };
  }

  // Flagged, not rejected. The monorepo rule was written for "pick a target for an
  // unattended run", where the tooling friction is the whole cost. These cases are
  // prepared by hand over half an hour each, and `target-dir` / `test-command` /
  // `allowed-paths` exist precisely for this - activepieces died on bun and Windows
  // path limits, not on the idea. A recognisable name is worth the setup work, and
  // recognisable repositories are almost all monorepos.
  if (pkg.workspaces) out.note = "monorepo - needs target-dir and a narrow test-command";
  const test = pkg.scripts?.test || "";
  out.test = test;
  if (isPlaceholderTest(test)) return { ...out, reject: "no real test script" };
  if (testScriptWrites(test)) return { ...out, reject: "test script rewrites files: " + test };
  out.package = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).length;
  return out;
}


/**
 * The higher-signal source: a bot's own major-version bump whose CI went red.
 *
 * Commit-message search asks "did someone write down that they migrated", which
 * selects for small projects that narrate their commits and against large ones that
 * write "chore(deps): bump x". This asks a different question - "did a major bump
 * break someone's build" - and the answer carries three guarantees the other search
 * has to hope for: the break is real, tests exist, and they fail. A red check IS the
 * failing baseline the action requires.
 *
 * It maps onto the case setup exactly: the PR's base commit is what to pin to, and
 * the version it was bumping to is what to install.
 *
 * The caveat is real and stays in the output: a red check is not proof the TESTS
 * failed, still less that they failed because of this package. Lint, a missing CI
 * secret and an already-broken pipeline all look identical from here.
 */
async function fromBotBumps(pkg) {
  const found = [];
  for (const bot of ["app/dependabot", "app/renovate"]) {
    let items = [];
    try {
      const res = await api(
        "https://api.github.com/search/issues?per_page=50&q=" +
          encodeURIComponent('is:pr author:' + bot + ' status:failure in:title "bump ' + pkg + ' from"')
      );
      items = res.items || [];
    } catch (err) {
      console.error("  bump search failed (" + bot + "): " + err.message);
      continue;
    }
    for (const it of items) {
      // "Bump openai from 6.1.0 to 7.0.1" -> majors 6 and 7. Only a crossing counts:
      // a minor bump that reddens CI is a flaky pipeline, not a breaking change.
      const m = (it.title || "").match(/from\s+(\d+)\.[\d.]+\s+to\s+(\d+)\.[\d.]+/i);
      if (!m || m[1] === m[2]) continue;
      const parts = (it.html_url || "").split("/");
      found.push({
        repo: parts[3] + "/" + parts[4],
        pr: it.html_url,
        pkg,
        fromMajor: m[1],
        toMajor: m[2],
      });
    }
    await sleep(2500);
  }
  return found;
}

const seen = new Set();
const kept = [];
const rejected = [];


const DEPS = argv.includes("--deps");
if (DEPS) {
  for (const pkg of queries) {
    console.error("· " + pkg + " (bot bumps with red CI)");
    let hits = [];
    try { hits = await fromBotBumps(pkg); } catch (e) { console.error("  " + e.message); }
    console.error("  " + hits.length + " major-crossing bump(s)");
    for (const h of hits) {
      if (seen.has(h.repo)) continue;
      seen.add(h.repo);
      try {
        const pr = await api("https://api.github.com/repos/" + h.repo + "/pulls/" + h.pr.split("/").pop());
        const r = await inspect(h.repo, pr.base.sha);
        Object.assign(r, { pr: h.pr, bump: h.pkg + " v" + h.fromMajor + " -> v" + h.toMajor });
        (r.reject ? rejected : kept).push(r);
      } catch (err) {
        rejected.push({ repo: h.repo, reject: err.message });
        if (/rate limited/.test(err.message)) break;
      }
      await sleep(400);
    }
  }
} else {
for (const q of queries) {
  let items = [];
  try {
    const res = await api(
      "https://api.github.com/search/commits?per_page=30&q=" + encodeURIComponent('"' + q + '"')
    );
    items = res.items || [];
  } catch (err) {
    console.error("search failed for " + JSON.stringify(q) + ": " + err.message);
    continue;
  }
  console.error("· " + q + " -> " + items.length + " commit(s)");
  for (const item of items) {
    const full = item.repository?.full_name;
    if (!full || seen.has(full)) continue;
    seen.add(full);
    try {
      const r = await inspect(full, item.sha);
      // A "migration" that changed no source file is not a migration. Four of the
      // first five survivors were exactly this: the major bump touched only
      // package.json, the lockfile, a changelog or a CI config, which means the new
      // version needed no call-site changes at all. There is nothing there for an
      // agent to get right or wrong, and the case would measure nothing.
      //
      // Only meaningful for a human's fix commit. In --deps mode the commit is the
      // bot's own bump, which by definition touches nothing else - whether code had
      // to change is the question the case exists to ask.
      if (!r.reject && !touchesSource(r.files)) {
        r.reject = "the fix changed no source file - this bump needed no migration";
      }
      (r.reject ? rejected : kept).push(r);
    } catch (err) {
      rejected.push({ repo: full, sha: item.sha, reject: err.message });
      if (/rate limited/.test(err.message)) break;
    }
    await sleep(800);
  }
  await sleep(7000); // the search endpoint is the tighter limit
}
}

kept.sort((a, b) => b.stars - a.stars);

console.log("\n=== SURVIVED THE FILTER (" + kept.length + ") ===\n");
for (const c of kept) {
  console.log("repo        : " + c.repo + "  (" + c.stars + " stars)");
  if (c.bump) console.log("bump        : " + c.bump + "   " + c.pr);
  console.log("fix commit  : " + String(c.sha).slice(0, 10) + "   " + (c.date || ""));
  console.log("PIN TO      : " + c.before);
  console.log("test command: npm test   ->  " + c.test);
  console.log("last push   : " + (c.pushed || "?"));
  if (c.note) console.log("note        : " + c.note);
  console.log("files fixed : " + (c.files || []).slice(0, 6).join(", "));
  console.log("still to check BY HAND: does `npm test` actually FAIL at the pinned commit?\n");
}

console.log("=== REJECTED (" + rejected.length + ") ===");
const why = {};
for (const r of rejected) why[r.reject] = (why[r.reject] || 0) + 1;
for (const [reason, n] of Object.entries(why).sort((a, b) => b[1] - a[1])) {
  console.log("  " + String(n).padStart(3) + "  " + reason);
}
