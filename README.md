<p align="center">
  <img src="assets/logo.png" width="64" height="64" alt="Patchery logo">
</p>

<h1 align="center">Patchery&trade;</h1>

<p align="center">
  <a href="https://patchery.dev">patchery.dev</a>
</p>

<p align="center">
  <strong>When a dependency breaks your code, Patchery fixes it — and proves the fix, or says plainly that it could not.</strong>
</p>

---

Dependabot bumps the version and hands you a red build. Patchery takes the next
step: it reads the changelog, migrates the call sites, runs your tests, and opens
a pull request **only when those tests pass**.

It runs as a GitHub Action, inside your own CI. Your code is never uploaded
anywhere.

```yaml
- uses: patchery-dev/Patchery@v0
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

## When it cannot patch it, it hands you the analysis

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

It made no code change, and said so. That report is the deliverable.

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
      - uses: patchery-dev/Patchery@v0
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

Patchery migrates **call sites in JavaScript and TypeScript projects** when a
dependency's API changes, and it is judged by your own test suite. Where the break
is not a call-site problem, it reports rather than patches.

It is being measured against real breaks in repositories we do not own — express,
node-fetch, winston, yargs and others — with the losses reported alongside the
wins. That benchmark is public and reproducible: the case list lives in
[`benchmark/`](benchmark) and the workflows that run it are in
[`.github/workflows`](.github/workflows). Numbers will be published here when the
full set has run, and one thing already measured is worth saying: a great deal of
what breaks a build in 2026 is packaging rather than a changed signature, which is
why the report is not a consolation prize.

The engine has 474 offline checks covering the guard, the census and the outcome
rules. None of them need an API key: `node scripts/selftest.mjs`.

## Where it is going

**Breaks that are not API changes.** Much of what actually breaks a build in 2026
is packaging, not signatures — a dependency shipping as an ES module and your
`require()` no longer working. The census makes it safe to let the agent touch
build configuration, which brings that class into range.

**Changes that do not break anything.** A new version can quietly make your
workaround unnecessary. Nothing goes red, so nobody notices. The same machinery
reads a changelog and proposes the adoption, with the same proof standard.

**Beyond npm.** A REST API removing a field breaks you without changing a single
line of your `package.json`. The engine already takes a changelog as input; the
work is in noticing.

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

**Patchery™** is a trademark of Ugur (ugursku), first used in commerce on
2026-09-05. The licence covers the code and grants no rights in the name: a
fork is free to exist, under its own name.
