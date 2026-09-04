# E1 — LAB-2 flipper transfer function (`lab22`)

- **instrument commit**: `369c1ce2a38722ecd9e4eb859e13814b02c6d86e`  ·  **generated**: 2026-09-04T22:29:07.096Z
- **Stage B trials**: 540000  ·  **flagged**: 11.14%  (IMPACTS_EXHAUSTED 0.01%, ESCAPED 0.000%, TIMEOUT 11.13%, STALLED 0.00%, NAN 0.000%)
- **flipper contact rate**: 50.4%  ·  **geometries characterised**: 24

## Declared premise (§2.7 exemption) — measured 11.14%, declared ceiling 14.00%

> This corpus declares an expected flagged fraction above §2.7's 1% gate. The declaration covers **TIMEOUT** only — every other flag is still held to 1%. This is a recorded claim, not a waiver: challenge it here.

- **declared ceiling**: 14.00%  ·  **measured**: 11.14%  ·  **verdict**: within the declaration
- **covers flags**: TIMEOUT
- **declared by**: ledger/handoffs/opus2/20260904T225500Z-declared-premise-mechanism.md §3 (extends the §(b) ruling in 20260904T150000Z-three-gate-rulings.md)
- **reason**: Same declared premise as e1-pilot-01 and for the same measured reason, extended to the full Stage B geometry sweep. §3.3 samples inbound speed down to 0.3 m/s against a 2.0s trial cap, so the slowest injections are still in play when the window closes. Measured post-substep-fix (abd4e88) over 540,000 trials: 11.143% flagged overall, of which TIMEOUT is 11.132pp, IMPACTS_EXHAUSTED is 0.009pp and STALLED 0.003pp — on the solver-validity axis §2.7 exists to protect this corpus is clean by three orders of magnitude. Ceiling set at 14% as a bound with headroom over the measured 11.143%, not as a measurement.

> §2.7: ESCAPED and NAN are near-zero (no solver artifact); TIMEOUT and IMPACTS_EXHAUSTED dominate the flagged fraction — the same pattern LAB-1b found for the main family (slow-speed injections still falling at the 2.0s cap; the flipper firing near a ball already at the pivot saturating MAX_IMPACTS), understood and not smoothed into the ranking below (fan width/sensitivity are computed only from `shotline` trials).

## Fan width / timing sensitivity / cradle, per geometry

