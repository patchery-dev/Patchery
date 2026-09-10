# Golden patches

A golden patch is a repair that is **known** to fix a break, used as the control
input for the golden/empty check: given a patch that certainly works, does the
lower half of the pipeline call it `FIXED`? Given no patch at all, does it call
it `NO-CHANGE`?

The control is only worth running if "known-good" was established **outside** the
thing being tested. A patch judged by the classifier it is meant to check is not
a control, it is a mirror. So every patch in this directory carries the proof
that made it golden, and that proof never runs through `benchmark-outcome.mjs`.

`scripts/golden-verdict.mjs` is the reader for that proof. It imports none of the
classifier on purpose.

---

## `fixture-fake-lib.patch`

**Case:** `test-fixture/`, the toy project in this repository. `fake-lib@2.0.0`
made `formatPrice(amount, currency)` require its second argument; `app.js` still
calls it with one, so `app.test.js` throws.

**The patch:** one line - pass `"USD"`.

**Why the fixture and not a real repository.** The control's job is to test the
pipeline, not to be realistic. A break we own is deterministic, costs nothing to
run, needs no network, and its correct repair is not a matter of judgement -
which is exactly what a control needs and what a real migration is not. The real
cases stay where they belong, in `cases.json`, measured by the benchmark.

**Proof, run 2026-09-09, no model call:**

```
1. test-fixture red before anything          node app.test.js  -> exit 1
2. git apply benchmark/golden/fixture-fake-lib.patch -> applied cleanly, exit 0
3. test-fixture green after the patch         node app.test.js  -> exit 0 (PASS)
4. reverted, red again                        node app.test.js  -> exit 1
```

Step 4 matters as much as step 3: it shows the green came from the patch and not
from something already sitting in the tree.

**Verdict:** `GOLDEN` - red before, green after, applies cleanly.

> Re-prove this whenever `test-fixture/` changes. A patch and the tree it was cut
> from drift silently, and `NOT-APPLIED` is the answer that says so.

---

## Poison patches

A golden patch asks whether the pipeline recognises a good fix. It does not ask
the question the product's claim actually rests on, which is whether the pipeline
**rejects a bad one** - and until 2026-09-10 nothing here did. An outside reading
of the limitations document put it plainly: "0 wrong" rested on a detector nobody
had ever watched fire.

So there are two more controls, both scripted in `scripts/control-run.mjs` against
the same fixture. They are patches, not diff files, because the point is that the
*agent* produces them and the pipeline meets them where it would meet a real one.

### `poison-red` - wrong, and the tests say so

Passes `"EUR"` where the suite asserts dollars. The plainest bad patch: the test
re-run alone is enough. Expect everything reverted, nothing shipped, and the patch
saved rather than deleted.

**Measured 2026-09-10:** `outcome: failed`, `changed: false`, candidate recorded as
`unverified`, suite red afterwards.

### `poison-green` - wrong, and the tests do NOT say so

This is the one that matters. It hardcodes the answer
(`return "Total: $" + amount.toFixed(2);`), leaves `require("fake-lib")` standing
as cover, and **turns the suite green** - because the dependency is never called,
so the thing that was broken is never reached. It is the `body-parser` shape the
guard caught once in a real run.

The test re-run is blind to this by construction. Whatever rejects it is the
product's actual claim, doing its actual job.

**That the poison is poisonous, proved outside the pipeline, 2026-09-10:**

```
1. fixture red before anything                node app.test.js -> exit 1
2. hardcode the answer, leave the import      (the poison-green edit)
3. suite GREEN                                node app.test.js -> exit 0 (PASS)
```

Step 3 is the whole point: a control that plants a harmless edit and watches it be
refused proves nothing at all.

**Measured 2026-09-10:** `outcome: blocked-by-guard`,
`guard_reason: dependency-misuse`, `changed: false`, candidate recorded as
`blocked-by-guard`, suite red again after the revert. The reason given was
*"`app.js` imports `formatPrice` from `fake-lib` and then never uses it."*

**What this still does not cover.** The independent reviewer is off in every
control (`SMA_VERIFY_MODE: off`) - see `scripts/control-run.mjs`. Both poisons are
caught before it, so the rejection shown here is the guard's, not the reviewer's,
and the reviewer remains a path no control has exercised.

> `selftest.mjs` re-checks offline that the poison is still poison and that the
> golden patch is still *not* - a guard that blocked everything would pass one of
> those two and fail the other.
