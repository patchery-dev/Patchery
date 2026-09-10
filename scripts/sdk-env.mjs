/**
 * Patchery - make sure the SDK's child process finds the Node we are running on.
 *
 * The SDK starts Claude Code by spawning the bare string `"node"`:
 *
 *     sdk.mjs:8601  executable: options.executable ?? (isRunningWithBun() ? "bun" : "node")
 *     sdk.mjs:7789  const spawnCommand = isNative ? pathToClaudeCodeExecutable : executable;
 *
 * A bare name is resolved from PATH, so which Node the child gets has nothing to
 * do with which Node the parent is running on. On a runner where
 * `actions/setup-node` has put Node 16 at the front of PATH, our script runs on
 * Node 20 and its grandchild opens on Node 16. Claude Code needs 18+, so it dies
 * at startup, and until stderr was piped it died without saying so.
 *
 * Measured on 2026-09-10 with Node 16.20.2 ahead of Node 24 on PATH, which is
 * what setup-node does to a runner:
 *
 *     ReferenceError: ReadableStream is not defined
 *         at .../claude-agent-sdk/cli.js:228:18617
 *
 * `ReadableStream` became a global in Node 18. Six legs of run #13 died this way
 * in about eight seconds each.
 *
 * This is also why `77d33f1` did not help. That commit was right - it stopped
 * asking PATH for our own Node and asked the runner instead - but it fixed the
 * parent. The death is one process further down, and the fix never reached it.
 *
 * ## Why PATH and not `executable`
 *
 * The obvious move is `executable: process.execPath`, and it is wrong. The type
 * is three strings, not a path:
 *
 *     runtimeTypes.d.ts:193  executable?: 'node' | 'bun';
 *     runtimeTypes.d.ts:303  executable?: 'bun' | 'deno' | 'node';
 *
 * Nothing validates it at run time (`options.executable ?? ...`), so a path
 * would probably work today and break on the SDK's next release, silently, in
 * the same place. Putting our Node's directory at the front of the child's PATH
 * uses a documented input to reach the same result, and it is one line.
 */

import path from "node:path";

/**
 * A copy of `env` whose PATH starts with the directory holding `execPath`.
 *
 * Copy, not mutation: the SDK deletes keys from the object it is handed
 * (`delete env.NODE_OPTIONS`, `sdk.mjs:7782`), and handing it `process.env`
 * itself would mean the SDK editing our own process's environment.
 *
 * @param {Record<string, string|undefined>} env the environment to start from, normally process.env
 * @param {string} execPath the running Node binary, normally process.execPath
 * @returns {Record<string, string|undefined>} a new object; unchanged copy if there is nothing to do
 */
export function withOwnNodeFirst(env = {}, execPath = "") {
  const copy = { ...env };
  const dir = execPath ? path.dirname(String(execPath)) : "";
  // No directory to add is not an error - it is a runtime we cannot name, and
  // the child is better off with the PATH it would have had than with a broken
  // one. Every failure in this file falls back to "change nothing".
  if (!dir || dir === "." || dir === path.sep) return copy;

  // Windows spells it `Path`, and a plain object - unlike process.env, which is
  // a case-insensitive proxy there - would then carry BOTH `Path` and `PATH`,
  // leaving the child to pick one. Find whatever name is already in use and
  // keep it.
  const key = Object.keys(copy).find((k) => k.toLowerCase() === "path") ?? "PATH";
  const current = copy[key] ?? "";

  // Already at the front: adding it again is harmless but makes the variable
  // grow every time a run nests, and PATH has a length limit on Windows.
  const first = current.split(path.delimiter)[0] ?? "";
  if (samePath(first, dir)) return copy;

  copy[key] = current ? dir + path.delimiter + current : dir;
  return copy;
}

/**
 * Whether two path strings name the same directory, as far as we can tell
 * without touching the disk.
 *
 * Deliberately shallow - it decides only whether to skip a prepend that would
 * have been redundant. Getting it wrong costs one duplicated PATH entry, never
 * a wrong Node.
 */
function samePath(a, b) {
  const norm = (p) => {
    const resolved = path.normalize(String(p ?? "").trim()).replace(/[\\/]+$/, "");
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return Boolean(a) && norm(a) === norm(b);
}

/**
 * One line for the run summary saying which Node the child will find.
 *
 * Printed because CLAUDE.md rule 5.4 asks for it - every environment assumption
 * goes in the run's own summary - and because this is the assumption that was
 * wrong for six legs while every summary looked fine.
 *
 * @param {string} execPath normally process.execPath
 * @returns {string}
 */
export function childNodeLine(execPath = "") {
  if (!execPath) return "agent runtime: unknown - the child will resolve `node` from PATH";
  return "agent runtime: " + execPath + " (put at the front of the child's PATH)";
}
