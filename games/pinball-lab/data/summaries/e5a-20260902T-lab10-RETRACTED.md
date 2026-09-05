# E5a (LAB-10) — RETRACTED 2026-09-04 · **SUPERSEDED 2026-09-05 by `e5a-lab27`**

`e5a-20260902T-lab10.{json,md}` has been removed (`git rm`, recoverable in git history).
**This is no longer a death certificate.** E5a has been re-run as a new experiment against the
post-fix solver and published as [`e5a-lab27.md`](e5a-lab27.md) — see "What actually happened"
below, including a correction to the reason given for the original retraction.

## Why it was retracted (2026-09-04) — still correct

opus2's solver-fix audit (`ledger/handoffs/opus2/20260904T130000Z-lab-corpus-solver-fix-
audit.md`) found E5a is built on `data/e4/e5a-20260902T125754Z`, a raw run against the E4
arena as it stood *before* the `e5ff0d7` kinematic-flipper solver fix — 99.89% of that arena's
trials differ under the fixed solver. E5a's per-assembly `hsS`/shot-rate curve and its
GEOMETRY/MODEL verdict rest entirely on that pre-fix data. **That reasoning stands: the old
corpus was invalid and remains withdrawn.**

## What the retraction got wrong about the blocker

The original disposition said:

> *"A fresh E5a run needs a fresh E4 assembly grid (E5a's cfgs are drawn from E4's
> `E4_W1_GRID`/Stage-B/Stage-C winners), and E4 itself is currently blocked from regeneration
> at HEAD."*

**That was not true, and it kept E5a shelved for longer than it needed to be.**
`buildE5aCfgs()` reads no E4 run data at all. Every input is a static constant in `sweep.js` —
`E4_W1_GRID`, `E4_RADII`, `E4_LAB2_WINNER`, `E4_STAGEC_UPMS`, `E4_STAGEC_RELEASE_DELAY_MS`,
`E5A_ACTIVE_ANGLES` — plus the analytic `predictHsS`/`withPocketSolve`. No Stage-B or Stage-C
winner enters the grid, and `--grid e5a` is the only derived E4 sweep that takes no `--top`
argument; `stageA2`, `stageB` and `stageC` all require one.

So E5a was never waiting on a regenerated E4. What was stale was **E5a's own raw run**, and it
became re-runnable the moment the solver was fixed, not when E4 regenerated.

## What actually happened (2026-09-05)

Re-run as a **new experiment**, not a restoration: `data/e4/e5a-lab25final`, 135 cfgs, 180,000
trials, instrument commit recorded (the writer gap that let the original omit it is closed).
Published as `data/summaries/e5a-lab25.{json,md}`.

- **Validity: sound.** `IMPACTS_EXHAUSTED`, `ESCAPED` and `NAN` are all **zero** over
  non-stalled trials after the LAB-23 metric fix.
- **First attempt (LAB-25, `e5a-lab25`): verdict INDETERMINATE.** Nine of fifteen assemblies
  shared `hsSPredicted` = 0.0000 exactly, and the r of 0.845 rested on two rows. That summary is
  superseded by `e5a-lab27` below and should not be cited.
- **Resolved (LAB-27, `e5a-lab27`): verdict GEOMETRY, on a sound axis.** The degeneracy was two
  code artifacts, not a property of the geometry — `predictHsS` clamps its projection to [0,1]
  to match `classifySettle`'s measured range, collapsing 62.4% of the 1,080 feasible assemblies
  onto exactly 0, and the sampler then quantile-binned on that clamped value. Unclamped, the
  same quantity spans [-0.3811, +0.2546] with 450 distinct values. LAB-27 exposes the unclamped
  projection and samples RANGE-uniformly along it. The axis now passes gate.js's population test
  (16 distinct values in 16 assemblies) and the curve is a clean threshold: shot rate ≤ 2.2% for
  every assembly at hsS ≤ +0.116, then 29.3% / 39.4% / 45.6% at +0.158 / +0.192 / +0.226.
  Pearson r = 0.687, and — the check that killed the first attempt — **leave-one-out keeps r in
  [0.606, 0.747], entirely above the 0.5 threshold**. No single assembly carries the verdict.
- **No premise needed.** The re-sampled corpus flags **0.684%** excluding STALLED, under the
  plain 1% gate, so the declaration written for the LAB-25 run has been removed rather than
  carried forward.

## What the finding says, and what it does not

E5a's question was *"does shot rate rise with hsS (geometry, solver exonerated) or stay ~0
everywhere (model is the suspect)?"* — and the answer is **geometry**. Shot rate is a threshold
in hsS, not a gradient: flat at ≤2.2% for the thirteen assemblies at hsS ≤ +0.116, then rising
monotonically 29.3% → 39.4% → 45.6% across the three above +0.15. The retrap E4 attributed to
hsS is real and geometric.

What it does not license: the correlation still weakens below the 0.5 threshold if the top TWO
assemblies are dropped (r = 0.480), so the finding rests on three rising-limb points, not on a
densely sampled curve. And the feasible range ends at +0.2546, barely past the transition — the
W1 grid cannot reach far enough to show where shot rate plateaus. Anyone wanting the shape of
the rise, rather than its existence, needs a geometry family that reaches higher hsS.

Ruling: `ledger/handoffs/opus2/20260905T020000Z-e5a-reborn-and-premise-hardening.md`.
