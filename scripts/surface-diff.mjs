#!/usr/bin/env node
/**
 * What a package stopped offering, what it started offering, and which half of
 * that your code actually touches.
 *
 * This is the only part of Patchery that does not need your tests to go red
 * first, and it exists because of a measurement: Express 5 - one of the most
 * widely known breaking releases in this ecosystem - was installed into four
 * projects that depend on it and NOT ONE test suite noticed. A break your suite
 * never exercises is a break the rest of this product never sees.
 *
 * Running the upgrade earlier does not fix that. Running it on the bump PR, or
 * on a schedule, still asks the same question - "did the tests go red?" - just
 * sooner. The only way to see what the tests cannot is to read the package
 * instead of running it.
 *
 * TWO ANSWERS, ONE READING. A release note says "foo() is gone, use bar()", and
 * that single sentence is both halves of what a maintainer wants to know: what
 * is about to break, and what is newly available. Libraries publish both in the
 * same place, so one comparison answers both.
 *
 * NO PROSE IS PARSED, DELIBERATELY. An earlier sketch read CHANGELOG.md and
 * looked for words like "removed" and "deprecated". That is guessing dressed as
 * analysis: changelogs are unstructured, inconsistent, and frequently absent -
 * `which@7` ships none at all, which a run in the benchmark discovered the
 * expensive way. This compares what the two versions EXPORT. Names are facts.
 *
 * WHAT THIS MAY AND MAY NOT SAY. It may say "this name is gone and your code
 * uses it". It may not say "your project will break" - a name can survive with
 * different behaviour, and a name can vanish from a file we did not read. The
 * published sentence stays what it has always been: we tell you what your tests
 * would have caught, not what will break.
 */

import fs from "node:fs";
import path from "node:path";
import { packageBindings } from "./guard.mjs";

