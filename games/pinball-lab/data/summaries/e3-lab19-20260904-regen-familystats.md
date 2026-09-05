# E3 family stats — corrected sample (companion to `data/summaries/e3-lab19-20260904-regen.json`)

- **source run**: `data/e3/lab19-20260904-regen` · **instrument commit**: `ba9fe4ee843e685bd45819b044a00af6dcc14f31`
- **generated**: 2026-09-05T20:52:00.123Z

> The published summary is **unchanged and not regenerated**. `returnXVariety` and
> `timeToReturnMedianS` were computed there from the first `FAMILY_SAMPLE_CAP` reached
> trials each worker saw — a prefix of that worker's contiguous cfg slice, not a sample
> of the family. Every trial is on disk, so the correct values are recoverable without
> re-simulating anything. These are those values, over **every** reached trial.

| family | reached trials | returnXVariety (published → corrected) | timeToReturnMedianS (published → corrected) | published sample |
|---|---|---|---|---|
| P1 | 116,954 | 0.4638 → **0.8794** | 1.7875 s → **2.0292 s** | not recorded |
| P2 | 149,296 | 0.9055 → **0.8964** | 1.1042 s → **1.1583 s** | not recorded |
| P3 | 196,201 | 0.8753 → **0.8969** | 0.7542 s → **0.7417 s** | not recorded |
| P4 | 199,997 | 0.9092 → **0.9084** | 0.9875 s → **0.8625 s** | not recorded |
| P5 | 200,000 | 0.8875 → **0.9095** | 0.0583 s → **0.2208 s** | not recorded |

## Uncertainty

- **P1** — returnXVariety 0.8794 (n=116954, uncertainty not established — entropy interval needs measured.js slice 3 (Dirichlet resample of the 32 bin counts)); timeToReturnMedianS 2.0292 (n=116954, uncertainty not established — median interval needs measured.js slice 3 (order-statistic interval))
- **P2** — returnXVariety 0.8964 (n=149296, uncertainty not established — entropy interval needs measured.js slice 3 (Dirichlet resample of the 32 bin counts)); timeToReturnMedianS 1.1583 (n=149296, uncertainty not established — median interval needs measured.js slice 3 (order-statistic interval))
- **P3** — returnXVariety 0.8969 (n=196201, uncertainty not established — entropy interval needs measured.js slice 3 (Dirichlet resample of the 32 bin counts)); timeToReturnMedianS 0.7417 (n=196201, uncertainty not established — median interval needs measured.js slice 3 (order-statistic interval))
- **P4** — returnXVariety 0.9084 (n=199997, uncertainty not established — entropy interval needs measured.js slice 3 (Dirichlet resample of the 32 bin counts)); timeToReturnMedianS 0.8625 (n=199997, uncertainty not established — median interval needs measured.js slice 3 (order-statistic interval))
- **P5** — returnXVariety 0.9095 (n=200000, uncertainty not established — entropy interval needs measured.js slice 3 (Dirichlet resample of the 32 bin counts)); timeToReturnMedianS 0.2208 (n=200000, uncertainty not established — median interval needs measured.js slice 3 (order-statistic interval))
