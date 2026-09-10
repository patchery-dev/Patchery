/**
 * Run the golden and empty controls: does the deterministic half of the pipeline
 * reach the right verdict when the model's half is known?
 *
 *   golden  a repair that certainly works  -> expect a run that ships (changed=true)
 *   empty   the model offers nothing       -> expect no-changes
 *
 * Both run the real agent.mjs, the real guard, the real census and the real
 * classifier. The only thing replaced is the provider, from outside, through
 * ANTHROPIC_BASE_URL - see control-stub.mjs for why that was chosen over a code
 * path in the shipped action.
 *
 * The fixture is copied into a throwaway git repository first, so a control can
 * never touch this one, and so `git status` sees the agent's edits the way it
 * would in a customer checkout.
 *
 * Neither control asserts anything by itself. It prints what the pipeline said,
 * and the caller compares that with what it should have said - because a control
 * that grades itself is the mirror this whole exercise exists to avoid.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startControlStub } from "./control-stub.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const MARKER = "PATCHERY-CONTROL-6f2a";

function git(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error("git " + args.join(" ") + ": " + (r.stderr || r.stdout));
  return r.stdout;
}

/** A throwaway checkout of the fixture, committed, so edits show up as changes. */
function makeWorkspace() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "patchery-control-"));
  fs.cpSync(path.join(REPO, "test-fixture"), work, { recursive: true });
  git(["init", "-q"], work);
  git(["config", "user.email", "control@patchery.dev"], work);
  git(["config", "user.name", "Patchery control"], work);
  git(["add", "-A"], work);
  git(["commit", "-q", "-m", "fixture at the break"], work);
  return work;
}

function scriptFor(kind, work) {
  if (kind === "empty") return { marker: MARKER, turns: [], finalText: "I could not find a safe change to make." };
  return {
    marker: MARKER,
    // Read first: Edit refuses a file the session has not read, which is not our
    // rule but is the CLI's, and a control that trips over it proves nothing.
    turns: [
      { tool: "Read", input: { file_path: path.join(work, "app.js") } },
      {
        tool: "Edit",
        input: {
          file_path: path.join(work, "app.js"),
          old_string: "  return `Total: ${formatPrice(amount)}`;",
          new_string: '  return `Total: ${formatPrice(amount, "USD")}`;',
        },
      },
    ],
    finalText: "Passed the currency through, as fake-lib@2 requires.",
  };
}

function readOutputs(file) {
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const out = {};
  // GITHUB_OUTPUT heredoc form: key<<DELIM \n value \n DELIM
  const re = /^([a-zA-Z0-9_]+)<<(\S+)\r?\n([\s\S]*?)\r?\n\2$/gm;
  let m;
  while ((m = re.exec(text))) out[m[1]] = m[3];
  return out;
}

export async function runControl(kind) {
  const work = makeWorkspace();
  const outFile = path.join(work, "..", "control-" + kind + "-output.txt");
  fs.writeFileSync(outFile, "");
  // Logged, because "the run hung" and "the run hung without the provider ever
  // being asked" are different faults and the first report could not tell them
  // apart.
  const stub = startControlStub(scriptFor(kind, work), {
    onRequest: (route, k, stop) => console.log("   [stub] " + route + " " + k + " -> " + stop),
  });
  const base = await stub.listen();
  console.log("   [stub] listening on " + base);

  // spawn, NOT spawnSync. The stub is an HTTP server living in THIS process's
  // event loop, and spawnSync blocks that loop until the child exits - so the
  // child's very first request had nobody to answer it and both sides waited
  // for each other. Four runs hung on that deadlock, and the stub's own log
  // said so plainly: listening, then zero requests, ever.
  //
  // The instrument was holding the door shut and timing how long nobody came in.
  const r = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(REPO, "scripts", "agent.mjs")], {
      cwd: work,
      // Inherited, not captured. A first version buffered it, the run hung, and
      // the report was five empty fields and no way to see where it stopped - a
      // control that hides its own working is no better than the table it checks.
      stdio: "inherit",
    env: {
      // NOT ...process.env. A control that inherits the environment of whatever
      // started it is not a control: the first attempt hung in the model call
      // because the shell running it was itself an agent session, and its
      // CLAUDE_CODE_* variables - one of them announcing that a host process
      // handles auth refresh - travelled into the child, where no such host
      // exists. Only what the run genuinely needs crosses the line.
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      windir: process.env.windir,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      USERPROFILE: process.env.USERPROFILE,
      HOME: process.env.HOME,
      ComSpec: process.env.ComSpec,
      PATHEXT: process.env.PATHEXT,
      SMA_WORKSPACE: work,
      SMA_TARGET_DIR: ".",
      SMA_PACKAGE: "fake-lib",
      SMA_TEST_COMMAND: "node app.test.js",
      SMA_CHANGELOG: "fake-lib 2.0.0: formatPrice(amount, currency) now requires currency.",
      SMA_EXTRA_INSTRUCTIONS: MARKER,
      SMA_MAX_TURNS: "6",
      // The reviewer is OFF, and the control is narrower because of it.
      //
      // It is a second model call with its own structured-output contract, and
      // the stub can be made to answer it but not yet in the shape the CLI
      // accepts - six attempts, then a timeout. Rather than hold the whole
      // control behind that, this states the gap: THE CONTROL DOES NOT EXERCISE
      // THE REVIEW STEP.
      //
      // What it still covers is the part that decides a run can ship: the
      // guard, the census, the git-verified diff, and the classifier. The
      // reviewer can only ever LOWER an outcome, so a control that skips it
      // tests every gate capable of raising one - which is the direction a
      // false pass would come from.
      SMA_VERIFY_MODE: "off",
      ANTHROPIC_BASE_URL: base,
      ANTHROPIC_AUTH_TOKEN: "control-stub-not-a-key",
      ANTHROPIC_API_KEY: "control-stub-not-a-key",
      GITHUB_OUTPUT: outFile,
      GITHUB_STEP_SUMMARY: path.join(work, "..", "control-" + kind + "-summary.md"),
      },
    });
    const killer = setTimeout(() => child.kill("SIGKILL"), 150 * 1000);
    child.on("exit", (code) => {
      clearTimeout(killer);
      resolve({ status: code });
    });
  });

  await stub.close();
  const outputs = readOutputs(outFile);
  const suite = spawnSync(process.execPath, ["app.test.js"], { cwd: work, encoding: "utf8" });
  const result = {
    kind,
    exit: r.status,
    outcome: outputs.outcome || "",
    changed: outputs.changed || "",
    files: (outputs.files || "").split("\n").filter(Boolean),
    candidate: outputs.candidate_disposition || "",
    candidateFiles: outputs.candidate_files || "",
    suiteAfter: suite.status,
    stdout: "",
    stderr: "",
  };
  fs.rmSync(work, { recursive: true, force: true });
  return result;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const only = process.argv[2];
  for (const kind of only ? [only] : ["golden", "empty"]) {
    const r = await runControl(kind);
    console.log("\n=== " + kind + " ===");
    console.log("agent exit      : " + r.exit);
    console.log("outcome         : " + JSON.stringify(r.outcome));
    console.log("changed         : " + JSON.stringify(r.changed));
    console.log("files           : " + JSON.stringify(r.files));
    console.log("candidate       : " + JSON.stringify(r.candidate) + " / " + JSON.stringify(r.candidateFiles));
    console.log("suite afterwards: exit " + r.suiteAfter);
    if (!r.outcome) console.log("--- stderr tail ---\n" + r.stderr.split("\n").slice(-15).join("\n"));
  }
}
