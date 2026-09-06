# The scenario harness

`src/scenarios.js` runs named, data-driven trials against the real game code — physics
(`games/pinball/src/physics`, `table`) or rules (`games/pinball/src/rules`) — headless, at a
fixed timestep, so the same call from `node --test` and from the sandbox UI gives
byte-identical results. Read this before writing a scenario, not after — it exists so the
next person picks the right kind of scenario rather than the first one they find, or writes a
new scenario kind for a bug this harness was never going to be able to stage.

## What it stages, by kind

Each kind answers a different question. Picking the wrong one gets you an answer to a
question you didn't ask.

- **`sandbox-table`** — real balls on the real table (`buildTable`/`wireTable`, the same
  assembly both main.js files use), driving a real mechanism's own capture/eject logic
  exactly as main.js's frame loop does. Answers: *what happens physically when N balls hit
  this mechanism in this timing?*
- **`channel`** — a small, purpose-built physics geometry (two walls + an arc backstop), not
  the real table. Answers: *does this shape of collider contain or leak a ball at this speed,
  and is the boundary monotonic?* Use when the question is about geometry in isolation, not
  about a specific table mechanism.
- **`ramp-reachability`** — fires a ball at a ramp's own real exit point/direction/speed
  (read live from `table/ramps.js`, never a copied constant) and sweeps small position/angle/
  speed perturbations against a real flipper. Answers: *can a flipper actually reach what this
  ramp's exit sends it?* — a shot-geometry question, not a rules question.
- **`rules-sequence`** — drives a fresh `rules/game.js` game through a sequence of steps
  (`events`, `tilt`, `launchBall`), entirely through its own exported functions, reporting
  display events and chosen state reads after each step. Answers: *what did the rules layer
  do, in this order?* — the only kind that can see a flag surviving a boundary it shouldn't,
  or a same-tick ordering race between two rules calls. No physics engine can see this class
  of bug; a `sandbox-table` or `channel` scenario never will either.
- **`kickback-sequence`** — drives `game/mechanisms.js`'s kickback functions
  (`createKickback`/`resetKickbackForNewBall`/`tryKickback`) directly. Exists because that
  state lives OUTSIDE `rulesState` — main.js owns it as a sibling object and calls it off a
  physics tag directly, never through `rules/game.js`. If a future bug turns out to live in
  some other main.js-owned mechanism state (the scoop, the trough, a lock) that isn't reachable
  through `rules/game.js` either, this is the pattern to copy: a small kind driving that
  mechanism's own exported functions directly, not a stretch of `rules-sequence`.

Two cross-cutting tools sit on top of any kind: `runScenarioGrid` sweeps a scenario across a
parameter matrix and summarizes its shape (monotonic vs. islands); `runScenarioNullTest`
checks whether a grid's own summary statistic is actually responding to structure, or would
look the same on randomly relabeled data. Neither is a scenario kind — both just call
`runScenario` repeatedly.

## What it cannot stage

**Anything with no rules or physics state to drive.** This is the limit that matters more
than the capability list above, because it's the one someone will assume away.

The moment-screen bug found today (a bonus-breakdown overlay outliving the ball it describes)
is the concrete example: it lives entirely in `main.js`/`ui/moment-screen.js`'s own DOM/timer
bookkeeping. There is no `rulesState` field, no physics body, nothing this harness's headless
world touches, involved anywhere in that bug. Writing a new scenario kind would not close
that gap — a kind can only drive functions that exist and touch state that exists, and
neither exists here. That bug's home is a plain, dedicated unit test in
`games/pinball/test/moment-screen.test.mjs`, which is where it correctly lives.

The general rule this generalizes to: before reaching for this harness, ask what state the
bug actually lives in. `rulesState` (via `rules/game.js`'s exports) → `rules-sequence`. A
physics body → `sandbox-table`/`channel`/`ramp-reachability`. Some other main.js-owned
mechanism object with its own exported functions → a new kind shaped like
`kickback-sequence`. Pure UI/DOM/timer state with no rules or physics counterpart → this
harness is the wrong tool; write the unit test where that code already lives.

## The one discipline that makes any of this trustworthy

**A scenario must reproduce the real conditions, not something adjacent — and if the real
conditions can't be established without breaking the harness's own rules, that's a reason to
say so, not to approximate.**

Concretely, twice today:

- `fieldday-lone-ball-drain` reaches FIELD DAY by actually completing all 4 modes through
  their own real completion paths (a real 4-shot KICKBALL sequence, a real 20-pop DODGEBALL
  loop, two real timeouts) — never the direct-write shortcut
  (`games/pinball/test/field-day.test.mjs`'s own `forceStartMode`) the hand-written test uses
  for speed. `rules-sequence`'s own contract (driven entirely through `rules/game.js`'s public
  functions, never a direct `rulesState` write) isn't a style preference; it's what makes a
  passing scenario mean the bug is actually fixed under real conditions, not just under
  conditions convenient to construct.
- A HANG TIME `bonusX` write-site guard was a real candidate for a third scenario today, and
  got declined: under the current code, the real trigger condition (a MONKEY BARS hit landing
  during FIELD DAY) is already intercepted by an earlier guard, so there's no way to reach it
  through `rules/game.js`'s real event surface without writing `rulesState` directly to fake
  past that guard. Declined, with the reason recorded, rather than staged against a condition
  that isn't the real one.

The `ramp-reachability` scenarios hold the same line from the other direction: each pins an
already-published figure (an 81-sample sweep's exact contact count, already measured and
committed as a comment or a test) rather than a fresh guess at what the number should be.

A scenario that quietly approximates its own preconditions can pass while proving nothing.
That's the failure mode this discipline exists to rule out — and the reason a green run here
is worth trusting.
