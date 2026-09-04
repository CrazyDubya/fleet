# E1 pilot summary — run `pilot-01-lab22`

- **exp**: e1  ·  **instrument commit**: `d7b887182644f92beb26c31586f75be392849979`  ·  **generated**: 2026-09-04T22:04:05.741Z
- **cfgs**: 12  ·  **trials**: 10000  ·  **flagged fraction (any bit)**: 10.420%  ·  **wall-clock**: 5.4s
- **units**: length m, speed m/s, angle deg (recorded) / rad (internal), `dt` ms, `dw` s
- **§2.4a ensemble check** (so the next reader can see the ensemble was real without opening a shard): inbound sd — x0=0.0577m, speed0=1.2140m/s, angle0=40.08° (all cfgs passed their §2.4a floor) · **`never`-baseline flipper-contact rate**: 51.6% (floor > 30%)

> Pilot scope (program handoff §9/LAB-1): one fixed geometry × the policy families (`never`/`fixedDelay`/`proximity`), ~800 trials/cfg — proves the harness and every §3.4 column, not the full Stage A/B geometry sweep or the §3.6 transfer function (LAB-2).

## Declared premise (§2.7 exemption) — measured 10.42%, declared ceiling 13.00%

> This corpus declares an expected flagged fraction above §2.7's 1% gate. The declaration covers **TIMEOUT** only — every other flag is still held to 1%. This is a recorded claim, not a waiver: challenge it here.

- **declared ceiling**: 13.00%  ·  **measured**: 10.42%  ·  **verdict**: within the declaration
- **covers flags**: TIMEOUT
- **declared by**: ledger/handoffs/opus2/20260904T150000Z-three-gate-rulings.md §(b)
- **reason**: The TIMEOUT tail is this pilot's subject matter, not a defect. §3.3 samples inbound speed down to 0.3 m/s against a 2.0s trial cap, so the slowest injections are still in play when the window closes. The pilot exists to prove the harness and every §3.4 column against exactly those edge cases, so redesigning it to clear 1% would remove what it validates. Measured post-solver-fix at 11.565% flagged overall, of which 10.914pp is TIMEOUT and only 0.650pp is IMPACTS_EXHAUSTED — on the solver-validity axis §2.7 exists to protect, this corpus passes. The ceiling is set at 13% to leave headroom over the measured 11.565% for run-to-run variation; it is not a measurement, it is a bound, and a run that exceeds it is still refused.

## ⚠ Validity warning (§2.7)

> "An experiment whose flagged fraction exceeds 1% is not summarised until the cause is understood." The following cfg(s) exceed that on their own — flagged here, not smoothed into the aggregate; their columns below describe *what saturated the solver*, not a clean flipper response, and should not be read as characterising the geometry.

