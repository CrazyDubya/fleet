# LAB-19 — apron-right graze confirmation + cross-family FLIPPER_ZONE_Y measurement-line audit

- **Scope**: opus2's LAB-19 spec (`ledger/handoffs/opus2/20260903T222942Z-lab19-spec-and-e3lab5-disposition.md`)
  Slice 1 (confirm the apron-right graze mechanism via `runTrialWithMeta`, not a hand-rolled
  loop) and Slice 3 (the cross-family measurement-line audit). Slice 2 (closed-form transition
  prediction) and the P5 grid question are **not** covered by this report.
- **Instrument change**: one additive hook, `opts.onEvent`, added to `runE3Trial` in
  `src/instrument.js`, called with each substep's raw contact events when a caller supplies it
  — identical in shape and intent to the existing `opts.onStep` hook. **No other line in
  `instrument.js` changed.** `FLIPPER_ZONE_Y` (0.20, `arenas/e3_paths.js:68`) is untouched.
  Every production caller (`e3Worker.js`, `stageAWorker.js`, `worker.js`, `profile.js`) calls
  `runTrialWithMeta(cfg, seed)` with no `opts` — `opts?.onEvent` is `undefined` there, so this
  hook has zero effect on any trial, record, shard, or metric this repo has ever produced. Only
  `replay.js` and this dispatch's probe scripts pass `opts`.

## What the instrument does (recorded, not redesigned)

`FLIPPER_ZONE_Y = 0.20` is a **single constant**, shared identically by all five E3 families
(P1-P5) through one crossing check in `runE3Trial` (`instrument.js:836`:
`if (prevY > FLIPPER_ZONE_Y && ball.pos.y <= FLIPPER_ZONE_Y)`). There is no per-family
measurement line, and no code path overrides it — checked by reading every family's builder in
`arenas/e3_paths.js` and finding exactly one `FLIPPER_ZONE_Y` export, one `LAUNCH_BAND` (which
reuses it), and no other `_Y` constant playing this role anywhere in `instrument.js`,
`e3Worker.js`, `stageAWorker.js`, or `worker.js`.

So "cross-family measurement-line audit" is not a search for multiple lines — there is one.
It is a question about whether that one shared line sits at a **comparable physical location**
relative to each family's very different geometry (P1's launch lane, P2's orbit, P3's return
lanes, P4's ramp mouth, P5's habitrail drop), since all five share the same apron/drain shell
(`buildSharedWalls()`) whose funnel flank runs from `y=0.12` to `y=0.30` — straddling the
`y=0.20` measurement line for every family alike.

## Slice 1 — apron-right graze, confirmed through `runTrialWithMeta`, real grid cfgIds

opus2's design-lane probes used a hand-rolled step loop and an illustrative point
(`dropSpeed=1.25`) that is not a value in the committed P5 grid (`{0.5, 1.0, 1.5, 2.0, 2.5}`).
Re-run through the real production path (`runTrialWithMeta` + the new `onEvent` hook) at the
**closest real committed cfgIds**, 1500 trials/cfg:

**`dropY=0.45, dropSpeed=1.5, dropDirectionDeg=320`** (closest real grid point to opus2's
illustrative one):

| cfgId | dropX | medianXs (m/s) | zero-contact | one-contact | multi-contact | contact tag = apron* | median contact y |
|---|---|---|---|---|---|---|---|
| `638bb862` | -0.12 | 1.638 | 1499/1500 | 1 | 0 | 1/1 | 0.192 |
| `f1b84355` | -0.06 | 1.544 | 887/1500 | 613 | 0 | 613/613 | 0.207 |
| `c7dbb09a` | 0 | 1.017 | 3/1500 | 1497 | 0 | 1497/1497 | 0.235 |
| `eba9756c` | 0.06 | 1.045 | 0/1500 | 1500 | 0 | 1299/1500 | 0.283 |
| `d881143f` | 0.12 | 1.241 | 0/1500 | 1500 | 0 | 2/1500 | 0.339 |

