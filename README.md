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

It runs as a GitHub Action, inside your own CI. Your code is never uploaded
anywhere.

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
refused, and every edit must sit inside the directory you named.

**A test census.** The suite is counted while your code is still whole and
counted again afterwards. If fewer tests pass than before, the change is rejected
however green the run looks. An agent cannot quietly shrink the thing that judges
it.

**An independent reviewer.** A second model, on a different provider, is given
the diff and asked to refute it. It does not see the first model's reasoning, so
it cannot inherit its mistakes. Its verdict is attached to the pull request
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

permissions:
  contents: write
  pull-requests: write

jobs:
  fix:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: patchery-dev/Patchery@v0.3
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

*Last measured 2026-09-07.*

Patchery works on **JavaScript projects with a test command**, and it is judged by
your own suite. It is measured on real breaks in repositories we do not own, and
most of what it has met so far is packaging rather than a changed signature.
Where the break is not a call-site problem, it reports rather than patches.

The benchmark is public and reproducible: the case list is in
[`benchmark/cases.json`](benchmark/cases.json), the workflows that run it are in
[`.github/workflows`](.github/workflows). **14 breaks in 9 repositories we do not
own** are confirmed real — each one verified to turn that project's own suite red
before Patchery is allowed near it.

**There is no ratio on this page yet, and the reason is not a bad one.** The
first batch has run once, but not every case reached a verdict — some runs died
to a model that stopped answering, some to our own harness — and the rules for
which of those belong in the denominator are exactly what we were fixing while
that run was in flight. A number produced under rules that changed mid-run is not
a measurement, and one we would have to caveat is not a number. It gets published
here when a full set has run under one set of rules, win or lose.

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
on it, not one suite noticed. Closing that gap needs a second trigger that does
not wait for red, which is the next thing being built.

The engine has 719 offline checks covering the guard, the census and the outcome
rules. None of them need an API key: `node scripts/selftest.mjs`.

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
