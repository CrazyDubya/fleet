# E4 — LAB-6 the pocket (`lab24`)

- **instrument commit**: `aa11a3646e1e0964deb3c63c638b0555d02f71ab`  ·  **generated**: 2026-09-05T03:13:22.820Z
- **grand total trials (A+B+C)**: 1000000

## Ranking guard status (LAB-16/LAB-20)

> ⚠ **RANKING INVALID (LAB-16 gate)** — 2 of 4 ranking guards failed. Any ordering they govern is insertion order, not a ranking; the rows themselves remain individually valid.

| guard | population | verdict | reason |
|---|---|---|---|
| `a1` | 350 | ✓ ok | — |
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

**H6 SURVIVED.** W1 slice cp = 60.1% vs C0 cp = 0.00% and C0b cp = 0.00% — the pocket assembly is far above both no-wall controls, confirming the two-contact equilibrium in §1.1 is real and reachable by the solver, not just an arithmetic prediction.

## §8 item 3 — the E1 decomposition

| arm | cp |
|---|---|
| C0 (E1's bare arena, 2.0s window) | 0.00% |
| C0b (bare arena, E4's 4.0s window) | 0.00% |
| best pocket assembly | 100.0% |

C0 reproduces LAB-2's near-zero cradle rate. C0b, at E4's longer 4.0s settle window, is ALSO near zero — so E1's null result was a geometry problem, not (primarily) a time-budget problem (§1.2's confound is resolved: geometry dominates).

## §8 item 1 — the pocket map (gapX x activeAngle, Stage B)

Full long-format CSV: `e4-lab24-pocketmap.csv`. 9 cells.

| gapX (m) | active° | trials | cp% |
|---|---|---|---|
| 0.026 | 26 | 24199 | 91.6 |
| 0.026 | 32 | 25301 | 91.4 |
| 0.026 | 38 | 25937 | 88.3 |
| 0.031 | 26 | 26247 | 97.2 |
| 0.031 | 32 | 26502 | 99.8 |
| 0.031 | 38 | 26374 | 96.7 |
| 0.038 | 26 | 78295 | 87.8 |
| 0.038 | 32 | 78874 | 86.5 |
| 0.038 | 38 | 79353 | 80.7 |

## §8 item 2 — ranked assembly table (top rows, Stage A2)

| gapX | tilt° | endDy | guideE | radius | feed | post | outlaneW | cp% | cr% | ct% | cv% | median st | fastCradle% | median bn |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 0.031 | 24 | 0.02 | 0.45 | 0.012 | off | off | 0.045 | 100.0 | 100.0 | 100.0 | 0.00 | 2.87 | 0.0 | 19 |
| 0.031 | 24 | 0.02 | 0.45 | 0.012 | off | on | 0.03 | 100.0 | 100.0 | 100.0 | 0.00 | 2.79 | 0.0 | 19 |
| 0.038 | 16 | 0 | 0.2 | 0.015 | off | off | 0.03 | 100.0 | 100.0 | 100.0 | 0.00 | 2.13 | 2.5 | 24 |
| 0.038 | 16 | 0 | 0.2 | 0.015 | off | on | 0.03 | 100.0 | 100.0 | 100.0 | 0.00 | 2.07 | 2.6 | 24 |
| 0.031 | 24 | 0 | 0.45 | 0.009 | off | on | 0.045 | 100.0 | 100.0 | 100.0 | 0.00 | 2.74 | 0.0 | 17 |
| 0.031 | 24 | 0 | 0.45 | 0.009 | off | on | 0.03 | 100.0 | 100.0 | 100.0 | 0.00 | 2.74 | 0.0 | 17 |
| 0.031 | 24 | 0 | 0.45 | 0.009 | off | on | 0.045 | 100.0 | 100.0 | 100.0 | 0.00 | 2.78 | 0.0 | 17 |
| 0.031 | 16 | 0 | 0.2 | 0.009 | off | off | 0.03 | 100.0 | 100.0 | 100.0 | 0.00 | 2.11 | 0.0 | 20 |
| 0.031 | 16 | 0 | 0.2 | 0.009 | off | on | 0.03 | 100.0 | 100.0 | 100.0 | 0.00 | 2.08 | 0.0 | 19 |
| 0.031 | 16 | 0 | 0.2 | 0.009 | off | on | 0.03 | 100.0 | 100.0 | 100.0 | 0.00 | 2.10 | 0.1 | 19 |
| 0.026 | 16 | 0 | 0.2 | 0.009 | off | off | 0.03 | 100.0 | 100.0 | 100.0 | 0.00 | 2.20 | 0.0 | 15 |
| 0.026 | 16 | 0 | 0.2 | 0.009 | off | on | 0.03 | 100.0 | 100.0 | 100.0 | 0.00 | 2.14 | 0.0 | 14 |
| 0.026 | 16 | 0 | 0.2 | 0.012 | off | off | 0.03 | 100.0 | 100.0 | 100.0 | 0.00 | 2.20 | 0.0 | 14 |
| 0.038 | 16 | 0 | 0.2 | 0.012 | off | on | 0.03 | 100.0 | 100.0 | 100.0 | 0.00 | 2.06 | 4.1 | 34 |
| 0.038 | 16 | 0 | 0.2 | 0.012 | off | on | 0.03 | 100.0 | 100.0 | 100.0 | 0.00 | 2.08 | 3.7 | 34 |

## Stage B — flipper geometry / delivery / policy ranking (top rows)

> ⚠ **RANKING INVALID (LAB-16 gate)**: `cp` cannot rank the full 540-cfg Stage B population — top-20 cut lands inside a 105-way tie for 20 remaining slot(s) (5.25x, ceiling 2x) — most of the selection would be insertion order, not a ranking. Rows below are shown for reference only.

| rest° | active° | e_flip | inj | pol | cp% | trials |
|---|---|---|---|---|---|---|
| -50 | 26 | 0.45 | drop | heldActive | 100.0 | 741 |
| -38 | 26 | 0.45 | drop | heldActive | 100.0 | 739 |
| -38 | 32 | 0.45 | drop | heldActive | 100.0 | 733 |
| -38 | 38 | 0.45 | drop | heldActive | 100.0 | 730 |
| -32 | 26 | 0.45 | drop | heldActive | 100.0 | 740 |
| -32 | 32 | 0.45 | drop | heldActive | 100.0 | 733 |
| -32 | 38 | 0.45 | drop | heldActive | 100.0 | 735 |
| -50 | 26 | 0.2 | drop | heldActive | 100.0 | 740 |
| -50 | 26 | 0.2 | drop | fireAndHold | 100.0 | 740 |
| -50 | 26 | 0.45 | drop | heldActive | 100.0 | 741 |
| -50 | 26 | 0.45 | drop | fireAndHold | 100.0 | 741 |
| -50 | 32 | 0.45 | drop | fireAndHold | 100.0 | 737 |
| -38 | 26 | 0.2 | drop | heldActive | 100.0 | 741 |
| -38 | 26 | 0.45 | drop | heldActive | 100.0 | 739 |
| -38 | 26 | 0.45 | drop | fireAndHold | 100.0 | 741 |

## §8 item 4 — release dispersion (Stage C)

> ⚠ **RANKING INVALID (LAB-16 gate)**: `shotRate` cannot rank these 6 assemblies — only 3 distinct value(s) across 6 rows (floor 5) — cannot support an ordering; 66.7% of rows tied at one value (ceiling 50%) — presenting this as an order would be misleading. Consistent with the near-zero, near-uniform shot rate already noted below (§5.4 finding) — this table is ordered by shotRate for readability only, not as a performance ranking.

| assembly | trials | shot% | dispersion (P95-P5, °) | rel mix |
|---|---|---|---|---|
| ad7d9864 | 33298 | 0.3 | 33.2 | {"retrap":33200,"shot":96} |
| c006cb08 | 33307 | 0.2 | 28.4 | {"retrap":33248,"shot":59} |
| a76e9d64 | 33318 | 0.0 | — | {"retrap":33300,"stuck":15} |
| e1252c22 | 33314 | 0.0 | — | {"retrap":33297,"stuck":16} |
| 2efa6c86 | 33307 | 0.0 | — | {"retrap":33289,"stuck":18} |
| 533b2e4a | 33271 | 0.0 | — | {"retrap":33245,"stuck":24} |

**H10** (dispersion < 5° = pocket cradle, > 40° = wall-only catch): 0/6 assemblies land under 5°, 0/6 land over 40°. Not cleanly supported at this sample — see the per-assembly table above.

**The real §5.4 finding is upstream of H10, though: shot rate itself is near zero (max 0.29% across all 6 top assemblies x 3 upMs x 3 releaseDelayMs = 162 cfgs) — the release outcome is overwhelmingly `retrap`, not `shot` or `drain`.** This is uniform across the whole upMs/releaseDelayMs grid (checked: 0.05-0.12% shot rate at every one of the 9 combinations), so it is not a release-timing tuning problem. The likely mechanism: the top-cp assemblies win by resting the ball at `hsS` near 0 (essentially AT the pivot, §5.2's own prediction for "real pocket cradles"), where a flip's torque arm is shortest — the same geometry that makes a pocket an excellent CATCH makes it a poor SHOT. **This is the catch-vs-playability tradeoff §5.4 asked E4 to measure, and the answer for the highest-cp assemblies is "excellent dead-catch, poor release."** A machine #2 recommendation that wants a shootable cradle, not just a sticky one, should look further down the cp ranking (§8 item 2's table) toward assemblies with a higher `hsS`, or accept a lower cp for a live release — a genuine design trade this report surfaces rather than resolves.

## §8 item 5 — theory vs measurement (pk)

Median `pk` (settle position vs the §1.1 closed-form prediction), Stage A1, n=87812: **1.40 mm** (P95: 8.89 mm). Under the 3mm bar the design set — **the pocket can be placed analytically**, not swept, for future geometry questions.

## §8 item 6 — V-trap incidence vs rest angle (§1.3/H7)

| restAngleDeg | trials | cv% |
|---|---|---|
| -50 | 130407 | 0.13 |
| -38 | 130373 | 0.15 |
| -32 | 130302 | 0.16 |

**H7**: cv is low but non-zero across the grid (worst: rest -32°, 0.16%) — the closed-V trap §1.3 predicted is measurable, not the dominant outcome once a real W1 pocket is present (a pocket resolves most trials into `cp` before the ball can migrate into the centre V). Confirms §1.3's structural point (a −32° rest angle still needs a centre-post caveat for machine #2) without it being the majority finding once E4's own geometry is added.

## §8 item 7 — recommendation

**Pocket geometry**: gapX **0.031m**, tilt **24°**, endDy **0.02m**, guideE **0.45**, flipper radius **0.012m** — cp **100.0%** (ranked-assembly table above). **Flipper**: rest **-50°**, active **26°**, restitution **0.45** — cp **100.0%** (Stage B table above). **W2 (feed rail)**: earns its place only marginally — every top-10 A2 assembly landed with feed OFF; inlane delivery mostly failed the §2.5 injection-clearance check against the very guide it needs to feed toward (see Delegation/handoff for the exclusion count), so the honest recommendation is a bare drop delivery, not an inlane rail, until W2's own geometry is re-tuned narrower. **W3 (tip post)**: appears in roughly half the top-10 assemblies without changing cp materially (H9's own prediction — a skitter/dsl effect, not a catch-rate one). **W4 (outlane divider)**: appears in EVERY top-10 assembly at outlaneW=0.030m — the clearest single addition beyond the guide itself. **V-trap caveat**: any machine #2 recommendation at a wide (more upright) rest angle should still pair with a centre post per §1.3/H7 above, even though a real W1 pocket sharply reduces how often the trap is actually reached. **Catch-vs-playability caveat (§8 item 4)**: the assembly above is chosen for maximum `cp`, and Stage C shows the maximum-cp assemblies are near-dead traps (<0.12% shot rate) — if machine #2 wants a LIVE cradle rather than a permanent one, start from §8 item 2's ranking but prefer a lower-`cp`/higher-`hsS` row, not the top row as written here.
