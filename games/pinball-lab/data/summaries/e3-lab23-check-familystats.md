# E3 family stats — corrected sample (companion to `data/summaries/e3-lab23-check.json`)

- **source run**: `data/e3/lab23-check` · **instrument commit**: `a2ac4a737d060efb7bab78febb569ef29d78f2de`
- **generated**: 2026-09-05T20:52:07.558Z

> The published summary is **unchanged and not regenerated**. `returnXVariety` and
> `timeToReturnMedianS` were computed there from the first `FAMILY_SAMPLE_CAP` reached
> trials each worker saw — a prefix of that worker's contiguous cfg slice, not a sample
> of the family. Every trial is on disk, so the correct values are recoverable without
> re-simulating anything. These are those values, over **every** reached trial.

| family | reached trials | returnXVariety (published → corrected) | timeToReturnMedianS (published → corrected) | published sample |
|---|---|---|---|---|
| P1 | 584,815 | 0.4614 → **0.8796** | 1.7479 s → **2.0292 s** | not recorded |
| P2 | 748,030 | 0.9081 → **0.8964** | 1.0792 s → **1.1583 s** | not recorded |
| P3 | 980,605 | 0.8756 → **0.8970** | 0.7542 s → **0.7417 s** | not recorded |
| P4 | 999,977 | 0.9092 → **0.9083** | 0.9750 s → **0.8625 s** | not recorded |
| P5 | 1,000,000 | 0.8688 → **0.9095** | 0.1000 s → **0.2208 s** | not recorded |

## Uncertainty

- **P1** — returnXVariety 0.8796 (n=584815, uncertainty not established — entropy interval needs measured.js slice 3 (Dirichlet resample of the 32 bin counts)); timeToReturnMedianS 2.0292 (n=584815, uncertainty not established — median interval needs measured.js slice 3 (order-statistic interval))
- **P2** — returnXVariety 0.8964 (n=748030, uncertainty not established — entropy interval needs measured.js slice 3 (Dirichlet resample of the 32 bin counts)); timeToReturnMedianS 1.1583 (n=748030, uncertainty not established — median interval needs measured.js slice 3 (order-statistic interval))
- **P3** — returnXVariety 0.8970 (n=980605, uncertainty not established — entropy interval needs measured.js slice 3 (Dirichlet resample of the 32 bin counts)); timeToReturnMedianS 0.7417 (n=980605, uncertainty not established — median interval needs measured.js slice 3 (order-statistic interval))
- **P4** — returnXVariety 0.9083 (n=999977, uncertainty not established — entropy interval needs measured.js slice 3 (Dirichlet resample of the 32 bin counts)); timeToReturnMedianS 0.8625 (n=999977, uncertainty not established — median interval needs measured.js slice 3 (order-statistic interval))
- **P5** — returnXVariety 0.9095 (n=1000000, uncertainty not established — entropy interval needs measured.js slice 3 (Dirichlet resample of the 32 bin counts)); timeToReturnMedianS 0.2208 (n=1000000, uncertainty not established — median interval needs measured.js slice 3 (order-statistic interval))
