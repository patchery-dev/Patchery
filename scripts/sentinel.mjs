#!/usr/bin/env node
/**
 * Patchery before the build breaks.
 *
 * The rest of this product starts when your tests go red. That is the right
 * moment to FIX something and the wrong moment to LEARN it: by then the upgrade
 * is already in your branch, and - measured - a great many upgrades never turn
 * anything red at all. Express 5 went into four projects that depend on it and
 * not one suite noticed.
 *
 * So there are two earlier moments, and they answer different questions.
 *
 *   ON THE BUMP PULL REQUEST (level 2). Dependabot or Renovate opens "bump X
 *   from 4 to 5". The new version is right there, unmerged. Install it in that
 *   checkout, run the suite, and answer before a human reads the PR. Nothing is
 *   wasted: this only runs when a version actually moved.
 *
 *   ON A SCHEDULE (level 3). For a repository with no bump bot, or one that
 *   wants longer notice: take each dependency with a newer major, install it in
 *   a throwaway copy, and report. Weekly is a defensible default because majors
 *   arrive a few times a year - a daily check buys the same answer seven times.
 *
 * BOTH OF THOSE STILL ASK THE TEST SUITE. The third question does not, and it
 * is the one the Express measurement forced: surface-diff.mjs compares what the
 * two versions export and tells you what disappeared that your code uses. No
 * suite is involved, so a suite that never exercises the path cannot hide it.
 *
 * THE SENTENCE THAT MAY NOT DRIFT. A green suite after an upgrade is not
 * permission to upgrade. It is "your tests did not object", and this file says
 * that in as many words every single time, because the entire brand is built on
 * not overstating - and this is the exact place a product like ours would start.
 *
 * No model is called here. Installing a package and running its tests is
 * arithmetic, not judgement; the model is only worth paying for once something
 * is actually broken and needs repairing.
 */

/**
 * Which package moved, and between which versions.
 *
 * Bump bots put it in the title and they do not agree on the wording:
 *
 *   Bump express from 4.18.2 to 5.0.0
 *   chore(deps): bump express from 4.18.2 to 5.0.0
 *   build(deps-dev): Bump @types/node from 20.1.0 to 22.0.0
 *   Update express requirement from ^4.18.2 to ^5.0.0
 *
 * Returns null rather than guessing. A wrong package name here would install
 * something nobody asked for, so an unreadable title is a reason to do nothing -
 * the same rule the version-range reader follows.
 */
export function bumpFromTitle(title = "") {
  const text = String(title || "").trim();
  const bump = /\b(?:bump|update)\s+(@?[\w.-]+(?:\/[\w.-]+)?)\s+(?:requirement\s+)?from\s+\D*([\d][\w.-]*)\s+to\s+\D*([\d][\w.-]*)/i.exec(
    text
  );
  if (!bump) return null;
  const [, name, from, to] = bump;
  // A bot that bumps several packages at once writes "the X group" or a list,
  // and this reader must not pick one of them and call it the change.
  if (/\bgroup\b|\band\b\s+\d+\s+other/i.test(text)) return null;
  return { package: name, from, to };
}

/** Is this a major move? Only a major can remove a name. */
export function isMajorMove(from = "", to = "") {
  const major = (v) => {
    const m = /^(\d+)/.exec(String(v || "").trim());
    return m ? Number(m[1]) : null;
  };
  const a = major(from);
  const b = major(to);
  if (a === null || b === null) return null;
  return b > a;
}

/**
 * What the sentinel found, in the only two shapes it can honestly take.
 *
 * `suite` is "red" | "green" | "unknown". Unknown is a real answer - a project
 * whose tests could not be run tells you nothing about the upgrade, and saying
 * "green" there would be the worst available lie.
 */
export function sentinelVerdict({ suite = "unknown", atRisk = 0 } = {}) {
  if (suite === "red") return "breaks-your-tests";
  if (suite === "unknown") return "could-not-run-your-tests";
  return atRisk > 0 ? "green-but-a-name-you-use-is-gone" : "your-tests-did-not-object";
}

/**
 * The report a maintainer reads.
 *
 * Four verdicts, four sentences, and the boundary is attached to the two that
 * would otherwise be read as approval. `surfaceText` is whatever
 * renderSurfaceReport produced, or "".
 */
export function renderSentinel({ packageName = "", from = "", to = "", verdict = "", surfaceText = "" } = {}) {
  const move = "`" + packageName + "` " + from + " -> " + to;
  const head = {
    "breaks-your-tests":
      "### " + move + " breaks your tests\n\nInstalled it and ran your suite: it went red. " +
      "This is the case Patchery exists for - the repair pass can take it from here.",
    "green-but-a-name-you-use-is-gone":
      "### " + move + " - your tests stayed green, and something you use is gone\n\n" +
      "Read both halves. The suite did not object, AND the new version no longer " +
      "offers a name your code reaches for. Those are not in conflict: a suite only " +
      "objects to what it exercises.",
    "your-tests-did-not-object":
      "### " + move + " - your tests did not object\n\n" +
      "Installed it and ran your suite: it stayed green, and we found no name your " +
      "code uses that the new version dropped.\n\n" +
      "**This is not \"safe to upgrade\".** It is the two things we checked, and both " +
      "are bounded: your suite only objects to what it exercises, and we compared " +
      "exported names, not behaviour. We installed Express 5 into four projects that " +
      "depend on it and not one suite went red.",
    "could-not-run-your-tests":
      "### " + move + " - we could not run your tests\n\n" +
      "So this says nothing about the upgrade. Reported as unknown rather than as a " +
      "pass, because an unrunnable suite and a passing suite are not the same thing.",
  }[verdict];
  if (!head) return "";
  return surfaceText ? head + "\n\n" + surfaceText : head;
}
