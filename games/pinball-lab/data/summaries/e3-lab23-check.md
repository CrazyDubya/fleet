# E3 (paths) summary — run `lab23-check`

- **instrument commit**: `a2ac4a737d060efb7bab78febb569ef29d78f2de`  ·  **generated**: 2026-09-04T23:12:46.142Z
- **cfgs**: 1303  ·  **trials**: 5000000  ·  **flagged (any bit)**: 13.57%  ·  **wall-clock**: 459.2s
- **units**: length m, speed m/s, angle deg, time s

> H4 (program §9): "the return-speed BAND matters more than the return RATE" — every
> ranking below is on `inBandFraction` (fraction of RETURNS inside the 1.0-2.5 m/s
> playable band), not `returnRate`. A lane returning 100% at 4 m/s ranks below one
> returning 60% at 2 m/s.

## Per-family summary (§5.4)

| family | trials | flagged% | IMPACTS_EXHAUSTED% | returnRate | inBandFraction | stallRate | variety(entropy) | median timeToReturn(s) |
|---|---|---|---|---|---|---|---|---|
| P1 launch lane | 1000000 | 41.52 | 0.00 | 58.5% | 89.4% | 41.5% | 0.461 | 1.75 |
| P2 orbit | 1000000 | 25.00 | 0.00 | 74.8% | 23.6% | 25.0% | 0.908 | 1.08 |
| P3 return lanes | 1000000 | 1.33 | 0.02 | 98.1% | 20.7% | 1.1% | 0.876 | 0.75 |
| P4 ramp mouth | 1000000 | 0.00 | 0.00 | 100.0% | 27.3% | 0.0% | 0.909 | 0.97 |
| P5 habitrail drop | 1000000 | 0.00 | 0.00 | 100.0% | 58.6% | 0.0% | 0.869 | 0.10 |

## Feed classification, per family (fraction of ALL trials, §5.4)

| family | centre | leftInlane | rightInlane | leftOutlane | rightOutlane | directDrain |
|---|---|---|---|---|---|---|
| P1 | 15.5% | 18.0% | 11.0% | 10.2% | 0.2% | 3.6% |
| P2 | 13.1% | 18.7% | 22.5% | 11.9% | 4.2% | 4.6% |
| P3 | 28.4% | 27.8% | 27.9% | 7.4% | 7.3% | 0.0% |
| P4 | 19.1% | 24.3% | 23.7% | 17.6% | 15.1% | 0.0% |
| P5 | 24.2% | 28.6% | 26.6% | 10.0% | 10.5% | 0.0% |

## Top 10 cfgs per family, ranked by inBandFraction (the trade-off curve, §5.4)

### P1 launch lane

> ⚠ **`inBandFraction` RANKING INVALID (LAB-16 gate)**: cannot rank this family's 203 cfgs — top-10 cut lands inside a 60-way tie for 10 remaining slot(s) (6.00x, ceiling 2x) — most of the selection would be insertion order, not a ranking. Ranked below by **distance from the band centre** (median return speed vs. the 1.75 m/s midpoint of the 1.0-2.5 m/s band) instead — a continuous proxy for the same "landed in the playable band" question that does not saturate the way a bounded fraction can.

| cfgId | trials | returnRate | inBandFraction | medianXs (m/s) | stallRate | flagged% |
|---|---|---|---|---|---|---|
| 94ca27fc | 4926 | 100.0% | 100.0% | 1.22 | 0.0% | 0.00 |
| ecd42d0e | 4926 | 100.0% | 100.0% | 1.22 | 0.0% | 0.00 |
| 647e1b90 | 4926 | 100.0% | 100.0% | 1.22 | 0.0% | 0.00 |
| f7a54b96 | 4926 | 100.0% | 100.0% | 1.22 | 0.0% | 0.00 |
| 7a827ffa | 4926 | 100.0% | 100.0% | 1.22 | 0.0% | 0.00 |
| 5ef8ebbd | 4926 | 100.0% | 100.0% | 1.22 | 0.0% | 0.00 |
| 9e73cd27 | 4926 | 100.0% | 100.0% | 1.22 | 0.0% | 0.00 |
| 039abb86 | 4926 | 100.0% | 100.0% | 1.22 | 0.0% | 0.00 |
| ce55af69 | 4926 | 100.0% | 100.0% | 1.22 | 0.0% | 0.00 |
| 80533984 | 4926 | 100.0% | 100.0% | 1.22 | 0.0% | 0.00 |

