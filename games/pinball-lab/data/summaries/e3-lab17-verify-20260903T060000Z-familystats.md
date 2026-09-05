# E3 family stats — corrected sample (companion to `data/summaries/e3-lab17-verify-20260903T060000Z.json`)

- **source run**: `data/e3/lab17-verify-20260903T060000Z` · **instrument commit**: `0bc4b55bc413861d199780e5fcc946c6183493aa`
- **generated**: 2026-09-05T20:52:07.919Z

> The published summary is **unchanged and not regenerated**. `returnXVariety` and
> `timeToReturnMedianS` were computed there from the first `FAMILY_SAMPLE_CAP` reached
> trials each worker saw — a prefix of that worker's contiguous cfg slice, not a sample
> of the family. Every trial is on disk, so the correct values are recoverable without
> re-simulating anything. These are those values, over **every** reached trial.

| family | reached trials | returnXVariety (published → corrected) | timeToReturnMedianS (published → corrected) | published sample |
|---|---|---|---|---|
| P1 | 112,789 | 0.8607 → **0.8792** | 2.0250 s → **2.0292 s** | not recorded |

## Uncertainty

- **P1** — returnXVariety 0.8792 (n=112789, uncertainty not established — entropy interval needs measured.js slice 3 (Dirichlet resample of the 32 bin counts)); timeToReturnMedianS 2.0292 (n=112789, uncertainty not established — median interval needs measured.js slice 3 (order-statistic interval))
