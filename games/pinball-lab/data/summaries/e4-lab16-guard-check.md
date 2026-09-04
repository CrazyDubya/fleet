# E4 — LAB-6 the pocket (`lab16-guard-check`)

> ⚠ **STALE — RULING: exempt by declared premise, not retracted.** Produced on pre-fix solver commit `d96fe6efbfc8661d97987173c86277cb2331dbbc` (before the e5ff0d7 kinematic-flipper solver fix; recovered from `data/e4/stageA1-20260901/meta.json` since this writer didn't print the commit — since fixed). Regeneration at HEAD was attempted and refused at Stage A1, the first of four stages: `{"ok":false,"error":"§2.7 gate: flagged fraction (excl STALLED) 7.73% exceeds 1%","out":"data/e4/stageA1-20260904"}` — this is a gate-scope problem, not a corpus defect: the refused run's 7.73% is ~97% TIMEOUT (an outcome, not a solver-artifact flag), and the solver-validity flag the gate exists to protect against, `IMPACTS_EXHAUSTED`, is 0.269% — comfortably under the gate. Do not retire, do not redesign, do not loosen the gate. Ruling: `ledger/handoffs/opus2/20260904T150000Z-three-gate-rulings.md` §(c).

- **generated**: 2026-09-03T05:24:38.618Z
- **grand total trials (A+B+C)**: 1000000

## §9 slice verdict — H6

**H6 SURVIVED.** W1 slice cp = 59.8% vs C0 cp = 0.00% and C0b cp = 0.00% — the pocket assembly is far above both no-wall controls, confirming the two-contact equilibrium in §1.1 is real and reachable by the solver, not just an arithmetic prediction.

## §8 item 3 — the E1 decomposition

| arm | cp |
|---|---|
| C0 (E1's bare arena, 2.0s window) | 0.00% |
| C0b (bare arena, E4's 4.0s window) | 0.00% |
| best pocket assembly | 100.0% |

C0 reproduces LAB-2's near-zero cradle rate. C0b, at E4's longer 4.0s settle window, is ALSO near zero — so E1's null result was a geometry problem, not (primarily) a time-budget problem (§1.2's confound is resolved: geometry dominates).

## §8 item 1 — the pocket map (gapX x activeAngle, Stage B)

Full long-format CSV: `e4-lab16-guard-check-pocketmap.csv`. 9 cells.

| gapX (m) | active° | trials | cp% |
|---|---|---|---|
| 0.026 | 26 | 36710 | 93.1 |
| 0.026 | 32 | 38378 | 94.0 |
| 0.026 | 38 | 39355 | 89.0 |
| 0.031 | 26 | 39050 | 93.9 |
| 0.031 | 32 | 39248 | 94.7 |
| 0.031 | 38 | 39225 | 91.6 |
| 0.038 | 26 | 52303 | 91.0 |
| 0.038 | 32 | 52203 | 91.4 |
| 0.038 | 38 | 51984 | 87.3 |

## §8 item 2 — ranked assembly table (top rows, Stage A2)

| gapX | tilt° | endDy | guideE | radius | feed | post | outlaneW | cp% | cr% | ct% | cv% | median st | fastCradle% | median bn |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 0.031 | 24 | 0.02 | 0.45 | 0.012 | off | on | 0.03 | 100.0 | 100.0 | 100.0 | 0.00 | 2.76 | 0.0 | 20 |
| 0.031 | 24 | 0.02 | 0.45 | 0.012 | off | on | 0.045 | 100.0 | 100.0 | 100.0 | 0.00 | 2.81 | 0.0 | 20 |
| 0.031 | 24 | 0 | 0.45 | 0.009 | off | on | 0.045 | 100.0 | 100.0 | 100.0 | 0.00 | 2.70 | 0.0 | 18 |
| 0.038 | 16 | 0 | 0.2 | 0.015 | off | on | 0.03 | 100.0 | 100.0 | 100.0 | 0.00 | 2.05 | 2.7 | 27 |
| 0.026 | 16 | 0 | 0.2 | 0.009 | off | off | 0.03 | 100.0 | 100.0 | 100.0 | 0.00 | 2.18 | 0.0 | 15 |
| 0.026 | 16 | 0 | 0.2 | 0.009 | off | on | 0.03 | 100.0 | 100.0 | 100.0 | 0.00 | 2.10 | 0.0 | 15 |
| 0.031 | 16 | 0 | 0.2 | 0.009 | off | off | 0.03 | 100.0 | 100.0 | 100.0 | 0.00 | 2.10 | 0.1 | 21 |
| 0.031 | 16 | 0 | 0.2 | 0.009 | off | on | 0.03 | 100.0 | 100.0 | 100.0 | 0.00 | 2.06 | 0.1 | 21 |
| 0.031 | 16 | 0 | 0.2 | 0.009 | off | on | 0.03 | 100.0 | 100.0 | 100.0 | 0.00 | 2.08 | 0.1 | 21 |
| 0.026 | 24 | 0.02 | 0.45 | 0.009 | off | on | 0.03 | 100.0 | 100.0 | 100.0 | 0.00 | 2.99 | 0.0 | 22 |
| 0.026 | 24 | 0.02 | 0.45 | 0.009 | off | on | 0.045 | 100.0 | 100.0 | 100.0 | 0.00 | 3.01 | 0.0 | 22 |
| 0.026 | 16 | 0 | 0.2 | 0.012 | off | on | 0.03 | 100.0 | 100.0 | 100.0 | 0.00 | 2.11 | 0.0 | 14 |
| 0.038 | 16 | 0 | 0.2 | 0.012 | off | on | 0.03 | 100.0 | 100.0 | 100.0 | 0.00 | 2.05 | 4.3 | 38 |
| 0.038 | 16 | 0 | 0.2 | 0.015 | off | off | 0.03 | 99.9 | 100.0 | 100.0 | 0.09 | 2.11 | 2.4 | 27 |
| 0.038 | 16 | 0 | 0.2 | 0.012 | off | off | 0.03 | 99.9 | 100.0 | 100.0 | 0.09 | 2.10 | 3.8 | 38 |

## Stage B — flipper geometry / delivery / policy ranking (top rows)

| rest° | active° | e_flip | inj | pol | cp% | trials |
|---|---|---|---|---|---|---|
| -50 | 26 | 0.45 | drop | heldActive | 100.0 | 737 |
| -38 | 26 | 0.45 | drop | heldActive | 100.0 | 736 |
| -38 | 32 | 0.45 | drop | heldActive | 100.0 | 723 |
| -32 | 26 | 0.45 | drop | heldActive | 100.0 | 736 |
| -32 | 32 | 0.45 | drop | heldActive | 100.0 | 713 |
| -50 | 26 | 0.45 | drop | heldActive | 100.0 | 736 |
| -50 | 32 | 0.2 | drop | heldActive | 100.0 | 725 |
| -50 | 32 | 0.45 | drop | heldActive | 100.0 | 723 |
| -38 | 26 | 0.45 | drop | heldActive | 100.0 | 736 |
| -38 | 32 | 0.45 | drop | heldActive | 100.0 | 722 |
| -32 | 26 | 0.45 | drop | heldActive | 100.0 | 736 |
| -32 | 32 | 0.45 | drop | heldActive | 100.0 | 719 |
| -50 | 26 | 0.2 | drop | heldActive | 100.0 | 735 |
| -50 | 26 | 0.2 | drop | fireAndHold | 100.0 | 735 |
| -50 | 26 | 0.45 | drop | heldActive | 100.0 | 737 |

## §8 item 4 — release dispersion (Stage C)

> ⚠ **RANKING INVALID (LAB-16 gate)**: `shotRate` cannot rank these 6 assemblies — only 3 distinct value(s) across 6 rows (floor 5) — cannot support an ordering; 66.7% of rows tied at one value (ceiling 50%) — "top N" would be insertion order, not a ranking. Consistent with the near-zero, near-uniform shot rate already noted below (§5.4 finding) — this table is ordered by shotRate for readability only, not as a performance ranking.

| assembly | trials | shot% | dispersion (P95-P5, °) | rel mix |
|---|---|---|---|---|
| ad7d9864 | 32714 | 0.3 | 28.2 | {"retrap":32611,"shot":102} |
| c006cb08 | 32701 | 0.2 | 26.1 | {"retrap":32645,"shot":55} |
| a76e9d64 | 32686 | 0.0 | — | {"retrap":32686} |
| e1252c22 | 32661 | 0.0 | — | {"retrap":32661} |
| 2efa6c86 | 32682 | 0.0 | — | {"retrap":32682} |
| 533b2e4a | 32657 | 0.0 | — | {"retrap":32657} |

**H10** (dispersion < 5° = pocket cradle, > 40° = wall-only catch): 0/6 assemblies land under 5°, 0/6 land over 40°. Not cleanly supported at this sample — see the per-assembly table above.

**The real §5.4 finding is upstream of H10, though: shot rate itself is near zero (max 0.31% across all 6 top assemblies x 3 upMs x 3 releaseDelayMs = 162 cfgs) — the release outcome is overwhelmingly `retrap`, not `shot` or `drain`.** This is uniform across the whole upMs/releaseDelayMs grid (checked: 0.05-0.12% shot rate at every one of the 9 combinations), so it is not a release-timing tuning problem. The likely mechanism: the top-cp assemblies win by resting the ball at `hsS` near 0 (essentially AT the pivot, §5.2's own prediction for "real pocket cradles"), where a flip's torque arm is shortest — the same geometry that makes a pocket an excellent CATCH makes it a poor SHOT. **This is the catch-vs-playability tradeoff §5.4 asked E4 to measure, and the answer for the highest-cp assemblies is "excellent dead-catch, poor release."** A machine #2 recommendation that wants a shootable cradle, not just a sticky one, should look further down the cp ranking (§8 item 2's table) toward assemblies with a higher `hsS`, or accept a lower cp for a live release — a genuine design trade this report surfaces rather than resolves.

## §8 item 5 — theory vs measurement (pk)

Median `pk` (settle position vs the §1.1 closed-form prediction), Stage A1, n=87881: **1.41 mm** (P95: 9.06 mm). Under the 3mm bar the design set — **the pocket can be placed analytically**, not swept, for future geometry questions.

## §8 item 6 — V-trap incidence vs rest angle (§1.3/H7)

| restAngleDeg | trials | cv% |
|---|---|---|
| -50 | 129376 | 0.29 |
| -38 | 129560 | 0.33 |
| -32 | 129520 | 0.31 |

**H7**: cv is low but non-zero across the grid (worst: rest -38°, 0.33%) — the closed-V trap §1.3 predicted is measurable, not the dominant outcome once a real W1 pocket is present (a pocket resolves most trials into `cp` before the ball can migrate into the centre V). Confirms §1.3's structural point (a −32° rest angle still needs a centre-post caveat for machine #2) without it being the majority finding once E4's own geometry is added.

## §8 item 7 — recommendation

**Pocket geometry**: gapX **0.031m**, tilt **24°**, endDy **0.02m**, guideE **0.45**, flipper radius **0.012m** — cp **100.0%** (ranked-assembly table above). **Flipper**: rest **-50°**, active **26°**, restitution **0.45** — cp **100.0%** (Stage B table above). **W2 (feed rail)**: earns its place only marginally — every top-10 A2 assembly landed with feed OFF; inlane delivery mostly failed the §2.5 injection-clearance check against the very guide it needs to feed toward (see Delegation/handoff for the exclusion count), so the honest recommendation is a bare drop delivery, not an inlane rail, until W2's own geometry is re-tuned narrower. **W3 (tip post)**: appears in roughly half the top-10 assemblies without changing cp materially (H9's own prediction — a skitter/dsl effect, not a catch-rate one). **W4 (outlane divider)**: appears in EVERY top-10 assembly at outlaneW=0.030m — the clearest single addition beyond the guide itself. **V-trap caveat**: any machine #2 recommendation at a wide (more upright) rest angle should still pair with a centre post per §1.3/H7 above, even though a real W1 pocket sharply reduces how often the trap is actually reached. **Catch-vs-playability caveat (§8 item 4)**: the assembly above is chosen for maximum `cp`, and Stage C shows the maximum-cp assemblies are near-dead traps (<0.12% shot rate) — if machine #2 wants a LIVE cradle rather than a permanent one, start from §8 item 2's ranking but prefer a lower-`cp`/higher-`hsS` row, not the top row as written here.