- **6c7d9477** (`never`): 14.0% flagged, dominated by `TIMEOUT` (14.0%). the ball is still in play at the 2.0s cap — likely a slow-speed injection (§3.3 samples down to 0.3 m/s) taking a while to fall/settle rather than a stuck state; check a --trace replay of one flagged trial before assuming either way.
- **61547799** (`fixedDelay` d=0): 11.6% flagged, dominated by `TIMEOUT` (11.6%). the ball is still in play at the 2.0s cap — likely a slow-speed injection (§3.3 samples down to 0.3 m/s) taking a while to fall/settle rather than a stuck state; check a --trace replay of one flagged trial before assuming either way.
- **3eeefdfc** (`fixedDelay` d=50): 10.6% flagged, dominated by `TIMEOUT` (10.6%). the ball is still in play at the 2.0s cap — likely a slow-speed injection (§3.3 samples down to 0.3 m/s) taking a while to fall/settle rather than a stuck state; check a --trace replay of one flagged trial before assuming either way.
- **9c8f8fa3** (`fixedDelay` d=100): 11.9% flagged, dominated by `TIMEOUT` (11.9%). the ball is still in play at the 2.0s cap — likely a slow-speed injection (§3.3 samples down to 0.3 m/s) taking a while to fall/settle rather than a stuck state; check a --trace replay of one flagged trial before assuming either way.
- **b156f110** (`fixedDelay` d=150): 13.0% flagged, dominated by `TIMEOUT` (13.0%). the ball is still in play at the 2.0s cap — likely a slow-speed injection (§3.3 samples down to 0.3 m/s) taking a while to fall/settle rather than a stuck state; check a --trace replay of one flagged trial before assuming either way.
- **1daae80c** (`fixedDelay` d=200): 11.8% flagged, dominated by `TIMEOUT` (11.8%). the ball is still in play at the 2.0s cap — likely a slow-speed injection (§3.3 samples down to 0.3 m/s) taking a while to fall/settle rather than a stuck state; check a --trace replay of one flagged trial before assuming either way.
- **03ede277** (`proximity` R=0.07 L=0): 6.6% flagged, dominated by `TIMEOUT` (6.4%). the ball is still in play at the 2.0s cap — likely a slow-speed injection (§3.3 samples down to 0.3 m/s) taking a while to fall/settle rather than a stuck state; check a --trace replay of one flagged trial before assuming either way.
- **04315c9f** (`proximity` R=0.07 L=40): 5.0% flagged, dominated by `TIMEOUT` (4.9%). the ball is still in play at the 2.0s cap — likely a slow-speed injection (§3.3 samples down to 0.3 m/s) taking a while to fall/settle rather than a stuck state; check a --trace replay of one flagged trial before assuming either way.
- **db0bc0cf** (`proximity` R=0.1 L=0): 10.8% flagged, dominated by `TIMEOUT` (10.8%). the ball is still in play at the 2.0s cap — likely a slow-speed injection (§3.3 samples down to 0.3 m/s) taking a while to fall/settle rather than a stuck state; check a --trace replay of one flagged trial before assuming either way.
- **b1f67129** (`proximity` R=0.1 L=40): 4.3% flagged, dominated by `TIMEOUT` (4.1%). the ball is still in play at the 2.0s cap — likely a slow-speed injection (§3.3 samples down to 0.3 m/s) taking a while to fall/settle rather than a stuck state; check a --trace replay of one flagged trial before assuming either way.
- **050caf60** (`proximity` R=0.14 L=0): 14.4% flagged, dominated by `TIMEOUT` (14.4%). the ball is still in play at the 2.0s cap — likely a slow-speed injection (§3.3 samples down to 0.3 m/s) taking a while to fall/settle rather than a stuck state; check a --trace replay of one flagged trial before assuming either way.
- **279b3e0b** (`proximity` R=0.14 L=40): 11.0% flagged, dominated by `TIMEOUT` (10.9%). the ball is still in play at the 2.0s cap — likely a slow-speed injection (§3.3 samples down to 0.3 m/s) taking a while to fall/settle rather than a stuck state; check a --trace replay of one flagged trial before assuming either way.

