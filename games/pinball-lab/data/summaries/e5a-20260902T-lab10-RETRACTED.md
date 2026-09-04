# E5a (LAB-10) — RETRACTED, 2026-09-04

`e5a-20260902T-lab10.{json,md}` has been removed (`git rm`, recoverable in git history).

## Why

opus2's solver-fix audit (`ledger/handoffs/opus2/20260904T130000Z-lab-corpus-solver-fix-
audit.md`) found E5a is built on `data/e4/e5a-20260902T125754Z`, a raw run against the E4
arena as it stood *before* the `e5ff0d7` kinematic-flipper solver fix — 99.89% of that arena's
trials differ under the fixed solver. E5a's per-assembly `hsS`/shot-rate curve and its
GEOMETRY/MODEL verdict rest entirely on that pre-fix data.

## Disposition

**Retracted, not regenerated.** A fresh E5a run needs a fresh E4 assembly grid (E5a's cfgs are
drawn from E4's `E4_W1_GRID`/Stage-B/Stage-C winners), and E4 itself is currently blocked from
regeneration at HEAD — see `ledger/handoffs/sonnet2/20260904T*-lab-corpus-regen-blocked.md` for
why (the `§2.7` flag gate, added after E4's original run, now hard-rejects the same command
that produced it). Re-running E5a against a still-pre-fix E4 arena would just repeat the
mistake with a new timestamp.

**E5a must be re-run as a new experiment once E4 has a valid post-fix arena to draw its
assembly grid from** — not refreshed in place. This is not a data refresh; the input arena
itself needs to exist first.