### P2 orbit

| cfgId | trials | returnRate | inBandFraction | stallRate | flagged% |
|---|---|---|---|---|---|
| fac1c83c | 3334 | 82.3% | 34.7% | 17.7% | 17.70 |
| 0637faf1 | 3333 | 54.1% | 33.5% | 45.9% | 45.93 |
| 60824a2a | 3333 | 61.2% | 33.4% | 37.6% | 37.62 |
| 8644eca8 | 3333 | 58.8% | 33.2% | 39.0% | 39.00 |
| 2dcf445f | 3333 | 63.5% | 33.0% | 36.5% | 36.45 |
| f522bed4 | 3333 | 64.4% | 32.9% | 35.6% | 35.61 |
| f25af151 | 3334 | 81.6% | 32.9% | 18.4% | 18.39 |
| ab0bec09 | 3333 | 71.3% | 32.8% | 26.0% | 25.95 |
| 6bee18ab | 3333 | 78.6% | 32.8% | 21.4% | 21.42 |
| e14ca0aa | 3333 | 73.2% | 32.8% | 23.7% | 23.73 |

### P3 return lanes

| cfgId | trials | returnRate | inBandFraction | stallRate | flagged% |
|---|---|---|---|---|---|
| 79269eae | 10000 | 98.7% | 38.0% | 1.3% | 1.31 |
| ce6a968c | 10000 | 96.7% | 37.7% | 3.3% | 3.27 |
| 3a501216 | 10000 | 98.5% | 37.6% | 1.5% | 1.48 |
| cdfaad8e | 10000 | 98.5% | 37.6% | 1.5% | 1.53 |
| 7f7c5669 | 10000 | 96.8% | 37.5% | 1.4% | 3.24 |
| c515d437 | 10000 | 98.5% | 37.5% | 1.5% | 1.50 |
| a1399ac6 | 10000 | 96.9% | 37.3% | 0.6% | 3.11 |
| 3cea8167 | 10000 | 96.9% | 37.1% | 1.5% | 3.11 |
| ff8a8115 | 10000 | 97.6% | 37.0% | 2.4% | 2.44 |
| a0920224 | 10000 | 97.5% | 36.8% | 0.0% | 2.49 |

### P4 ramp mouth

| cfgId | trials | returnRate | inBandFraction | stallRate | flagged% |
|---|---|---|---|---|---|
| df7676b9 | 10000 | 100.0% | 31.6% | 0.0% | 0.00 |
| 9e97147c | 10000 | 100.0% | 31.5% | 0.0% | 0.00 |
| d0aa04a6 | 10000 | 100.0% | 31.4% | 0.0% | 0.00 |
| 3d9ecadd | 10000 | 100.0% | 30.9% | 0.0% | 0.00 |
| ed3d530c | 10000 | 100.0% | 30.6% | 0.0% | 0.00 |
| 49334300 | 10000 | 100.0% | 30.4% | 0.0% | 0.00 |
| 2a2d732c | 10000 | 100.0% | 30.3% | 0.0% | 0.00 |
| e0b99962 | 10000 | 100.0% | 30.0% | 0.0% | 0.00 |
| f4cf447e | 10000 | 100.0% | 29.9% | 0.0% | 0.00 |
| e0eef81a | 10000 | 100.0% | 29.7% | 0.0% | 0.00 |

### P5 habitrail drop

