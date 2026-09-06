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

async function api(url) {
  const res = await fetch(url, { headers });
  if (res.status === 403 || res.status === 429) {
    const reset = res.headers.get("x-ratelimit-reset");
    throw new Error(
      "rate limited" + (reset ? " until " + new Date(Number(reset) * 1000).toLocaleTimeString() : "") +
      (token ? "" : " - set GITHUB_TOKEN to raise the limit")
    );
  }
  if (!res.ok) throw new Error(res.status + " " + res.statusText + " for " + url);
  return res.json();
}

/** The test script disqualifies a target when running it rewrites the working tree. */
function testScriptWrites(script = "") {
  return /(^|\s)(-u|--updateSnapshot|--fix|--write|-w)(\s|$)/.test(script);
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

  if (pkg.workspaces) return { ...out, reject: "monorepo (workspaces)" };
  const test = pkg.scripts?.test || "";
  out.test = test;
  if (isPlaceholderTest(test)) return { ...out, reject: "no real test script" };
  if (testScriptWrites(test)) return { ...out, reject: "test script rewrites files: " + test };
  out.package = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).length;
  return out;
}

const seen = new Set();
const kept = [];
const rejected = [];

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
      (r.reject ? rejected : kept).push(r);
    } catch (err) {
      rejected.push({ repo: full, sha: item.sha, reject: err.message });
      if (/rate limited/.test(err.message)) break;
    }
    await sleep(800);
  }
  await sleep(7000); // the search endpoint is the tighter limit
}

kept.sort((a, b) => b.stars - a.stars);

console.log("\n=== SURVIVED THE FILTER (" + kept.length + ") ===\n");
for (const c of kept) {
  console.log("repo        : " + c.repo + "  (" + c.stars + " stars)");
  console.log("fix commit  : " + c.sha.slice(0, 10) + "   " + c.date);
  console.log("PIN TO      : " + c.before);
  console.log("test command: npm test   ->  " + c.test);
  console.log("last push   : " + (c.pushed || "?"));
  console.log("files fixed : " + (c.files || []).slice(0, 6).join(", "));
  console.log("still to check BY HAND: does `npm test` actually FAIL at the pinned commit?\n");
}

console.log("=== REJECTED (" + rejected.length + ") ===");
const why = {};
for (const r of rejected) why[r.reject] = (why[r.reject] || 0) + 1;
for (const [reason, n] of Object.entries(why).sort((a, b) => b[1] - a[1])) {
  console.log("  " + String(n).padStart(3) + "  " + reason);
}
