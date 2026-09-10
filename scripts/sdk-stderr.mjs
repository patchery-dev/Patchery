/**
 * Patchery - the Agent SDK's stderr, made readable.
 *
 * The SDK spawns Claude Code as a child process, and unless it is asked for
 * something else that child's stderr is opened as `"ignore"`:
 *
 *     sdk.mjs:7605  const stderrMode =
 *                     env.DEBUG_CLAUDE_AGENT_SDK || this.options.stderr ? "pipe" : "ignore";
 *
 * `"ignore"` is not "we did not print it", it is "the operating system threw it
 * away". That is why six legs of run #13 died in eight seconds and left the run
 * a single line - `process exited with code 1` - with no cause attached. The
 * child had almost certainly said why; nobody was listening.
 *
 * There are two ways to open it and only one of them is usable here. Setting
 * `DEBUG_CLAUDE_AGENT_SDK` opens the same branch, but the SDK then writes the
 * output to `~/.claude/debug/sdk-<uuid>.txt` (`sdk.mjs:7539`) - a random name,
 * outside the workspace, so it is not in the artifact and cannot be found by
 * the next session. The typed `options.stderr` callback
 * (`runtimeTypes.d.ts:512`) hands us the text instead, and we put it where the
 * rest of the run already goes.
 *
 * The one hard rule this file exists to keep: **the callback must not throw.**
 * It runs on the child's `data` event inside the SDK. One exception there and
 * the listener is gone, which means the failure we opened stderr to read would
 * take the reading of it down with it - and it would do so silently, looking
 * exactly like a child that said nothing. So every path below is wrapped, and a
 * writer that throws is dropped rather than retried.
 */

/**
 * A line that names a thrown thing, as opposed to one that locates it.
 *
 * Node prints an uncaught exception as four parts, in this order: the file and
 * line, the source line it died on, a caret, and only then the error. So the
 * FIRST line of a crash is a path, and the line worth quoting is the fourth.
 * Measured on the real failure - the first line was
 * `file:///.../cli.js:228`, the fourth was
 * `ReferenceError: ReadableStream is not defined`, and only the fourth says
 * anything.
 *
 * Deliberately narrow, and the fallback is the first line: a pattern that
 * guesses wrong here does not lose the evidence, it only picks a worse quote.
 */
const THROWN = /^(?:[A-Z][A-Za-z0-9_$]*(?:Error|Exception)\b|FATAL ERROR\b|panic:|Uncaught\b)/;

/** Trim a line and cut it to length, saying how much was cut. "" if it was blank. */
function cut(line, max) {
  const trimmed = String(line ?? "").trim();
  if (!trimmed || trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max) + " ... [+" + (trimmed.length - max) + " chars]";
}

/**
 * Collect the child process's stderr, line by line.
 *
 * Line by line and not chunk by chunk because a chunk is a read boundary, not a
 * message: a crash message can arrive split across two `data` events, and the
 * first line - the one that names the cause - is exactly the one that gets cut
 * in half. Anything still in the buffer when the run ends is released by
 * `flush()`, because a process that dies at startup usually dies mid-line,
 * without the newline that would have ended it.
 *
 * Lines are also cut to `maxLineChars`. Not a nicety: measured on the real
 * failure, the second line of a Node crash is the source line it crashed on,
 * and the SDK's `cli.js` is a bundle whose "lines" are hundreds of kilobytes.
 * Uncut, one stderr line turned a 3 KB run log into 108 KB, and the useful
 * content of that line was its first eighty characters.
 *
 * @param {object} [opts]
 * @param {string} [opts.label] which SDK call this is (fixer, reviewer, repair)
 * @param {(line: string) => void} [opts.write] where a line goes; already redacted by the caller
 * @param {number} [opts.maxLines] stop writing after this many lines, keep counting
 * @param {number} [opts.maxLineChars] cut any single line to this many characters
 * @returns {{onData: (chunk: unknown) => void, flush: () => void, first: () => string,
 *            cause: () => string, lines: () => string[], count: () => number,
 *            suppressed: () => number}}
 */
export function createStderrSink({
  label = "sdk",
  write = () => {},
  maxLines = 200,
  maxLineChars = 400,
} = {}) {
  let partial = "";
  let first = "";
  let cause = "";
  let count = 0;
  let written = 0;
  // A writer that threw once is not asked again. The alternative is a run that
  // spends its remaining stderr throwing the same exception per line.
  let writable = true;
  const kept = [];

  const emit = (line) => {
    count += 1;
    if (!first) first = line;
    if (!cause && THROWN.test(line)) cause = line;
    // Bounded on purpose: `kept` is read after the run to build the diagnosis,
    // and a chatty child must not be able to grow it without limit.
    if (kept.length < maxLines) kept.push(line);
    if (!writable) return;
    if (written < maxLines) {
      written += 1;
      write("[" + label + ":stderr] " + line);
      return;
    }
    if (written === maxLines) {
      written += 1;
      write("[" + label + ":stderr] ... further stderr lines suppressed; still counted");
    }
  };

  const safeEmit = (line) => {
    try {
      emit(line);
    } catch {
      // Includes the case where `write` itself threw: stop writing, keep counting.
      writable = false;
    }
  };

  const onData = (chunk) => {
    try {
      const text = typeof chunk === "string" ? chunk : String(chunk ?? "");
      if (!text) return;
      const parts = (partial + text).split(/\r?\n/);
      // The last piece has no newline after it yet - it is the start of the next
      // line, not a line.
      partial = parts.pop() ?? "";
      for (const line of parts) {
        const trimmed = cut(line, maxLineChars);
        if (trimmed) safeEmit(trimmed);
      }
    } catch {
      // Never let anything reach the SDK's data listener.
    }
  };

  const flush = () => {
    try {
      const trimmed = cut(partial, maxLineChars);
      partial = "";
      if (trimmed) safeEmit(trimmed);
    } catch {
      partial = "";
    }
  };

  return {
    onData,
    flush,
    first: () => first,
    cause: () => cause,
    lines: () => kept.slice(),
    count: () => count,
    suppressed: () => Math.max(0, count - kept.length),
  };
}

/**
 * One sentence naming what the child said before it died, or nothing.
 *
 * Goes into the failure message and therefore into the benchmark row, not only
 * into the log: run #13 crashed seven times and all seven rows read
 * `process exited with code 1`, which is the symptom in every case and the
 * cause in none. The log holds the rest; this is the one line that has to
 * survive into a table.
 *
 * Returns "" rather than a placeholder when stderr was empty, and the
 * difference is the whole point of KAPI 0: a run that reports "the child said
 * nothing" has learned something, and it must not be confused with a run where
 * we never listened. The empty string is only truthful now that stderr is
 * actually piped - before this change every run looked like this one.
 *
 * @param {{first: () => string, cause?: () => string, count: () => number}} sink
 * @returns {string}
 */
export function stderrNote(sink) {
  if (!sink) return "";
  let line = "";
  let total = 0;
  try {
    // The thrown error when there is one, the opening line when there is not.
    line = (typeof sink.cause === "function" ? sink.cause() : "") || sink.first();
    total = sink.count();
  } catch {
    return "";
  }
  if (!line) return "";
  const more = total > 1 ? " (" + (total - 1) + " more stderr line" + (total === 2 ? "" : "s") + ")" : "";
  return "The agent runtime said on stderr: " + line + more;
}
