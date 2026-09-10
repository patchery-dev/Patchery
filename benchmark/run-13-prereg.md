# Pre-registration: the frozen run

**Written 2026-09-10, after the run was dispatched and before any result was
seen.** Same discipline as `label-rules-prereg.md`, and for the same reason: a
prediction written after the fact is not a prediction, and this project's whole
claim is that it does not do that.

## Settings, as dispatched

```
only                 : (empty - all 14 cases)
limit                : 0
repeats              : 3        -> 42 legs, 4 in parallel
model                : muse-spark-1.3-contributor
max-turns            : 45
run-budget-minutes   : 45
job-timeout-minutes  : 90
briefing             : on
runner               : ubuntu-24.04
```

This is run #11's regime exactly. The recommendation to raise the ceilings was
withdrawn: three independent providers argued against it, and the measurement
that settled it was ours - the five legs that hit the 45-minute clock in run #11
had already used 38 to 41 of their 45 turns, so extra minutes buy four to seven
turns and then stop at the turn ceiling instead.

## What changed since run #11, and what it can move

| change | can it move an outcome? |
|---|---|
| Node floor fixed (`77d33f1`) | **Yes.** Six node-fetch legs were `BLOCKED`; they now run |
| Failed-verification patches saved (C13) | **Yes.** `REFUSED` could not be labelled before, because the evidence was deleted |
| CLI telemetry off | **Unknown, and stated as unknown.** May or may not affect the two treeherder crashes |
| Call-site count printed | No. It reports; it gates nothing |
| `patchNote` reason per path | No. Wording only |
| Candidate record (C12) | No. Extra outputs only |

## The predictions

Run #11, measured: `NO-CHANGE` 17 · `EXHAUSTED` 13 · `BLOCKED` 8 · `FIXED` 4,
and `REFUSED`, `WRONG`, `CRASHED`, `UNANSWERED`, `NEEDS-DECISION` all zero.

For this run, over 42 legs:

| outcome | predicted | reasoning |
|---|---|---|
| `FIXED` | **3-6** | Same corpus, model and ceilings as run #11's 4. No change here targets success |
| `NO-CHANGE` | **17-24** | Run #11's 17 plus a share of the six revived legs |
| `EXHAUSTED` | **13-19** | Run #11's 13 plus a share of the six revived legs |
| `BLOCKED` | **0-3** | Only treeherder should remain, and only if telemetry was not the cause |
| `REFUSED` | **0-2** | The blocker was the deleted patch, not the ceiling. But only one leg in 48 has ever reached this state |
| `WRONG` | **0** | This is the claim. **One falsifies it** |
| `CRASHED` | **0-1** | Never seen |
| `UNANSWERED` | **0-1** | Never seen |
| `NEEDS-DECISION` | **0** | The gate needs `inScope === false`; the corpus is mostly `esm-require`, which is `partial` |

And two figures that matter more than the table:

| quantity | predicted |
|---|---|
| Legs producing a candidate patch | **4-8** (run #11: 4 of 42) |
| Legs whose patch is saved to disk after failing verification | **at least 1 if any leg fails verification** - this is what C13 changed, and the artifact is `sma-unverified.patch` |
| Wall clock | **1.5-3 hours** (run #11: 1h29m, plus six legs that used to die in eight seconds) |
| Anthropic-list-equivalent spend | **$110-160** (run #11: $101.95 measured across the 29 legs that reported; 13 reported nothing) |

## How to tell a wrong prediction from a wrong run

- **`WRONG` ≥ 1** - the headline claim is falsified. Publish it. This is the
  error budget, and it was set before the run.
- **`REFUSED` = 0** - not a failure of the tool and not a broken prediction. The
  pre-written limitation stands: no one has established that any case in this
  corpus structurally permits "fixable but not verifiable", so the event may
  simply have no opportunity to occur. Say that, do not explain it away.
- **`BLOCKED` > 3** - the Node fix did not hold, or a new harness fault. Ours,
  out of the denominator, and it must be named.
- **A number outside its band** - the prediction was wrong, and that is a fact
  about our understanding, not about the run. Record it and say which way.

## What must not happen after the results land

The limitations section (`vault 88`) is already written and must not change
because of what the table says. Its own test: *no item may change based on the
result.* Adding an item now would make it an excuse.

The outcome table is published **whatever it says**.