| geom | rest° | active° | upMs | ω | r | e | fan(xa)° | sens(°/ms) | cradle% | minCs(m/s) | vo/vi grad | pareto |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 4b50c1c7 | -38 | 38 | 8 | sCurve | 0.009 | 0.65 | 83.0 | 0.142 | 0.0 | 0.730 | 1.876 | ✓ |
| dba8027f | -32 | 26 | 8 | sCurve | 0.012 | 0.45 | 82.4 | 0.259 | 0.0 | 0.347 | 1.044 |  |
| fe4d2989 | -32 | 26 | 8 | easeIn | 0.012 | 0.45 | 81.4 | 0.246 | 0.0 | 0.331 | 1.304 |  |
| 4a613f59 | -32 | 32 | 18 | sCurve | 0.015 | 0.45 | 80.7 | 0.529 | 0.0 | 0.318 | 0.753 |  |
| 0ea563eb | -22 | 38 | 11 | easeIn | 0.012 | 0.65 | 80.2 | 0.249 | 0.0 | 0.755 | 1.613 |  |
| 90b781ae | -22 | 38 | 14 | sCurve | 0.009 | 0.65 | 79.8 | 0.432 | 0.0 | 0.740 | 1.102 |  |
| 9361e471 | -38 | 38 | 18 | sCurve | 0.015 | 0.65 | 79.8 | 0.275 | 0.0 | 0.708 | 1.273 |  |
| 27f45872 | -38 | 38 | 24 | easeIn | 0.012 | 0.65 | 79.7 | 0.211 | 0.0 | 0.729 | 1.111 |  |
| 5672041a | -28 | 32 | 18 | easeOut | 0.012 | 0.45 | 77.9 | 0.372 | 0.0 | 0.322 | 0.600 |  |
| 1c9cbd7c | -22 | 32 | 11 | constant | 0.012 | 0.45 | 77.7 | 0.511 | 0.0 | 0.337 | 0.821 |  |
| 2e65cea7 | -44 | 38 | 11 | constant | 0.009 | 0.65 | 77.3 | 0.487 | 0.0 | 0.745 | 1.514 |  |
| 9c5cdf73 | -22 | 38 | 11 | easeIn | 0.015 | 0.85 | 77.1 | 0.276 | 0.0 | 1.262 | 1.655 |  |
| b3cd11cf | -28 | 38 | 8 | constant | 0.012 | 0.45 | 76.8 | 0.366 | 0.0 | 0.329 | 1.199 |  |
| 74e93e88 | -28 | 38 | 8 | sCurve | 0.009 | 0.45 | 75.8 | 0.284 | 0.2 | 0.357 | 1.386 |  |
| 740583bf | -32 | 38 | 8 | constant | 0.009 | 0.45 | 75.3 | 0.251 | 0.4 | 0.352 | 1.286 |  |
| 7a3f2cb7 | -28 | 38 | 14 | easeIn | 0.009 | 0.45 | 75.3 | 0.360 | 0.3 | 0.362 | 1.125 |  |
| 4a1d8409 | -28 | 38 | 24 | easeIn | 0.009 | 0.45 | 75.0 | 0.383 | 0.1 | 0.355 | 0.769 |  |
| 5cf7aa66 | -32 | 38 | 24 | constant | 0.012 | 0.45 | 74.5 | 0.447 | 0.0 | 0.338 | 0.579 |  |
| 7c8188f2 | -32 | 38 | 14 | easeOut | 0.009 | 0.45 | 73.0 | 0.425 | 0.4 | 0.341 | 0.931 |  |
| d420ba7d | -32 | 32 | 18 | sCurve | 0.009 | 0.85 | 72.6 | 0.151 | 0.0 | 1.311 | 0.900 |  |
| d7c5d5e3 | -28 | 38 | 14 | easeOut | 0.009 | 0.45 | 70.8 | 0.495 | 0.2 | 0.362 | 0.894 |  |
| cccbf48b | -38 | 38 | 8 | sCurve | 0.012 | 0.45 | 69.5 | 0.240 | 0.0 | 0.326 | 1.594 |  |
| e5f9b1a0 | -38 | 38 | 11 | easeIn | 0.012 | 0.45 | 66.7 | 0.336 | 0.0 | 0.349 | 1.544 |  |
| 3a156da3 | -50 | 38 | 18 | easeOut | 0.009 | 0.45 | 64.7 | 0.428 | 0.2 | 0.362 | 0.935 |  |

> `minCs(m/s)`: median of the minimum ball speed while touching a flipper, across every CONTACTING cradle trial for that geometry (not just settled ones) — reported alongside `cradle%`, not used to select anything here. Pilot (ledger/handoffs/sonnet2/20260904T160000Z-cradle-continuous-stat-pilot.md) found it separates all 24 geometries cleanly where `cradle%`/`cradleProxy` are degenerate; Stage A selection is unchanged pending the ranking-validity guard fix.

## Ranked under the sensitivity ceiling (≤ 1.5°/ms)

| rank | geom | fan(xa)° | sens(°/ms) | cradle% |
|---|---|---|---|---|
| 1 | 4b50c1c7 | 83.0 | 0.142 | 0.0 |
| 2 | dba8027f | 82.4 | 0.259 | 0.0 |
| 3 | fe4d2989 | 81.4 | 0.246 | 0.0 |
| 4 | 4a613f59 | 80.7 | 0.529 | 0.0 |
| 5 | 0ea563eb | 80.2 | 0.249 | 0.0 |
| 6 | 90b781ae | 79.8 | 0.432 | 0.0 |
| 7 | 9361e471 | 79.8 | 0.275 | 0.0 |
| 8 | 27f45872 | 79.7 | 0.211 | 0.0 |
| 9 | 5672041a | 77.9 | 0.372 | 0.0 |
| 10 | 1c9cbd7c | 77.7 | 0.511 | 0.0 |
| 11 | 2e65cea7 | 77.3 | 0.487 | 0.0 |
| 12 | 9c5cdf73 | 77.1 | 0.276 | 0.0 |
| 13 | b3cd11cf | 76.8 | 0.366 | 0.0 |
| 14 | 74e93e88 | 75.8 | 0.284 | 0.2 |
| 15 | 740583bf | 75.3 | 0.251 | 0.4 |
| 16 | 7a3f2cb7 | 75.3 | 0.360 | 0.3 |
| 17 | 4a1d8409 | 75.0 | 0.383 | 0.1 |
| 18 | 5cf7aa66 | 74.5 | 0.447 | 0.0 |
| 19 | 7c8188f2 | 73.0 | 0.425 | 0.4 |
| 20 | d420ba7d | 72.6 | 0.151 | 0.0 |
| 21 | d7c5d5e3 | 70.8 | 0.495 | 0.2 |
| 22 | cccbf48b | 69.5 | 0.240 | 0.0 |
| 23 | e5f9b1a0 | 66.7 | 0.336 | 0.0 |
| 24 | 3a156da3 | 64.7 | 0.428 | 0.2 |

