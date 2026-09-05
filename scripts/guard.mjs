/**
 * Safety rule: paths the agent must never modify.
 *
 * Kept in its own module because this is the most critical part of the product —
 * it has to be testable offline, without a model call (see scripts/selftest.mjs).
 */

/**
 * @param {string} relPath path relative to the repository root
 * @returns {string|null} reason the path is off limits, or null if it is fair game
 */
export function protectedReason(relPath) {
  const p = String(relPath).replace(/\\/g, "/");
  if (/(^|\/)node_modules\//.test(p)) return "inside node_modules";
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(p)) return "test file";
  if (/(^|\/)(__tests__|__mocks__|tests?)\//.test(p)) return "inside a test directory";
  if (/(^|\/)\.github\//.test(p)) return "CI configuration";
  if (/(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(p)) return "lockfile";
  return null;
}

/**
 * Turns `git status --porcelain -uall --no-renames` output into a set of paths.
 *
 * The status field is two characters wide and either half can be a space
 * (" M path" for an unstaged edit, "M  path" for a staged one, "?? path" for an
 * untracked file). A fixed `slice(3)` therefore chops a character off the path
 * of any line whose leading space was lost — which is exactly what happened when
 * the caller trimmed the whole output. Matching the status field explicitly
 * makes this correct either way.
 *
 * @param {string} porcelain
 * @returns {Set<string>}
 */
export function parsePorcelain(porcelain) {
  if (!porcelain || !porcelain.trim()) return new Set();
  return new Set(
    porcelain
      .split("\n")
      .map((line) => {
        const m = line.match(/^([ MADRCU?!]{1,2}) (.*)$/);
        const p = (m ? m[2] : line).trim();
        return p.replace(/^"|"$/g, "");
      })
      .filter(Boolean)
  );
}
