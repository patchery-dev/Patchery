/**
 * A provider that says exactly what we tell it to, so the deterministic half of
 * the pipeline can be tested without a model.
 *
 * The golden/empty control asks whether the lower half - guard, census,
 * reviewer, classifier - reaches the right verdict when the upper half is known.
 * Given a repair that certainly works, does it say FIXED? Given nothing, does it
 * say NO-CHANGE? A table nobody has asked that of is a table on trust.
 *
 * Three designs were on the table. One put a code path into the shipped action
 * that skips the model, which is not a small thing in a product whose claim is
 * that the guard is the authority. This is the one that needs no such path: the
 * SDK already reads ANTHROPIC_BASE_URL, so the provider is replaced from outside
 * and agent.mjs is not modified at all.
 *
 * TWO THINGS WERE MEASURED HERE, AND THE FIRST ANSWER WAS WRONG.
 *
 * A first probe answered every call with plain JSON, saw the run reach
 * `result: success`, and concluded SSE was not needed. It was: the real call
 * arrives with `stream: true`, a JSON answer means the tool call is never
 * carried out, and the CLI then quietly repeats the whole exchange with
 * `stream: false`. The probe's green light came from a reply that did nothing,
 * which is the same trap as a search returning "0 results" and being believed
 * without a known hit.
 *
 * The second probe read the request bodies and found the rest of it: auxiliary
 * calls share the endpoint - one of them on a different, smaller model, for a
 * title - so "the first request is the conversation" is false too. A scripted
 * turn handed out by counting requests goes to a summariser.
 *
 * Hence both rules below: speak SSE, and give a scripted turn only to the
 * request whose body carries the conversation's marker.
 *
 * This is a measurement instrument, not part of the action. agent.mjs never
 * imports it and action.yml never points at it.
 */

import http from "node:http";
import fs from "node:fs";

const MODEL = "control-stub";

/**
 * Which request is this?
 *
 *   "continue"  the conversation coming back with our tool's result
 *   "scripted"  the conversation itself, identified by the marker
 *   "aside"     a title, a summary, anything else sharing the endpoint
 */
export function classifyRequest(body, marker) {
  const text = String(body || "");
  // The marker is in the opening prompt and the transcript carries it forward,
  // so it identifies the conversation on EVERY turn, not just the first. An
  // earlier version looked for a tool_result before the marker and treated the
  // turn after a tool call as something to end - which is why the second
  // scripted turn was never served and the file it was meant to edit never
  // changed. The tool ran; the follow-up went to the wrong branch.
  if (marker && text.includes(marker)) return "scripted";
  return "aside";
}

/** The message the stub means to send, before it is put on the wire. */
export function turnMessage(script, n, kind) {
  const turns = (script && Array.isArray(script.turns) ? script.turns : []).filter(Boolean);
  const turn = kind === "scripted" ? turns[n] : null;
  const base = { id: "msg_control_" + n, type: "message", role: "assistant", model: MODEL };
  if (!turn) {
    const text = kind === "scripted" && script && script.finalText ? script.finalText : "ok";
    return { ...base, content: [{ type: "text", text }], stop_reason: "end_turn" };
  }
  return {
    ...base,
    content: [{ type: "tool_use", id: "toolu_control_" + n, name: turn.tool, input: turn.input || {} }],
    stop_reason: "tool_use",
  };
}

/** One Anthropic-style SSE frame. */
function frame(event, data) {
  return "event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n";
}

/**
 * The message as a stream. Written out rather than assembled cleverly, because
 * the shape is the contract and a reader should be able to check it against the
 * API docs line by line.
 */
export function streamFrames(message) {
  const block = message.content[0];
  const out = [
    frame("message_start", {
      type: "message_start",
      message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } },
    }),
  ];
  if (block.type === "tool_use") {
    out.push(
      frame("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
      }),
      frame("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
      })
    );
  } else {
    out.push(
      frame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      frame("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: block.text },
      })
    );
  }
  out.push(
    frame("content_block_stop", { type: "content_block_stop", index: 0 }),
    frame("message_delta", {
      type: "message_delta",
      delta: { stop_reason: message.stop_reason, stop_sequence: null },
      usage: { output_tokens: 1 },
    }),
    frame("message_stop", { type: "message_stop" })
  );
  return out.join("");
}

export function routeOf(url) {
  const path = String(url || "").split("?")[0];
  if (path === "/v1/messages") return "messages";
  if (path === "/v1/messages/count_tokens") return "count_tokens";
  return "other";
}

export function startControlStub(script, { onRequest } = {}) {
  const marker = script && script.marker;
  let served = 0;
  const log = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const route = routeOf(req.url);
      if (route === "count_tokens") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ input_tokens: 1 }));
        log.push({ route });
        return;
      }
      if (route === "other") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
        log.push({ route });
        return;
      }
      const kind = classifyRequest(body, marker);
      const message = turnMessage(script, served, kind);
      if (kind === "scripted") served++;
      log.push({ route, kind, stop: message.stop_reason });
      if (onRequest) onRequest(route, kind, message.stop_reason);

      let wantsStream = false;
      try {
        wantsStream = !!JSON.parse(body).stream;
      } catch {}
      if (wantsStream) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        res.end(streamFrames(message));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ...message, usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  });
  return {
    server,
    log,
    listen: () =>
      new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve("http://127.0.0.1:" + server.address().port));
      }),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

if (process.argv[1] && process.argv[1].endsWith("control-stub.mjs")) {
  const scriptPath = process.argv[2];
  if (!scriptPath) {
    console.error("usage: control-stub.mjs <script.json>");
    process.exit(2);
  }
  const script = JSON.parse(fs.readFileSync(scriptPath, "utf8"));
  const stub = startControlStub(script, {
    onRequest: (route, kind, stop) => console.error("[stub] " + route + " " + kind + " -> " + stop),
  });
  const base = await stub.listen();
  process.stdout.write(base + "\n");
}
