#!/usr/bin/env node
/**
 * Works out WHICH directory of a repository a break lives in.
 *
 * In a single-package repository this is always ".". In a monorepo it is not,
 * and the difference is the single biggest thing standing between this tool and
 * most modern projects: the root package.json of an n8n or a joplin is a
 * coordinator, not the product. The dependency that broke is declared three
 * levels down, its tests run there, and a run pointed at the root measures a
 * package that never imported the thing.
 *
 * `find-bumps` already flags these ("monorepo - may need target-dir") and then
 * leaves it to a human, which means in practice it is never set.
 *
 * Two independent signals, both mechanical, no model:
 *
 *   1. WHICH WORKSPACE DECLARES IT. Whoever lists the package in their
 *      dependencies is who calls it.
 *   2. WHERE THE ERROR POINTS. A test failure names files. The one that is
 *      inside the repository and outside node_modules is the code that broke.
 *
 * When they agree, that is as close to certain as this gets. When only one
 * speaks, it is used and said so. When they disagree, both are reported and
 * neither is chosen - a wrong directory produces a verdict about a package that
 * was never involved, which is exactly the class of wrong answer this project
 * keeps finding in its own output.
 *
 * Returning null is a legitimate answer and the default when nothing is clear.
 */

/** Normalise a path for comparison: forward slashes, no leading "./". */
export function normDir(p) {
  return String(p || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
}

/**
 * The workspaces whose package.json lists this dependency.
 *
 * `manifests` is `[{ dir, deps }]` where deps is the merged dependencies and
 * devDependencies. The root counts like any other: a monorepo that declares the
 * package at the root really does own it there.
 */
export function workspacesDeclaring(packageName, manifests) {
  const name = String(packageName || "").trim();
  if (!name) return [];
  return (manifests || [])
    .filter((m) => m && m.deps && Object.prototype.hasOwnProperty.call(m.deps, name))
    .map((m) => normDir(m.dir) || ".");
}

/**
 * Repository-relative file paths named in test output.
 *
 * Excludes node_modules: those paths are the dependency's own files, and on the
 * ES-module breaks that dominate this benchmark the FIRST path in the message is
 * always the dependency - "require() of ES Module <node_modules/...> from
 * <our file>". Taking it would point every monorepo at the wrong place.
 */
export function repoPathsInOutput(output, root = "") {
  const text = String(output || "").replace(/\\/g, "/");
  const rootPrefix = normDir(root);
  const out = [];
  const seen = new Set();
  // Absolute or relative paths ending in a source-ish extension.
  for (const m of text.matchAll(/[\w./-]*\/[\w.-]+\.[cm]?[jt]sx?\b/g)) {
    let p = m[0];
    if (/(^|\/)node_modules\//.test(p)) continue;
    if (rootPrefix && p.includes(rootPrefix + "/")) p = p.slice(p.indexOf(rootPrefix + "/") + rootPrefix.length + 1);
    p = p.replace(/^\/+/, "");
    if (!p || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

/**
 * The deepest workspace directory that contains this file.
 *
 * The workspace is matched ANYWHERE along the path, not only at its start,
 * because a stack trace prints an absolute path and we do not reliably know how
 * deep the checkout sits ("/home/runner/work/case/packages/core/src/read.js").
 * Requiring a prefix match there quietly found nothing, fell back to the root,
 * and the root then read as a second signal contradicting the first - a
 * disagreement invented by our own path handling rather than by the repository.
 *
 * Matching is on whole segments, so "packages/core" cannot be found inside
 * "packages/core-utils". It could still be found inside "vendor/packages/core",
 * which is a real but rare miss and one that costs a directory, not a verdict:
 * a wrong hit here disagrees with the declaration signal and produces null.
 *
 * "." is the weakest possible answer - a file that belongs to no workspace
 * belongs to the root - so any real workspace outranks it.
 */
export function ownerOf(relPath, dirs) {
  const segs = normDir(relPath).split("/").filter(Boolean);
  let best = null;
  for (const raw of dirs || []) {
    const d = normDir(raw) || ".";
    if (d === ".") {
      if (best === null) best = ".";
      continue;
    }
    const want = d.split("/").filter(Boolean);
    // The workspace must end before the file itself, hence segs.length - want.length.
    for (let i = 0; i + want.length < segs.length; i++) {
      if (want.every((w, j) => segs[i + j] === w)) {
        if (best === null || best === "." || d.length > best.length) best = d;
        break;
      }
    }
  }
  return best;
}

/**
 * The directory to run in, and why.
 *
 * Returns `{ dir, why, agreed }`. `dir` is null when the signals disagree or
 * neither speaks - guessing here is worse than asking, because the run would
 * still produce a confident-looking verdict.
 */
export function chooseTargetDir({ packageName, manifests = [], output = "", root = "" } = {}) {
  const declaring = workspacesDeclaring(packageName, manifests);
  const dirs = manifests.map((m) => normDir(m.dir) || ".");

  let fromStack = null;
  for (const p of repoPathsInOutput(output, root)) {
    const owner = ownerOf(p, dirs);
    if (owner) {
      fromStack = owner;
      break;
    }
  }

  // Only one workspace declares it, and nothing contradicts that.
  if (declaring.length === 1 && (!fromStack || fromStack === declaring[0])) {
    return {
      dir: declaring[0],
      agreed: Boolean(fromStack),
      why: fromStack
        ? "`" + packageName + "` is declared in " + declaring[0] + ", and the failure points there too"
        : "`" + packageName + "` is declared only in " + declaring[0],
    };
  }

  // Several declare it - the failure says which one actually broke.
  if (declaring.length > 1 && fromStack && declaring.includes(fromStack)) {
    return {
      dir: fromStack,
      agreed: true,
      why:
        declaring.length + " workspaces declare `" + packageName + "`; the failure is in " + fromStack,
    };
  }

  // Nothing declares it anywhere we can see, but the failure is unambiguous.
  if (declaring.length === 0 && fromStack) {
    return {
      dir: fromStack,
      agreed: false,
      why: "no workspace declares `" + packageName + "`, but the failure is in " + fromStack,
    };
  }

  return {
    dir: null,
    agreed: false,
    why:
      declaring.length && fromStack
        ? "declared in " + declaring.join(", ") + " but the failure is in " + fromStack + " - refusing to guess"
        : declaring.length
        ? "declared in " + declaring.join(", ") + " and nothing says which one broke - refusing to guess"
        : "nothing declares `" + packageName + "` and the failure names no file we own",
  };
}

/**
 * Command line, for the half of the design that only exists once something has
 * run: `find-bumps` resolves what it can from declarations alone, and a case it
 * could not settle arrives here with the test output that names the file.
 *
 *   node scripts/target-dir.mjs --package content-type --root case --output test.log
 *
 * Prints the directory on stdout and the reasoning on stderr, so a workflow can
 * capture one without losing the other. Exits 1 with no stdout when the answer
 * is unknown - a caller must not be able to read silence as ".".
 */
const isMain = process.argv[1] && process.argv[1].endsWith("target-dir.mjs");
if (isMain) {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const argv = process.argv.slice(2);
  const flag = (n) => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : null;
  };
  const packageName = flag("--package");
  const root = flag("--root") || ".";
  const outputFile = flag("--output");

  const manifests = [];
  const walk = (dir, rel, depth) => {
    if (depth > 5) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && e.name === "package.json")) {
      try {
        const json = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
        manifests.push({
          dir: rel || ".",
          deps: { ...(json.dependencies || {}), ...(json.devDependencies || {}) },
        });
      } catch {
        // An unparseable manifest is not a workspace we can reason about.
      }
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name === "node_modules" || e.name.startsWith(".")) continue;
      walk(path.join(dir, e.name), rel ? rel + "/" + e.name : e.name, depth + 1);
    }
  };
  walk(root, "", 0);

  let output = "";
  if (outputFile) {
    try {
      output = fs.readFileSync(outputFile, "utf8");
    } catch {
      // No output file is the declaration-only case, which is still an answer.
    }
  }

  const r = chooseTargetDir({ packageName, manifests, output, root });
  console.error(
    "target-dir: " + (r.dir === null ? "unknown" : r.dir) +
      " — " + r.why +
      " (" + manifests.length + " manifest(s)" + (r.agreed ? ", both signals agree" : "") + ")"
  );
  if (r.dir === null) process.exit(1);
  console.log(r.dir);
}
