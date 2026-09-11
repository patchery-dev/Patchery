/**
 * Run the golden and empty controls: does the deterministic half of the pipeline
 * reach the right verdict when the model's half is known?
 *
 *   golden        a repair that certainly works -> expect a run that ships
 *   empty         the model offers nothing      -> expect no-changes
 *   poison-red    a plausible wrong fix         -> expect reverted, nothing shipped
 *   poison-green  the answer hardcoded, the package left unused, TESTS GREEN
 *                                               -> expect blocked by the guard
 *
 * The two poison controls exist because an outside reading of the limitations
 * document found the hole the first two leave: golden shows a good patch passing,
 * empty shows nothing being nothing, and NEITHER EVER ASKS THE PIPELINE TO REJECT
 * ANYTHING. "No bad patch shipped" then rests on a detector never once observed
 * firing. poison-green is the one that matters: it is the body-parser shape, where
 * the suite goes green precisely because the dependency stopped being used, so the
 * test re-run cannot see it and only the guard can.
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

/**
 * What the scripted model does, per control.
 *
 * Each is one Read then one Edit, because the CLI's Edit refuses a file the
 * session has not read - not our rule, but a control that trips over it proves
 * nothing. The Read is scaffolding; the Edit is the whole experiment.
 */
export const EDITS = {
  // The fix. Passes the currency through, as the new major requires.
  golden: {
    to: '  return `Total: ${formatPrice(amount, "USD")}`;',
    said: "Passed the currency through, as fake-lib@2 requires.",
  },
  // Wrong, and the tests say so: the suite asserts dollars and this renders
  // euros. The plainest kind of bad patch - the one the test re-run alone is
  // enough to catch. Expect everything reverted and nothing shipped.
  "poison-red": {
    to: '  return `Total: ${formatPrice(amount, "EUR")}`;',
    said: "Passed a currency through, as fake-lib@2 requires.",
  },
  // Wrong, and the tests DO NOT say so. The answer is hardcoded, the import is
  // left standing as cover, and the suite turns green because `fake-lib` is
  // never called - the exact shape the guard caught once on body-parser. The
  // test re-run is blind to this by construction: from its side nothing is
  // wrong. If any gate rejects it, that gate is the product's actual claim.
  "poison-green": {
    to: '  return "Total: $" + amount.toFixed(2);',
    said: "Computed the total directly, which avoids the breaking change.",
  },
};

export function scriptFor(kind, work) {
  if (kind === "empty") return { marker: MARKER, turns: [], finalText: "I could not find a safe change to make." };
  // The clock control borrows golden's script and never gets to finish it: the
  // stub answers the opening turns and then goes quiet, so the run's own wall
  // clock is what ends it. What is under test is not the edit but the exit.
  const edit = EDITS[kind === "clock" ? "golden" : kind];
  if (!edit) throw new Error("no script for control: " + kind);
  return {
    marker: MARKER,
    turns: [
      { tool: "Read", input: { file_path: path.join(work, "app.js") } },
      {
        tool: "Edit",
        input: {
          file_path: path.join(work, "app.js"),
          old_string: "  return `Total: ${formatPrice(amount)}`;",
          new_string: edit.to,
        },
      },
    ],
    finalText: edit.said,
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
    // Two turns, then silence. Enough that the run has a real turn count and a
    // real token tally to have lost, which is the whole point: an exit that
    // records nothing looks identical to an exit that had nothing to record.
    stallAfter: kind === "clock" ? 2 : 0,
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
      // One minute, and only for the clock control. The floor is a whole minute
      // (run-budget-minutes is floored to an integer), so this control costs
      // about that in wall time - the price of watching the most expensive exit
      // the product has without paying a provider for it.
      ...(kind === "clock" ? { SMA_RUN_BUDGET_MINUTES: "1" } : {}),
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
    // For the poison controls this is the finding. "Blocked" without a reason
    // cannot be told apart from blocked by accident.
    guardReason: outputs.guard_reason || "",
    changed: outputs.changed || "",
    files: (outputs.files || "").split("\n").filter(Boolean),
    candidate: outputs.candidate_disposition || "",
    candidateFiles: outputs.candidate_files || "",
    // The two things a leg that delivers nothing can still leave behind. Both
    // were absent from every wall-clock leg of run #13, and an exit that leaves
    // neither cannot be told apart from one that had nothing to leave.
    diagnosisFile: outputs.diagnosis_file || "",
    tokensTotal: outputs.tokens_total || "",
    suiteAfter: suite.status,
    stdout: "",
    stderr: "",
  };
  fs.rmSync(work, { recursive: true, force: true });
  return result;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const only = process.argv[2];
  for (const kind of only ? [only] : ["golden", "empty", "poison-red", "poison-green", "clock"]) {
    const r = await runControl(kind);
    console.log("\n=== " + kind + " ===");
    console.log("agent exit      : " + r.exit);
    console.log("outcome         : " + JSON.stringify(r.outcome));
    console.log("guard reason    : " + JSON.stringify(r.guardReason));
    console.log("changed         : " + JSON.stringify(r.changed));
    console.log("files           : " + JSON.stringify(r.files));
    console.log("candidate       : " + JSON.stringify(r.candidate) + " / " + JSON.stringify(r.candidateFiles));
    console.log("suite afterwards: exit " + r.suiteAfter);
    console.log("diagnosis file  : " + JSON.stringify(r.diagnosisFile));
    console.log("tokens total    : " + JSON.stringify(r.tokensTotal));
    if (!r.outcome) console.log("--- stderr tail ---\n" + r.stderr.split("\n").slice(-15).join("\n"));
  }
}