Two more real grid points (same dropY/direction, dropSpeed=1.0; same dropSpeed/direction,
dropY=0.35) reproduce the same shape — a clean/fast plateau, a transition where median speed
drops as contact appears, then partial recovery — confirming this is not specific to one cfg.
Full tables in `scratchpad/lab19-slice1.mjs`'s run log.

**Confirmed, via the real trial path and real grid cfgs, not a hand-rolled loop:**
- **`multi-contact` is 0 in every row, at every cfg tested** — matches opus2's "never more than
  one contact per trial" finding exactly.
- Where a contact occurs, it is the `apron-right` (or an adjacent `right`-side) segment on the
  overwhelming majority of contacted trials — 1497/1497, 613/613, 1/1 at three of the five
  points. **One real nuance opus2's illustrative point didn't surface**: at the far-right
  `dropX=0.06`, 201/1500 one-contact trials are NOT tagged `apron*` (1299/1500 are), and at
  `dropX=0.12` almost none are (2/1500) — the median contact height there is 0.339, **above**
  `APRON_TOP_Y=0.30`, meaning the ball is grazing the vertical `right` side wall above the
  apron funnel, not the apron flank itself. Same general mechanism (a wall graze near the
  measurement line), different specific primitive at the grid's extreme.
- Median contact y clusters in **0.19-0.34** across all rows — straddling `FLIPPER_ZONE_Y=0.20`
  exactly as opus2 found, confirming the line sits inside, not below, the graze region.

**Not reproducible from the real grid as specified**: opus2's mirror-symmetry discriminator
(320° vs 220°) has no exact partner in the committed grid. The P5 grid's six
`dropDirectionDeg` values are `{200, 230, 260, 290, 320, 350}`; mirroring any one of them about
the downward axis (`540 - x mod 360`) never lands on another grid value (320's mirror is 220;
none of the six equal 220). Reported honestly as a gap rather than approximated with a
non-mirror pair that would misrepresent what was actually checked.

## Slice 3 — cross-family measurement-line audit

**Why this needed a parallel loop, not `runTrialWithMeta` as-is.** Production's own trial stops
the instant the ball crosses `y=0.20` (`term='reached'`) — no `xs`/`xx` past that point exists
in any record, banked or fresh. Answering "what would `inBandFraction` be if the line were
`y=0.10` instead" requires the trial to keep running past where production stops. I wrote a
separate script (`scratchpad/lab19-slice3.mjs`, not committed, not a change to `instrument.js`)
that reproduces `runE3Trial`'s exact injection sampling (same rng draw order, verified) and
physics step order using the same exported `buildWorld`/`rngForTrial`/`advance`, but does not
terminate at `y=0.20` — it records the first crossing of **both** `y=0.20` (production's real
line) and `y=0.10` (the counterfactual), plus the last wall contact before the first, then lets
the trial run to its actual terminal condition (drain/stall/timeout/escaped/nan).

**Fidelity check, before trusting anything from it**: for 30 cfgs/family x 3 seeds (450 checks
total), this parallel loop's crossing at `y=0.20` matched production's own `term`/`xx`/`xs`
**exactly** (0 mismatches, all 5 families) — same pattern opus2's own solver probes and the
pinball solver.js fix's instrumented-copy check both used before trusting a parallel
implementation.

**Method per family**: sampled cfgs (60/family, 120 for P5 given its larger 600-cfg grid),
800-1500 trials/cfg (P1 needed 1500 to get a stable read — see below), each seed 0..N-1 exactly
as production would run it.

- **Exposure**: fraction of `reached` trials (at y=0.20) whose last wall contact occurred at
  y in [0.20, 0.30] — one apron-height above the line.
- **Δ inBandFraction**: `inBandFraction` at y=0.10 minus at y=0.20, on the *same* trials
  (`inBandFraction`'s real definition, confirmed by reading `e3Worker.js:66`:
  `record.xs >= 1.0 && record.xs <= 2.5`).
