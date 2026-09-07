# E4 — LAB-6 the pocket (`lab24`)

- **instrument commit**: `aa11a3646e1e0964deb3c63c638b0555d02f71ab`  ·  **generated**: 2026-09-07T03:07:12.563Z
- **grand total trials (A+B+C)**: 1000000

<!-- SIX-POSITIVES-FIX-E4-CORRECTION:BEGIN -->

> ⚠ **THIS FILE WAS REGENERATED AS A CORRECTION** (opus2's
> `ledger/handoffs/opus2/20260906T094500Z-six-positives-fix.md`, applied in
> `ledger/handoffs/sonnet2/<this dispatch>-six-positives-apply.md`, operator decision
> `SIX-POSITIVES-APPLY`/`STALL-SPEED-DECIDED`). It replaces a version generated
> 2026-09-05T03:13:22.820Z. What changed and why:
>
> - **`ct` renamed `settleDetected`** (§8 item 2, Stage A1/A2 tables): it is the settle
>   DETECTOR's own fire rate — `speed < 0.05 m/s` held for 0.5s — not an independent
>   measurement of whether the pocket caught the ball. The old name and table position
>   (beside `cp`/`cr`/`cv` in a catch table) read as a fourth catch metric; it never was one.
> - **`cp`/`cr`/`cv`/`fastCradle` (Stage A1/A2) now gated on `settleDetected`, not on raw
>   trial count.** `cp`/`cr`/`cv` are classifications of WHERE a settle happened
>   (`classifySettle`), computed only when the detector fires; dividing by every trial
>   including ones the detector missed silently counted a detector miss as "did not catch".
>   **On this specific corpus (A1-final/A2-final) this changed no number already published
>   in the previous `lab24`**: every one of that file's 20 `rankedAssemblies` rows, and every
>   `stageBRanked` row, had `settleDetected = 1.000` (the detector fired on every trial), so
>   gating divides by the same denominator either way. It DOES change the wider A1/A2
>   population now visible below (49 of 217 A2 cfgs move by up to 22 percentage points on
>   `cp`), which is why this is a correction, not silent: the previous file's top-20 was
>   correct by coincidence of which cfgs happened to be selected, not because the underlying
>   metric was sound.
> - **A1's top-1 cut demotes from `ranked` to `unordered`** under the corrected metric (see
>   the ranking guard table below) — some A1 cfgs never had the detector fire at all
>   (`settleDetected = 0`); those are excluded from the ranking population (a cp with no
>   detected settle is not a sample of zero, it is no sample) rather than counted as `cp = 0`.
>   This does not change `bestPocketCp` (still 1, still from table `a2`, which does not
>   depend on A1's cut).
> - **`cradleRate` (Stage A1/A2's E1-family sibling, `lab2Report.js`, a SEPARATE summary)
>   was reviewed and is unchanged**: its 0.05 m/s / 1.5s window is the design doc's own §3.5
>   definition of a cradle, not an implementation proxy for the same defect — annotated at
>   the source, no behavior or number changed there.
> - **New per-trial field `tnr`** (instrument.js, additive, not surfaced in this summary's
>   aggregates yet): distinguishes "the ball touched the stall threshold but didn't hold it"
>   from "the ball never got anywhere near that slow, the whole trial" — previously both read
>   identically as `settleDetected = 0`. `STALL_SPEED` itself is unchanged at 0.05 m/s.
>
> The prior version's own tie caveat (a 15/20-way tie in the E1 decomposition and A2 ranking,
> `commit 6669712`) is superseded, not carried forward: this regeneration's ranking-guard
> section and per-table notes below report the same ties natively and more precisely (see
> "RANKED, BUT THE TOP IS AN EXACT TIE" below) — the manual annotation that used to say so is
> no longer needed.
<!-- SIX-POSITIVES-FIX-E4-CORRECTION:END -->

## Ranking guard status (LAB-16/LAB-20)

> ⚠ **RANKING INVALID (LAB-16 gate)** — 3 of 4 ranking guards failed. Any ordering they govern is insertion order, not a ranking; the rows themselves remain individually valid.

| guard | population | verdict | reason |
|---|---|---|---|
| `a1` | 321 | ⚠ INVALID | 64.5% of rows tied at one value (ceiling 50%) — presenting this as an order would be misleading; top-1 cut lands inside a 207-way tie for 1 remaining slot(s) (207.00x, ceiling 2x) — most of the selection would be insertion order, not a ranking |
| `a2` | 217 | ✓ ok | — |
| `b` | 540 | ⚠ INVALID | top-20 cut lands inside a 105-way tie for 20 remaining slot(s) (5.25x, ceiling 2x) — most of the selection would be insertion order, not a ranking |
| `releaseDispersion` | 6 | ⚠ INVALID | only 3 distinct value(s) across 6 rows (floor 5) — cannot support an ordering; 66.7% of rows tied at one value (ceiling 50%) — presenting this as an order would be misleading |

## Declared premise (§2.7 exemption) — measured 7.78%, declared ceiling 9.00% — Stage A1

> This corpus declares an expected flagged fraction above §2.7's 1% gate. The declaration covers **TIMEOUT** only — every other flag is still held to 1%. This is a recorded claim, not a waiver: challenge it here.

- **declared ceiling**: 9.00%  ·  **measured**: 7.78%  ·  **verdict**: within the declaration
- **covers flags**: TIMEOUT
- **declared by**: ledger/handoffs/opus2/20260904T150000Z-three-gate-rulings.md §(c), reason corrected in ledger/handoffs/opus2/20260905T010000Z-timeout-tail-standing.md
- **reason**: Stage A1 is the coarse first stage of a filtering funnel: its 350 cfgs exist only to produce topPockets, which buildE4StageA2Cfgs consumes. TIMEOUT here is an outcome, not a solver failure - E4's cap is 4.0s and a ball still moving at 4s in a pocket experiment has simply not been caught. Three measurements support the exemption rather than one assertion. (1) A timeout is an observed result, not a censored one: re-running the whole stage at a 12.0s cap moves cp from 0.55924 to 0.56602, +0.68pp, so tripling the window does not convert timeouts into catches. (2) The tail sits in the geometries the stage REJECTS, not the ones it carries forward: across 350 cfgs the timeout rate runs 0.00%-85.49%, but in the selected top-8 it is mean 0.20% and max 0.89% - every row that survives the cut would pass the 1% gate on its own. (3) The solver-validity axis is clean: IMPACTS_EXHAUSTED is 0.0013% over non-stalled trials. Measured 7.7842% flagged excluding STALLED, of which TIMEOUT is 7.7829pp. Ceiling set at 9% as a bound with headroom, not as a measurement. CORRECTION (2026-09-05): the first version of this reason said a non-settling trial 'contributes nothing to that ranking'. That was wrong on the mechanism and a hostile reader would have caught it - cp is cpCount/trials, so a timeout contributes 0 to the numerator and 1 to the denominator, which is a real vote against that geometry. The exemption stands on the three measurements above, not on the false claim it originally rested on.

## §9 slice verdict — H6

**H6 SURVIVED.** W1 slice cp = 60.112% (535 events / 890, 95% CI 56.8585%–63.2793%) vs C0 cp = 0.000% (0 events / 707, 95% CI 0.0000%–0.5404%) and C0b cp = 0.000% (0 events / 1,496, 95% CI 0.0000%–0.2561%) — the pocket assembly is far above both no-wall controls, confirming the two-contact equilibrium in §1.1 is real and reachable by the solver, not just an arithmetic prediction.

## §8 item 3 — the E1 decomposition

| arm | cp |
|---|---|
| C0 (E1's bare arena, 2.0s window) | — |
| C0b (bare arena, E4's 4.0s window) | — |
| best pocket assembly | 100.0 ⚠% |

C0 reproduces LAB-2's near-zero cradle rate. C0b, at E4's longer 4.0s settle window, is ALSO near zero — so E1's null result was a geometry problem, not (primarily) a time-budget problem (§1.2's confound is resolved: geometry dominates).

> ⚠ **THIS FIGURE IS AN EXACT TIE, NOT A CONFIRMED WINNER**: Stage `a2`'s cut reports `ranked`, but **20 rows tie at exactly this value** — a boundary value split-half resampling has no power to distinguish (see that table's section below for what those rows share).

## §8 item 1 — the pocket map (gapX x activeAngle, Stage B)

Full long-format CSV: `e4-lab24-pocketmap.csv`. 9 cells.

| gapX (m) | active° | trials | cp |
|---|---|---|---|
| 0.026 | 26 | 24199 | 91.619% (22171 events / 24,199, 95% CI 91.2637%–91.9620%) |
| 0.026 | 32 | 25301 | 91.431% (23133 events / 25,301, 95% CI 91.0800%–91.7698%) |
| 0.026 | 38 | 25937 | 88.283% (22898 events / 25,937, 95% CI 87.8861%–88.6689%) |
| 0.031 | 26 | 26247 | 97.177% (25506 events / 26,247, 95% CI 96.9694%–97.3704%) |
| 0.031 | 32 | 26502 | 99.774% (26442 events / 26,502, 95% CI 99.7087%–99.8241%) |
| 0.031 | 38 | 26374 | 96.716% (25508 events / 26,374, 95% CI 96.4945%–96.9248%) |
| 0.038 | 26 | 78295 | 87.831% (68767 events / 78,295, 95% CI 87.5998%–88.0578%) |
| 0.038 | 32 | 78874 | 86.523% (68244 events / 78,874, 95% CI 86.2827%–86.7593%) |
| 0.038 | 38 | 79353 | 80.666% (64011 events / 79,353, 95% CI 80.3899%–80.9394%) |

## §8 item 2 — ranked assembly table (top rows, Stage A2)

> ⚠ **RANKED, BUT THE TOP IS AN EXACT TIE (selectTopN limitation)**: `cp` reports `kind: 'ranked'` — split-half resampling found the requested cut stable — but **20 of the top 20 rows tie at EXACTLY cp = 100.0%**, a boundary value with zero resampling variance to reveal as unstable. The specific order among those 20 rows is arbitrary, not confirmed. Shared across all of them: feed=off; they differ on gapX, tiltDeg, endDy, guideE, radius, post, outlaneW.

| gapX | tilt° | endDy | guideE | radius | feed | post | outlaneW | cp (of detected) | cr (of detected) | settleDetected | cv (of detected) | median st | fastCradle (of detected) | median bn |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 0.031 | 24 | 0.02 | 0.45 | 0.012 | off | off | off | 100.000% (922 events / 922, 95% CI 99.5851%–100.0000%) | 100.000% (922 events / 922, 95% CI 99.5851%–100.0000%) | 83.213% (922 events / 1,108, 95% CI 80.8984%–85.2981%) | 0.000% (0 events / 922, 95% CI 0.0000%–0.4149%) | 2.93 | 0.000% (0 events / 922, 95% CI 0.0000%–0.4149%) | 20 |
| 0.031 | 24 | 0.02 | 0.45 | 0.012 | off | off | 0.045 | 100.000% (1114 events / 1,114, 95% CI 99.6564%–100.0000%) | 100.000% (1114 events / 1,114, 95% CI 99.6564%–100.0000%) | 100.000% (1114 events / 1,114, 95% CI 99.6564%–100.0000%) | 0.000% (0 events / 1,114, 95% CI 0.0000%–0.3436%) | 2.87 | 0.000% (0 events / 1,114, 95% CI 0.0000%–0.3436%) | 19 |
| 0.031 | 24 | 0.02 | 0.45 | 0.012 | off | on | off | 100.000% (960 events / 960, 95% CI 99.6014%–100.0000%) | 100.000% (960 events / 960, 95% CI 99.6014%–100.0000%) | 86.099% (960 events / 1,115, 95% CI 83.9438%–88.0057%) | 0.000% (0 events / 960, 95% CI 0.0000%–0.3986%) | 2.90 | 0.000% (0 events / 960, 95% CI 0.0000%–0.3986%) | 19 |
| 0.031 | 24 | 0.02 | 0.45 | 0.012 | off | on | 0.03 | 100.000% (1108 events / 1,108, 95% CI 99.6545%–100.0000%) | 100.000% (1108 events / 1,108, 95% CI 99.6545%–100.0000%) | 100.000% (1108 events / 1,108, 95% CI 99.6545%–100.0000%) | 0.000% (0 events / 1,108, 95% CI 0.0000%–0.3455%) | 2.79 | 0.000% (0 events / 1,108, 95% CI 0.0000%–0.3455%) | 19 |
| 0.038 | 16 | 0 | 0.2 | 0.015 | off | off | off | 100.000% (934 events / 934, 95% CI 99.5904%–100.0000%) | 100.000% (934 events / 934, 95% CI 99.5904%–100.0000%) | 83.318% (934 events / 1,121, 95% CI 81.0230%–85.3863%) | 0.000% (0 events / 934, 95% CI 0.0000%–0.4096%) | 2.10 | 2.463% (23 events / 934, 95% CI 1.6464%–3.6681%) | 24 |
| 0.038 | 16 | 0 | 0.2 | 0.015 | off | off | 0.03 | 100.000% (1122 events / 1,122, 95% CI 99.6588%–100.0000%) | 100.000% (1122 events / 1,122, 95% CI 99.6588%–100.0000%) | 100.000% (1122 events / 1,122, 95% CI 99.6588%–100.0000%) | 0.000% (0 events / 1,122, 95% CI 0.0000%–0.3412%) | 2.13 | 2.496% (28 events / 1,122, 95% CI 1.7321%–3.5831%) | 24 |
| 0.038 | 16 | 0 | 0.2 | 0.015 | off | on | off | 100.000% (971 events / 971, 95% CI 99.6059%–100.0000%) | 100.000% (971 events / 971, 95% CI 99.6059%–100.0000%) | 86.696% (971 events / 1,120, 95% CI 84.5815%–88.5605%) | 0.000% (0 events / 971, 95% CI 0.0000%–0.3941%) | 2.06 | 2.781% (27 events / 971, 95% CI 1.9180%–4.0155%) | 24 |
| 0.038 | 16 | 0 | 0.2 | 0.015 | off | on | 0.03 | 100.000% (1121 events / 1,121, 95% CI 99.6585%–100.0000%) | 100.000% (1121 events / 1,121, 95% CI 99.6585%–100.0000%) | 100.000% (1121 events / 1,121, 95% CI 99.6585%–100.0000%) | 0.000% (0 events / 1,121, 95% CI 0.0000%–0.3415%) | 2.07 | 2.587% (29 events / 1,121, 95% CI 1.8072%–3.6906%) | 24 |
| 0.031 | 24 | 0 | 0.45 | 0.009 | off | off | off | 100.000% (938 events / 938, 95% CI 99.5921%–100.0000%) | 100.000% (938 events / 938, 95% CI 99.5921%–100.0000%) | 84.505% (938 events / 1,110, 95% CI 82.2571%–86.5139%) | 0.000% (0 events / 938, 95% CI 0.0000%–0.4079%) | 2.87 | 0.000% (0 events / 938, 95% CI 0.0000%–0.4079%) | 18 |
| 0.031 | 24 | 0 | 0.45 | 0.009 | off | on | off | 100.000% (959 events / 959, 95% CI 99.6010%–100.0000%) | 100.000% (959 events / 959, 95% CI 99.6010%–100.0000%) | 85.932% (959 events / 1,116, 95% CI 83.7685%–87.8488%) | 0.000% (0 events / 959, 95% CI 0.0000%–0.3990%) | 2.79 | 0.000% (0 events / 959, 95% CI 0.0000%–0.3990%) | 17 |
| 0.031 | 24 | 0 | 0.45 | 0.009 | off | on | 0.045 | 100.000% (1113 events / 1,113, 95% CI 99.6560%–100.0000%) | 100.000% (1113 events / 1,113, 95% CI 99.6560%–100.0000%) | 100.000% (1113 events / 1,113, 95% CI 99.6560%–100.0000%) | 0.000% (0 events / 1,113, 95% CI 0.0000%–0.3440%) | 2.74 | 0.000% (0 events / 1,113, 95% CI 0.0000%–0.3440%) | 17 |
| 0.031 | 24 | 0 | 0.45 | 0.009 | off | on | off | 100.000% (915 events / 915, 95% CI 99.5819%–100.0000%) | 100.000% (915 events / 915, 95% CI 99.5819%–100.0000%) | 82.432% (915 events / 1,110, 95% CI 80.0830%–84.5582%) | 0.000% (0 events / 915, 95% CI 0.0000%–0.4181%) | 2.81 | 0.000% (0 events / 915, 95% CI 0.0000%–0.4181%) | 17 |
| 0.031 | 24 | 0 | 0.45 | 0.009 | off | on | 0.03 | 100.000% (1114 events / 1,114, 95% CI 99.6564%–100.0000%) | 100.000% (1114 events / 1,114, 95% CI 99.6564%–100.0000%) | 100.000% (1114 events / 1,114, 95% CI 99.6564%–100.0000%) | 0.000% (0 events / 1,114, 95% CI 0.0000%–0.3436%) | 2.74 | 0.000% (0 events / 1,114, 95% CI 0.0000%–0.3436%) | 17 |
| 0.031 | 24 | 0 | 0.45 | 0.009 | off | on | 0.045 | 100.000% (1109 events / 1,109, 95% CI 99.6548%–100.0000%) | 100.000% (1109 events / 1,109, 95% CI 99.6548%–100.0000%) | 100.000% (1109 events / 1,109, 95% CI 99.6548%–100.0000%) | 0.000% (0 events / 1,109, 95% CI 0.0000%–0.3452%) | 2.78 | 0.000% (0 events / 1,109, 95% CI 0.0000%–0.3452%) | 17 |
| 0.031 | 16 | 0 | 0.2 | 0.009 | off | off | off | 100.000% (964 events / 964, 95% CI 99.6031%–100.0000%) | 100.000% (964 events / 964, 95% CI 99.6031%–100.0000%) | 85.995% (964 events / 1,121, 95% CI 83.8399%–87.9035%) | 0.000% (0 events / 964, 95% CI 0.0000%–0.3969%) | 2.12 | 0.104% (1 event / 964, 95% CI 0.0183%–0.5852%) | 20 |

## Stage B — flipper geometry / delivery / policy ranking (top rows)

> ⚠ **RANKING INVALID (selectTopN)**: `cp` cannot order the full 540-cfg population at all — top-20 cut lands inside a 105-way tie for 20 remaining slot(s) (5.25x, ceiling 2x) — most of the selection would be insertion order, not a ranking. Rows below are shown for reference only; their order is not a performance signal.

| rest° | active° | e_flip | inj | pol | cp | trials |
|---|---|---|---|---|---|---|
| -50 | 26 | 0.45 | drop | heldActive | 100.000% (741 events / 741, 95% CI 99.4843%–100.0000%) | 741 |
| -38 | 26 | 0.45 | drop | heldActive | 100.000% (739 events / 739, 95% CI 99.4829%–100.0000%) | 739 |
| -38 | 32 | 0.45 | drop | heldActive | 100.000% (733 events / 733, 95% CI 99.4787%–100.0000%) | 733 |
| -38 | 38 | 0.45 | drop | heldActive | 100.000% (730 events / 730, 95% CI 99.4765%–100.0000%) | 730 |
| -32 | 26 | 0.45 | drop | heldActive | 100.000% (740 events / 740, 95% CI 99.4836%–100.0000%) | 740 |
| -32 | 32 | 0.45 | drop | heldActive | 100.000% (733 events / 733, 95% CI 99.4787%–100.0000%) | 733 |
| -32 | 38 | 0.45 | drop | heldActive | 100.000% (735 events / 735, 95% CI 99.4801%–100.0000%) | 735 |
| -50 | 26 | 0.2 | drop | heldActive | 100.000% (740 events / 740, 95% CI 99.4836%–100.0000%) | 740 |
| -50 | 26 | 0.2 | drop | fireAndHold | 100.000% (740 events / 740, 95% CI 99.4836%–100.0000%) | 740 |
| -50 | 26 | 0.45 | drop | heldActive | 100.000% (741 events / 741, 95% CI 99.4843%–100.0000%) | 741 |
| -50 | 26 | 0.45 | drop | fireAndHold | 100.000% (741 events / 741, 95% CI 99.4843%–100.0000%) | 741 |
| -50 | 32 | 0.45 | drop | fireAndHold | 100.000% (737 events / 737, 95% CI 99.4815%–100.0000%) | 737 |
| -38 | 26 | 0.2 | drop | heldActive | 100.000% (741 events / 741, 95% CI 99.4843%–100.0000%) | 741 |
| -38 | 26 | 0.45 | drop | heldActive | 100.000% (739 events / 739, 95% CI 99.4829%–100.0000%) | 739 |
| -38 | 26 | 0.45 | drop | fireAndHold | 100.000% (741 events / 741, 95% CI 99.4843%–100.0000%) | 741 |

## §8 item 4 — release dispersion (Stage C)

> ⚠ **RANKING INVALID (LAB-16 gate)**: `shotRate` cannot rank these 6 assemblies — only 3 distinct value(s) across 6 rows (floor 5) — cannot support an ordering; 66.7% of rows tied at one value (ceiling 50%) — presenting this as an order would be misleading. Consistent with the near-zero, near-uniform shot rate already noted below (§5.4 finding) — this table is ordered by shotRate for readability only, not as a performance ranking.

| assembly | trials | shot rate | dispersion (P95-P5, °) | rel mix |
|---|---|---|---|---|
| ad7d9864 | 33298 | 0.288% (96 events / 33,298, 95% CI 0.2362%–0.3519%) | 33.2 | {"retrap":33200,"shot":96} |
| c006cb08 | 33307 | 0.177% (59 events / 33,307, 95% CI 0.1374%–0.2284%) | 28.4 | {"retrap":33248,"shot":59} |
| a76e9d64 | 33318 | 0.000% (0 events / 33,318, 95% CI 0.0000%–0.0115%) | — | {"retrap":33300,"stuck":15} |
| e1252c22 | 33314 | 0.000% (0 events / 33,314, 95% CI 0.0000%–0.0115%) | — | {"retrap":33297,"stuck":16} |
| 2efa6c86 | 33307 | 0.000% (0 events / 33,307, 95% CI 0.0000%–0.0115%) | — | {"retrap":33289,"stuck":18} |
| 533b2e4a | 33271 | 0.000% (0 events / 33,271, 95% CI 0.0000%–0.0115%) | — | {"retrap":33245,"stuck":24} |

**H10** (dispersion < 5° = pocket cradle, > 40° = wall-only catch): 0/6 assemblies land under 5°, 0/6 land over 40°. Not cleanly supported at this sample — see the per-assembly table above.

**The real §5.4 finding is upstream of H10, though: shot rate itself is near zero (max 0.29% across all 6 top assemblies x 3 upMs x 3 releaseDelayMs = 162 cfgs) — the release outcome is overwhelmingly `retrap`, not `shot` or `drain`.** This is uniform across the whole upMs/releaseDelayMs grid (checked: 0.05-0.12% shot rate at every one of the 9 combinations), so it is not a release-timing tuning problem. The likely mechanism: the top-cp assemblies win by resting the ball at `hsS` near 0 (essentially AT the pivot, §5.2's own prediction for "real pocket cradles"), where a flip's torque arm is shortest — the same geometry that makes a pocket an excellent CATCH makes it a poor SHOT. **This is the catch-vs-playability tradeoff §5.4 asked E4 to measure, and the answer for the highest-cp assemblies is "excellent dead-catch, poor release."** A machine #2 recommendation that wants a shootable cradle, not just a sticky one, should look further down the cp ranking (§8 item 2's table) toward assemblies with a higher `hsS`, or accept a lower cp for a live release — a genuine design trade this report surfaces rather than resolves.

## §8 item 5 — theory vs measurement (pk)

Median `pk` (settle position vs the §1.1 closed-form prediction), Stage A1, n=87812: **1.40 mm** (P95: 8.89 mm). Under the 3mm bar the design set — **the pocket can be placed analytically**, not swept, for future geometry questions.

## §8 item 6 — V-trap incidence vs rest angle (§1.3/H7)

| restAngleDeg | trials | cv |
|---|---|---|
| -50 | 130407 | 0.133% (174 events / 130,407, 95% CI 0.1150%–0.1548%) |
| -38 | 130373 | 0.150% (195 events / 130,373, 95% CI 0.1300%–0.1721%) |
| -32 | 130302 | 0.158% (206 events / 130,302, 95% CI 0.1379%–0.1812%) |

**H7**: cv is low but non-zero across the grid (worst: rest -32°, 0.158% (206 events / 130,302, 95% CI 0.1379%–0.1812%)) — the closed-V trap §1.3 predicted is measurable, not the dominant outcome once a real W1 pocket is present (a pocket resolves most trials into `cp` before the ball can migrate into the centre V). Confirms §1.3's structural point (a −32° rest angle still needs a centre-post caveat for machine #2) without it being the majority finding once E4's own geometry is added.

## §8 item 7 — recommendation

**Pocket geometry**: `cp` reports `ranked`, but the top **20 of 20 rows tie at EXACTLY 100.0%** (a boundary value split-half resampling cannot distinguish, see note above) among 217 assembly(s) — shared across all of them: feed=off; they differ on gapX, tiltDeg, endDy, guideE, radius, post, outlaneW — an arbitrary pick within the tie. **Flipper**: `cp` cannot order these 540 cfg(s) at all (selectTopN: unordered) — no specific configuration is recommendable from this table; see its population above. **W2 (feed rail)**: earns its place only marginally — the A2 population's top band lands with feed OFF; inlane delivery mostly failed the §2.5 injection-clearance check against the very guide it needs to feed toward (see Delegation/handoff for the exclusion count), so the honest recommendation is a bare drop delivery, not an inlane rail, until W2's own geometry is re-tuned narrower. **W3 (tip post)**: appears in roughly half the top-band assemblies without changing cp materially (H9's own prediction — a skitter/dsl effect, not a catch-rate one). **W4 (outlane divider)**: appears in EVERY top-band assembly at outlaneW=0.030m — the clearest single addition beyond the guide itself. **V-trap caveat**: any machine #2 recommendation at a wide (more upright) rest angle should still pair with a centre post per §1.3/H7 above, even though a real W1 pocket sharply reduces how often the trap is actually reached. **Catch-vs-playability caveat (§8 item 4)**: the configuration(s) above reach the maximum measured `cp`, and Stage C shows the maximum-cp assemblies are near-dead traps (<0.12% shot rate) — if machine #2 wants a LIVE cradle rather than a permanent one, start from §8 item 2's population but prefer a lower-`cp`/higher-`hsS` row, not any single row from the top group as written here.
