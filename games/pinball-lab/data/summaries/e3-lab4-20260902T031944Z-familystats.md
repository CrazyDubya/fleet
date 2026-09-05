# E3 family stats — corrected sample (companion to `data/summaries/e3-lab4-20260902T031944Z.json`)

- **source run**: `data/e3/lab4-20260902T031944Z` · **instrument commit**: `575fb105b37fe5f95ac7093f1aea60378ada245a`
- **generated**: 2026-09-05T20:51:40.430Z

> The published summary is **unchanged and not regenerated**. `returnXVariety` and
> `timeToReturnMedianS` were computed there from the first `FAMILY_SAMPLE_CAP` reached
> trials each worker saw — a prefix of that worker's contiguous cfg slice, not a sample
> of the family. Every trial is on disk, so the correct values are recoverable without
> re-simulating anything. These are those values, over **every** reached trial.

| family | reached trials | returnXVariety (published → corrected) | timeToReturnMedianS (published → corrected) | published sample |
|---|---|---|---|---|
| P1 | 188,254 | 0.6266 → **0.7019** | 1.9625 s → **2.0167 s** | not recorded |
| P2 | 127,212 | 0.9121 → **0.9066** | 0.9750 s → **1.1042 s** | not recorded |
| P3 | 196,639 | 0.8706 → **0.8985** | 1.0375 s → **0.7458 s** | not recorded |
| P4 | 199,996 | 0.9093 → **0.9084** | 0.9125 s → **0.8625 s** | not recorded |
| P5 | 200,000 | 0.9033 → **0.9096** | 0.2042 s → **0.2208 s** | not recorded |

## Uncertainty

- **P1** — returnXVariety 0.7019 (n=188254, uncertainty not established — entropy interval needs measured.js slice 3 (Dirichlet resample of the 32 bin counts)); timeToReturnMedianS 2.0167 (n=188254, uncertainty not established — median interval needs measured.js slice 3 (order-statistic interval))
- **P2** — returnXVariety 0.9066 (n=127212, uncertainty not established — entropy interval needs measured.js slice 3 (Dirichlet resample of the 32 bin counts)); timeToReturnMedianS 1.1042 (n=127212, uncertainty not established — median interval needs measured.js slice 3 (order-statistic interval))
- **P3** — returnXVariety 0.8985 (n=196639, uncertainty not established — entropy interval needs measured.js slice 3 (Dirichlet resample of the 32 bin counts)); timeToReturnMedianS 0.7458 (n=196639, uncertainty not established — median interval needs measured.js slice 3 (order-statistic interval))
- **P4** — returnXVariety 0.9084 (n=199996, uncertainty not established — entropy interval needs measured.js slice 3 (Dirichlet resample of the 32 bin counts)); timeToReturnMedianS 0.8625 (n=199996, uncertainty not established — median interval needs measured.js slice 3 (order-statistic interval))
- **P5** — returnXVariety 0.9096 (n=200000, uncertainty not established — entropy interval needs measured.js slice 3 (Dirichlet resample of the 32 bin counts)); timeToReturnMedianS 0.2208 (n=200000, uncertainty not established — median interval needs measured.js slice 3 (order-statistic interval))