/** Comments hide nothing useful here and confuse every pattern below. */
function withoutComments(text) {
  return String(text || "")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

const IDENT = "[A-Za-z_$][\\w$]*";

/**
 * The names a module offers to whoever imports it.
 *
 * Covers the shapes a published package actually uses - CommonJS assignment,
 * ES module declarations and re-exports, and TypeScript declaration files -
 * and nothing else.
 *
 * The list is a FLOOR, for the same reason importSites' count is: these are
 * regexes, so a surface built at runtime (`Object.assign(exports, table)`, a
 * name from a variable, a proxy) is not seen. A name missing from this list
 * therefore means "not found", never "not offered", and every caller has to
 * treat it that way - which is why nothing here returns a verdict.
 */
export function publicNames(rawText = "") {
  const text = withoutComments(rawText);
  const names = new Set();
  const add = (n) => {
    const name = String(n || "").trim();
    if (name && new RegExp("^" + IDENT + "$").test(name)) names.add(name);
  };

  // `export function foo`, `export const foo`, `export class Foo`,
  // and the TypeScript declaration forms `export declare function foo`.
  for (const m of text.matchAll(
    new RegExp("\\bexport\\s+(?:declare\\s+)?(?:async\\s+)?(?:function\\*?|const|let|var|class|interface|type|enum)\\s+(" + IDENT + ")", "g")
  )) add(m[1]);

  // `export { a, b as c }` - the exported name is the one on the right.
  for (const m of text.matchAll(/\bexport\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(",")) {
      const aliased = part.match(new RegExp("\\bas\\s+(" + IDENT + ")\\s*$"));
      add(aliased ? aliased[1] : part.trim());
    }
  }

  // `export default` offers exactly one thing, under a name the importer picks.
  if (/\bexport\s+default\b/.test(text)) add("default");

  // `exports.foo =` and `module.exports.foo =`.
  for (const m of text.matchAll(new RegExp("\\b(?:module\\.)?exports\\.(" + IDENT + ")\\s*=", "g"))) add(m[1]);

  // `module.exports = { a, b: x, c }` - the key is the offered name.
  for (const m of text.matchAll(/\bmodule\.exports\s*=\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(",")) {
      const key = part.split(":")[0].trim();
      add(key);
    }
  }

  return [...names].sort();
}

/**
 * The file this one just hands its exports to, if that is all it does.
 *
 * Express is the reason this exists. Its entry file is one line -
 * `module.exports = require("./lib/express")` - so a reader that stops at the
 * entry sees ZERO names and reports zero changes, which is indistinguishable
 * from a package that changed nothing. Measured on express 4.22.2 against
 * 5.2.1: no names either side, and no names in common, because none were read.
 *
 * A report of "nothing found" that comes from not looking is the exact failure
 * this project has a rule about, so the chain is followed and the depth is
 * bounded and reported rather than assumed.
 */
export function reexportTarget(rawText = "") {
  const text = withoutComments(rawText);
  const cjs = /module\.exports\s*=\s*require\(\s*['\"](\.[^'\"]*)['\"]\s*\)\s*;?/.exec(text);
  if (cjs) return cjs[1];
  const esm = /export\s+\*\s+from\s+['\"](\.[^'\"]*)['\"]/.exec(text);
  if (esm) return esm[1];
  const dflt = /export\s*\{\s*default\s*\}\s*from\s+['\"](\.[^'\"]*)['\"]/.exec(text);
  return dflt ? dflt[1] : null;
}

/**
 * Where a package's names actually live, following re-exports.
 *
 * `read(relativePath)` returns the file's text or null. Injected rather than
 * imported so the walk is testable without a package on disk - the same reason
 * every other decision in this project takes its input rather than fetching it.
 *
 * Returns the text AND the trail, because "we followed four hops and the last
 * one was missing" and "the entry had no exports" are different answers and a
 * caller that cannot tell them apart will report the wrong one.
 */
export function surfaceText(entry, read, maxHops = 5) {
  const trail = [];
  let at = entry;
  for (let hop = 0; hop <= maxHops; hop++) {
    const text = read(at);
    trail.push({ path: at, found: text != null });
    if (text == null) return { text: "", trail, why: "file not found: " + at };
    const next = reexportTarget(text);
    if (!next) return { text, trail, why: null };
    at = next;
  }
  return { text: "", trail, why: "re-export chain deeper than " + maxHops + " hops" };
}

/**
 * The names a package has marked as on their way out.
 *
 * The other half of the same reading, and the half surfaceDiff cannot see: a
 * deprecated name is still exported, so nothing disappears and the comparison
 * finds nothing. It is also the earlier warning - a maintainer who learns today
 * that a function they call is deprecated has until the next major to move,
 * instead of finding out when it is already gone.
 *
 * THIS ONE IS STRUCTURED, WHICH IS WHY IT IS ALLOWED. The rest of this file
 * refuses to read prose, and a changelog is prose. `@deprecated` is not: it is a
 * JSDoc tag, written by the package author, in a fixed place, next to the thing
 * it describes. Verified on a real package - mocha annotates its legacy plugin
 * errors exactly this way, with the replacement named in an {@link}.
 *
 * The note is carried through verbatim rather than summarised, because the
 * author's own sentence usually names what to use instead, and a summary of it
 * would be us inventing a migration.
 */
export function deprecatedNames(rawText = "") {
  const text = String(rawText || "");
  const out = [];
  const seen = new Set();

  // A JSDoc block containing @deprecated, and whatever it is attached to.
  for (const m of text.matchAll(/\/\*\*([\s\S]*?)\*\/\s*([^\n]*)/g)) {
    const [, body, declaration] = m;
    if (!/@deprecated\b/.test(body)) continue;

    const name =
      // export function foo / export declare const foo
      new RegExp("\\bexport\\s+(?:declare\\s+)?(?:async\\s+)?(?:function\\*?|const|let|var|class)\\s+(" + IDENT + ")").exec(declaration)?.[1] ??
      // exports.foo = / module.exports.foo =
      new RegExp("\\b(?:module\\.)?exports\\.(" + IDENT + ")\\s*=").exec(declaration)?.[1] ??
      // function foo( / const foo = / class Foo
      new RegExp("\\b(?:async\\s+)?(?:function\\*?|const|let|var|class)\\s+(" + IDENT + ")").exec(declaration)?.[1] ??
      // foo: value, inside an exported object literal
      new RegExp("^\\s*(" + IDENT + ")\\s*:").exec(declaration)?.[1] ??
      null;
    if (!name || seen.has(name)) continue;
    seen.add(name);

    // The author's own words, minus the tags and the box drawing.
    const note = body
      .split(/\n/)
      .map((l) => l.replace(/^\s*\*ent?\s?/, "").replace(/^\s*\*\s?/, "").trim())
      .filter((l) => l && !/^@(?!deprecated)/.test(l))
      .join(" ")
      .replace(/@deprecated\s*/g, "")
      .replace(/\s+/g, " ")
      .trim();
    out.push({ name, note });
  }
  return out;
}

/**
 * What changed between two versions of a package's surface.
 *
 * Pure, and it takes text rather than paths so the decision can be tested
 * without a registry, a network or an install.
 */
export function surfaceDiff(beforeText = "", afterText = "") {
  const before = publicNames(beforeText);
  const after = publicNames(afterText);
  const afterSet = new Set(after);
  const beforeSet = new Set(before);
  return {
    removed: before.filter((n) => !afterSet.has(n)),
    added: after.filter((n) => !beforeSet.has(n)),
    kept: before.filter((n) => afterSet.has(n)),
  };
}

/**
 * Which of a package's names one of your files actually touches.
 *
 * Two shapes, because both are ordinary:
 *
 *   const { formatPrice } = require("pkg")   -> the destructured name IS the name
 *   const lib = require("pkg"); lib.foo()    -> the name is reached through lib
 *
 * The second is why this cannot be answered by packageBindings alone: it returns
 * the LOCAL names a file binds, and `lib` is not a name the package offers.
 */
export function packageMemberUse(rawText = "", packageName = "", surface = []) {
  const text = withoutComments(rawText);
  const found = packageBindings(text, packageName);
  const offered = new Set(surface);
  const used = new Set();

  // A binding that is itself an offered name was destructured out of the package.
  for (const b of found.bindings) if (offered.has(b)) used.add(b);

  // Anything reached through a binding: `lib.foo`, `lib.foo()`, `lib["foo"]`.
  for (const b of found.bindings) {
    const esc = b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    for (const m of text.matchAll(new RegExp("\\b" + esc + "\\s*\\.\\s*(" + IDENT + ")", "g"))) {
      if (offered.has(m[1])) used.add(m[1]);
    }
    for (const m of text.matchAll(new RegExp("\\b" + esc + "\\s*\\[\\s*['\"]([^'\"]+)['\"]\\s*\\]", "g"))) {
      if (offered.has(m[1])) used.add(m[1]);
    }
  }

  return [...used].sort();
}

/**
 * The report: what is gone that you use, and what is new.
 *
 * `atRisk` is the sentence worth paying for. `added` is the other half of the
 * same reading, and it is kept separate because the two are different kinds of
 * news and running them together would let the alarming one borrow urgency for
 * the informative one.
 *
 * `files` is `{path, text}[]` - the project's own source, never node_modules.
 */
export function upgradeSurfaceReport({
  packageName = "",
  beforeText = "",
  afterText = "",
  files = [],
  // Where to look for @deprecated, when that is not the entry file.
  //
  // MEASURED, and it killed the first version of this: mocha keeps its
  // deprecation tags in lib/errors.js, and neither mocha nor chai ships a .d.ts.
  // Reading only the entry found ZERO on both - a check that had never once
  // fired on a real package while looking like it worked.
  //
  // Widening the search is safe because of what happens to the result: a name
  // is only reported if it is ALSO in the public surface and ALSO used by the
  // caller's code, so an internal function marked deprecated never reaches a
  // reader.
  deprecationText = null,
} = {}) {
  const diff = surfaceDiff(beforeText, afterText);
  const gone = new Set(diff.removed);
  const atRisk = [];

  // Deprecations are read from the NEW version only. A name the old version
  // already called deprecated is not news brought by this upgrade, and telling
  // someone about it here would attach an old warning to a new decision.
  const deprecated = deprecatedNames(deprecationText ?? afterText);
  const deprecatedByName = new Map(deprecated.map((d) => [d.name, d.note]));
  const surviving = new Set(diff.kept.concat(diff.added));
  const fading = [];

  for (const f of files || []) {
    const used = packageMemberUse(f.text || "", packageName, diff.removed);
    const hit = used.filter((n) => gone.has(n));
    if (hit.length) atRisk.push({ path: f.path, names: hit });

    // Still there, still callable, and marked as on its way out. surfaceDiff
    // cannot see this one at all - nothing disappeared.
    const stillUsed = packageMemberUse(f.text || "", packageName, [...surviving]);
    for (const n of stillUsed) {
      if (!deprecatedByName.has(n)) continue;
      fading.push({ path: f.path, name: n, note: deprecatedByName.get(n) });
    }
  }

  return {
    package: packageName,
    removed: diff.removed,
    added: diff.added,
    atRisk,
    // Named separately from atRisk on purpose. "Gone" and "going" are different
    // urgencies, and a report that ran them together would either panic a reader
    // about a deprecation or bury a removal underneath one.
    fading,
    deprecated: deprecated.map((d) => d.name),
    // Counted, not judged. Zero at-risk files is not "safe to upgrade" - it is
    // "we found no use of a removed name", and the difference is the whole
    // Express finding.
    searched: (files || []).length,
  };
}

/**
 * The report as text a maintainer reads, or "" when there is nothing to say.
 *
 * The boundary sentence is not decoration and is not optional: without it, "your
 * tests stayed green" reads as "safe to upgrade", which is exactly the claim the
 * Express measurement disproves.
 */
export function renderSurfaceReport(report) {
  const hasSomething =
    report &&
    (report.atRisk?.length || report.added?.length || report.removed?.length || report.fading?.length);
  if (!hasSomething) return "";
  const out = [];
  const pkg = "`" + report.package + "`";

  if (report.atRisk?.length) {
    out.push("**" + pkg + " removed something your code uses.**", "");
    for (const f of report.atRisk) {
      out.push("- `" + f.path + "` uses " + f.names.map((n) => "`" + n + "`").join(", "));
    }
    out.push(
      "",
      "Your test suite may not notice this. We installed Express 5 into four projects " +
        "that depend on it and not one suite went red, which is why this check reads the " +
        "package instead of waiting for your tests."
    );
  } else if (report.removed?.length) {
    out.push(
      "**" + pkg + " removed " + report.removed.length + " name(s), and we found none of them in your source** " +
        "(searched " + report.searched + " file(s)). That is where we looked, not a verdict that " +
        "the upgrade is safe."
    );
  }

  if (report.fading?.length) {
    out.push("", "**Still there, but marked deprecated - and your code uses it.**", "");
    for (const d of report.fading) {
      const note = d.note ? " - " + d.note : "";
      out.push("- `" + d.path + "` uses `" + d.name + "`" + note);
    }
    out.push(
      "",
      "Nothing breaks today. This is the earlier warning: the name is still exported, " +
        "so a comparison of what the two versions offer would not have found it."
    );
  }

  if (report.added?.length) {
    out.push("", "**New in this version:** " + report.added.map((n) => "`" + n + "`").join(", ") + ".");
  }

  out.push(
    "",
    "_Names only. A name that survives can still behave differently, and this reads " +
      "the files it was given - it does not run anything._"
  );
  return out.join("\n");
}

/**
 * Where a package says its entry point is.
 *
 * `exports` before `main` before `index.js`, because that is Node's own order,
 * and the string form of `exports` before its object form. Express 5 declares
 * neither and relies on the default, which is exactly the case a hand-written
 * shortcut would have missed.
 */
export function entryPath(pkgJson = {}) {
  const e = pkgJson.exports;
  if (typeof e === "string") return "./" + String(e).replace(/^\.\//, "");
  if (e && typeof e === "object") {
    const dot = e["."] ?? e;
    const pick = typeof dot === "string" ? dot : dot?.require ?? dot?.default ?? dot?.node;
    if (typeof pick === "string") return "./" + pick.replace(/^\.\//, "");
  }
  if (typeof pkgJson.main === "string" && pkgJson.main) return "./" + pkgJson.main.replace(/^\.\//, "");
  return "./index.js";
}

/** A reader over a directory on disk, with Node's own extension guesses. */
export function dirReader(dir, io = fs, join = path.join) {
  return (rel) => {
    const base = join(dir, String(rel).replace(/^\.\//, ""));
    for (const candidate of [base, base + ".js", base + ".cjs", base + ".mjs", join(base, "index.js")]) {
      try {
        return io.readFileSync(candidate, "utf8");
      } catch {}
    }
    return null;
  };
}

/**
 * Every JavaScript file a package ships, concatenated, bounded.
 *
 * For the deprecation scan only, and bounded twice - file count and total bytes -
 * because a package like a bundled test runner ships megabytes of generated code
 * and reading all of it would turn a fast check into a slow one for no gain. What
 * is skipped is not announced to the reader, and that is deliberate: nothing here
 * claims completeness, and the report never says a package has no deprecations.
 */
export function packageBodyText(dir, io = fs, join = path.join, maxFiles = 300, maxBytes = 2_000_000) {
  const parts = [];
  let bytes = 0;
  let seen = 0;
  const walk = (at) => {
    if (seen >= maxFiles || bytes >= maxBytes) return;
    let entries = [];
    try {
      entries = io.readdirSync(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (seen >= maxFiles || bytes >= maxBytes) return;
      const full = join(at, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === "test" || e.name === "__tests__") continue;
        walk(full);
      } else if (/\.(?:js|mjs|cjs|d\.ts|ts)$/i.test(e.name) && !/\.map$/i.test(e.name)) {
        try {
          const text = io.readFileSync(full, "utf8");
          seen++;
          bytes += text.length;
          parts.push(text);
        } catch {}
      }
    }
  };
  walk(dir);
  return parts.join("\n");
}

/** Both halves of the comparison, read off two installed copies. */
export function readPackageSurface(dir, io = fs, join = path.join) {
  let pkgJson = {};
  try {
    pkgJson = JSON.parse(io.readFileSync(join(dir, "package.json"), "utf8"));
  } catch {
    return { text: "", trail: [], why: "no package.json in " + dir, version: null };
  }
  const found = surfaceText(entryPath(pkgJson), dirReader(dir, io, join));
  return { ...found, version: pkgJson.version ?? null };
}

if (process.argv[1] && process.argv[1].endsWith("surface-diff.mjs")) {
  const [beforeDir, afterDir, ...sourceDirs] = process.argv.slice(2);
  if (!beforeDir || !afterDir) {
    console.error("usage: surface-diff.mjs <old-package-dir> <new-package-dir> [source-dir...]");
    process.exit(2);
  }
  const before = readPackageSurface(beforeDir);
  const after = readPackageSurface(afterDir);
  for (const [label, side] of [["old", before], ["new", after]]) {
    if (side.why) console.error("[" + label + "] could not read the surface: " + side.why);
  }
  // Named from the new copy, because that is the one being offered to you.
  let name = "the package";
  try {
    name = JSON.parse(fs.readFileSync(path.join(afterDir, "package.json"), "utf8")).name || name;
  } catch {}

  const files = [];
  const walk = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === ".git") continue;
        walk(full);
      } else if (/\.(?:js|mjs|cjs|jsx|ts|tsx|mts|cts)$/i.test(e.name)) {
        try {
          files.push({ path: full, text: fs.readFileSync(full, "utf8") });
        } catch {}
      }
    }
  };
  for (const d of sourceDirs) walk(d);

  const report = upgradeSurfaceReport({
    packageName: name,
    beforeText: before.text,
    afterText: after.text,
    files,
    deprecationText: packageBodyText(afterDir),
  });
  console.log(renderSurfaceReport(report) || "Nothing to report: no names left, arrived or matched.");
}
