/**
 * Safety rules and run-state analysis — every function here is pure.
 *
 * Kept in its own module because this is the most critical part of the product:
 * it has to be testable offline, without a model call (see scripts/selftest.mjs).
 * Anything in agent.mjs that decides "is this safe / is this going anywhere"
 * should live here instead, so a regression test can pin it down.
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

/**
 * Did the test command fail because it does not exist, rather than because the
 * code is broken? A missing script is a configuration mistake by whoever set the
 * workflow up, and it must not be mistaken for "this project is broken, send in
 * the agent" — that wastes a whole paid run on a typo.
 *
 * Real example: activepieces' openai piece had no tests at all, only a build.
 *
 * @param {string} output combined stdout+stderr of the test command
 * @param {number|null} exitCode
 * @returns {string|null} short reason, or null if the command really did run
 */
export function testCommandLooksUnavailable(output, exitCode) {
  const o = String(output || "");
  if (/npm error Missing script|npm ERR! Missing script|Missing script:/i.test(o)) {
    return "npm reports a missing script";
  }
  if (/Command "[^"]*" not found|error Command "[^"]*" not found/i.test(o)) {
    return "the package manager has no such script";
  }
  if (/No tasks were executed|No projects matched the filters/i.test(o)) {
    return "the monorepo task runner matched no task";
  }
  if (/command not found|is not recognized as an internal or external command|No such file or directory/i.test(o)) {
    return "the command does not exist on this runner";
  }
  // 127 is the conventional shell exit code for "command not found".
  if (exitCode === 127) return "the shell could not find the command (exit 127)";
  return null;
}

/**
 * Does this output look like a dependency-resolution deadlock rather than a
 * code problem? If so, the agent could only have fixed it by editing a lockfile,
 * which the guard forbids — so the run was doomed, and saying "protected path
 * touched" hides the real reason.
 *
 * @param {string} output
 * @returns {boolean}
 */
export function looksLikeDependencyConflict(output) {
  return /ERESOLVE|could not resolve dependency|unable to resolve dependency tree|ERR_PNPM_PEER_DEP_ISSUES|peer dep(endency)? conflict|incorrect peer dependency/i.test(
    String(output || "")
  );
}

/**
 * Redact obvious secrets before anything is written to a log or a PR body.
 *
 * Deliberately not exhaustive — the goal is "catch the obvious ones" so a stray
 * key in a test fixture or an error message does not end up published in a pull
 * request. Pass `extraValues` (e.g. the run's own auth token) to redact literal
 * values that no pattern would catch.
 *
 * @param {string} text
 * @param {string[]} [extraValues] literal strings to blank out
 * @returns {string}
 */
export function redactSecrets(text, extraValues = []) {
  let s = String(text ?? "");

  for (const value of extraValues) {
    const v = String(value || "");
    // Only redact values long enough to be a real credential, so a short or
    // empty env var cannot blank out half the log.
    if (v.length < 12) continue;
    s = s.split(v).join("[REDACTED]");
  }

  const patterns = [
    /\bsk-[A-Za-z0-9_-]{16,}/g, // OpenAI / Anthropic style
    /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens
    /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
    /\bAIza[A-Za-z0-9_-]{20,}/g, // Google API keys
    /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack
    /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
    /\bBearer\s+[A-Za-z0-9._-]{20,}/g,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  ];
  for (const re of patterns) s = s.replace(re, "[REDACTED]");

  // KEY=value / "token": "value" style assignments, where the name itself says
  // this is a credential. Keeps the name so the log still makes sense.
  s = s.replace(
    /\b([A-Za-z0-9_]*(?:API_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL)[A-Za-z0-9_]*)(\s*[:=]\s*)(["']?)([^\s"'&]{8,})\3/gi,
    (_m, name, sep, quote) => name + sep + quote + "[REDACTED]" + quote
  );

  return s;
}

/**
 * Watches the agent's tool calls and decides whether it has stopped making
 * progress. Without this, a confused agent burns its entire turn budget (and
 * your money) re-reading the same files — observed for real: 25 turns, $0.88,
 * zero output.
 *
 * Two independent signals, both deliberately simple so the behaviour stays
 * predictable:
 *   - the exact same tool call (same tool, same arguments) is made `repeats` times
 *   - `noEditTurns` turns in a row use tools but never edit anything
 *
 * @param {{repeats?: number, noEditTurns?: number}} [options]
 */
export function createStallDetector({ repeats = 3, noEditTurns = 8 } = {}) {
  const seen = new Map();
  let turnsWithoutEdit = 0;

  return {
    /**
     * Record one assistant turn.
     * @param {Array<{name: string, input: unknown}>} toolUses tool calls in this turn
     * @returns {string|null} reason to stop, or null to keep going
     */
    observeTurn(toolUses) {
      const calls = Array.isArray(toolUses) ? toolUses : [];
      if (calls.length === 0) return null; // a text-only turn is not evidence either way

      const edited = calls.some((c) => c.name === "Edit" || c.name === "Write");
      turnsWithoutEdit = edited ? 0 : turnsWithoutEdit + 1;

      for (const call of calls) {
        let signature;
        try {
          signature = call.name + ":" + JSON.stringify(call.input);
        } catch {
          signature = call.name + ":<unserializable>";
        }
        const count = (seen.get(signature) ?? 0) + 1;
        seen.set(signature, count);
        if (count >= repeats) {
          return (
            "the same " + call.name + " call was repeated " + count + " times without making progress"
          );
        }
      }

      if (turnsWithoutEdit >= noEditTurns) {
        return turnsWithoutEdit + " turns in a row used tools but changed nothing";
      }
      return null;
    },
  };
}
