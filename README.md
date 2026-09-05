<p align="center">
  <img src="assets/logo.png" width="64" height="64" alt="Patchery logo">
</p>

<h1 align="center">Patchery</h1>

**When a dependency breaks your code, Patchery fixes it and proves the fix.**

A GitHub Action that fixes your code when a dependency ships a breaking change — verified against your own tests, delivered as a pull request.

Dependabot bumps the version and leaves you with a red build. This action goes one
step further: it reads the changelog, migrates the call sites to the new API, runs
your tests, and opens a PR **only if those tests pass**.

---

## How it works

```
1. Run the tests        -> Is it actually broken? If it passes, do nothing.
2. Run the agent        -> Read the changelog, migrate the call sites.
3. Check with git       -> What changed? Touched a test or node_modules? REVERT.
4. Run the tests again  -> Never trust the agent's word; measure it.
5. Open a PR            -> Only if steps 1-4 came back clean.
```

Steps 3 and 4 are the point of this project. If you tell an AI agent to make the
tests pass, deleting the tests is a valid way to do that. So this action never reads
the agent's own report: it inspects the diff with `git status`, reverts everything if
a protected file was touched, and re-runs the test command itself.

**Protected paths** — if the agent touches any of these, the whole run is discarded:

- test files — `*.test.*`, `*.spec.*`, `test/`, `tests/`, `__tests__/`, `__mocks__/`
- `node_modules/`
- `.github/`
- lockfiles — `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`

That guard is covered by [`scripts/selftest.mjs`](scripts/selftest.mjs), which runs on
every push and needs no API key.

---

## Setup

### 1. Add your secrets

Repo → **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Required | Purpose |
| --- | --- | --- |
| `ANTHROPIC_AUTH_TOKEN` | yes | The agent's API key / token |
| `ANTHROPIC_BASE_URL` | no | Only if you use a compatible custom endpoint |
| `ANTHROPIC_MODEL` | no | Model name (default if empty) |

Never inline the key in a workflow file — Actions logs can be public.

### 2. Copy the workflow

Save [`examples/self-maintain.yml`](examples/self-maintain.yml) in your own repository
as `.github/workflows/self-maintain.yml`.

### 3. Run it

Repo → **Actions → self-maintain → Run workflow**, then fill in which package broke
and which directory to fix.

> There is deliberately **no scheduling or automatic package scanning** in this
> version. You decide which package gets handled. Full automation is the next step.

---

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `package` | *(required)* | Name of the package that broke |
| `target-dir` | `.` | Project directory to fix |
| `test-command` | `npm test` | Verification command (runs before and after) |
| `changelog` | `""` | Changelog path or URL; empty means the agent looks for it |
| `max-turns` | `25` | Agent turn limit — your cost brake |
| `extra-instructions` | `""` | Extra instructions for the agent |
| `require-failing-baseline` | `true` | Skip the agent entirely if tests already pass |
| `dry-run` | `false` | Only measure the baseline test run |
| `node-version` | `20` | Node version to install |
| `anthropic-auth-token` | *(required)* | Pass from secrets |
| `anthropic-base-url` | `""` | Pass from secrets |
| `anthropic-model` | `""` | Pass from secrets |

## Outputs

| Output | Description |
| --- | --- |
| `changed` | `true` / `false` — whether files actually changed |
| `tests-passed` | Whether tests passed after the fix |
| `files` | Changed files, one per line (ready for `add-paths`) |
| `pr-body-file` | Path to the generated PR body (ready for `body-path`) |
| `summary` | One-line summary |

---

## Try it on this repo

[`test-fixture/`](test-fixture/) is broken on purpose: `fake-lib` went from 1.x to
2.0.0 and `formatPrice(amount)` became `formatPrice(amount, currency)`.
`test-fixture/app.js` still makes the old call, so `npm test` fails.

Go to **Actions → self-maintain (demo) → Run workflow**. Expected result: the agent
fixes `app.js`, the tests pass, and a PR appears on the `self-maintain/fake-lib` branch.

> Do **not** merge the demo PR — the fixture has to stay broken, otherwise later runs
> will correctly report "nothing to fix".

To try it locally, without Actions:

```bash
npm install
SMA_PACKAGE=fake-lib \
SMA_TARGET_DIR=test-fixture \
SMA_CHANGELOG=node_modules/fake-lib/CHANGELOG.md \
ANTHROPIC_AUTH_TOKEN=... \
node scripts/agent.mjs
```

---

## Limitations (stated honestly)

- Only tried on **Node/npm** projects so far. The test command is configurable, so
  other ecosystems may work, but that is unverified.
- **One package per run.** It does not resolve cascading breakages.
- Cost varies per run; `max-turns` is the brake.
- The resulting PR **needs human review**. There is no auto-merge, and there should not be.
- The agent sees your source code. Do not point it at private repositories without
  checking the data policy of the model provider you configured.

## License

MIT
