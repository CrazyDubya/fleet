# E5a — the release diagnostic (LAB-10)

- **instrument commit**: `da2476b5644ba5506279848a6c578ff89edb4a61`  ·  **generated**: 2026-09-05T12:38:27.528Z

## VERDICT: **GEOMETRY**


Shot rate rises with `hsS` (Pearson r = 0.687, max shot rate 45.57% vs Stage C's banked ceiling of 0.12%) — **E4's catch/playability tradeoff is real geometry, the kinematic-flipper solver is exonerated on this question.**

<!-- ANNOTATE-3-E5A-ANNOTATION:BEGIN -->

> ⚠ **This file predates a retirement now in `e5aReport.js` (commit `fba0803`).** "Pearson r =
> 0.687", headlined in the VERDICT paragraph above and restated in the detail note below the
> table, is retired as the verdict's supporting statistic: the marginal distributions here
> permit a maximum achievable r of 0.6949, so the published 0.687 is 98.9% of everything this
> data could show — a near-perfect relationship reads as a merely strong one. The relationship
> is also a STEP (13 assemblies at <=2.15% shot rate, 3 at >=29.26%, a 13.6x gap), not a trend
> the Pearson coefficient's linear framing implies.
>
> **What still stands: the verdict `GEOMETRY` is correct, and stronger than the correlation
> implied.** The separation is near-perfect, not merely correlated, and holds under every
> shuffle/leave-one-out check performed. The table's own measured shot/catch/retrap/drain rates
> are untouched by this retirement — only the single coefficient used to headline them is.
>
> No summary regenerated. See `ledger/handoffs/opus2/20260905T201139Z-decisions.md` §6 and
> `ledger/handoffs/opus2/20260905T234733Z-lab-state.md` §7.
<!-- ANNOTATE-3-E5A-ANNOTATION:END -->

- **arena-on-target**: C0 cp = 0.00% (gate: <1%) — PASS
- **trials**: 180000 across 144 cfgs (16 assemblies x upMs x releaseDelayMs) in 96.4s

## Shot rate vs hsS (the deciding curve)

| hsS (axis, unclamped) | hsS (predicted, clamped) | hsS (measured mean) | n | cr% | cp% | shot% | retrap% | drain% |
|---|---|---|---|---|---|---|---|---|
| -0.3530 | 0.0000 | — | 11244 | 0.00 | 0.00 | 0.000 | 0.00 | 0.01 |
| -0.3194 | 0.0000 | 0.0007 | 11243 | 78.37 | 78.32 | 0.044 | 78.32 | 0.00 |
| -0.2798 | 0.0000 | 1.0000 | 11129 | 0.20 | 0.00 | 0.189 | 0.01 | 0.00 |
| -0.2424 | 0.0000 | 0.0001 | 11242 | 81.97 | 81.96 | 0.009 | 81.96 | 0.00 |
| -0.2018 | 0.0000 | 1.0000 | 11088 | 0.29 | 0.00 | 0.271 | 0.00 | 0.00 |
| -0.1626 | 0.0000 | — | 11246 | 0.00 | 0.00 | 0.000 | 0.00 | 0.01 |
| -0.1227 | 0.0000 | 0.0000 | 11241 | 77.97 | 77.97 | 0.000 | 77.97 | 0.00 |
| -0.0832 | 0.0000 | 0.0014 | 11035 | 79.83 | 79.72 | 0.100 | 79.73 | 0.00 |
| -0.0438 | 0.0000 | 0.0041 | 11032 | 79.74 | 79.41 | 0.317 | 79.42 | 0.00 |
| -0.0033 | 0.0000 | 0.0371 | 11250 | 74.17 | 72.02 | 2.151 | 72.02 | 0.00 |
| 0.0352 | 0.0352 | 0.0493 | 11250 | 79.89 | 79.22 | 0.676 | 79.22 | 0.00 |
| 0.0752 | 0.0752 | 0.0844 | 11232 | 72.85 | 72.85 | 0.000 | 70.78 | 2.07 |
| 0.1162 | 0.1162 | 0.1257 | 11235 | 72.59 | 72.53 | 0.596 | 39.16 | 32.84 |
| 0.1578 | 0.1578 | 0.2186 | 10993 | 80.07 | 75.28 | 29.264 | 3.61 | 46.78 |
| 0.1921 | 0.1921 | 0.2232 | 11250 | 65.38 | 64.28 | 39.369 | 23.82 | 2.19 |
| 0.2262 | 0.2262 | 0.2452 | 11059 | 72.70 | 72.62 | 45.574 | 2.50 | 24.63 |

Pearson r(hsS, shotRate) = 0.687 across 16 assemblies. Max shot rate 45.574%, min 0.000%.

## Notes

- Assemblies are the W1 guide grid (§2.1, `E4_W1_GRID`) x Stage B's activeAngleDeg values x A1's radius values (`E4_RADII`), stratified by PREDICTED `hsS` (the `pocketSolve` two-contact analytic, same formula as `classifySettle`'s clamped projection) into one-per-quantile-bin across the WHOLE feasible range — not ranked by `cp` the way Stage C's top-6 were.
- The achievable `hsS` range for this W1 geometry family is asymmetric: unclamped analytic values across the full 1,080-combination grid (W1 x radius x activeAngleDeg) span roughly [-0.38, +0.25]; clamped to [0,1] (matching `classifySettle`), most feasible pockets land at/near 0 and the reachable positive ceiling is ~0.19-0.25, never near the tip. That ceiling is itself part of the answer to "how much of the hsS range is even geometrically reachable" — reported here, not smoothed over.
- Same release protocol as Stage C: `holdThenRelease` policy, `release: true` (6.0s window), `upMs` ∈ {8,14,24}, `releaseDelayMs` ∈ {60,150,350}, `inj: drop`. `restAngleDeg`/`restitution` held at LAB-2's winner, matching every other E4 stage's "flipper held fixed except where the design explicitly re-sweeps it" convention.
