# E5a — the release diagnostic (LAB-10)

- **instrument commit**: `5475ecbde2f68b9f7e7d37b447a3e93702adad8d`  ·  **generated**: 2026-09-05T03:59:48.637Z

## VERDICT: **INDETERMINATE**

> ⚠ **The verdict is INDETERMINATE because the axis cannot carry it.** `hsSPredicted` has 7 distinct values across 15 assemblies and 60% of them are tied at a single value — 60.0% of rows tied at one value (ceiling 50%) — presenting this as an order would be misleading. A Pearson r computed over that is decided by the handful of rows that are not tied, so neither GEOMETRY nor MODEL can be read off it. The per-assembly table below is real measured data and stands on its own; what does not stand is the curve drawn through it. Fixing this needs a denser feasible hsS sweep, not a re-run of this grid.


Shot rate stays near zero across the WHOLE `hsS` range swept here (Pearson r = 0.845, max shot rate 45.64%, min 0.00%) — including assemblies E4's Stage C never released from. **The kinematic, spinless, single-`MU` flipper model is the suspect: E4's release finding is provisional, and E5b/E5c (ball spin + rubber friction + dynamic flipper) are justified.**

- **arena-on-target**: C0 cp = 0.00% (gate: <1%) — PASS
- **trials**: 180000 across 135 cfgs (15 assemblies x upMs x releaseDelayMs) in 96.7s

## Shot rate vs hsS (the deciding curve)

| hsS (predicted) | hsS (measured mean) | n | cr% | cp% | shot% | retrap% | drain% |
|---|---|---|---|---|---|---|---|
| 0.0000 | 0.0017 | 11777 | 63.77 | 63.66 | 0.110 | 63.66 | 0.00 |
| 0.0000 | 0.0084 | 12006 | 77.37 | 76.72 | 0.650 | 76.72 | 0.00 |
| 0.0000 | 0.0045 | 11764 | 68.22 | 67.91 | 0.272 | 67.94 | 0.00 |
| 0.0000 | 0.0050 | 12000 | 76.39 | 76.01 | 0.358 | 76.03 | 0.02 |
| 0.0000 | 0.0018 | 11802 | 82.88 | 82.72 | 0.119 | 82.76 | 0.00 |
| 0.0000 | 0.0711 | 11939 | 69.95 | 64.97 | 4.774 | 65.16 | 0.01 |
| 0.0000 | 1.0000 | 11633 | 0.31 | 0.00 | 0.249 | 0.02 | 0.01 |
| 0.0000 | 0.0000 | 11982 | 82.67 | 82.67 | 0.000 | 82.67 | 0.00 |
| 0.0000 | 0.0000 | 11991 | 54.32 | 54.32 | 0.000 | 54.36 | 0.00 |
| 0.0159 | 0.0395 | 11949 | 80.39 | 79.94 | 0.385 | 79.96 | 0.00 |
| 0.0411 | 0.0663 | 11992 | 72.32 | 71.78 | 0.534 | 71.79 | 0.01 |
| 0.0677 | 0.0898 | 11068 | 78.84 | 78.11 | 0.623 | 78.18 | 0.02 |
| 0.1033 | 0.1199 | 11297 | 75.46 | 75.22 | 1.337 | 74.11 | 0.00 |
| 0.1364 | 0.1535 | 11520 | 77.28 | 76.73 | 20.642 | 5.26 | 51.38 |
| 0.1896 | 0.2236 | 11976 | 77.79 | 75.84 | 45.641 | 2.15 | 30.00 |

Pearson r(hsS, shotRate) = 0.845 across 15 assemblies. Max shot rate 45.641%, min 0.000%.

## Notes

- Assemblies are the W1 guide grid (§2.1, `E4_W1_GRID`) x Stage B's activeAngleDeg values x A1's radius values (`E4_RADII`), stratified by PREDICTED `hsS` (the `pocketSolve` two-contact analytic, same formula as `classifySettle`'s clamped projection) into one-per-quantile-bin across the WHOLE feasible range — not ranked by `cp` the way Stage C's top-6 were.
- The achievable `hsS` range for this W1 geometry family is asymmetric: unclamped analytic values across the full 1,080-combination grid (W1 x radius x activeAngleDeg) span roughly [-0.38, +0.25]; clamped to [0,1] (matching `classifySettle`), most feasible pockets land at/near 0 and the reachable positive ceiling is ~0.19-0.25, never near the tip. That ceiling is itself part of the answer to "how much of the hsS range is even geometrically reachable" — reported here, not smoothed over.
- Same release protocol as Stage C: `holdThenRelease` policy, `release: true` (6.0s window), `upMs` ∈ {8,14,24}, `releaseDelayMs` ∈ {60,150,350}, `inj: drop`. `restAngleDeg`/`restitution` held at LAB-2's winner, matching every other E4 stage's "flipper held fixed except where the design explicitly re-sweeps it" convention.
