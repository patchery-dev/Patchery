# Pre-registration: three label rules, and what happened to them

**Written 2026-09-10, before the frozen run.** The predictions below were
published first, in the notes repository, timestamped, and only then tested.
That order is the whole point of this file, so it records the failures as
plainly as it would have recorded a success.

## The problem

Run #11 has 42 legs. Fifteen of them ended with the agent writing a reasoned
diagnosis - root cause named, call sites listed, the decision handed back to the
owner - and deliberately stopping. None of the fifteen hit a ceiling: all
finished at 13 to 44 turns against a limit of 45.

All fifteen are filed `NO-CHANGE`, which the outcome table reads as *"Patchery
had nothing to offer"*. That sentence is false about a leg that offered a
correct analysis.

## Why this was pre-registered

Any rule that fixes this moves legs out of a column that counts against us and
into one that does not. `benchmark-outcome.mjs` already warns, in its own
comments, that `NEEDS-DECISION` must never become the column where nothing is
ever our failure.

So the predictions were fixed in advance: **how many legs each rule would move**,
written down before a line of it was implemented. A rule that moves a different
number is a wrong rule, not a wrong table.

## The predictions, and what measurement did to them

| rule | predicted | actual | what happened |
|---|---|---|---|
| **C** - the package is never imported in the project's own source, so there is no call site to fix | **3** | **0** | The claim was the agent's, and it is false. Checked against a real checkout of `yargs` at the benchmarked commit: `test/integration.mjs` contains `import which from 'which'`. One import-position hit in 101 source files. The agent had written *"Every call site in this project's own source: there are none."* |
| **A** - a packaging break on a CommonJS project whose Node cannot `require()` an ES module has no call-site fix | **9** | **0** | Not mechanically decidable, and the repository's own strategy text says why: a dynamic `import()` is a legitimate call-site fix and works on any Node. Whether it applies depends on whether the surrounding function can become async without changing the project's public behaviour. That is a judgement, and a judgement is exactly what this rule was supposed to avoid. |
| **B** - `EBADENGINE` never reaches the classifier, so an out-of-scope break is misfiled | **3** | **0** | There is no defect. `classifyFailure` already demotes warning lines on purpose, and the comment above it records the measured bug that led to it: a single `npm warn EBADENGINE` anywhere in a log was turning real, fixable API breaks into "no code change fixes this" - moving cases out of the failure column. Verified: warning plus a real failure classifies as the real failure; the warning decides only when nothing else in the log said anything. |

**Predicted 15 legs would move. Zero move.**

All three predictions were wrong, and all three were wrong in the direction that
flattered us. That is the direction pre-registration exists to catch, and it
caught it. Had the rules been written first and the count read off afterwards,
the table would have improved by fifteen legs and every one of those fifteen
would have been unearned.

## What is being built instead

Neither of these moves a leg into a friendlier column. Both make the output
harder to be wrong in.

1. **Count the call sites mechanically and print the count.** The yargs leg
   asserted there were none; a `git ls-files` and the existing
   `packageBindings()` find one in a second, and would have printed it beside
   the claim. Reported as a fact, never as a gate - it decides no outcome. The
   count is `null`, never `0`, where the files could not be listed, for the same
   reason the test census returns `null`: "we could not count" must not read as
   "we counted zero".

2. **Stop the closing line from contradicting the line above it.** On the yargs
   leg the handover said, four lines apart:

   > *"**What would unblock it.** This is an ordinary migration and should be
   > fixable - if this run could not do it, the changelog is likely thin."*
   >
   > *"...shipped no patch, because on this break **a patch would encode a
   > decision that is yours**."*

   One says the run fell short, the other says the run was right to stop. The
   closing sentence was fixed text chosen only by whether the agent wrote notes;
   it now follows the classification, which is what the line above it follows.

## What stays broken, on purpose

The fifteen legs keep the `NO-CHANGE` label, and it keeps understating them. The
honest reason is that no deterministic signal separates *"this agent found
nothing"* from *"there was a decision here and it correctly handed it back"* -
and the only candidate signals are things the model asserts, which is the escape
hatch this whole gate exists to close. It stays understated until something
mechanical can tell them apart.

That limitation belongs in the published limitations section, not in a promise.

---

## A fourth rule, pre-registered 2026-09-10 during the frozen run

Found while reading live legs, not from a hypothesis.

**`bcoe/yargs` + `which@7` cannot be fixed by this tool, by our own rule.**

The only place the project imports the package is `test/integration.mjs`
(measured: 1 import site across 101 source files, and the agent's own exhaustive
grep agrees). `agent.mjs:892` instructs the agent to NEVER edit test files, and
`agent.mjs:1514` reverts and refuses if one is touched.

So the only permitted fix does not exist. The case has now burned three legs in
run #11 and three in this run, and both times it was filed `NO-CHANGE` -
"Patchery had nothing to offer" - when the truth is that our own rule forbids
the only available repair.

**Rule D.** If every import site of the package is inside a protected path, no
permitted fix exists → `NEEDS-DECISION`, reason `only-call-site-is-protected`.

Mechanical: `callSiteScan` already returns the paths, and the protected-path
test already exists for the guard. No model claim is involved.

**Prediction, written before any implementation: 3 legs move.** The three
`yargs`/`which` legs of this run, and no others. If a fourth moves, the rule is
wrong and the table is not.

**NOT IMPLEMENTED YET, AND DELIBERATELY.** The benchmark run is in flight and
each leg checks the repository out fresh, so changing the classifier now would
mean different legs of one run were judged by different code. It waits until the
run is finished. That is the same discipline as the rest of this file: the order
of operations is the evidence.
