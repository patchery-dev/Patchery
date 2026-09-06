<p align="center">
  <img src="assets/logo.png" width="64" height="64" alt="Patchery logo">
</p>

<h1 align="center">Patchery</h1>

<p align="center"><a href="https://patchery.dev">patchery.dev</a></p>

**When a dependency breaks your code, Patchery fixes it and proves the fix.**

Your project runs on other people's code. When they change how it works, your app
stops working. Patchery finds what broke, rewrites the lines that need rewriting,
and checks the result against your own tests before it shows you anything — and
throws its own work away if that check goes badly.

Dependabot bumps the version and leaves you with a red build. This action goes one
step further: it reads the changelog, migrates the call sites to the new API, runs
your tests, and opens a pull request **only if those tests pass**.

---

## Writing the fix is the easy part

Tell an AI to make your tests pass and it can pass them by deleting them. It can
soften a check, stub out the function, or edit the very file that decides what
"working" means. Every one of those makes a broken project look fixed.

So this action never reads the agent's own account of what it did. It looks at the
files themselves, throws the whole attempt away if anything off-limits moved, and
re-runs your test command itself.

```
1. Run the tests        -> Is it actually broken? If it passes, do nothing.
2. Run the agent        -> Read the changelog, migrate the call sites.
3. Check with git       -> What changed? Touched a test or node_modules? REVERT.
4. Run the tests again  -> Never trust the agent's word; measure it.
5. Try to refute it     -> A second agent, read-only, never shown the first one's reasoning.
6. Open a PR            -> Only if steps 1-4 came back clean, with step 5's verdict in it.
```

Steps 3 and 4 are the point of this project.

**Blocked changes** — if any of these show up in the diff, the whole run is
reverted and no PR is opened:

- test files — `*.test.*`, `*.spec.*`, `test/`, `tests/`, `__tests__/`, `__mocks__/`
- test harness configuration — `jest`/`vitest`/`playwright`/`cypress`/`karma` config,
  `.mocharc.*`, `jest.setup.*`, `vitest.setup.*`, `setupTests.*`. Protecting the tests
  is not enough on its own: excluding a spec in `vitest.config.js` turns the build
  green without touching a single test.
- `node_modules/`
- `.github/`
- lockfiles — `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`
- **anything outside `target-dir`** — unless you list it in `allowed-paths`
- **any deleted tracked file** — unless you set `allow-deletions: true`

The last two exist because a migration edits call sites; it does not delete files
or wander into unrelated directories. Anything that does is either the agent
exceeding its brief or another process dirtying the tree mid-run — and Patchery
cannot tell those apart, so it treats both the same way: show you the diff, revert,
open nothing. Whatever it blocks, it names, with the input that would allow it.

That guard lives in [`scripts/guard.mjs`](scripts/guard.mjs) as pure functions, and
is covered by [`scripts/selftest.mjs`](scripts/selftest.mjs), which runs on every
push, offline, in about a second, with no API key.

## "So one AI wrote it and the same AI approved it?"

No. Step 5 is a second agent whose job is to **refute** the change, not to review it
politely. It gets the diff, the test output from before and after, and the changelog.
It is never given the first agent's explanation — not by convention, but because the
function that assembles its evidence has no parameter for one, and a test fails if
someone adds it. Hand a judge the author's argument and it grades the argument.

It has `Read`, `Grep` and `Glob`, and nothing else. No shell: that is both code
execution and a way to write files. No network. Whether it stayed read-only is
measured against the working tree afterwards rather than assumed.

Its opinion can only ever **lower** the outcome. It cannot unblock a protected path,
widen the scope, or un-fail a test run — the mechanical guard and your own tests
remain the authority, and the stochastic part stays off the critical path. Low
confidence downgrades a refutation exactly as it downgrades an approval: the same bar
to condemn as to bless. A review that could not run, or could not open the repository
to check its own claims, never returns "not refuted".

By default it never blocks. A false "this is bad" silently destroys a correct, tested
fix and you never see the diff — the expensive direction. The verdict goes in the pull
request instead, including the unflattering ones, because the honest answer to the
question in this heading is an artifact you can read, not a veto you have to trust.
`verify-mode: block` is there if you want it, and it saves the rejected diff as a
patch file rather than losing it.

