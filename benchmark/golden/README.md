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
