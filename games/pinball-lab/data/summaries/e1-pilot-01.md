# E1 pilot summary — run `pilot-01`

> ⚠ **STALE — ruling pending.** Produced on pre-fix solver commit `9a6eb1e7fd21f657170a831edc07416585391058` (before the e5ff0d7 kinematic-flipper solver fix). Regeneration at HEAD was attempted and refused: `{"ok":false,"error":"§2.7 gate: flagged fraction 11.56% exceeds 1%","out":"data/e1/pilot-01-20260904"}` — the pilot's deliberately edge-heavy cfg set predates the post-LAB-11 §2.7 flag gate and no longer clears it. Ruling pending, see `ledger/handoffs/sonnet2/20260904T142000Z-lab-corpus-regen-blocked.md`.

- **exp**: e1  ·  **instrument commit**: `9a6eb1e7fd21f657170a831edc07416585391058`  ·  **generated**: 2026-09-01T04:13:46.382Z
- **cfgs**: 12  ·  **trials**: 10000  ·  **flagged fraction (any bit)**: 15.600%  ·  **wall-clock**: 2.8s
- **units**: length m, speed m/s, angle deg (recorded) / rad (internal), `dt` ms, `dw` s
- **§2.4a ensemble check** (so the next reader can see the ensemble was real without opening a shard): inbound sd — x0=0.0577m, speed0=1.2140m/s, angle0=40.08° (all cfgs passed their §2.4a floor) · **`never`-baseline flipper-contact rate**: 51.4% (floor > 30%)

> Pilot scope (program handoff §9/LAB-1): one fixed geometry × the policy families (`never`/`fixedDelay`/`proximity`), ~800 trials/cfg — proves the harness and every §3.4 column, not the full Stage A/B geometry sweep or the §3.6 transfer function (LAB-2).

## ⚠ Validity warning (§2.7)

> "An experiment whose flagged fraction exceeds 1% is not summarised until the cause is understood." The following cfg(s) exceed that on their own — flagged here, not smoothed into the aggregate; their columns below describe *what saturated the solver*, not a clean flipper response, and should not be read as characterising the geometry.