**One repair turn, off by default.** `verify-repair` lets a concern go back
to the fixing agent for a single extra turn. It is off because most of what a reviewer
raises is *I could not check this from here* — a hardcoded value nothing validates, a
test file it was never shown. That is honest, useful to you, and useless to the fixer:
what is missing is information, not code. Hand it back anyway and a model given
criticism will find something to change, and every extra change to already-passing code
is risk. So a concern qualifies only when it is anchored twice — the reviewer named a
file, **and** at least one of its own checks actually found something rather than coming
back with no evidence. When it does fire, the guard, your tests and the review all run
again over the result, so the verdict in the pull request describes the diff in the pull
request.

**Letting it read the repository costs money on some models.** Grepping for call sites
the migration missed is the reviewer's highest-value move and the one check the
mechanical guard cannot do — so `verify-tools` defaults to `auto`, which hands it
`Read`, `Grep` and `Glob`. But a model that investigates until its turns run out
answers nothing at all, which is worse than a shallower answer. Measured on GLM: 12
turns, 12 tool calls, no verdict, on every run, then a second no-tools call that
converged in 4. `auto` now pays that discovery cost at most once per run instead of
once per review, and `verify-tools: off` skips it entirely — the right setting once
you have measured your reviewer model, at the cost of capping the verdict at
`concerns`, because a reviewer that never opened the repository cannot check a single
one of its own claims. `verify-tools: on` insists on tools and reports a burnout as
*the review could not run*, rather than quietly substituting the weaker answer.

**`verify-min-confidence` is a guess, and it is labelled as one.** It ships at 60.
Nobody measured 60. That input does exactly one thing — below it, a verdict is
recorded as a concern instead of acted on — which means over a set of changes whose
correctness is already known, every possible threshold has exactly three effects, and
they can be counted:

| | |
| --- | --- |
| **helped** | a *wrong* approval gets flagged — the entire point of the input |
| **false alarm** | a *right* approval gets flagged — noise on a correct fix |
| **defused** | a *right* refutation stops blocking — in `block` mode, a bad fix goes through |

`node scripts/calibrate.mjs` runs the real reviewer — same prompt, same schema, same
evidence builder — over [`calibration/`](calibration/): 23 changes to the fixture, 11
correct migrations and 12 subtly wrong ones. **Every case passes the tests.** That is
the design: a wrong migration that fails the tests is already caught by the test
re-run, for free, before a reviewer is paid, so it tells you nothing about a
confidence threshold. The population the threshold is applied to is exactly this one.
The script prints what each threshold from 0 to 100 would have done, and recommends
`argmax(helped − falseAlarm − defused)` with ties going to the lowest, because the
default should be to intervene less. A net of 0 everywhere is a real answer: it means
the number carries no signal and the honest setting is 0.

The counting is a pure function, unit-tested offline; `--dry-run` exercises the whole
harness without calling a model, and CI runs it on every push so the tool cannot rot
between uses. **What has not happened is the run itself** — that needs a key and a
budget, and until someone does it, 60 stays a round number. The `review-confidence`
output exists so your own runs accumulate the same data.

**What it is not.** With `verify-model` empty it shares the fixer's weights, so what
you get is different context, no rationale, no write access and an opposite success
condition — not true independence. It will not catch a change that is wrong in a way
invisible in the code and untested by your suite. Judge it on the concerns it actually
files, which are on every PR for you to check.

---

## What it has actually done

One pull request, opened end to end with no human in the loop. The fixture is
committed broken on purpose so the run can be repeated, and each run replaces the
same branch, so the figures below are the latest of four successful runs rather
than a one-off:

