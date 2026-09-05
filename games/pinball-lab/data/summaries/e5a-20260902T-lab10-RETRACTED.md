# E5a (LAB-10) — RETRACTED 2026-09-04 · **SUPERSEDED 2026-09-05 by `e5a-lab25`**

`e5a-20260902T-lab10.{json,md}` has been removed (`git rm`, recoverable in git history).
**This is no longer a death certificate.** E5a has been re-run as a new experiment against the
post-fix solver and published as [`e5a-lab25.md`](e5a-lab25.md) — see "What actually happened"
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

- **Validity: sound.** 1.8356% flagged excluding STALLED, all of it TIMEOUT;
  `IMPACTS_EXHAUSTED`, `ESCAPED` and `NAN` are all **zero** over non-stalled trials after the
  LAB-23 metric fix. It carries a declared §2.7 premise (3% ceiling, TIMEOUT only) whose reason
  is written in `cfgs/e4-e5a.json`.
- **Verdict: INDETERMINATE, not GEOMETRY.** The new summary does *not* revive the old
  conclusion. Nine of the fifteen assemblies share `hsSPredicted` = 0.0000 exactly (7 distinct
  values across 15 rows, 60% tied), and the Pearson r of 0.845 is carried by two rows whose
  shot rates are 0.2064 and 0.4564 while the other thirteen sit between 0.0000 and 0.0477.
  LAB-25 wires gate.js's existing population validity test onto that axis and it fails, so the
  verdict is gated to INDETERMINATE. The per-assembly table is real measured data and stands;
  the curve drawn through it does not.
- **A second reason not to trust the curve**, recorded in the premise itself: the per-assembly
  TIMEOUT rate runs 2.32%–83.05% and correlates **−0.5569** with `hsSPredicted`, so the tail
  suppresses shot rate hardest at the low-hsS end — the direction that inflates a positive
  correlation. Unlike A1/A2/B, E5a's tail is aligned with the axis of its own finding.

## What E5a would need to answer its question

A denser feasible `hsS` sweep, not a re-run of this grid. The binning in `buildE5aAssemblies()`
draws 16 bins from the analytic prediction, and the feasible set collapses most of them onto
zero; the question "does shot rate rise with hsS" needs assemblies actually spread along that
axis before a correlation over it means anything.

Ruling: `ledger/handoffs/opus2/20260905T020000Z-e5a-reborn-and-premise-hardening.md`.
