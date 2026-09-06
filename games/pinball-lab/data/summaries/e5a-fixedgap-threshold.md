# E5a — the release diagnostic (LAB-10)

- **instrument commit**: `709e4312fb7d2926eb249f0c55e02dcc1d4fb3f5`  ·  **generated**: 2026-09-06T00:39:39.796Z

## VERDICT: **GEOMETRY**


Shot rate clears Stage C's banked ceiling (0.12%) by more than an order of magnitude at its highest hsS assemblies — max shot rate 25.35% — and does so as a STEP, not a trend: 1 of 14 assemblies clear 25.35%, 13 sit at or under 5.99%, a 4.2x gap between the two groups. **E4's catch/playability tradeoff is real geometry, the kinematic-flipper solver is exonerated on this question.** (A Pearson r was computed for this shape in an earlier version of this report and is retired: the two marginal distributions here permit a maximum achievable r of ~0.69, so a near-perfect relationship read as "moderate" against the usual 0-1 intuition, and the coefficient is the wrong statistic for a step in the first place — see RETIRE-ALL §6, ledger/handoffs/opus2/20260905T201139Z-decisions.md.)

- **arena-on-target**: C0 cp = 0.00% (gate: <1%) — PASS
- **trials**: 157500 across 126 cfgs (14 assemblies x upMs x releaseDelayMs) in 73.3s

## Shot rate vs hsS (the deciding curve)

| hsS (axis, unclamped) | hsS (predicted, clamped) | hsS (measured mean) | n | cr | cp | shot | retrap | drain |
|---|---|---|---|---|---|---|---|---|
| -0.0165 | 0.0000 | 0.0051 | 10974 | 75.296% (8263 events / 10,974, 95% CI 74.4805%–76.0941%) | 74.932% (8223 events / 10,974, 95% CI 74.1121%–75.7337%) | 0.319% (35 events / 10,974, 95% CI 0.2294%–0.4432%) | 74.977% (8228 events / 10,974, 95% CI 74.1582%–75.7788%) | 0.000% (0 events / 10,974, 95% CI 0.0000%–0.0350%) |
| 0.0943 | 0.0943 | 0.1220 | 11250 | 71.049% (7993 events / 11,250, 95% CI 70.2037%–71.8797%) | 70.293% (7908 events / 11,250, 95% CI 69.4421%–71.1307%) | 0.756% (85 events / 11,250, 95% CI 0.6115%–0.9332%) | 62.453% (7026 events / 11,250, 95% CI 61.5544%–63.3438%) | 7.849% (883 events / 11,250, 95% CI 7.3662%–8.3604%) |
| 0.0943 | 0.0943 | 0.1073 | 10870 | 72.484% (7879 events / 10,870, 95% CI 71.6365%–73.3154%) | 72.328% (7862 events / 10,870, 95% CI 71.4787%–73.1605%) | 0.147% (16 events / 10,870, 95% CI 0.0906%–0.2390%) | 65.612% (7132 events / 10,870, 95% CI 64.7134%–66.4991%) | 6.734% (732 events / 10,870, 95% CI 6.2781%–7.2207%) |
| 0.0994 | 0.0994 | 0.1154 | 10689 | 77.257% (8258 events / 10,689, 95% CI 76.4526%–78.0418%) | 76.808% (8210 events / 10,689, 95% CI 75.9983%–77.5983%) | 0.365% (39 events / 10,689, 95% CI 0.2670%–0.4984%) | 60.389% (6455 events / 10,689, 95% CI 59.4584%–61.3125%) | 16.503% (1764 events / 10,689, 95% CI 15.8113%–17.2187%) |
| 0.1021 | 0.1021 | 0.1108 | 11236 | 76.210% (8563 events / 11,236, 95% CI 75.4142%–76.9887%) | 76.210% (8563 events / 11,236, 95% CI 75.4142%–76.9887%) | 0.000% (0 events / 11,236, 95% CI 0.0000%–0.0342%) | 43.058% (4838 events / 11,236, 95% CI 42.1450%–43.9758%) | 33.152% (3725 events / 11,236, 95% CI 32.2878%–34.0284%) |
| 0.1036 | 0.1036 | 0.1182 | 11020 | 84.002% (9257 events / 11,020, 95% CI 83.3055%–84.6744%) | 83.512% (9203 events / 11,020, 95% CI 82.8073%–84.1929%) | 2.532% (279 events / 11,020, 95% CI 2.2546%–2.8420%) | 47.078% (5188 events / 11,020, 95% CI 46.1473%–48.0108%) | 34.392% (3790 events / 11,020, 95% CI 33.5107%–35.2842%) |
| 0.1041 | 0.1041 | 0.1122 | 11248 | 39.909% (4489 events / 11,248, 95% CI 39.0079%–40.8176%) | 39.909% (4489 events / 11,248, 95% CI 39.0079%–40.8176%) | 0.240% (27 events / 11,248, 95% CI 0.1650%–0.3490%) | 24.520% (2758 events / 11,248, 95% CI 23.7337%–25.3236%) | 15.158% (1705 events / 11,248, 95% CI 14.5074%–15.8329%) |
| 0.1055 | 0.1055 | 0.1179 | 11246 | 39.490% (4441 events / 11,246, 95% CI 38.5899%–40.3965%) | 39.490% (4441 events / 11,246, 95% CI 38.5899%–40.3965%) | 1.574% (177 events / 11,246, 95% CI 1.3598%–1.8210%) | 23.822% (2679 events / 11,246, 95% CI 23.0435%–24.6180%) | 14.112% (1587 events / 11,246, 95% CI 13.4805%–14.7674%) |
| 0.1069 | 0.1069 | 0.1197 | 11250 | 38.204% (4298 events / 11,250, 95% CI 37.3108%–39.1062%) | 38.187% (4296 events / 11,250, 95% CI 37.2931%–39.0883%) | 1.040% (117 events / 11,250, 95% CI 0.8685%–1.2449%) | 22.791% (2564 events / 11,250, 95% CI 22.0253%–23.5755%) | 14.400% (1620 events / 11,250, 95% CI 13.7634%–15.0609%) |
| 0.1091 | 0.1091 | 0.1181 | 11234 | 75.120% (8439 events / 11,234, 95% CI 74.3122%–75.9109%) | 75.111% (8438 events / 11,234, 95% CI 74.3032%–75.9021%) | 0.534% (60 events / 11,234, 95% CI 0.4152%–0.6868%) | 42.638% (4790 events / 11,234, 95% CI 41.7266%–43.5553%) | 31.948% (3589 events / 11,234, 95% CI 31.0917%–32.8159%) |
| 0.1092 | 0.1092 | 0.1350 | 10720 | 73.405% (7869 events / 10,720, 95% CI 72.5602%–74.2328%) | 72.463% (7768 events / 10,720, 95% CI 71.6091%–73.3001%) | 5.989% (642 events / 10,720, 95% CI 5.5552%–6.4539%) | 61.175% (6558 events / 10,720, 95% CI 60.2490%–62.0938%) | 6.222% (667 events / 10,720, 95% CI 5.7802%–6.6951%) |
| 0.1103 | 0.1103 | 0.1368 | 11235 | 76.119% (8552 events / 11,235, 95% CI 75.3221%–76.8986%) | 75.033% (8430 events / 11,235, 95% CI 74.2246%–75.8251%) | 5.002% (562 events / 11,235, 95% CI 4.6143%–5.4209%) | 53.956% (6062 events / 11,235, 95% CI 53.0335%–54.8765%) | 17.170% (1929 events / 11,235, 95% CI 16.4835%–17.8781%) |
| 0.1162 | 0.1162 | 0.1257 | 11235 | 72.586% (8155 events / 11,235, 95% CI 71.7532%–73.4027%) | 72.532% (8149 events / 11,235, 95% CI 71.6993%–73.3498%) | 0.596% (67 events / 11,235, 95% CI 0.4699%–0.7566%) | 39.163% (4400 events / 11,235, 95% CI 38.2646%–40.0695%) | 32.844% (3690 events / 11,235, 95% CI 31.9814%–33.7180%) |
| 0.1602 | 0.1602 | 0.1946 | 11239 | 73.245% (8232 events / 11,239, 95% CI 72.4187%–74.0553%) | 71.804% (8070 events / 11,239, 95% CI 70.9643%–72.6279%) | 25.349% (2849 events / 11,239, 95% CI 24.5535%–26.1618%) | 14.183% (1594 events / 11,239, 95% CI 13.5500%–14.8400%) | 33.713% (3789 events / 11,239, 95% CI 32.8447%–34.5924%) |

