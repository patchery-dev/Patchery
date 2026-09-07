#!/usr/bin/env node
/**
 * Refuses a tagline that says one thing on one surface and another next door.
 *
 * This is not tidiness. Four separate inconsistencies were found by hand on one
 * evening, all of them the same shape - a surface was updated and its sibling
 * was not:
 *
 *   the licence changed, and the hero badge still said "open source" (759f27d)
 *   the README told people to install `@v1`, and the only tag was v0 (d28fea1)
 *   the README said 388 checks, and the suite ran 474 (7169b59)
 *   the positioning changed, the share card kept the old pitch, and its alt
 *   text described a third thing (8bf6916)
 *
 * Every one was found by a person reading two files side by side, which is not
 * a mechanism. The claim now lives on five surfaces - the site, this README,
 * the profile README, action.yml's Marketplace description, and the share card
 * - and nothing but attention kept them together.
 *
 * What is compared is the CORE of the tagline: the problem, and what Patchery
 * does about it. Everything after that is allowed to differ, because it
 * genuinely does - the site's meta description adds where it runs, the README
 * adds the refusal - and a check that demanded identical sentences everywhere
 * would be switched off within a week.
 *
 * Two surfaces are outside this repository and cannot be checked from here: the
 * profile README, and the pixels inside og.png. The alt text of that image IS
 * checked, and it is what said the third thing.
 */

import fs from "node:fs";
import path from "node:path";

/** Markup, entities and typography out; what a reader would hear, in. */
export function normaliseClaim(text) {
  return String(text || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&trade;|&reg;/g, "")
    .replace(/&mdash;|&ndash;/g, "-")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/[—–]/g, "-")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The first two claims a tagline makes, as one comparable string.
 *
 * Split on clause boundaries, not on "." alone: the same claim is punctuated
 * three different ways across these surfaces ("for your code.", "for your
 * code,", "for your code -") and none of those is a difference in what is being
 * said.
 */
export function taglineCore(text) {
  // The share card names the product before making the claim. The label is not
  // one of the claims.
  const t = normaliseClaim(text).replace(/^Patchery\s*[-:]\s*/i, "");
  const units = t
    .split(/[.,;:]|\s-\s/)
    .map((u) => u.trim())
    .filter(Boolean);
  return units.slice(0, 2).join(". ");
}

/** Everything in this repository that states the tagline, by name. */
export function taglineSurfaces(files = {}) {
  // Every one of these files is CRLF on Windows, where a pattern anchored to a
  // bare newline matches nothing - and a check that finds no surfaces reports
  // agreement, having found nobody to disagree.
  const lf = (v) => String(v || "").replace(/\r\n/g, "\n");
  const readme = lf(files.readme);
  const action = lf(files.action);
  const site = lf(files.site);

  const out = [];
  // A surface whose tagline cannot be found is reported with found: false, not
  // dropped. "I could not read it" and "it agrees" must never look the same.
  const push = (name, raw, present) => {
    if (!present) return;
    out.push({ name, core: raw ? taglineCore(raw) : "", said: normaliseClaim(raw), found: Boolean(raw) });
  };

  // The one bold sentence under the logo.
  push("README.md", (/<strong>([\s\S]*?)<\/strong>/.exec(readme) || [])[1], readme);

  // action.yml's description is the Marketplace listing - the surface a reader
  // meets before any of the others.
  push("action.yml", (/^description:[ \t]*>-?[ \t]*\n((?:[ \t]+\S.*\n)+)/m.exec(action) || [])[1], action);

  const meta = (property) => {
    const re = new RegExp('<meta [^>]*(?:name|property)="' + property + '" content="([^"]*)"', "i");
    return (re.exec(site) || [])[1];
  };
  push("site <h1>", (/<h1 class="display display--hero">([\s\S]*?)<\/h1>/.exec(site) || [])[1], site);
  push("site description", meta("description"), site);
  push("site og:description", meta("og:description"), site);
  // The one that said a third thing. og.png itself cannot be read from here;
  // its alt text is the closest thing to a check on the picture.
  push("site og:image:alt", meta("og:image:alt"), site);
  push("site twitter:description", meta("twitter:description"), site);
  return out;
}

/**
 * Which surfaces disagree with the rest.
 *
 * The majority is taken as the intended wording, because drift is one surface
 * being forgotten, not five being rewritten. With no majority every surface is
 * reported: a two-two split is not something to guess about.
 */
export function taglineDrift(surfaces) {
  const list = surfaces.filter((s) => s.found);
  if (list.length < 2) return [];
  const counts = new Map();
  for (const s of list) counts.set(s.core, (counts.get(s.core) || 0) + 1);
  if (counts.size === 1) return [];
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const tied = ranked[0][1] === ranked[1][1];
  const top = ranked[0][0];
  return list
    .filter((s) => tied || s.core !== top)
    .map((s) => ({ name: s.name, core: s.core, expected: tied ? null : top }));
}

const isMain = process.argv[1] && process.argv[1].endsWith("check-claims.mjs");
if (isMain) {
  const read = (p) => {
    try {
      return fs.readFileSync(p, "utf8");
    } catch {
      return "";
    }
  };
  const root = process.argv[2] || ".";
  const surfaces = taglineSurfaces({
    readme: read(path.join(root, "README.md")),
    action: read(path.join(root, "action.yml")),
    site: read(path.join(root, "docs", "index.html")),
  });

  const missing = surfaces.filter((s) => !s.found);
  const drift = taglineDrift(surfaces);

  for (const m of missing) {
    console.error(m.name + ": states the tagline, and this check could not find it.");
  }
  if (drift.length > 0) {
    console.error("The tagline does not say the same thing on every surface:\n");
    for (const d of drift) {
      console.error("  " + d.name + "\n    says     " + d.core);
      if (d.expected) console.error("    others   " + d.expected);
    }
  }
  if (missing.length > 0 || drift.length > 0) {
    console.error(
      "\nFour inconsistencies of exactly this shape were found by hand in one evening,\n" +
        "each one a surface updated while its sibling was forgotten. Two more surfaces\n" +
        "are outside this repository - the profile README and the pixels in og.png -\n" +
        "and this check cannot see either; update them by hand in the same pass."
    );
    process.exit(1);
  }
  console.log("tagline: " + surfaces.length + " surface(s) saying the same thing");
}