| cfg | pol | d | R | L | n | flagged% | top term | vi | ai | hs | ha | hw | dt(ms) | vo | ao | contacts(n) | fan(xa) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 6c7d9477 | never | — | — | — | 834 | 14.03 | drain | 2.44 | 270.6 | 0.30 | 85.1 | 0.0 | — | 2.16 | 173.0 | 0.65 | 71.1 |
| 61547799 | fixedDelay | 0 | — | — | 834 | 11.63 | drain | 2.37 | 268.4 | 0.35 | 89.0 | 0.0 | 242.3 | 2.09 | 168.9 | 0.54 | 77.3 |
| 3eeefdfc | fixedDelay | 50 | — | — | 834 | 10.55 | drain | 2.34 | 268.4 | 0.40 | 90.6 | 0.0 | 184.7 | 2.05 | 139.1 | 0.56 | 71.6 |
| 9c8f8fa3 | fixedDelay | 100 | — | — | 834 | 11.87 | drain | 2.28 | 270.6 | 0.38 | 91.6 | -0.6 | 142.7 | 2.53 | 129.8 | 0.56 | 74.6 |
| b156f110 | fixedDelay | 150 | — | — | 833 | 12.97 | drain | 2.33 | 271.0 | 0.38 | 82.0 | 4.6 | 105.0 | 2.69 | 139.2 | 0.59 | 82.8 |
| 1daae80c | fixedDelay | 200 | — | — | 833 | 11.76 | drain | 2.35 | 269.9 | 0.35 | 88.5 | 0.9 | 99.3 | 2.79 | 154.5 | 0.61 | 64.7 |
| 03ede277 | proximity | — | 0.07 | 0 | 833 | 6.60 | drain | 2.23 | 274.1 | 0.39 | 89.0 | 1.4 | 17.4 | 6.12 | 121.7 | 0.51 | 54.2 |
| 04315c9f | proximity | — | 0.07 | 40 | 833 | 5.04 | drain | 2.24 | 267.8 | 0.32 | 97.6 | -1.8 | 6.8 | 3.21 | 160.4 | 0.84 | 55.6 |
| db0bc0cf | proximity | — | 0.1 | 0 | 833 | 10.80 | drain | 2.26 | 265.9 | 0.47 | 92.8 | 3.1 | 30.4 | 5.04 | 132.1 | 0.47 | 61.5 |
| b1f67129 | proximity | — | 0.1 | 40 | 833 | 4.32 | drain | 2.24 | 269.2 | 0.33 | 84.3 | 1.5 | 12.7 | 5.06 | 133.0 | 0.71 | 54.4 |
| 050caf60 | proximity | — | 0.14 | 0 | 833 | 14.41 | drain | 2.47 | 271.3 | 0.50 | 89.3 | -0.3 | 47.2 | 2.70 | 114.3 | 0.44 | 86.7 |
| 279b3e0b | proximity | — | 0.14 | 40 | 833 | 11.04 | drain | 2.38 | 271.5 | 0.38 | 94.5 | -1.9 | 17.7 | 5.71 | 131.9 | 0.51 | 64.1 |

## IMPACTS_EXHAUSTED, per cfg (§2.7/§4.5 — reported prominently, not folded away)

| cfg | pol | IMPACTS_EXHAUSTED% | ESCAPED% | TIMEOUT% | STALLED% | NAN% |
|---|---|---|---|---|---|---|
| 6c7d9477 | never | 0.00 | 0.00 | 14.03 | 0.00 | 0.00 |
| 61547799 | fixedDelay | 0.00 | 0.00 | 11.63 | 0.00 | 0.00 |
| 3eeefdfc | fixedDelay | 0.00 | 0.00 | 10.55 | 0.00 | 0.00 |
| 9c8f8fa3 | fixedDelay | 0.00 | 0.00 | 11.87 | 0.00 | 0.00 |
| b156f110 | fixedDelay | 0.00 | 0.00 | 12.97 | 0.00 | 0.00 |
| 1daae80c | fixedDelay | 0.00 | 0.00 | 11.76 | 0.00 | 0.00 |
| 03ede277 | proximity | 0.24 | 0.00 | 6.36 | 0.00 | 0.00 |
| 04315c9f | proximity | 0.12 | 0.00 | 4.92 | 0.00 | 0.00 |
| db0bc0cf | proximity | 0.00 | 0.00 | 10.80 | 0.00 | 0.00 |
| b1f67129 | proximity | 0.24 | 0.00 | 4.08 | 0.00 | 0.00 |
| 050caf60 | proximity | 0.00 | 0.00 | 14.41 | 0.00 | 0.00 |
| 279b3e0b | proximity | 0.12 | 0.00 | 10.92 | 0.00 | 0.00 |

## Terminal-state breakdown, per cfg

| cfg | pol | drain | timeout | shotline |
|---|---|---|---|---|
| 6c7d9477 | never | 488 | 117 | 229 |
| 61547799 | fixedDelay | 567 | 97 | 170 |
| 3eeefdfc | fixedDelay | 518 | 88 | 228 |
| 9c8f8fa3 | fixedDelay | 491 | 99 | 244 |
| b156f110 | fixedDelay | 477 | 108 | 248 |
| 1daae80c | fixedDelay | 514 | 98 | 221 |
| 03ede277 | proximity | 477 | 53 | 303 |
| 04315c9f | proximity | 453 | 41 | 339 |
| db0bc0cf | proximity | 500 | 90 | 243 |
| b1f67129 | proximity | 450 | 34 | 349 |
| 050caf60 | proximity | 468 | 120 | 245 |
| 279b3e0b | proximity | 480 | 91 | 262 |
