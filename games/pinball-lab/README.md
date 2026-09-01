# PINBALL LAB

A headless experimental harness for `games/pinball`'s physics solver. It **imports**
`games/pinball/src/physics/*` — same 240 Hz swept solver, same constants, same seeded RNG —
and never copies it, so results transfer to the game. See
`ledger/handoffs/opus2/20260901T031204Z-pinball-lab-program.md` for the full program spec;
this README is "how to run it", not a restatement of the contract.

## Status: LAB-1 (E1 harness + 10k-trial pilot)

E1 ("flippers only") is built and piloted. E2 (bumpers) and E3 (paths) are specified in the
program handoff but not yet built — `instrument.js`'s `buildWorld`/`runTrial` dispatch on
`cfg.exp` and currently only handle `'e1'`.

**This is a pilot, not the full sweep.** One fixed geometry (RECESS's current live flipper
constants) × the three actuation-policy families, ~10,000 trials total — enough to prove
every piece of the harness and every §3.4 record column works, not to characterise the
flipper transfer function. That full characterisation (the geometry × policy Stage A/B sweep,
1,000,000 trials, the binned transfer function, fan width, timing sensitivity, Pareto front)
is LAB-2.

## Running it

```bash
# Profile first (always, before a real sweep) — µs/step, trials/s, projected 1e6 wall-clock.
node src/profile.js --exp e1 --trials 2000

# Regenerate the pilot cfg list (deterministic; only needed if sweep.js's PILOT_* changes).
node src/sweep.js --exp e1 --grid pilot --out cfgs/e1-pilot.json

# Run the pilot: 10,000 trials split across the 12 pilot cfgs, sharded across worker_threads.
node src/runner.js --exp e1 --cfgs cfgs/e1-pilot.json --trials 10000 --out data/e1/pilot-01

# Aggregate: shards -> data/summaries/e1-pilot-01.{json,md}
node src/aggregate.js --exp e1 --run pilot-01

# Replay any single trial by (cfgId, seed) — reproduces it exactly. --trace adds a
# per-substep line (t, pos, vel, both flippers' angle/ω, contact count).
node src/replay.js --exp e1 --cfg <cfgId> --seed <n> [--trace]

# Run just one cfg at a larger trial count (e.g. for LAB-2's Stage B):
node src/runner.js --exp e1 --cfg-index 3 --cfgs cfgs/e1-pilot.json --trials 1000000 --out data/e1/run-02
```

Every command's final stdout line is a single-line JSON object with `"ok"` and exits non-zero
on failure — the CLI contract a crank (haiku) thread runs against without judgement.

## Determinism and replay

A trial is fully determined by `(cfgId, seed)`: `src/seed.js`'s `seededRng(hash(cfgId) ^
seed)`, nothing else. **Not** the game's `physics/rng.js` `makeRng` directly — LAB-1's pilot
used that and every trial in a cfg sampled the *same ball*, because `makeRng` only seeds one
of its four xorshift words; see `seed.js`'s header comment and §2.4a of the program handoff.
`cfgId` is the first 8 hex of a sha256 over the cfg's sorted-key JSON (`src/sweep.js`),
recorded in every `meta.json` next to the full cfg — a summary row is always traceable back
to its exact parameters, and `replay.js --cfg <id> --seed <n>` reproduces it bit-for-bit.

## Ensemble validity (§2.4a)

Determinism alone doesn't prove a run's trials actually differ from each other — LAB-1's
pilot was fully deterministic *and* completely degenerate. Every `runner.js` invocation now
also computes the sd of each sampled inbound quantity across a cfg's whole trial count and
fails loudly (non-zero exit, no shard silently treated as good data) if any falls below half
its theoretical Uniform(lo,hi) sd, and separately requires the `never`-policy baseline to
touch a flipper in more than 30% of trials — an E1 arena/injection band that never reaches a
flipper is measuring drains, not flippers. Both numbers are reported in every summary's
header (`ensembleInboundSds`/`neverBaselineContactRate` in `meta.json`) so a reader can see
the ensemble was real without opening a shard.

## Validity flags (§2.7)

Every record's `f` field is a bitmask: `1` IMPACTS_EXHAUSTED (the solver hit `MAX_IMPACTS`
resolving contacts this substep — a model artifact, not a measurement), `2` ESCAPED (outside
the arena's bounding box — a tunneling bug in the solver, reported immediately, not filed),
`4` TIMEOUT, `8` STALLED, `16` NAN. **A cfg whose flagged fraction exceeds 1% is called out
explicitly in the Markdown summary rather than folded into the ranking** — see
`data/summaries/e1-pilot-01.md`'s "Validity warning" section for a live example (one pilot
cfg, `proximity R=0.07 L=0`, is 100% `IMPACTS_EXHAUSTED` — a real, explained finding: firing
the flipper the instant the ball is already at the pivot saturates the impact budget the same
way the RECESS P0 merry-go-round bug did).

## Layout

```
src/instrument.js       buildWorld(cfg) / runTrial(cfg, seed) -> record. The only file that
                        steps a trial against games/pinball/src/physics/*.
src/arenas/e1_flippers.js   the E1 arena (walls + two real flippers) + the ω(t) profiles.
src/policy.js           flipper actuation policies: never / fixedDelay / proximity.
src/sweep.js            cfgId hashing, grid expansion, the committed pilot cfg list.
src/metrics.js          pure stats: mean/sd/percentile/fanWidth/histogram/entropy/tally.
src/profile.js          µs/step, trials/s, projected 1e6 wall-clock. Run before every sweep.
src/runner.js           CLI + worker_threads pool -> gzipped JSONL shards + meta.json.
src/worker.js           one (cfg, seed range) shard, run by runner.js in a worker thread.
src/aggregate.js        shards -> data/summaries/<exp>-<runId>.{json,md}.
src/replay.js           reproduce one trial by (cfgId, seed), optionally with a step trace.
cfgs/                   committed cfg lists (JSON), e.g. e1-pilot.json.
data/e1/<runId>/        gitignored: meta.json + gzipped shards.
data/summaries/         committed: the Markdown/JSON summaries every run produces.
```

## The one instrument change

`games/pinball/src/physics/flipper.js`'s `updateFlipper` gained an optional
`flipper.omegaProfile(u)` hook (`u` = fraction of the up-stroke's *duration* elapsed, not
fraction of angle covered — see the function's own comment for why a position-based `u`
doesn't work for a profile that tapers toward 0). Undefined (every flipper RECESS itself
builds) is bit-identical to before the hook existed — verified by running the full 10k-trial
pilot against both the pre- and post-change instrument and diffing the decompressed shards
byte-for-byte (see the LAB-1 handoff for the exact byte counts). `test/omegaProfile.test.mjs`
exercises all four profiles (`constant`/`easeOut`/`easeIn`/`sCurve`) directly against the
real `updateFlipper`.