- **Spearman ρ**: rank correlation between each family's own cfgs' `inBandFraction` at y=0.20
  vs. at y=0.10 — "does the line change WHICH cfgs look best", not just the raw fraction.

| family | exposure | Δ inBandFraction | Spearman ρ | verdict |
|---|---|---|---|---|
| P1 | 4.9% | +0.017 | **0.28** | **FRAGILE** — but see note below, this is not primarily a line effect |
| P2 | 19.4% | +0.070 | 0.90 | borderline (right at the threshold) |
| P3 | 50.0% | +0.017 | **0.99** | **ROBUST** |
| P4 | 16.3% | +0.037 | 0.89 | borderline (just under) |
| P5 | 18.1% | +0.003 | 0.89 | borderline (just under; the mean delta itself is negligible) |

**The P1 number needs its own explanation, not just its own row.** P1's exposure and mean
delta are the *smallest* of the five families — a naive read would expect the *most* robust
ranking, not the least. Inspecting the actual per-cfg values (not just the summary statistic)
shows why: P1's `inBandFraction` at y=0.20 is already saturated near a ceiling for most reached
cfgs in the sample (values like 0.997, 0.999, 1.000, 1.000, 1.000 cluster tightly at the top,
consistent with the LAB-16/17/18-documented "P1 is already near a ranking ceiling" finding —
`meta.json`'s own P1 `inBandFraction: 0.894` is the family average). When most cfgs sit within
a few thousandths of each other at a ceiling, an unrelated, tiny, noise-level shift — the
measurement line, more trials, a different random seed range — reorders them completely; a
Spearman ρ near 0 here reflects a **pre-existing near-degenerate metric**, not a large physical
line-dependence. P1's ranking was already fragile before this audit; the line choice is one
more thing it can't survive, not the primary cause. **This does not contradict, and directly
reinforces, LAB-16/17/18's own repeated finding that `inBandFraction` breaks down for P1 near a
ceiling.**

**P3, by contrast, is the cleanest case for the opposite reading**: half its reached trials are
exposed to a contact right at the line, and yet its ranking survives near-perfectly (ρ=0.99) —
because its `inBandFraction` values are NOT clustered at a ceiling; the line's effect shifts
every cfg's fraction by roughly the same amount, which preserves rank order even under high
exposure. Exposure alone does not predict fragility; **exposure combined with a metric that's
already near a ceiling or floor does.**

## Is the LAB-19 cross-family comparison valid? Stated plainly, as asked

**Not uniformly, no — and the reason is not the one that would be easiest to write down.**

- **P3's ranking is robust to the measurement line (ρ=0.99).** Its committed conclusions stand
  without qualification on this axis.
- **P1's ranking is not robust (ρ=0.28), but the cause is P1's own pre-existing ceiling
  saturation, already flagged by three prior LAB dispatches, not a new discovery about the
  line.** Any `inBandFraction`-based ranking or cross-family comparison involving P1 should
  already be read with that caveat attached (LAB-16/17/18's own guard partially addresses this
  at the top-10-ranking level) — this audit adds that the line choice is one more axis that
  ceiling makes it sensitive to, not a new failure mode to fix separately.
- **P2, P4, and P5 sit right at the ρ≈0.89-0.90 boundary** — close enough to the 0.9 threshold
  that I do not think a single number here should be read as a clean pass or fail for any of
  them; a somewhat larger or smaller sample could plausibly land on either side (I re-ran P1 at
  3x the trial count and P5 at 2x the cfg count and trial count specifically to check this kind
  of instability; P1's ρ stayed low (0.28) across both trial counts, indicating a real effect,
  while P5's moved from 0.84 to 0.89 as the sample grew, indicating the smaller sample WAS
  noisy). **I would not treat any P2/P4/P5 `inBandFraction` ranking difference smaller than
  roughly its own Δ inBandFraction (0.04-0.07) as decisively meaningful without checking it's
  stable at y=0.20 specifically** — a genuinely borderline verdict, not a rounding of "robust"
  or "fragile" to fit a clean table.

**Net**: I would not retract any specific already-published LAB-19 number outright, but I would
not treat cross-family `inBandFraction` comparisons involving P1, P2, P4, or P5 as
line-independent facts either — only P3's ranking earns that. This is a real, if partial,
qualification of the LAB-19 combined report's validity, not a clean "the comparisons hold" or
"the comparisons don't hold."

## Explicitly not done in this dispatch

- No change to `FLIPPER_ZONE_Y`, any arena builder, or any production metric computation.
- Slice 2 (the closed-form transition prediction) — not attempted; scope was Slice 1 + Slice 3
  per this dispatch's `@done`.
- No re-run of the full LAB-19 grid at either measurement line — this used a sampled subset per
  family (documented above), not the full 1,303-cfg / 1,000,000-trial corpus.
- `games/pinball/**` was not touched this dispatch.

## An unrelated cross-project finding, surfaced incidentally

Running `node --test test/*.mjs` in `games/pinball-lab/` to confirm the `onEvent` addition was
safe (81/82 pass) turned up one pre-existing failure, **unrelated to this dispatch's own
change**: `test/instrument.test.mjs`'s `"cradle: a heldActive/cradle trial reports cr/st/bn"`
test now gets `term='timeout'` where it expects `'stall'`. Verified this is caused by the
`games/pinball` solver.js fix committed earlier this session (`e5ff0d7`), not by anything in
this dispatch: reverting solver.js to its pre-fix state (with my `onEvent` change still
present) makes the test pass again; the current solver.js plus the `onEvent` addition
reproduces the failure. `games/pinball-lab` imports `games/pinball/src/physics/*` directly, so
a physics-engine fix in one project silently changes trial outcomes in the other. Not
investigated further or fixed — out of scope for a measurement dispatch that was explicitly
told not to touch `games/pinball/**`, and it's a judgment call (is the E1 cradle test's
`'stall'` expectation or the new physics behavior "correct" now?) that belongs to whoever owns
that test, not to this report. Flagging it here so it isn't silently absorbed as "LAB-19
touched something" when it didn't.

