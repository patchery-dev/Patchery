<p align="center">
  <img src="assets/logo.png" width="64" height="64" alt="Patchery logo">
</p>

<h1 align="center">Patchery</h1>

<p align="center">
  <a href="https://patchery.dev">patchery.dev</a>
</p>

<p align="center">
  <strong>When a dependency breaks your code, Patchery fixes it — and proves the fix before you see it.</strong>
</p>

---

Dependabot bumps the version and hands you a red build. Patchery takes the next
step: it reads the changelog, migrates the call sites, runs your tests, and opens
a pull request **only when those tests pass**.

It runs as a GitHub Action, inside your own CI. Your code is never uploaded
anywhere.

```yaml
- uses: patchery-dev/Patchery@v1
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
it cannot inherit its mistakes.

**A refusal.** If the fix cannot be proved, nothing is shipped. You get the
diagnosis instead: what broke, why the obvious fix does not apply, and which
decision would unblock it.

That last one is the point. A tool that is right most of the time and silent
about the rest is worth more than one that is confident every time.

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
      - uses: patchery-dev/Patchery@v1
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
dependency's API changes, and it is judged by your own test suite.

It is being measured against real breaks in repositories we do not own — express,
node-fetch, winston, yargs and others — with the losses reported alongside the
wins. That benchmark is public and reproducible: the case list lives in
[`benchmark/`](benchmark) and the workflows that run it are in
[`.github/workflows`](.github/workflows). Numbers will be published here when the
full set has run.

The engine has 348 offline checks covering the guard, the census and the outcome
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

## License

MIT