> ⚠ **`inBandFraction` RANKING INVALID (LAB-16 gate)**: cannot rank this family's 600 cfgs — top-10 cut lands inside a 242-way tie for 10 remaining slot(s) (24.20x, ceiling 2x) — most of the selection would be insertion order, not a ranking. Ranked below by **distance from the band centre** (median return speed vs. the 1.75 m/s midpoint of the 1.0-2.5 m/s band) instead — a continuous proxy for the same "landed in the playable band" question that does not saturate the way a bounded fraction can.

| cfgId | trials | returnRate | inBandFraction | medianXs (m/s) | stallRate | flagged% |
|---|---|---|---|---|---|---|
| 3d7ac060 | 1666 | 100.0% | 100.0% | 1.76 | 0.0% | 0.00 |
| 8f640040 | 1667 | 100.0% | 100.0% | 1.74 | 0.0% | 0.00 |
| 76fd0a89 | 1667 | 100.0% | 100.0% | 1.74 | 0.0% | 0.00 |
| f1021b91 | 1667 | 100.0% | 100.0% | 1.70 | 0.0% | 0.00 |
| b5acde4b | 1666 | 100.0% | 72.0% | 1.80 | 0.0% | 0.00 |
| 087d258d | 1667 | 100.0% | 100.0% | 1.70 | 0.0% | 0.00 |
| 3d9957db | 1667 | 100.0% | 100.0% | 1.70 | 0.0% | 0.00 |
| 420f7cc7 | 1667 | 100.0% | 100.0% | 1.70 | 0.0% | 0.00 |
| a1ba3ae0 | 1666 | 100.0% | 100.0% | 1.70 | 0.0% | 0.00 |
| 54220c8a | 1667 | 100.0% | 100.0% | 1.70 | 0.0% | 0.00 |

## Dead-zone heatmap

`e3-lab23-check-heatmap.csv` — 1cm x 1cm occupancy bins (`family,x,y,count`) of every
substep a ball spent below 0.15 m/s, summed across that family's trials. §5.4: "the single
most directly useful artifact in the whole program" — a map of where a ball goes to die.

<!-- SAMPLECAP-1-ANNOTATION:BEGIN -->

## Corrected family characterisation (SAMPLECAP-1)

`returnXVariety` and `timeToReturnMedianS` in the table above were computed from a
per-worker **prefix** of each family's reached trials — workers own contiguous cfg
slices, so the retained trials came from one end of each slice — not from a sample of
the family. Every trial is on disk, so both have been recomputed over **every** reached
trial. Nothing was re-simulated and this summary was not regenerated; no other metric
here is affected. Source: `e3-lab23-check-familystats.json`.

**These are the values this run supports:**

| family | reached trials | return-x variety | median time to return |
|---|---|---|---|
| P1 | 584,815 | **0.8796** | **2.0292 s** |
| P2 | 748,030 | **0.8964** | **1.1583 s** |
| P3 | 980,605 | **0.8970** | **0.7417 s** |
| P4 | 999,977 | **0.9083** | **0.8625 s** |
| P5 | 1,000,000 | **0.9095** | **0.2208 s** |

**Return-x variety.** 0.880–0.909 across the 5 families, a spread of 0.030. All of them spread their returns comparably; none concentrates them into a narrow band. 
The table above shows a spread of 0.448 — an apparent separation 15× wider than the data supports. That separation is an artifact of which trials were retained.
- **P1** reads 0.4614 above; it is **0.8796**. Any reading that treats P1 as less various than the other families does not survive the correction.

**Median time to return.** P5 < P3 < P4 < P2 < P1 — P1 2.029 s, P2 1.158 s, P3 0.742 s, P4 0.862 s, P5 0.221 s.
- The **ordering is unchanged** from the table above; the magnitudes are not.
- **P5** reads 0.1000 s above; it is **0.2208 s** (2.21×).

<!-- SAMPLECAP-1-ANNOTATION:END -->