- **6c7d9477** (`never`): 14.6% flagged, dominated by `TIMEOUT` (14.6%). the ball is still in play at the 2.0s cap — likely a slow-speed injection (§3.3 samples down to 0.3 m/s) taking a while to fall/settle rather than a stuck state; check a --trace replay of one flagged trial before assuming either way.
- **61547799** (`fixedDelay` d=0): 11.8% flagged, dominated by `TIMEOUT` (11.8%). the ball is still in play at the 2.0s cap — likely a slow-speed injection (§3.3 samples down to 0.3 m/s) taking a while to fall/settle rather than a stuck state; check a --trace replay of one flagged trial before assuming either way.
- **3eeefdfc** (`fixedDelay` d=50): 11.0% flagged, dominated by `TIMEOUT` (11.0%). the ball is still in play at the 2.0s cap — likely a slow-speed injection (§3.3 samples down to 0.3 m/s) taking a while to fall/settle rather than a stuck state; check a --trace replay of one flagged trial before assuming either way.
- **9c8f8fa3** (`fixedDelay` d=100): 12.0% flagged, dominated by `TIMEOUT` (11.3%). the ball is still in play at the 2.0s cap — likely a slow-speed injection (§3.3 samples down to 0.3 m/s) taking a while to fall/settle rather than a stuck state; check a --trace replay of one flagged trial before assuming either way.
- **b156f110** (`fixedDelay` d=150): 16.0% flagged, dominated by `TIMEOUT` (13.7%). the ball is still in play at the 2.0s cap — likely a slow-speed injection (§3.3 samples down to 0.3 m/s) taking a while to fall/settle rather than a stuck state; check a --trace replay of one flagged trial before assuming either way.
- **1daae80c** (`fixedDelay` d=200): 14.4% flagged, dominated by `TIMEOUT` (12.6%). the ball is still in play at the 2.0s cap — likely a slow-speed injection (§3.3 samples down to 0.3 m/s) taking a while to fall/settle rather than a stuck state; check a --trace replay of one flagged trial before assuming either way.
- **03ede277** (`proximity` R=0.07 L=0): 16.1% flagged, dominated by `IMPACTS_EXHAUSTED` (9.6%). the flipper firing right as the ball is already at/near the pivot saturates MAX_IMPACTS resolving the overlap in one substep — the same class of fact as the P0 root cause (a kinematic surface appearing where the ball already is).
- **04315c9f** (`proximity` R=0.07 L=40): 21.2% flagged, dominated by `IMPACTS_EXHAUSTED` (16.3%). the flipper firing right as the ball is already at/near the pivot saturates MAX_IMPACTS resolving the overlap in one substep — the same class of fact as the P0 root cause (a kinematic surface appearing where the ball already is).
- **db0bc0cf** (`proximity` R=0.1 L=0): 14.5% flagged, dominated by `TIMEOUT` (12.2%). the ball is still in play at the 2.0s cap — likely a slow-speed injection (§3.3 samples down to 0.3 m/s) taking a while to fall/settle rather than a stuck state; check a --trace replay of one flagged trial before assuming either way.
- **b1f67129** (`proximity` R=0.1 L=40): 21.2% flagged, dominated by `IMPACTS_EXHAUSTED` (17.6%). the flipper firing right as the ball is already at/near the pivot saturates MAX_IMPACTS resolving the overlap in one substep — the same class of fact as the P0 root cause (a kinematic surface appearing where the ball already is).
- **050caf60** (`proximity` R=0.14 L=0): 14.6% flagged, dominated by `TIMEOUT` (14.6%). the ball is still in play at the 2.0s cap — likely a slow-speed injection (§3.3 samples down to 0.3 m/s) taking a while to fall/settle rather than a stuck state; check a --trace replay of one flagged trial before assuming either way.
- **279b3e0b** (`proximity` R=0.14 L=40): 19.7% flagged, dominated by `TIMEOUT` (12.2%). the ball is still in play at the 2.0s cap — likely a slow-speed injection (§3.3 samples down to 0.3 m/s) taking a while to fall/settle rather than a stuck state; check a --trace replay of one flagged trial before assuming either way.

| cfg | pol | d | R | L | n | flagged% | top term | vi | ai | hs | ha | hw | dt(ms) | vo | ao | contacts(n) | fan(xa) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 6c7d9477 | never | — | — | — | 834 | 14.63 | drain | 2.46 | 270.2 | 0.30 | 85.0 | 0.0 | — | 2.17 | 175.1 | 0.64 | 74.0 |
| 61547799 | fixedDelay | 0 | — | — | 834 | 11.75 | drain | 2.37 | 269.6 | 0.34 | 86.1 | 0.0 | 241.4 | 2.09 | 169.0 | 0.54 | 85.9 |
| 3eeefdfc | fixedDelay | 50 | — | — | 834 | 11.03 | drain | 2.35 | 268.8 | 0.41 | 89.8 | 0.0 | 184.2 | 2.05 | 136.0 | 0.55 | 74.8 |
| 9c8f8fa3 | fixedDelay | 100 | — | — | 834 | 11.99 | drain | 2.24 | 270.2 | 0.38 | 88.7 | -0.0 | 146.6 | 2.22 | 130.5 | 0.58 | 72.6 |
| b156f110 | fixedDelay | 150 | — | — | 833 | 15.97 | drain | 2.27 | 272.1 | 0.37 | 84.7 | 2.3 | 109.2 | 2.37 | 139.5 | 0.55 | 89.6 |
| 1daae80c | fixedDelay | 200 | — | — | 833 | 14.41 | drain | 2.32 | 269.8 | 0.33 | 88.5 | -0.3 | 106.0 | 2.37 | 153.5 | 0.58 | 69.6 |
| 03ede277 | proximity | — | 0.07 | 0 | 833 | 16.09 | drain | 2.27 | 275.3 | 0.34 | 90.6 | 0.8 | 18.7 | 4.32 | 129.8 | 0.46 | 63.5 |
| 04315c9f | proximity | — | 0.07 | 40 | 833 | 21.25 | drain | 2.38 | 267.2 | 0.22 | 103.3 | -3.6 | 10.1 | 2.46 | 162.0 | 0.62 | 58.4 |
| db0bc0cf | proximity | — | 0.1 | 0 | 833 | 14.53 | drain | 2.23 | 265.6 | 0.42 | 93.0 | 5.1 | 32.6 | 3.20 | 131.9 | 0.44 | 68.6 |
| b1f67129 | proximity | — | 0.1 | 40 | 833 | 21.25 | drain | 2.29 | 270.1 | 0.19 | 84.6 | 6.2 | 16.2 | 3.40 | 137.7 | 0.51 | 60.6 |
| 050caf60 | proximity | — | 0.14 | 0 | 833 | 14.65 | drain | 2.46 | 271.9 | 0.50 | 89.6 | -0.2 | 47.3 | 2.50 | 114.6 | 0.44 | 87.6 |
| 279b3e0b | proximity | — | 0.14 | 40 | 833 | 19.69 | drain | 2.27 | 271.4 | 0.31 | 90.4 | -2.9 | 19.7 | 4.05 | 128.1 | 0.42 | 73.1 |

