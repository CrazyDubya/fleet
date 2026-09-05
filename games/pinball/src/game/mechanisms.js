// T4 runtime mechanism state: drop-target banks, F-U-N lamp/lane rotation, spinner decay.
// This is explicitly a STUB standing in for the real rules core (T6) — per the design doc
// §9 T4 row, it only needs to consume switch events and produce provisional scores/lamp
// state for the HUD and debug log. It is not `rules/` and is not held to the physics
// purity contract (`purity.test.mjs` only greps physics/, table/, rules/, save/schema.js).
import { SW_HOPSCOTCH, SW_HOPSCOTCH_COMPLETE, SW_SAND, SW_SAND_COMPLETE, SW_FUN, SW_FUN_COMPLETE } from '../table/switches.js';

const DROP_RESPAWN_S = 3;

/** One bank of drop targets. `targets` is the array of {tag, shape} from table/mechanisms.js. */
export function createDropBank(id, targets, completeTag) {
  return { id, targets, completeTag, dropped: new Set(), respawnAt: null };
}

/** Feed a tick of wall-clock seconds; respawns a completed bank after DROP_RESPAWN_S. */
export function tickDropBank(bank, elapsedS) {
  if (bank.respawnAt !== null && elapsedS >= bank.respawnAt) {
    for (const t of bank.targets) t.shape.active = true;
    bank.dropped.clear();
    bank.respawnAt = null;
  }
}

/**
 * Apply a hit event (by tag) to a bank; returns the list of switch tags fired this hit
 * (the target's own tag, plus the bank-complete tag if this was the last one standing).
 */
export function applyDropHit(bank, tag, elapsedS) {
  const target = bank.targets.find((t) => t.tag === tag);
  if (!target || bank.dropped.has(tag)) return [];
  target.shape.active = false;
  bank.dropped.add(tag);
  const fired = [tag];
  if (bank.dropped.size === bank.targets.length) {
    fired.push(bank.completeTag);
    bank.respawnAt = elapsedS + DROP_RESPAWN_S;
  }
  return fired;
}

export function createHopscotchBank(targets) {
  return createDropBank('hopscotch', targets, SW_HOPSCOTCH_COMPLETE);
}
export function createSandBank(targets) {
  return createDropBank('sand', targets, SW_SAND_COMPLETE);
}

/** F-U-N: one lane is "lit" at a time; flipper presses rotate which; landing the lit lane
 * lights that letter permanently until all three are lit, then the set fires complete and
 * resets. */
export function createFunLamps() {
  return { lit: new Set(), pointer: 0 };
}

export function advanceFunPointer(lamps) {
  lamps.pointer = (lamps.pointer + 1) % SW_FUN.length;
}

/** Returns the switch tags fired: the crossed lane's own tag always, plus fun_complete if
 * this crossing completed the set (and resets the lamps for the next cycle). */
export function applyFunCross(lamps, tag) {
  const fired = [tag];
  const idx = SW_FUN.indexOf(tag);
  if (idx === lamps.pointer) {
    lamps.lit.add(tag);
    if (lamps.lit.size === SW_FUN.length) {
      fired.push(SW_FUN_COMPLETE);
      lamps.lit.clear();
    }
  }
  return fired;
}

/** Spinner: an angular-velocity accumulator, kicked by each crossing and decaying over
 * time — drives both the "clicks" scoring (via the caller counting events) and a visual
 * spin rate for rendering. Not physics — purely cosmetic/scoring bookkeeping. */
export function createSpinner() {
  return { angle: 0, angularVel: 0 };
}

const SPINNER_KICK = 18; // rad/s per crossing
const SPINNER_DECAY = 3.5; // 1/s

export function registerSpinnerHit(spinner) {
  spinner.angularVel += SPINNER_KICK;
}

export function tickSpinner(spinner, dt) {
  spinner.angle += spinner.angularVel * dt;
  spinner.angularVel = Math.max(0, spinner.angularVel - SPINNER_DECAY * spinner.angularVel * dt);
}

/** SANDBOX scoop: captures on entry (physics/world.js pins the ball and reports the
 * capture event), holds it for `delayS`, then the caller ejects it. This module only owns
 * the timer — the actual capture/eject of the ball's pos/vel lives in world.js/main.js,
 * since only physics touches ball state directly. */
const SCOOP_HOLD_S = 1.0;

export function createScoop() {
  return { ejectAt: null, ball: null };
}

// `ball` (T8): which physical ball entered, so the eject can reposition the right one now
// that more than one ball can be in play at once. If a second ball enters the sandbox
// before the first is ejected (only possible during multiball), it overwrites `ball` — the
// scoop holds one ball's worth of state, and a simultaneous second entry is a rare edge case
// the design doc doesn't specifically cover; not worth a queue for T8.
export function armScoop(scoop, elapsedS, ball) {
  scoop.ejectAt = elapsedS + SCOOP_HOLD_S;
  scoop.ball = ball;
}

/** Returns true exactly once, on the tick the hold period elapses. */
export function tickScoop(scoop, elapsedS) {
  if (scoop.ejectAt !== null && elapsedS >= scoop.ejectAt) {
    scoop.ejectAt = null;
    return true;
  }
  return false;
}