**[patchery-dev/Patchery#2](https://github.com/patchery-dev/Patchery/pull/2)** — `fake-lib`
went 1.x → 2.0.0 and made `formatPrice`'s second argument required. The action ran
the tests (failed), read the changelog, changed one line in one file, checked the
diff against the guard, ran the tests again (passed), and opened the pull request.
The first human to see it was the reviewer.

| files | lines | tests | turns | cost at list rates |
| --- | --- | --- | --- | --- |
| 1 | +1 −1 | failed → passed | 9 | $0.2251 |

A second agent then reviewed that diff without write access and without being shown
the first agent's reasoning: **not refuted, confidence 72, $0.3298**. Proving the fix
cost more than making it. Every figure here is read out of the pull request itself,
and [patchery.dev](https://patchery.dev) re-checks them against it in your browser —
because we quoted two of them wrong once and nothing caught it.

And the same job by hand, on projects we don't own — no agent involved in either,
they are here because doing the work manually is how we learned what the automated
version has to survive:

| Repo | What changed |
| --- | --- |
| [ianarawjo/ChainForge#416](https://github.com/ianarawjo/ChainForge/pull/416) | OpenAI SDK v3 → v4: three call sites, plus response unwrapping and `APIError` handling |
| [ToolJet/ToolJet#17829](https://github.com/ToolJet/ToolJet/pull/17829) | Gemini plugin off `@google/generative-ai`, end-of-life since 30 Nov 2025 |
| [Caknoooo/chatgpt3-openai-api#2](https://github.com/Caknoooo/chatgpt3-openai-api/pull/2) | OpenAI SDK v3 → v4, and a model that had already been shut down |

All three are open. None has been merged. We will change this sentence the day that
changes — and [patchery.dev](https://patchery.dev) checks it against the GitHub API
every time someone loads the page, so if it ever stops being true the site says so
before we do.

---

## What it could not do

Pointed at four repositories we don't own, it has opened nothing. Every run below is
real and was paid for.

| Target | Turns | Wrote | What stopped it |
| --- | --- | --- | --- |
| `giancarloerra/SocratiCode` | 25 | nothing | Read every failing test, worked out they were all about the machine we ran on rather than the library it was sent to fix, and declined to invent a change |
| `dwmkerr/terminal-ai` | 15, 22, 40 | nothing | A stateful-to-stateless API redesign, bigger than one run. Twice our own stall rule cut it off as it was about to start writing — that rule has since been replaced |
| `gitroomhq/postiz-agent` | 0 | nothing | A real, reported break that had already healed on the newer Node we ran on, so the baseline passed and the agent never started |
| `activepieces/activepieces` | 0 | nothing | Its package manager was missing, a partial install left shared dependencies unlinked, and the file we came to fix has no tests at all |

A fifth, `evolution-foundation/evolution-api`, was dropped before a run: a real
unfixed break with an open issue and no pull request against it — and not one real
test file in 559.

Not one of these is a wrong fix. In every one there was an obvious way to look
productive: write something plausible, get the tests green, open the pull request.
It never did. And the most common thing that stops it appears twice in that table —
the project has no tests, so there is nothing to measure a fix against, and refusing
is the correct answer.

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

### 2. Let Actions open pull requests

Repo → **Settings → Actions → General → Workflow permissions** → tick
**"Allow GitHub Actions to create and approve pull requests"**.

Without it the agent runs, fixes your code, verifies the tests — and then the last
step fails with:

```
GitHub Actions is not permitted to create or approve pull requests.
```

The work is done at that point but has nowhere to go, and the error does not say
which setting to change. If your repository belongs to an organisation, the same
switch also has to be on at the org level (**Organisation settings → Actions →
General**); a repository cannot grant itself more than the org allows.

### 3. Copy the workflow

Save [`examples/patchery.yml`](examples/patchery.yml) in your own repository
as `.github/workflows/patchery.yml`.

### 4. Run it

Repo → **Actions → Patchery → Run workflow**, then fill in which package broke
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
| `extra-checks` | `auto` | Also run the project's own lint/type-check and refuse a change that breaks one |
| `allowed-paths` | `""` | Paths outside `target-dir` the run may still change, one per line |
| `allow-deletions` | `false` | Allow the run to delete tracked files |
| `verify-mode` | `warn` | Independent review: `warn` records the verdict, `block` withholds a refuted PR, `off` skips it |
| `verify-model` | `""` | Model for the reviewer; empty means the same one, in a separate call |
| `verify-base-url` | `""` | Send the review to a different provider entirely (a second party sees the diff) |
| `verify-auth-token` | `""` | Credential for that provider; redacted like every other key |
| `verify-tools` | `auto` | Whether the reviewer may read the repository. `off` skips a tool pass your model never converges in — see below |
| `verify-repair` | `false` | Hand an actionable concern back to the fixer for one more turn. Off on purpose — see above |
| `verify-repair-turns` | `8` | Turn limit for that repair turn |
| `verify-min-confidence` | `60` | Below this, a verdict is recorded as a concern rather than acted on. **A round number nobody has measured** — see below |
| `verify-max-turns` | `12` | Turn limit for the reviewer |
| `verify-max-diff-bytes` | `60000` | Skip the review above this diff size |
| `max-turns` | `25` | Agent turn limit — your cost brake |
| `baseline-retries` | `2` | Re-runs of a failing baseline before believing it. Catches a flaky suite before you pay for an agent |
| `stall-repeats` | `3` | Stop if the same tool call is repeated this many times |
| `stall-stale-turns` | `5` | Stop after this many turns in a row that turn up nothing the run has not already seen |
| `stall-no-edit-turns` | `0` | Legacy ceiling on turns without an edit. Off by default: it stopped careful agents mid-research |
| `extra-instructions` | `""` | Extra instructions for the agent |
| `require-failing-baseline` | `true` | Skip the agent entirely if tests already pass |
| `dry-run` | `false` | Only measure the baseline test run |
| `node-version` | `22` | Node version your tests run on (Node 20 is end-of-life) |
| `anthropic-auth-token` | *(required)* | Pass from secrets |
| `anthropic-base-url` | `""` | Pass from secrets |
| `anthropic-model` | `""` | Pass from secrets |

## Outputs

| Output | Description |
| --- | --- |
| `outcome` | `fixed`, `nothing-to-do`, `flaky`, `inconclusive`, `no-changes`, `dry-run`, `blocked-by-review` or `failed`. Everything but `failed` exits 0 |
| `changed` | `true` / `false` — whether files actually changed |
| `tests-passed` | Whether tests passed after the fix |
| `files` | Changed files, one per line (ready for `add-paths`) |
| `pr-body-file` | Path to the generated PR body (ready for `body-path`) |
| `summary` | One-line summary |
| `review-status` | `not-reviewed`, `unavailable`, `not-refuted`, `concerns` or `refuted` |
| `review-label` | Suggested PR label: `patchery:reviewed`, `patchery:needs-attention`, `patchery:refuted` or `patchery:unreviewed`. Feed it straight into `create-pull-request`'s `labels` — the example workflow does |
| `review-confidence` | The reviewer's own confidence, 0–100, or empty when no review produced one |

---

## Try it on this repo

[`test-fixture/`](test-fixture/) is broken on purpose: `fake-lib` went from 1.x to
2.0.0 and `formatPrice(amount)` became `formatPrice(amount, currency)`.
`test-fixture/app.js` still makes the old call, so `npm test` fails.

Go to **Actions → Patchery (demo) → Run workflow**. Expected result: the agent
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

## Where this actually is

**True today**

- Anyone can install it right now, and read every line of it. MIT licensed.
- One pull request opened start to finish with no human in the loop, four times over.
- A second agent reviews every fix before it ships. It cannot write, and it is never
  shown the first agent's reasoning.
- Four repositories we don't own produced nothing — and nothing wrong. It has never
  invented a fix.
- The off-limits check is pure, unit-tested, and runs on every push with no AI.
- Keys and passwords are redacted before anything reaches a log or a PR body.
- Works on Node / npm projects. You decide what counts as a passing test.

**Not yet**

- Nothing hosted. It runs in your Actions runner, not ours.
- No revenue, no users, no logo wall. Nobody is paying for this.
- No open-source pull request accepted yet — three are waiting, and no human has
  looked at any of them yet.
- One package per run. It does not resolve cascading breakages.
- The off-limits check reads *which* files moved, never what the change did to them.
  Deleting a validation check inside a file the agent is entitled to edit walks past
  it. The second agent reads the change, but that is judgement rather than a rule —
  which is exactly what a deterministic guard exists to avoid having to trust.
- **The fixing agent runs with a shell and no permission prompts.** It gets `Read`,
  `Edit`, `Write`, `Bash`, `Glob` and `Grep`, in `bypassPermissions` mode, because a
  headless run has nobody to ask. Inside the runner it can execute commands and reach
  the network. Nothing is held back *during* the run — everything above happens
  *after* it, by reading git and re-running your tests, and the whole attempt is
  reverted if it does not survive. So the containment is your runner's own isolation
  plus that check, not a restricted toolset. (The reviewing agent is the opposite:
  `Read`, `Grep`, `Glob`, no shell, and its read-only status is measured against the
  working tree afterwards rather than assumed.)
- Whether a break reproduces at all can depend on the runtime. Your `node-version`
  decides which Node the tests run on, and a break that is real on an older one can
  pass on a newer one — we hit exactly that, and the run said "nothing to fix". It
  now flags the case instead of staying silent, but it cannot know which runtime
  you meant.
- Ecosystems beyond Node / npm are plausible, but nobody has proven it.
- Cost varies per run; `max-turns` is the brake.
- The resulting PR **needs human review**. There is no auto-merge, and there
  should not be.
- The agent sees your source code. Check what your model provider does with it
  before you point this at anything private.

We would rather you audit this than trust it. Every number in the pull request table
comes from a run you can open and read. The numbers in *What it could not do* do not —
those runs happened on a laptop and left no public artifact, which is why they are
written out in full rather than summarised.

## License

MIT