## IMPACTS_EXHAUSTED, per cfg (§2.7/§4.5 — reported prominently, not folded away)

| cfg | pol | IMPACTS_EXHAUSTED% | ESCAPED% | TIMEOUT% | STALLED% | NAN% |
|---|---|---|---|---|---|---|
| 6c7d9477 | never | 0.00 | 0.00 | 14.63 | 0.00 | 0.00 |
| 61547799 | fixedDelay | 0.00 | 0.00 | 11.75 | 0.00 | 0.00 |
| 3eeefdfc | fixedDelay | 0.00 | 0.00 | 11.03 | 0.00 | 0.00 |
| 9c8f8fa3 | fixedDelay | 0.72 | 0.00 | 11.27 | 0.00 | 0.00 |
| b156f110 | fixedDelay | 2.40 | 0.00 | 13.69 | 0.00 | 0.00 |
| 1daae80c | fixedDelay | 2.16 | 0.00 | 12.61 | 0.00 | 0.00 |
| 03ede277 | proximity | 9.60 | 0.00 | 8.64 | 0.00 | 0.00 |
| 04315c9f | proximity | 16.33 | 0.00 | 5.88 | 0.00 | 0.00 |
| db0bc0cf | proximity | 3.36 | 0.00 | 12.24 | 0.00 | 0.00 |
| b1f67129 | proximity | 17.65 | 0.00 | 5.88 | 0.00 | 0.00 |
| 050caf60 | proximity | 0.12 | 0.00 | 14.65 | 0.00 | 0.00 |
| 279b3e0b | proximity | 8.52 | 0.00 | 12.24 | 0.00 | 0.00 |

## Terminal-state breakdown, per cfg

| cfg | pol | drain | timeout | shotline |
|---|---|---|---|---|
| 6c7d9477 | never | 485 | 122 | 227 |
| 61547799 | fixedDelay | 568 | 98 | 168 |
| 3eeefdfc | fixedDelay | 515 | 92 | 227 |
| 9c8f8fa3 | fixedDelay | 498 | 94 | 242 |
| b156f110 | fixedDelay | 480 | 114 | 239 |
| 1daae80c | fixedDelay | 513 | 105 | 215 |
| 03ede277 | proximity | 515 | 72 | 246 |
| 04315c9f | proximity | 487 | 49 | 297 |
| db0bc0cf | proximity | 517 | 102 | 214 |
| b1f67129 | proximity | 505 | 49 | 279 |
| 050caf60 | proximity | 470 | 122 | 241 |
| 279b3e0b | proximity | 518 | 102 | 213 |
