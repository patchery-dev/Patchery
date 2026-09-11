#!/usr/bin/env node
/**
 * How much of the corpus stops being a break on a new enough Node?
 *
 * Eleven of our fourteen cases are `packaging` breaks, and packaging breaks have
 * a shelf life. Node 22.12 and 20.19 unflagged `require(esm)`, so a dependency
 * that went ESM-only stops being unloadable from CommonJS without a line of
 * anyone's code changing. Separately, a package that declares `engines.node
 * >= 22` is not a code break at all on Node 22 - it is a runtime the project has
 * not adopted yet, which note 103 found underneath nine of sixteen NO-CHANGE
 * legs.
 *
 * Either way the case disappears, and a benchmark whose cases evaporate as the
 * ecosystem moves is quoting a number about last year. So the rate is measured,
 * with a date, rather than argued about.
 *
 * WHAT THIS MEASURES, EXACTLY: whether the breaking version of the package can
 * be installed and `require()`d from an empty CommonJS project on the Node that
 * runs this script. Nothing more.
 *
 * WHAT IT DOES NOT MEASURE: whether the case's own repository would go green.
 * A project can load a package perfectly and still fail on an API that changed -
 * that is what our three `api` cases are - and a package that loads may still
 * break a call site. `loads` is an upper bound on disappearance for the
 * packaging half and says nothing at all about the api half. Both are reported
 * separately for that reason, and neither is summed into one headline number
 * without the split beside it.
 *
 * Needs the network. Costs no model call.
 *
 *   node scripts/disappearance.mjs                # measure, print a table
 *   node scripts/disappearance.mjs --json out.json
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

/**
 * Install one package version into a throwaway CommonJS project and require it.
 *
 * The verdict is one of:
 *   loads        required cleanly - this break has evaporated at the module level
 *   still-broken require() threw - the CommonJS entry point is still unreachable
 *   unmeasured   we could not get far enough to find out
 *
 * `unmeasured` is a third state on purpose. A registry timeout and a package
 * that refuses to load are different answers, and collapsing them would let a
 * bad network quietly lower the rate - reporting the corpus as more durable than
 * it is, which is the direction that flatters us.
 */
export function probe(pkg, version, { nodeExec = process.execPath } = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "patchery-disappear-"));
  try {
    fs.writeFileSync(
      path.join(work, "package.json"),
      JSON.stringify({ name: "probe", version: "1.0.0", private: true }, null, 2)
    );
    // Validated before it can reach a shell, not after. On Windows npm is a
    // `.cmd` and Node will not spawn one without a shell, so a shell there is
    // unavoidable - which makes this check the thing standing between a name in
    // a JSON file and a command line. The corpus is ours, and it will not stay
    // ours forever.
    if (!/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(pkg) || !/^[\w.^~><=*|\s-]+$/.test(String(version))) {
      return { verdict: "unmeasured", why: "refusing to install a name this script cannot vouch for: " + pkg + "@" + version };
    }
    const install = spawnSync(
      "npm",
      ["install", pkg + "@" + version, "--no-audit", "--no-fund", "--loglevel=error"],
      { cwd: work, encoding: "utf8", timeout: 180000, shell: process.platform === "win32" }
    );
    if (install.status !== 0) {
      // Never an empty reason. The first version of this printed "install
      // failed:" with nothing after it for all fourteen cases, because npm had
      // not run at all and so had written nothing to either stream - and a blank
      // reason is the shape of a measurement nobody can act on.
      const said =
        firstLine((install.stderr || install.stdout || "").trim()) ||
        (install.error ? String(install.error.message) : "") ||
        "npm exited " + install.status + (install.signal ? " on " + install.signal : "") + " and said nothing";
      return { verdict: "unmeasured", why: "install failed: " + said };
    }
    // The engines field, read from what was actually installed rather than from
    // the registry - a package can be installed despite EBADENGINE, and npm only
    // warns. This is the other way a case disappears: the code was never the
    // problem, the runtime was.
    let engines = "";
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(work, "node_modules", pkg, "package.json"), "utf8"));
      engines = (meta.engines && meta.engines.node) || "";
    } catch {
      engines = "";
    }

    // require(), in a child, because a module that throws on load would take
    // this process with it. CommonJS deliberately: the whole question is whether
    // a CJS project can reach it.
    const script = "require(" + JSON.stringify(pkg) + "); console.log('LOADED');";
    const r = spawnSync(nodeExec, ["-e", script], { cwd: work, encoding: "utf8", timeout: 60000 });
    if (r.status === 0 && /LOADED/.test(r.stdout || "")) return { verdict: "loads", why: "", engines };
    return { verdict: "still-broken", why: firstLine((r.stderr || "").trim()), engines };
  } catch (err) {
    return { verdict: "unmeasured", why: String(err?.message ?? err) };
  } finally {
    try {
      fs.rmSync(work, { recursive: true, force: true });
    } catch {
      // A temp directory we could not remove is not a measurement problem.
    }
  }
}