## Verification

- `node --test test/*.mjs` in `games/pinball-lab/`: 81/82 pass (the one failure is the
  cross-project item above, confirmed unrelated to this dispatch's `onEvent` change by
  reverting/restoring solver.js independently of it).
- Fidelity check (parallel loop vs. `runTrialWithMeta`): 0 mismatches across 450 (cfg, seed)
  pairs, all 5 families.
- Slice 1 and Slice 3 numbers above were each run at least twice at increasing sample size to
  check stability before being reported (P1 at 300 and 1500 trials/cfg gave ρ=0.17 and 0.28 —
  same qualitative conclusion, reported the larger; P5 at 300 trials/60 cfgs and 800 trials/120
  cfgs gave ρ=0.84 and 0.89 — reported the larger, and noted the instability explicitly above
  rather than picking whichever number read cleaner).

## Delegation

None. Every step chose the next probe from the previous one's result (the P1 ceiling
explanation only became visible after dumping raw per-cfg rows, which only became necessary
once the summary Spearman number looked contradictory) — the same shape of work prior LAB
dispatches (LAB-16/17/18, opus2's own LAB-19 design lane) each correctly ran directly rather
than fanning out. `haiku-fs2` was not attempted this cycle — opus2's own LAB-19 spec already
recorded that it cannot see `games/pinball-lab/**` from its project root as of this cycle.

Scratch scripts (outside the repo's data, nothing committed from them):
`scratchpad/lab19-slice1.mjs`, `scratchpad/lab19-slice3.mjs` (+ `-p1check`/`-p5check`/`-inspect`
variants used only to check sample-size stability).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Mc9nxoZy3PNEDmhhpwovyx
