<p align="center">
  <img src="assets/logo.png" width="64" height="64" alt="Patchery logo">
</p>

<h1 align="center">Patchery&trade;</h1>

<p align="center">
  <a href="https://patchery.dev">patchery.dev</a>
</p>

<p align="center">
  <strong>Dependabot tells you a dependency changed. Patchery works out what that means for your code — and will not claim a fix it cannot prove.</strong>
</p>

---

**This is not an alternative to Dependabot or Renovate. It starts where they
stop.** They do one job well: notice a new version and open the bump. By design
they do not read your code, so when that bump turns your suite red they have
nothing more to offer, and the pull request sits there until a human picks it up.

Patchery picks it up. It reproduces the break, reads the changelog, migrates the
call sites, re-runs your tests — and then does the part that actually decides
whether any of it was worth anything: it grades its own evidence, publishes the
level of proof it reached, and refuses to ship a change it could not prove.

Keep Dependabot. Patchery is the layer above it.

**Your suite may not be watching.** Express 4 → 5 is one of the best-known
breaking changes in JavaScript: routing and parameter handling moved, and the
ecosystem wrote migration guides for it. We installed Express 5 into four
projects that depend on it — `cors`, `multer`, `express-session` and
`formidable` — and ran each project's own tests.
[Not one of them went red.](https://github.com/patchery-dev/Patchery/actions/runs/34102236170)
Their suites never reach the paths that changed.

That is a limit of the trigger, not a claim about the fix. Patchery starts when
your build goes red, so a break your suite never sees is a break Patchery never
sees either. Where the suite *does* go red it is watching that path — which is
exactly what makes turning it green again worth something. (A fifth project was
already failing before the upgrade, so it could not be measured.)

It runs as a GitHub Action, inside your own CI. **Patchery hosts nothing and
stores nothing** — there is no service to sign up for and no copy of your
repository anywhere. What does leave the runner is what a model has to read to
do the work: the failing test output, the files the agent opens, and the diff it
writes. That goes to the endpoint *you* configure with `anthropic-base-url`,
and nowhere else. Point it at your own deployment and nothing reaches a third
party at all.

```yaml
- uses: patchery-dev/Patchery@v0.3
  with:
    package: react-router
    anthropic-auth-token: ${{ secrets.ANTHROPIC_AUTH_TOKEN }}
```

## Why the proof is the product

Writing a migration is the easy part. Telling a good migration from a
plausible-looking one is not — and an agent asked to make tests pass can pass
them by weakening them.

Four things stand between the agent and your branch:

**A mechanical guard.** Code, not a model, decides what may change. Test files,
lockfiles, CI configuration and `node_modules` are off limits, deletions are
refused, and every edit must sit inside `target-dir`.

Be aware what that means by default: `target-dir` is `.`, so the containment is
the whole repository minus the deny-list. The rules above are what actually bite
on a first run. Narrow it — `target-dir: src` or `allowed-paths` — and the
agent's reach shrinks with it, which is worth doing before you trust it with
anything.

**A test census.** The suite is counted before the agent is given the code and
counted again after. Fewer tests passing than before is a rejection, however
green the run looks — and so is more tests *skipped* than before, because a
suite can be made to agree by silencing it as easily as by deleting from it. An
agent cannot quietly shrink the thing that judges it.

That count is taken when Patchery is invoked, which is after the upgrade has
already broken your build — not on a healthy tree, because there is no longer
one to measure. Where the break stops your test files loading at all, there is
no count to take, and the pull request says so rather than leaving the row
blank: a check that could not run must not look like one that passed.

**An independent reviewer.** A second model is given the diff and asked to
refute it, in a separate call with no write access. It does not see the first
model's reasoning, so it cannot inherit its mistakes. Set `verify-model` and
`verify-base-url` and it runs on whatever provider you choose; leave them empty
and it is the same model, still in a separate call — and the pull request only
claims "a different model" when the telemetry confirms one actually ran. Our own
benchmark runs put the reviewer on a different provider from the fixer. Its verdict is attached to the pull request
whether it agrees or not — and with `verify-mode: block` it stops the pull
request from opening at all.

The first three are gates: fail any of them and the attempt is discarded whole.

**And proof has levels, so the pull request says which one it reached.** The
strongest is a suite that was red and is now green. But when the break never
turned your suite red — a proactive migration, or a change your tests do not
exercise — a green run shows no regression; it does not show the fix works,
because nothing ever ran the thing that changed. Patchery does not quietly
count that as proof: the pull request is headed *Not verified* and says why, and
the `draft` output opens it as a draft — the example workflow wires that up. The
level is decided by the same code that runs the gates, never by a model.

| What the pull request says | What it means |
| --- | --- |
| **Proof: the test suite** | Your suite was red on this break and is green after. The census held and the guard passed. This is the only level that claims the fix works. |
| **Proof: a mechanical check** | The suite never went red, but one of your project's own checks — a type-check or lint — failed before and passes after. Weaker, and named as weaker. |
| **Not verified** | The suite passed before *and* after, so nothing ever exercised what changed. Opened as a **draft**, because a green run here proves no regression, not a fix. |
| **No patch** | No code change was produced. Where the break has no fix at the call site, the report is what you get. |
| **Not delivered** | Something was written and the tests did not pass. It is reverted, and no pull request opens. |

## When no fix exists at the call site

Some breaks have no fix at the call site. A dependency that starts shipping as an
ES module does not rename anything — your code is fine and can no longer load it.
No amount of editing call sites solves that; it is a decision about your runtime
or your dependencies, and it is yours to make.

Patchery does not shrug at those. It reports:

- which call sites are affected, having searched for all of them
- why the obvious fix does not apply, with the specific contract it would break
- which decisions would unblock it, and what each one costs you

On `expressjs/express` with `content-disposition@3` it produced exactly that:
three call sites in one file, a demonstration that `res.attachment()` cannot
become async because `res.attachment().send()` is a tested contract, an argument
that a build transform would only paint this repository's CI green while leaving
every downstream consumer broken — and two options, one of which it verified by
running the alternative version and comparing the output byte for byte.

It made no code change, and said so. Where the fix does not exist at the call
site, that report is what is left — a fallback, not the thing Patchery is for.

A tool that is right most of the time, and says plainly what it found when it is
not, is worth more than one that is confident every time.

## Setup

**1. Add a secret.** `ANTHROPIC_AUTH_TOKEN` in *Settings → Secrets and variables
→ Actions*. Any Anthropic-compatible endpoint works — set `anthropic-base-url`
and `anthropic-model` to point elsewhere.

**2. Allow pull requests.** *Settings → Actions → General → Workflow
permissions* → tick *Allow GitHub Actions to create and approve pull requests*.

**3. Add the workflow.** A complete example is in
[`examples/patchery.yml`](examples/patchery.yml).

```yaml
name: Patchery
on:
  workflow_dispatch:
    inputs:
      package:
        description: Package that broke
        required: true

# contents: write lets the PR action push a branch - Patchery itself only reads
# and writes files in the checkout. pull-requests: write opens the PR. Neither
# is used by the fix step; drop both and run `mode: scan` if you want a
# read-only trial first.
permissions:
  contents: write
  pull-requests: write

jobs:
  fix:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      # Pin to the commit, not the tag: a tag can be moved, a SHA cannot. This
      # one is v0.3. Dependabot updates both together if you let it.
      - uses: patchery-dev/Patchery@6718a35ddc6a0e361ef40295bc2f62ff75bcb84e # v0.3
        id: patchery
        with:
          package: ${{ inputs.package }}
          anthropic-auth-token: ${{ secrets.ANTHROPIC_AUTH_TOKEN }}
      - uses: peter-evans/create-pull-request@v7
        if: steps.patchery.outputs.changed == 'true'
        with:
          title: "fix(deps): migrate ${{ inputs.package }} call sites"
          body-path: ${{ steps.patchery.outputs.pr-body-file }}
          add-paths: ${{ steps.patchery.outputs.files }}
```

Every input and output is documented in [`action.yml`](action.yml). The ones most
people change:

| Input | Default | |
|---|---|---|
| `package` | — | the dependency that broke |
| `target-dir` | `.` | directory to fix |
| `test-command` | `npm test` | how your tests run |
| `node-version` | `auto` | read from your `.nvmrc`, CI workflow or `engines.node` |
| `verify-mode` | `warn` | `block` refuses to open a PR the reviewer refutes |
| `allowed-paths` | — | narrow the agent further |

## Where it is today

*Last measured 2026-09-09.*

Patchery works on **JavaScript projects with a test command**, and it is judged by
your own suite. It is measured on real breaks in repositories we do not own, and
most of what it has met so far is packaging rather than a changed signature.
Where the break is not a call-site problem, it reports rather than patches.

The benchmark is public and reproducible: the case list is in
[`benchmark/cases.json`](benchmark/cases.json), the workflows that run it are in
[`.github/workflows`](.github/workflows). **14 breaks in 9 repositories we do not
own** are confirmed real — each one verified to turn that project's own suite red
before Patchery is allowed near it.

**There is no ratio on this page yet, and the reason is worth stating plainly.**
The first batch has run once, under rules that were still being fixed while it
was in flight, and reading it back afterwards found the classifier had mislabelled
rows — runs the clock cut mid-migration were recorded as though the tool had
nothing to offer. A number produced under rules that changed mid-run is not a
measurement. It gets published here when a full set has run under one set of
rules, win or lose.

**Eight of that batch's runs never reached a verdict, and every one of them was
our fault rather than the model's.** Six were a packaging bug of ours: the action
resolved its own runtime from `PATH`, so a workflow that set up Node before
calling it handed our code the project's Node, and the action died before it
started. Two were the agent reading a whole file instead of searching it. Both
are fixed. Neither is an outage we suffered, so neither is excluded from the
denominator — a run that fails because of a defect we shipped is a failed run.

**What is measured, and is not in dispute, is the shape of the problem.** Of the
14 confirmed breaks, **11 are packaging** — a dependency that now ships as an ES
module and a `require()` that no longer works — and only **3 are changed
signatures**. That is why the report is not a consolation prize: for most of what
actually breaks a build in 2026, the honest answer at the call site is *this is
not a call-site problem*, and saying so with the evidence beats guessing.

There is a structural finding behind that split, and it is the most useful thing
this benchmark has produced: **"did the test suite break" is a trigger that selects
for packaging.** A packaging break explodes at import time, so everyone's suite
goes red. A changed signature is only visible if a test happens to exercise that
exact call — and a library's tests exercise its own code, not its dependency's
changed paths. Measured directly: `express` v4 → v5 is one of the best-known
breaking changes in the ecosystem, and across **five** repositories that depend
on it — `expressjs/cors`, `expressjs/multer`, `expressjs/session`, `Unitech/pm2`
and `node-formidable/formidable` — not one suite noticed. They are rows in
[`benchmark/candidates.json`](benchmark/candidates.json); check them yourself. Closing that gap needs a second trigger that does
not wait for red, which is the next thing being built.

The engine has 774 offline checks covering the guard, the census and the outcome
rules. None of them need an API key: `node scripts/selftest.mjs`.

## Running the workflows

The measurement workflows are triggered by hand from the Actions tab. Their form
fields say what to type and nothing else; the reasons are here, because a
paragraph of rationale inside a text box is a paragraph nobody can act on.

| workflow | what it answers |
| --- | --- |
| **Patchery (verify case)** | Is this break real? Green before the upgrade, red after |
| **Patchery (verify batch)** | The same, for every row in `benchmark/candidates.json` |
| **Patchery (benchmark run)** | Given one confirmed break, what does Patchery do |
| **Patchery (benchmark, all cases)** | The same for every confirmed case, and one table |
| **Patchery (scan smoke)** | Does the *published* action work in a repository we do not own |
| **Refresh candidate pool** | Find new upgrade candidates |
| **Calibrate** | Where the independent reviewer's confidence threshold should sit |

Run **verify case** before **benchmark run**: a case that was never red teaches
nothing, and three wrong conclusions in a row came from skipping that.

### The fields that need a reason

**`node-version`** — `auto` asks the repository, which is usually what you want,
because the tests should run the way its maintainers run them. Pin an exact
version when you are repeating an earlier run and want the same conditions:
version drift between runs shows up as if it were the tool behaving
inconsistently.

**`repeat`** — a label that keeps artifact names apart. Two uploads under one
name is a lost result, and in a repeat set the lost one is exactly the result
that would have shown the case is unstable. It happened: three legs of one case
uploaded under a single name and the report called the case stable.

**`max-turns` and `run-budget-minutes`** — two separate brakes. Turns bound how
much work the agent does; minutes bound how long it waits, which no turn limit
can catch, because waiting is not a turn. **Raise them together.** An arm that
raises one is still held by the other, and 13 of 42 legs in one benchmark ended
at one ceiling or the other.

**`job-timeout-minutes`** — the runner's own cap, and it must stay well above
`run-budget-minutes` so that *our* clock is the one that closes. A job killed
from outside writes no result, no summary and no diagnosis: the case vanishes
instead of failing. At 60 minutes against a 45-minute budget that race was lost
silently. Keep at least 45 minutes of headroom — Patchery does not start at
minute zero, since install, census and baseline run first.

**`break-class`** — `packaging` or `api`, copied from `_class` in the
`cases.json` row. It exists so the report can split by it. A packaging break
announces itself the moment anything runs; an API change is invisible unless the
tests happen to reach that call. One number over both is mostly decided by the
easier class, and it moves as cases are added while the tool stays the same.

**`briefing`** — whether the agent is shown the mechanical classification of the
break. `off` measures whether showing it actually helps.

**`model`** — empty uses the endpoint's default. Set it explicitly when a run has
to be comparable to an earlier one.

**`runner`** — the machine label, and the default is the right answer for
anything whose number gets published. Two independent reviews both said pinning
a host makes a rate unrepresentative of a fleet, so `ubuntu-latest` is left to
move and the image it actually resolved to is recorded in the result instead —
which is what lets a result that differs be attributed to something. Pin an
exact label such as `ubuntu-24.04` only for a controlled comparison, where the
claim is that one thing differed between two arms. Recording is enough to
explain a fleet; it is not enough for an experiment, because with three runs to
an arm an image difference is visible in the record and still not correctable
from it.

## Where it is going

All four of these come from the same gap, stated once: **something outside your
dependency tree changed, and your tests are not going to tell you.**

**A trigger that does not wait for red.** Today Patchery wakes up when a suite
breaks, and the measurement above shows what that misses. A scheduled watcher
reads the list of things you already depend on — `package.json`, no new
configuration from you — and asks whether they changed, instead of waiting to be
told by a failure. Nothing is hosted: the "what have I seen already" state is a
small file in your own repository.

**Changes that break nothing at all.** A new version can quietly make your
workaround unnecessary, or quietly deprecate the path you are on. Nothing goes
red, so nobody notices — and *nobody noticed* is how most of this damage actually
happens. The same machinery reads the changelog, finds the call sites, and says
"these six places", with the same proof standard and no pretence that a green
suite proved anything.

**Beyond npm.** A REST API removing a field breaks you without changing a line of
your `package.json`, and your tests talk to a mock that still returns the old
answer. Both of the things Patchery stands on — a changed file, a red test —
are missing there. The honest target is deliberately weaker than the npm one:
*find the call sites and open a pull request with the analysis; prove it too,
where a type check or a published schema makes proof possible.*

**Beyond one file.** When an upgrade touches several call sites that must move
together, they should move in one verified change rather than a sequence of
half-migrations.

## Licence and pricing

The source is public and stays public — being auditable is the point of a tool
that edits your code.

**Free, no subscription:**

- any repository whose source is publicly readable, including every open source project
- personal, academic, research and non-commercial use
- trying it on your own private repositories, for the first three runs that
  change code — a tool that only acts when something breaks needs a trial
  measured in fixes, not in days

**Requires a subscription:** running it in production against a private
repository of a commercial organisation.

That is the whole distinction, and it is in the [licence](LICENSE) rather than
only on a pricing page — [BUSL-1.1](https://mariadb.com/bsl11/). Every version
becomes Apache-2.0 four years after it is released, so the restriction is on
what is current, never on what is old.

Versions published before 2026-09-07 were released under MIT and remain
available under it. That grant is not revoked; the LICENSE file carries both.

**Patchery™** is a trademark of Uğur Şişkolu (ugursku), first used in commerce on
2026-09-05. The licence covers the code and grants no rights in the name: a
fork is free to exist, under its own name.

### The three questions people actually ask

**Can I fork it?** Yes. The code is BUSL-1.1 — and everything published before
2026-09-07 is MIT and stays MIT. What you may not do is call your fork
*Patchery*, or present it as endorsed by this project. Rebrand it and it is
yours. Copyright and trademark are separate things, and the licence only moves
the first.

**What counts as "a run that changes code"?** A run that produced a patch and
delivered it. A scan, a run that found nothing, a run the guard reverted, a run
that ran out of budget — none of those are one. If nothing reached your branch,
it did not count.

**How is the trial enforced?** Not in this code, and that is deliberate. There
is no licence check, no phone home, and no counter anywhere in it — you can
read it and confirm that. A tool that edits your source and also calls a licence
server is a tool with a second reason to talk to the network, which is exactly
the thing you should not have to trust. Enforcement belongs in billing, outside
the runner that touches your files, and that is where it will go: at general
availability, a paid tier for private commercial repositories, checked where you
pay rather than where you build. Until then it is an honour system. If you are a
commercial team running this on a private repository past three fixes, write to
ugur@patchery.dev about a subscription — the licence asks for one, and this code
will not.