Step across 14 assemblies: 13 low (<=5.99%), 1 high (>=25.35%), gap 4.2x. Max shot rate 25.349%, min 0.000%.

## Notes

- Assemblies are the W1 guide grid (§2.1, `E4_W1_GRID`) x Stage B's activeAngleDeg values x A1's radius values (`E4_RADII`), stratified by PREDICTED `hsS` (the `pocketSolve` two-contact analytic, same formula as `classifySettle`'s clamped projection) into one-per-quantile-bin across the WHOLE feasible range — not ranked by `cp` the way Stage C's top-6 were.
- The achievable `hsS` range for this W1 geometry family is asymmetric: unclamped analytic values across the full 1,080-combination grid (W1 x radius x activeAngleDeg) span roughly [-0.38, +0.25]; clamped to [0,1] (matching `classifySettle`), most feasible pockets land at/near 0 and the reachable positive ceiling is ~0.19-0.25, never near the tip. That ceiling is itself part of the answer to "how much of the hsS range is even geometrically reachable" — reported here, not smoothed over.
- Same release protocol as Stage C: `holdThenRelease` policy, `release: true` (6.0s window), `upMs` ∈ {8,14,24}, `releaseDelayMs` ∈ {60,150,350}, `inj: drop`. `restAngleDeg`/`restitution` held at LAB-2's winner, matching every other E4 stage's "flipper held fixed except where the design explicitly re-sweeps it" convention.
