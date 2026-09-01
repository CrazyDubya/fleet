# E1 pilot summary — run `pilot-01`

- **exp**: e1  ·  **instrument commit**: `adbaa50869eff488ea7e7f1449ef1686f6ec1be2`  ·  **generated**: 2026-09-01T03:50:03.911Z
- **cfgs**: 12  ·  **trials**: 10000  ·  **flagged fraction (any bit)**: 8.330%  ·  **wall-clock**: 1.9s
- **units**: length m, speed m/s, angle deg (recorded) / rad (internal), `dt` ms, `dw` s

> Pilot scope (program handoff §9/LAB-1): one fixed geometry × the policy families (`never`/`fixedDelay`/`proximity`), ~800 trials/cfg — proves the harness and every §3.4 column, not the full Stage A/B geometry sweep or the §3.6 transfer function (LAB-2).

## ⚠ Validity warning (§2.7)

> "An experiment whose flagged fraction exceeds 1% is not summarised until the cause is understood." The following cfg(s) exceed that on their own — flagged here, not smoothed into the aggregate; their columns below describe *what saturated the solver*, not a clean flipper response, and should not be read as characterising the geometry.

- **03ede277** (`proximity` R=0.07 L=0): 100.0% flagged, dominated by `IMPACTS_EXHAUSTED` (100.0%). Cause, inspected: R=0.07 with L=0 fires the flipper the instant the ball is already essentially at the pivot — the same class of fact as the P0 root cause (a kinematic surface appearing where the ball already is saturates MAX_IMPACTS resolving the overlap), not a harness bug.

| cfg | pol | d | R | L | n | flagged% | top term | vi | ai | hs | ha | hw | dt(ms) | vo | ao | contacts(n) | fan(xa) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 6c7d9477 | never | — | — | — | 834 | 0.00 | drain | — | — | — | — | — | — | — | — | 0.00 | — |
| 61547799 | fixedDelay | 0 | — | — | 834 | 0.00 | drain | — | — | — | — | — | — | — | — | 0.00 | — |
| 3eeefdfc | fixedDelay | 50 | — | — | 834 | 0.00 | drain | 0.98 | 220.6 | 0.00 | 230.0 | 0.0 | — | 0.84 | 20.4 | 2.00 | — |
| 9c8f8fa3 | fixedDelay | 100 | — | — | 834 | 0.00 | drain | — | — | — | — | — | — | — | — | 0.00 | — |
| b156f110 | fixedDelay | 150 | — | — | 833 | 0.00 | drain | — | — | — | — | — | — | — | — | 0.00 | — |
| 1daae80c | fixedDelay | 200 | — | — | 833 | 0.00 | drain | 0.99 | 221.4 | 0.00 | 230.0 | 0.0 | — | 0.88 | 325.1 | 2.00 | — |
| 03ede277 | proximity | — | 0.07 | 0 | 833 | 100.00 | drain | 2.12 | 303.9 | 0.77 | 181.2 | -102.2 | 8.3 | 3.86 | 80.8 | 7.00 | — |
| 04315c9f | proximity | — | 0.07 | 40 | 833 | 0.00 | drain | — | — | — | — | — | — | — | — | 0.00 | — |
| db0bc0cf | proximity | — | 0.1 | 0 | 833 | 0.00 | drain | — | — | — | — | — | — | — | — | 0.00 | — |
| b1f67129 | proximity | — | 0.1 | 40 | 833 | 0.00 | drain | — | — | — | — | — | — | — | — | 0.00 | — |
| 050caf60 | proximity | — | 0.14 | 0 | 833 | 0.00 | shotline | 2.19 | 297.8 | 0.24 | 32.0 | 0.0 | 50.0 | 1.86 | 126.7 | 1.00 | 0.1 |
| 279b3e0b | proximity | — | 0.14 | 40 | 833 | 0.00 | drain | — | — | — | — | — | — | — | — | 0.00 | — |

## IMPACTS_EXHAUSTED, per cfg (§2.7/§4.5 — reported prominently, not folded away)

| cfg | pol | IMPACTS_EXHAUSTED% | ESCAPED% | TIMEOUT% | STALLED% | NAN% |
|---|---|---|---|---|---|---|
| 6c7d9477 | never | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 |
| 61547799 | fixedDelay | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 |
| 3eeefdfc | fixedDelay | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 |
| 9c8f8fa3 | fixedDelay | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 |
| b156f110 | fixedDelay | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 |
| 1daae80c | fixedDelay | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 |
| 03ede277 | proximity | 100.00 | 0.00 | 0.00 | 0.00 | 0.00 |
| 04315c9f | proximity | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 |
| db0bc0cf | proximity | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 |
| b1f67129 | proximity | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 |
| 050caf60 | proximity | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 |
| 279b3e0b | proximity | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 |

## Terminal-state breakdown, per cfg

| cfg | pol | drain | shotline |
|---|---|---|---|
| 6c7d9477 | never | 834 | 0 |
| 61547799 | fixedDelay | 834 | 0 |
| 3eeefdfc | fixedDelay | 834 | 0 |
| 9c8f8fa3 | fixedDelay | 834 | 0 |
| b156f110 | fixedDelay | 833 | 0 |
| 1daae80c | fixedDelay | 833 | 0 |
| 03ede277 | proximity | 833 | 0 |
| 04315c9f | proximity | 833 | 0 |
| db0bc0cf | proximity | 833 | 0 |
| b1f67129 | proximity | 833 | 0 |
| 050caf60 | proximity | 0 | 833 |
| 279b3e0b | proximity | 833 | 0 |
