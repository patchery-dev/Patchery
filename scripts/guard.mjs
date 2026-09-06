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
  return new Set(parsePorcelainEntries(porcelain).map((e) => e.path));
}

/**
 * Same parse, but keeps the status field. The status is what tells a deletion
 * apart from an edit, and a deletion is the change most likely to destroy work
 * that had nothing to do with the migration.
 *
 * @param {string} porcelain
 * @returns {Array<{status: string, path: string, deleted: boolean}>}
 */
export function parsePorcelainEntries(porcelain) {
  if (!porcelain || !porcelain.trim()) return [];
  return porcelain
    .split("\n")
    .map((line) => {
      const m = line.match(/^([ MADRCU?!]{1,2}) (.*)$/);
      const status = m ? m[1] : "";
      const p = (m ? m[2] : line).trim().replace(/^"|"$/g, "");
      return { status, path: p, deleted: status.includes("D") };
    })
    .filter((e) => e.path);
}

/** Normalise a path for comparison: forward slashes, no leading "./", no trailing "/". */
function normalisePath(p) {
  return String(p ?? "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
}

/**
 * Does `relPath` sit inside `dir`? An empty dir (or ".") means the whole repo.
 */
function isInside(relPath, dir) {
  const d = normalisePath(dir);
  if (d === "" || d === ".") return true;
  const p = normalisePath(relPath);
  return p === d || p.startsWith(d + "/");
}

/**
 * Is this change outside the area the agent was told to work in?
 *
 * The agent is told "work only inside target-dir", but a prompt is a request,
 * not a guarantee - and anything else running on the machine can dirty the tree
 * mid-run too. Whatever the cause, a change the operator did not ask for must
 * not ride along into a pull request unnoticed.
 *
 * `allowedPaths` is the escape hatch for the real case this would otherwise
 * break: a monorepo where fixing `packages/api` legitimately means touching the
 * root `package.json`. Entries are repo-root-relative files or directories; a
 * trailing `/**` or `/*` is accepted and ignored (the directory is what counts).
 *
 * @param {string} relPath repo-root-relative path
 * @param {string} targetDir repo-root-relative target directory ("" or "." = whole repo)
 * @param {string[]} [allowedPaths]
 * @returns {string|null} reason, or null if the change is in scope
 */
export function outOfScopeReason(relPath, targetDir, allowedPaths = []) {
  if (isInside(relPath, targetDir)) return null;
  for (const allowed of allowedPaths) {
    const cleaned = normalisePath(allowed).replace(/\/\*\*?$/, "");
    if (cleaned === "") continue;
    if (isInside(relPath, cleaned)) return null;
  }
  const target = normalisePath(targetDir) || ".";
  return "outside the target directory (" + target + ")";
}

/**
 * Splits a newline/comma separated input into a list of paths.
 * @param {string} raw
 * @returns {string[]}
 */
export function parsePathList(raw) {
  return String(raw ?? "")
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
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
 * What to say when the tests pass but the operator expected them to fail.
 *
 * Usually that means there is genuinely nothing to fix. But when the run was
 * pointed at a specific documented break — a changelog or a linked issue — a
 * passing baseline is suspicious, because whether a break reproduces can depend
 * on the runtime the tests happen to run on.
 *
 * Real case: gitroomhq/postiz-agent issue #9 (node-fetch v3 is ESM-only, a CommonJS
 * `require()` throws ERR_REQUIRE_ESM) is real and still reproduces for the reporter
 * on Node v22.11.0. Patchery ran the same tests on Node v24 — where `require()` of a
 * synchronous ES module has been supported since v22.12.0 — and saw them pass. The
 * break was real; our runtime hid it. Nothing distinguished that false negative from
 * "there was never anything wrong", which is the gap this closes.
 *
 * @param {{testCommand: string, changelog?: string, nodeVersion?: string}} opts
 * @returns {string} the message to show
 */
export function baselinePassedMessage({ testCommand, changelog, nodeVersion } = {}) {
  const cmd = "`" + String(testCommand ?? "the test command") + "`";
  const plain = cmd + " already passes - nothing to fix. The agent was not run.";
  if (!String(changelog ?? "").trim()) return plain;

  const runtime = String(nodeVersion ?? "").trim();
  return (
    plain +
    "\n\nWorth a second look: you pointed this run at a specific documented break" +
    (runtime ? ", and the tests ran on Node " + runtime : "") +
    ". Whether a break reproduces can depend on the runtime - a fix that landed in a " +
    "newer Node, or a transitive dependency that resolved differently, can hide a real " +
    "failure. If the linked changelog or issue describes a version-specific break, set " +
    "`node-version` to the version it was reported on and run again. If it does not, " +
    "this really is nothing to fix."
  );
}

/** JSON.stringify with object keys sorted, so payload key order cannot fake novelty. */
function stableStringify(value) {
  try {
    return JSON.stringify(value, (_k, v) =>
      v && typeof v === "object" && !Array.isArray(v)
        ? Object.keys(v)
            .sort()
            .reduce((acc, k) => ((acc[k] = v[k]), acc), {})
        : v
    );
  } catch {
    return "<unserializable>";
  }
}

/**
 * Normalise a path for use in an evidence key, stripping the target directory.
 * The SDK reports absolute paths while a Grep argument is repo-relative; without
 * this one file would become two keys and re-reading it would look like progress.
 * The prefix compare is case-insensitive because Windows drive letters and casing
 * must not split a key either.
 */
function normaliseKeyPath(p, root = "") {
  let out = normalisePath(p);
  const r = normalisePath(root);
  if (r && out.toLowerCase().startsWith(r.toLowerCase() + "/")) out = out.slice(r.length + 1);
  else if (r && out.toLowerCase() === r.toLowerCase()) out = "";
  return out;
}

/**
 * Canonical form of a shell command, for comparison only. Collapses whitespace,
 * drops a trailing ";" and a leading "cd <dir> && " — where a command runs is not
 * a discovery, what it runs is.
 *
 * Deliberately stops there. A normaliser aggressive enough to merge "ls -l" and
 * "ls -la" would also merge two genuinely different greps.
 *
 * @param {string} command
 * @returns {string}
 */
export function canonicalCommand(command) {
  return String(command ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/;+$/, "")
    .replace(/^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*&&\s*/, "")
    .trim();
}

/**
 * Does this shell command write to the working tree? Narrow and explicit on
 * purpose — a false positive here would let a real loop reset its own counter.
 *
 * @param {string} command
 * @returns {boolean}
 */
export function bashLooksMutating(command) {
  const c = String(command ?? "");
  if (/\bsed\s+[^|;]*-i\b/.test(c)) return true;
  if (/\bperl\s+[^|;]*-p?i\b/.test(c)) return true;
  if (/(^|[;&|]\s*)(patch|tee)\b/.test(c)) return true;
  // A redirect to anything but /dev/null writes a file.
  if (/>>?\s*(?!\/dev\/null)\S/.test(c)) return true;
  return false;
}

/** A bare read command (cat/head/tail/...) reduced to the file it reads, or null. */
function bashReadTarget(command) {
  const m = canonicalCommand(command).match(
    /^(?:cat|head|tail|less|bat|type)((?:\s+-\w+(?:\s+\d+)?|\s+-\d+)*)\s+("[^"]+"|'[^']+'|[^\s|;&><]+)$/
  );
  if (!m) return null;
  return m[2].replace(/^["']|["']$/g, "");
}

/**
 * What did this tool call let the agent SEE, and did it change anything?
 *
 * `keys` are canonical identity strings: two calls that would return the same
 * information produce the same key, and anything else produces a different one.
 * Both the repeat rule and the novelty rule read these, so the whole file has one
 * definition of "the same thing".
 *
 * `writes` are the paths this call changes. `edits` is true for the edit tools and
 * for a mutating shell command — a `sed -i` is an edit even though no Edit tool ran.
 *
 * @param {{name: string, input: unknown}} call
 * @param {string} [root] target directory, stripped from paths (case-insensitive)
 * @returns {{keys: string[], writes: string[], edits: boolean}}
 */
export function toolEvidence(call, root = "") {
  const name = String(call?.name ?? "");
  const input = call?.input ?? {};
  const p = (v) => normaliseKeyPath(v ?? "", root);

  if (name === "Read") {
    const key = "read:" + p(input.file_path);
    // A different offset is a different part of the file, so a different discovery.
    // `limit` is not: the same window read wider is the same question.
    return { keys: [key + (input.offset == null ? "" : "@" + input.offset)], writes: [], edits: false };
  }

  if (name === "Edit" || name === "Write" || name === "MultiEdit" || name === "NotebookEdit") {
    const file = p(input.file_path ?? input.notebook_path);
    // The whole input, not just the path: two different hunks in one file are two
    // discoveries, while the identical edit three times is still a repeat.
    return { keys: ["write:" + file + "|" + stableStringify(input)], writes: [file], edits: true };
  }

  if (name === "Grep") {
    // output_mode / -i / -n / -C / head_limit are dropped: the same search shown
    // differently is not a new question.
    return {
      keys: [
        "grep:" +
          String(input.pattern ?? "") +
          "|" + p(input.path) +
          "|" + String(input.glob ?? "") +
          "|" + String(input.type ?? ""),
      ],
      writes: [],
      edits: false,
    };
  }

  if (name === "Glob") {
    return { keys: ["glob:" + String(input.pattern ?? "") + "|" + p(input.path)], writes: [], edits: false };
  }

  if (name === "Bash") {
    const command = String(input.command ?? "");
    const readTarget = bashReadTarget(command);
    // `cat src/a.js` and `Read src/a.js` are one discovery, not two.
    if (readTarget) return { keys: ["read:" + p(readTarget)], writes: [], edits: false };
    return { keys: ["exec:" + canonicalCommand(command)], writes: [], edits: bashLooksMutating(command) };
  }

  return { keys: [name + ":" + stableStringify(input)], writes: [], edits: false };
}

/**
 * Watches the agent's tool calls and decides whether it has stopped making progress.
 *
 * Without this a confused agent burns its whole turn budget re-reading the same
 * files — observed for real: 25 turns, $0.88, nothing produced.
 *
 * The first version also had the opposite failure, which is why this one exists.
 * It stopped on "N turns in a row without an edit", and three real runs against
 * dwmkerr/terminal-ai (limits 15, 22 and 40) were each cut off in the turn before
 * the edit, having repeated nothing: every turn read a different file, ran a
 * different command, made a different search. "Has not edited yet" is not a stall
 * signal. Repeating work already done is.
 *
 * Three signals, all reading one map of evidence keys:
 *   - repeat:  the same key seen `repeats` times
 *   - stale:   `staleTurns` turns in a row that discover nothing new
 *   - window:  fewer than ceil(staleTurns/2) progress turns in the last staleTurns*2,
 *              which catches the slow grind that resets the consecutive counter with
 *              one genuine discovery every few turns
 *
 * A fourth, `noEditTurns`, is the old rule. Kept so an operator who wants a hard
 * research cap can have one, but OFF by default — it is the rule that caused the
 * failure above, and `max-turns` is already the cost brake.
 *
 * @param {{repeats?: number, staleTurns?: number, noEditTurns?: number, root?: string}} [options]
 */
export function createStallDetector({ repeats = 3, staleTurns = 5, noEditTurns = 0, root = "" } = {}) {
  const seen = new Map();
  const window = [];
  const windowSize = Math.max(2, staleTurns * 2);
  const minProgressInWindow = Math.max(1, Math.ceil(staleTurns / 2));
  let barren = 0;
  let turnsWithoutEdit = 0;
  let toolTurns = 0;
  let edits = 0;
  let lastNew = [];

  return {
    /**
     * Record one assistant turn.
     * @param {Array<{name: string, input: unknown}>} toolUses tool calls in this turn
     * @returns {string|null} reason to stop, or null to keep going
     */
    observeTurn(toolUses) {
      const calls = Array.isArray(toolUses) ? toolUses : [];
      if (calls.length === 0) return null; // a text-only turn is not evidence either way
      toolTurns++;

      const evidence = calls.map((c) => toolEvidence(c, root));
      const edited = evidence.some((e) => e.edits);

      let novel = false;
      const fresh = [];
      for (let i = 0; i < calls.length; i++) {
        for (const key of evidence[i].keys) {
          const prev = seen.get(key);
          if (!prev) {
            novel = true;
            fresh.push(key);
          }
          const count = (prev?.count ?? 0) + 1;
          seen.set(key, { count, tool: calls[i].name });
          if (count >= repeats) {
            return (
              "the same " + calls[i].name + " call was repeated " + count + " times without making progress"
            );
          }
        }
      }
      lastNew = fresh;

      // An edit changes the world, so some evidence goes stale: a command re-run
      // after an edit asks a genuinely new question, and so does re-reading the
      // file just written. Without this, "edit, test, edit, test, edit, test" -
      // exactly what the agent is told to do - trips the repeat rule.
      if (edited) {
        edits++;
        for (const key of [...seen.keys()]) if (key.startsWith("exec:")) seen.delete(key);
        for (const e of evidence) {
          for (const written of e.writes) {
            for (const key of [...seen.keys()]) {
              if (key === "read:" + written || key.startsWith("read:" + written + "@")) seen.delete(key);
            }
          }
        }
      }

      turnsWithoutEdit = edited ? 0 : turnsWithoutEdit + 1;
      const progress = edited || novel;
      barren = progress ? 0 : barren + 1;
      window.push(progress);
      if (window.length > windowSize) window.shift();

      if (barren >= staleTurns) {
        return (
          barren + " turns in a row found nothing new - every file, command and search had already been seen"
        );
      }
      if (window.length === windowSize) {
        const hits = window.filter(Boolean).length;
        if (hits < minProgressInWindow) {
          return (
            "only " + hits + " of the last " + windowSize +
            " turns found anything new - the agent is going over old ground"
          );
        }
      }
      if (noEditTurns > 0 && turnsWithoutEdit >= noEditTurns) {
        return turnsWithoutEdit + " turns in a row used tools but changed nothing";
      }
      return null;
    },
    /** Counters for the log and the summary, so "it looped" reads differently from "I cut it off". */
    inspect() {
      return { toolTurns, edits, discovered: seen.size, barren, lastNew };
    },
  };
}

/**
 * The whole decision in one call: replay a transcript, return the reason it would
 * have stopped, or null. This is what pins real runs down offline — a recorded run
 * pastes in as a literal array and is re-judged for free, forever.
 *
 * @param {Array<Array<{name: string, input: unknown}>>} transcript one entry per assistant turn
 * @param {object} [options] same options as createStallDetector
 * @returns {string|null}
 */
export function stallVerdict(transcript, options = {}) {
  const detector = createStallDetector(options);
  for (const turn of transcript || []) {
    const reason = detector.observeTurn(turn);
    if (reason) return reason;
  }
  return null;
}
