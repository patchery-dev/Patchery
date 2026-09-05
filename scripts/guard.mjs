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
 * @param {string} porcelain
 * @returns {Set<string>}
 */
export function parsePorcelain(porcelain) {
  if (!porcelain || !porcelain.trim()) return new Set();
  return new Set(
    porcelain
      .split("\n")
      .map((line) => line.slice(3).trim().replace(/^"|"$/g, ""))
      .filter(Boolean)
  );
}