const firstLine = (s) => String(s).split("\n").find((l) => l.trim()) || "";

export function renderReport(rows, { node = process.version, when = new Date().toISOString().slice(0, 10) } = {}) {
  const out = [];
  out.push("# Disappearance rate of the benchmark corpus", "");
  out.push("Measured " + when + " on Node " + node + ".", "");
  out.push("| case | package | class | verdict | engines | why |", "|---|---|---|---|---|---|");
  for (const r of rows) {
    out.push(
      "| " + r.repo + " | " + r.package + "@" + r.version + " | " + r.class + " | " + r.verdict +
        " | " + (r.engines || "") + " | " + (r.why || "").slice(0, 60) + " |"
    );
  }
  out.push("");

  const by = (cls, verdict) => rows.filter((r) => r.class === cls && r.verdict === verdict).length;
  const n = (cls) => rows.filter((r) => r.class === cls).length;
  const measured = rows.filter((r) => r.verdict !== "unmeasured").length;

  out.push("## The number", "");
  out.push(
    "**" + rows.filter((r) => r.verdict === "loads").length + " of " + rows.length +
      "** cases install and `require()` cleanly on Node " + node + "."
  );
  out.push("");
  out.push("Split, because the two halves mean different things:");
  out.push("");
  out.push("- packaging: **" + by("packaging", "loads") + " of " + n("packaging") + "** load. For these, loading IS the break, so this is the disappearance rate.");
  out.push("- api: **" + by("api", "loads") + " of " + n("api") + "** load. For these it means nothing - the break is a changed API at a call site, and a package that loads can still break it.");
  if (measured < rows.length) {
    out.push("");
    out.push(
      "**" + (rows.length - measured) + " case(s) could not be measured** and are counted in neither figure. " +
        "A registry failure is not evidence that a break survived."
    );
  }
  out.push("");
  out.push(
    "Upper bound, not the answer: a package loading does not make the case's own suite go green. " +
      "That needs the repository at its pinned commit, which this does not run."
  );
  return out.join("\n");
}

const isMain = process.argv[1] && process.argv[1].endsWith("disappearance.mjs");
if (isMain) {
  const cases = JSON.parse(fs.readFileSync(path.join(REPO, "benchmark", "cases.json"), "utf8"));
  const rows = [];
  for (const c of cases) {
    const pkg = c.package;
    const version = c["breaking-version"];
    process.stderr.write("probing " + pkg + "@" + version + " ... ");
    const r = probe(pkg, version);
    process.stderr.write(r.verdict + "\n");
    rows.push({ repo: c.repo, package: pkg, version, class: c._class || "", ...r });
  }
  const report = renderReport(rows);
  console.log(report);
  const ji = process.argv.indexOf("--json");
  if (ji >= 0 && process.argv[ji + 1]) {
    fs.writeFileSync(process.argv[ji + 1], JSON.stringify({ node: process.version, when: new Date().toISOString(), rows }, null, 2));
    process.stderr.write("wrote " + process.argv[ji + 1] + "\n");
  }
}