// LEFT OUTLANE KICKBACK. Whether the kickback starts lit is a game-design choice, not a
// physics fact — a real table would tie relighting it to a mode or shot, which nothing here
// builds (a future dispatch's call, not invented here). Starting lit is picked because a
// player's very first ball should see it work at least once, matching this project's general
// "make the mechanism demonstrably alive" bias (the same reason DO-OVER's own window opens
// wider on ball 1 — rules/game.js's DO_OVER_FIRST_BALL_S).
const KICKBACK_STARTS_LIT = true;

export function createKickback() {
  return { lit: KICKBACK_STARTS_LIT, usedThisBall: false };
}

/** Called on a genuinely NEW ball (main.js's 'ballServed' display kind) — not on a DO-OVER
 * 'ballSaved', since a DO-OVER is explicitly the SAME ball continuing (rules/game.js's own
 * saveBall doc comment), and "once per ball" means once per that same ball, kickback survives
 * across its own DO-OVER exactly the way its score/mode progress does. Restores `lit` to
 * KICKBACK_STARTS_LIT along with `usedThisBall` — a new ball gets a freshly-armed kickback,
 * same as it always has; only the *within-ball* lit state (below) is new. */
export function resetKickbackForNewBall(kickback) {
  kickback.usedThisBall = false;
  kickback.lit = KICKBACK_STARTS_LIT;
}

/** The actual save decision for one contact: true (and marks `usedThisBall`, clears `lit`) if
 * the kickback is lit and hasn't already fired this ball, so the caller should override the
 * ball's velocity with the kick; false (no state change) if unlit or already used, so the ball
 * is left to its ordinary post-collision velocity and continues toward the drain like any other
 * passive collider contact. Pure decision only — main.js applies the actual velocity, since
 * only physics/main.js touches ball state directly (same boundary as armScoop/tickScoop above).
 *
 * Clearing `lit` on a successful fire (2026-09-05, found by an outside review, reproduced
 * here): main.js chooses the kickback's mesh material from `lit` alone, and before this fix
 * nothing ever cleared it after firing — the mesh kept showing "armed" for the rest of the
 * ball even though `tryKickback` correctly refused every further contact via `usedThisBall`.
 * `usedThisBall` and `lit` were answering two different questions (`has this ball's one use
 * been spent` vs. `is it currently armed`) that happened to only ever agree by coincidence,
 * because nothing kept them in sync. Relighting mid-ball is still explicitly not built (a
 * future dispatch's call, per this file's KICKBACK_STARTS_LIT comment) — `lit` simply reflects
 * reality in the meantime instead of only ever going true->stays-true within a ball. */
export function tryKickback(kickback) {
  if (!kickback.lit || kickback.usedThisBall) return false;
  kickback.usedThisBall = true;
  kickback.lit = false;
  return true;
}

// RAMP DIVERTER (2026-09-05). table/ramps.js's buildDiverter returns `{gate, routeARampId,
// routeBRampId}`; there is no separate diverter "state object" the way createKickback/
// createScoop have one — the current route lives directly on the shared Gate's own
// `gate.toLayer` field, because physics/world.js's tryEnterGate reads that field fresh on
// every crossing. Mutating it here is the entire mechanism: the same "game layer mutates a
// field on the shared physics-owned object" pattern this file's own drop-target `.active`
// flag already uses (applyDropHit above), not a new kind of boundary.
export function setDiverterRoute(diverter, route) {
  if (route !== 'A' && route !== 'B') {
    throw new RangeError(`setDiverterRoute: route must be 'A' or 'B', got ${JSON.stringify(route)}`);
  }
  // physics/shapes.js's Gate(a, b, tag, meta) nests the routing metadata one level deep as
  // `.gate` on the Zone it returns — `diverter.gate` IS that Zone/Gate object, so the field
  // tryEnterGate actually reads is `diverter.gate.gate.toLayer`, not `diverter.gate.toLayer`.
  // Caught by this function's own test: writing the wrong path silently added a stray
  // `toLayer` property on the Zone object instead of ever touching the one physics reads, so
  // every "switch to B" call had no effect at all — exactly the class of bug this whole day
  // has been about (bad state, nothing checking it).
  diverter.gate.gate.toLayer = route === 'A' ? diverter.routeARampId : diverter.routeBRampId;
}

/** The diverter's current route, read back from the same field setDiverterRoute writes —
 * never tracked separately, so this can never drift out of sync with what a ball entering
 * right now would actually get routed to.
 *
 * Found by an outside review (2026-09-05), confirmed real: this used to be a plain
 * `=== routeARampId ? 'A' : 'B'` ternary, which means ANY other value — routeBRampId, yes, but
 * also undefined, null, or a corrupted/typo'd ramp id from some future bug — silently read as
 * a perfectly normal route B. A corrupt value must be distinguishable from a real one, not
 * quietly promoted to it. Now explicitly checks against both known values and throws on
 * anything else, the same "loud, not silent" standard this project settled on for recess.js's
 * degenerate-joint guard earlier today. */
export function currentDiverterRoute(diverter) {
  const toLayer = diverter.gate.gate.toLayer;
  if (toLayer === diverter.routeARampId) return 'A';
  if (toLayer === diverter.routeBRampId) return 'B';
  throw new Error(
    `currentDiverterRoute: diverter.gate.gate.toLayer is ${JSON.stringify(toLayer)}, which is ` +
    `neither routeARampId (${JSON.stringify(diverter.routeARampId)}) nor routeBRampId ` +
    `(${JSON.stringify(diverter.routeBRampId)}) — the diverter's routing state is corrupt.`
  );
}