## Recommendation

**Machine #2 default flipper**: rest angle **-38°**, active angle **38°** (sweep arc 76°), sweep **8 ms**, ω-profile **sCurve**, collision radius **0.009 m**, restitution **0.65**.

Justification: of the 24 geometries under the 1.5°/ms sensitivity ceiling, this one has the widest measured shot fan (P95−P5 of shot-line angle over the full timing sweep) at **83.0°**, with a median timing sensitivity of **0.142°/ms** (at or under the 1.5°/ms ceiling — a 10ms reaction-time error moves the shot by roughly 1.4°, still aimable), a cradle rate of **0.0%** (fraction of held-active trials settling within 1.5s — the "feels heavy" number), and a vo/vi-vs-hs gradient of **1.876 per unit hs** (positive means tip contact returns more energy than base contact, i.e. the ball rewards a good hit rather than saturating everywhere).

## Transfer function

Binned `(hs x phase x vi x ai) -> (vo, ao)` table (10 x 4 x 6 x 8 bins), 450 populated bins out of a possible 1920 — full table in the JSON summary; the 20 best-populated bins:

| hs bin | phase | vi bin (m/s) | ai bin (deg) | n | vo mean±sd | ao mean±sd |
|---|---|---|---|---|---|---|
| [0.0,0.1) | full | [1.0,2.0) | [225,270) | 9240 | 1.02±0.33 | 214.5±122.9 |
| [0.0,0.1) | full | [1.0,2.0) | [270,315) | 9210 | 1.01±0.33 | 214.4±67.7 |
| [0.0,0.1) | rest | [1.0,2.0) | [225,270) | 6595 | 0.98±0.33 | 156.1±105.3 |
| [0.0,0.1) | rest | [1.0,2.0) | [270,315) | 6575 | 0.98±0.32 | 159.6±99.9 |
| [0.0,0.1) | rest | [2.0,3.0) | [225,270) | 6089 | 1.71±0.40 | 155.3±101.2 |
| [0.0,0.1) | rest | [2.0,3.0) | [270,315) | 5978 | 1.72±0.40 | 144.2±96.7 |
| [0.9,1.0) | full | [1.0,2.0) | [225,270) | 5135 | 2.13±4.02 | 120.2±73.4 |
| [0.9,1.0) | full | [1.0,2.0) | [270,315) | 5115 | 2.20±4.17 | 131.7±103.4 |
| [0.0,0.1) | full | [2.0,3.0) | [225,270) | 5056 | 1.80±0.40 | 215.8±122.5 |
| [0.0,0.1) | full | [2.0,3.0) | [270,315) | 4938 | 1.81±0.42 | 214.6±67.4 |
| [0.9,1.0) | full | [2.0,3.0) | [270,315) | 3652 | 2.98±4.30 | 114.3±92.6 |
| [0.9,1.0) | full | [2.0,3.0) | [225,270) | 3589 | 3.10±4.52 | 116.8±62.6 |
| [0.0,0.1) | rest | [3.0,4.0) | [270,315) | 3310 | 2.25±0.54 | 145.5±98.8 |
| [0.0,0.1) | rest | [3.0,4.0) | [225,270) | 3294 | 2.25±0.54 | 141.4±97.3 |
| [0.1,0.2) | full | [1.0,2.0) | [270,315) | 1600 | 0.97±0.72 | 169.2±97.7 |
| [0.1,0.2) | full | [1.0,2.0) | [225,270) | 1592 | 0.95±0.68 | 91.8±77.5 |
| [0.0,0.1) | rest | [4.0,5.0) | [225,270) | 1543 | 2.77±0.64 | 119.6±72.4 |
| [0.0,0.1) | rest | [1.0,2.0) | [315,360) | 1506 | 0.90±0.28 | 217.3±83.2 |
| [0.0,0.1) | full | [3.0,4.0) | [225,270) | 1506 | 2.42±0.59 | 203.1±116.4 |
| [0.2,0.3) | full | [1.0,2.0) | [270,315) | 1494 | 1.11±1.18 | 173.5±99.2 |
