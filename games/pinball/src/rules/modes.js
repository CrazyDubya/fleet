// Modes, skill shot and the RECESS METER — design doc §4.4/§9 T7 row — plus the four
// cross-mechanism linkages deferred from T6 (see rules/game.js's T6 handoff): bank
// completion lighting a jackpot shot instead of paying flat, MONKEY BARS' every-3rd HANG
// TIME off the seeded PRNG, TETHERBALL/SLIDE combo multipliers that decay, and DODGEBALL
// lighting at 25 pop hits. All of it belongs here per the T7 dispatch, alongside modes.
//
// Purity: same contract as the rest of rules/ — no threejs/DOM/Date.now/Math.random. The
// only randomness is the seeded PRNG from physics/rng.js, and every timer takes the
// caller-supplied `atS` rather than reading a clock, so mode tests stay deterministic.
import { makeRng, pick } from '../physics/rng.js';
import {
  SW_FUN,
  SW_SLIDE_EXIT, SW_MONKEYBARS_EXIT, SW_TUNNEL_EXIT, SW_SANDBOX_ENTRY, SW_ORBIT_EXIT,
  SW_TETHERBALL_SPIN,
} from '../table/switches.js';

// The five §4.3 "shots" a mode cares about are the same four used for the RECESS BELL's
// shots term, in a fixed order: KICKBALL's four bases map onto them 1:1, and HIDE & SEEK
// hides among them.
export const MODE_SHOT_TAGS = [SW_SLIDE_EXIT, SW_MONKEYBARS_EXIT, SW_TUNNEL_EXIT, SW_SANDBOX_ENTRY];

export const MODE_DURATION_S = 40; // "each ~40 s" (§4.4)
const DODGEBALL_TARGET_HITS = 20;
const DODGEBALL_LIGHT_EVERY = 25; // "Every 25 hits lights DODGEBALL at the SANDBOX" (§4.4)
const COMBO_DECAY_S = 8; // "decays after 8 s without a slide" (§4.4); applied to the tunnel/tetherball combo too, by the same reasoning
const JUMP_ROPE_STALL_S = 4; // "Ends when the spinner stops for 4 s" (§4.4)
const JUMP_ROPE_TIME_PER_REV_S = 1;
const JUMP_ROPE_MAX_MULT = 50; // was 10 — §4.4 ratified 50 ("Double Dutch" needs it; a 10x
  // cap made an achievement the design doc itself already wrote unreachable, per opus2's
  // 20260830T024139Z-pinball-design.md ~line 741).
const JUMP_ROPE_MULT_PER_REV = 0.5; // was an inline 0.1 in onJumpRopeSpin. Retuned alongside
  // the 50x cap: at 0.1/rev, reaching 50x needs 490 revs, which — combined with JUMP_ROPE's
  // own timing floor (remainingS only grows 1s/rev, so sustaining the mode at all needs >=1
  // rev/sec) — is ~8.2 minutes of gapless play on a bare open-field crossing zone with no
  // loop geometry backing a real continuous spin (see buildSpinners() in table/mechanisms.js).
  // Not "hard but reachable" per §4.4's own phrase. At 0.5/rev, the cap needs 98 revs (~98s
  // at the same 1 rev/sec floor) — the same rough difficulty order the previous 10x cap had
  // at 0.1/rev (90 revs), for a genuinely rarer 50x mastery achievement. Judgment call, not
  // ratified like the 50x number itself.

const KICKBALL_HOME_RUN_POINTS = 2000000;
const HIDE_SEEK_WRONG_POINTS = 100000;
const HIDE_SEEK_FOUND_POINTS = 1000000;
const DODGEBALL_SUCCESS_POINTS = 2500000;
const JUMP_ROPE_REV_POINTS = 5000;

export const SKILL_SHOT_CYCLE_S = 1.5; // how fast the plunge-lit F-U-N lane cycles
export const SKILL_SHOT_BASE_POINTS = 250000; // "x ball number" (§4.4)
export const SUPER_SKILL_SHOT_POINTS = 1000000;

export const METER_FILL = 15; // major shots per fill — not specified numerically in §4.4; picked so a fill is reachable within a good ball without trivializing it

const MODE_ORDER = ['KICKBALL', 'HIDE_SEEK', 'DODGEBALL', 'JUMP_ROPE'];

const HANG_TIME_REWARDS = ['bonusX', 'ballSave', 'points'];
const HANG_TIME_POINTS = 500000;

// FIELD DAY (T9, wizard mode — design doc §4.4): "Completing all four lights FIELD DAY at the
// TREEHOUSE... 4-ball multiball, all five shots lit for 2 000 000, relighting; every 5 shots
// the value doubles. Bonus X locked at 25×. Runs until one ball remains."
//
// "all five shots" — §4.3/§4.4 only ever name four shots (SLIDE, MONKEY BARS, TUNNEL, SANDBOX;
// MODE_SHOT_TAGS above). THE ORBIT (SW_ORBIT_EXIT) was added later, after the design doc, and
// isn't in that set — but it's the only 5th major shot on the table, sits in the same
// SWITCH_POINTS tier as the other four, and "all five" has no other candidate. Read as meaning
// MODE_SHOT_TAGS + THE ORBIT, stated here rather than left to guesswork at the call site.
export const FIELD_DAY_SHOT_TAGS = [...MODE_SHOT_TAGS, SW_ORBIT_EXIT];
export const FIELD_DAY_BASE_VALUE = 2000000; // "2 000 000" (§4.4)
export const FIELD_DAY_DOUBLE_EVERY = 5; // "every 5 shots the value doubles" (§4.4)
export const FIELD_DAY_BONUS_X = 25; // "Bonus X locked at 25×" (§4.4)
export const FIELD_DAY_BALL_COUNT = 4; // "4-ball multiball" (§4.4)

export function createModesState(seed = 1) {
  return {
    rng: makeRng(seed),
    queue: [...MODE_ORDER],
    completed: [],
    activeMode: null, // { name, startAtS, ...mode-specific fields }
    sandboxLit: false,
    hopscotchJackpot: { lit: false, completions: 0 },
    monkeyBarsShotCount: 0,
    slideCombo: { mult: 1, lastAtS: -Infinity },
    tunnelCombo: { mult: 1, lastAtS: -Infinity, lit: false },
    popHitsLifetime: 0,
    meter: { count: 0, extraBallAwarded: false, specialAwarded: false },
    // FIELD DAY (T9). `fieldDayLit`: the TREEHOUSE lamp — set the instant `completed` first
    // contains all four base modes (see finishMode below), consumed the instant FIELD DAY
    // actually starts (startFieldDay), same "flag dies at the point its privilege is
    // exercised" convention LIT-1 established for sandboxLit/hopscotchJackpot.lit. `fieldDay`:
    // this wizard mode's OWN scoring loop (shot count, current value, and the bonusX to
    // restore when it ends) — deliberately separate from rules/multiball.js's jackpot/
    // add-a-ball fields, which belong to RECESS MULTIBALL's different lock-and-collect design
    // and are never read or written by FIELD DAY (see multiball.js's startFieldDay doc
    // comment). `fieldDaysCompleted`: survives the `completed` reset below, so "how many times
    // has this player finished FIELD DAY" isn't lost the instant its own trigger condition is
    // consumed.
    fieldDayLit: false,
    fieldDay: { shotsHit: 0, value: FIELD_DAY_BASE_VALUE, bonusXBeforeFieldDay: null },
    fieldDaysCompleted: 0,
  };
}

/** Reset the per-ball parts of modes state at launchBall — combo multipliers are ball-scoped
 * artifacts (like bonusX and the pop escalator), everything else (queue, meter, jackpot
 * completions, lifetime pop count) persists for the whole game, per §4.4's "this game"
 * wording on the jackpot and meter.
 *
 * LIT-1 (2026-09-05): sandboxLit and hopscotchJackpot.lit were missing from this list — both
 * are "this ball earned a shot that's now armed" flags (sandboxLit by 25 pop hits / S-A-N-D
 * completion / the super skill shot; hopscotchJackpot.lit by HOPSCOTCH bank completion), and
 * neither is meant to survive a drain: a flag left lit let the next ball collect a shot it
 * never earned (hopscotchJackpot.lit: 500000 uncontested on the first SLIDE exit) or start a
 * mode with no completion required (sandboxLit: the next ball's first SANDBOX shot would
 * start a mode instantly). Added below.
 *
 * Considered restructuring instead of extending the list: splitting state into a
 * wholesale-replaceable `ball: {...}` sub-object (slideCombo, tunnelCombo, sandboxLit,
 * hopscotchJackpot.lit) versus a `game: {...}` sub-object for everything else, so a reset can
 * never miss a field because it replaces the whole thing at once. Rejected for now:
 * hopscotchJackpot itself is a genuinely mixed object (`.lit` is ball-scoped, `.completions`
 * is game-scoped), so the split isn't clean even at the top level, and every read site of
 * these fields throughout modes.js and game.js would need updating for a state-shape change
 * whose benefit here is avoiding a list two entries just grew to four. Not worth the blast
 * radius for this fix; if a fifth or sixth ball-scoped field shows up later, revisit this. */
export function resetForNewBall(modesState) {
  modesState.slideCombo = { mult: 1, lastAtS: -Infinity };
  modesState.tunnelCombo = { mult: 1, lastAtS: -Infinity, lit: false };
  modesState.sandboxLit = false;
  modesState.hopscotchJackpot.lit = false;
}

/** Abandon any in-progress mode without crediting a completion — called when the ball ends
 * (drain, no save) rather than the mode's own timer/success path. The mode goes back on the
 * queue so a later ball can attempt it, rather than being lost. */
export function abandonActiveMode(modesState) {
  if (!modesState.activeMode) return;
  modesState.queue.push(modesState.activeMode.name);
  modesState.activeMode = null;
}

// LIT-1 (2026-09-05): a NaN atS here used to poison lastAtS permanently — once
// `combo.lastAtS` became NaN, every future `atS - combo.lastAtS` is NaN, `NaN >
// COMBO_DECAY_S` is always false, so the combo could never decay again for the rest of the
// game. onSlideExit/onTunnelExit are called from processEvents' bare `for (const raw of
// events)` loop (rules/game.js) with no try/catch around it — the same shape as the
// diverter's per-frame event loop — so throwing here would abort every other event in that
// tick, the exact mistake already fixed there. Loud, not fatal: log once per bad streak and
// hold the multiplier steady rather than silently accepting or advancing it; never let the
// bad timestamp overwrite lastAtS, so decay works correctly again the moment a real
// timestamp arrives.
function decayedMult(combo, atS) {
  if (!Number.isFinite(atS)) {
    if (!combo._loggedNaNAtS) {
      combo._loggedNaNAtS = true;
      console.error(`decayedMult: atS=${atS} is not a finite timestamp — ignoring it, holding mult=${combo.mult} steady`);
    }
    return combo.mult;
  }
  combo._loggedNaNAtS = false;
  return atS - combo.lastAtS > COMBO_DECAY_S ? 1 : Math.min(6, combo.mult + 1);
}

/** THE SLIDE: 100 000 base, 2x-6x combo on consecutive slide shots, decaying after 8s. */
export function onSlideExit(modesState, atS) {
  const combo = modesState.slideCombo;
  const mult = decayedMult(combo, atS);
  modesState.slideCombo = { mult, lastAtS: Number.isFinite(atS) ? atS : combo.lastAtS, _loggedNaNAtS: combo._loggedNaNAtS };
  return 100000 * mult;
}

/** THE TUNNEL lights TETHERBALL for 10 000/rev (base 2 500), with its own consecutive-loop
 * combo, decaying the same way the slide's does. */
export function onTunnelExit(modesState, atS) {
  const combo = modesState.tunnelCombo;
  const mult = decayedMult(combo, atS);
  modesState.tunnelCombo = { mult, lastAtS: Number.isFinite(atS) ? atS : combo.lastAtS, lit: true, _loggedNaNAtS: combo._loggedNaNAtS };
}

export function tetherballSpinValue(modesState, atS) {
  const c = modesState.tunnelCombo;
  if (c.lit && atS - c.lastAtS <= COMBO_DECAY_S) return 10000 * c.mult;
  if (c.lit) { c.lit = false; c.mult = 1; }
  return 2500;
}

/** HOPSCOTCH bank completion lights the SLIDE for the jackpot instead of paying flat
 * points directly (§4.4's linkage). */
export function onHopscotchComplete(modesState) {
  modesState.hopscotchJackpot.lit = true;
  modesState.hopscotchJackpot.completions += 1;
}

export function hopscotchJackpotValue(modesState) {
  const n = modesState.hopscotchJackpot.completions;
  return 500000 + 250000 * Math.max(0, n - 1);
}

/** MONKEY BARS: every 3rd shot draws a HANG TIME award from the seeded PRNG. Returns
 * `{ reward, points }` on the 3rd/6th/... shot, or null otherwise. `points` is only set for
 * the 'points' reward — the caller applies 'bonusX'/'ballSave' to player state itself, since
 * modes.js doesn't touch player fields directly (same boundary bonus.js/scoring.js keep). */
export function onMonkeyBarsExit(modesState) {
  modesState.monkeyBarsShotCount += 1;
  if (modesState.monkeyBarsShotCount % 3 !== 0) return null;
  const reward = pick(modesState.rng, HANG_TIME_REWARDS);
  return { reward, points: reward === 'points' ? HANG_TIME_POINTS : 0 };
}

/** Spring-rider (pop) hit, tracked across the whole game (independent of the per-ball
 * escalator counter in rules/game.js) so DODGEBALL can light at the 25th lifetime hit. */
export function onPopHit(modesState) {
  modesState.popHitsLifetime += 1;
  if (modesState.popHitsLifetime % DODGEBALL_LIGHT_EVERY !== 0) return false;
  if (modesState.activeMode?.name === 'DODGEBALL' || !modesState.queue.includes('DODGEBALL')) return false;
  modesState.queue = ['DODGEBALL', ...modesState.queue.filter((m) => m !== 'DODGEBALL')];
  modesState.sandboxLit = true;
  return true;
}

/** S-A-N-D bank completion lights the SANDBOX for the next queued mode (§4.4). */
export function onSandComplete(modesState) {
  if (modesState.queue.length > 0) modesState.sandboxLit = true;
}

/** Super skill shot pre-lights the next mode without needing S-A-N-D completion. */
export function preLightNextMode(modesState) {
  if (modesState.queue.length > 0) modesState.sandboxLit = true;
}

function initModeState(name, atS, modesState) {
  if (name === 'KICKBALL') return { name, startAtS: atS, base: 0 };
  if (name === 'HIDE_SEEK') return { name, startAtS: atS, hider: Math.floor(modesState.rng() * MODE_SHOT_TAGS.length) };
  if (name === 'DODGEBALL') return { name, startAtS: atS, hits: 0 };
  if (name === 'JUMP_ROPE') return { name, startAtS: atS, remainingS: MODE_DURATION_S, mult: 1, lastRevAtS: atS };
  throw new Error(`unknown mode ${name}`);
}

/** SANDBOX entry, when lit and no mode is running: starts the next queued mode. Returns a
 * display event or null. */
export function tryStartMode(modesState, atS) {
  if (!modesState.sandboxLit || modesState.activeMode || modesState.queue.length === 0) return null;
  const name = modesState.queue.shift();
  modesState.sandboxLit = false;
  modesState.activeMode = initModeState(name, atS, modesState);
  return { kind: 'modeStart', mode: name };
}

function finishMode(modesState, success) {
  const name = modesState.activeMode.name;
  modesState.activeMode = null;
  modesState.completed.push(name);
  // "Completing all four lights FIELD DAY at the TREEHOUSE" (§4.4). Timeout counts as
  // completing per the existing house interpretation (see haiku-fs2's mode-completion-state
  // audit: completed[] already doesn't distinguish success from timeout for the base four, and
  // §4.4's own wording is ambiguous on whether a timeout counts — this is consistent with that
  // prior, already-shipped reading, not a new judgment call here).
  if (!modesState.fieldDayLit && MODE_ORDER.every((m) => modesState.completed.includes(m))) {
    modesState.fieldDayLit = true;
  }
  return { kind: 'modeEnd', mode: name, success };
}

/**
 * TREEHOUSE hit while FIELD DAY is lit: starts the wizard mode. Returns `{ kind:
 * 'fieldDayStart' }` or null if it isn't lit (caller falls back to ordinary TREEHOUSE/lock
 * handling).
 *
 * Scope decisions, made deliberately (each is a real question the design doc leaves open):
 *
 * 1. `completed` resets to `[]` HERE, at START, not at FIELD DAY's end and not never. Consumed
 *    at the point its privilege is exercised — the same convention LIT-1 already established
 *    for sandboxLit/hopscotchJackpot.lit, and for the same reason: leaving `completed.length
 *    === 4` true while FIELD DAY is still running would leave a stale re-trigger condition
 *    live for the whole run (nothing currently re-checks it mid-run, but resetting at start
 *    means nothing has to remember not to). `fieldDaysCompleted` (bumped when FIELD DAY itself
 *    ends, in rules/game.js) preserves the historical count across the reset — a player who
 *    somehow completes all four a second time in one game (the mode queue has no replay
 *    mechanism today, so this can't happen yet, but the reset is written to stay coherent if
 *    one is ever added) gets a fresh, independent climb toward a fresh FIELD DAY, not an
 *    instant re-trigger off leftover entries.
 * 2. FIELD DAY's own value/shot-count state is reset FRESH every time it starts (see the
 *    `fieldDay` object below) — the doubling is scoped to a single run, not cumulative across
 *    the game (see FIELD_DAY_DOUBLE_EVERY's own use in rules/game.js for the other half of
 *    this decision).
 * 3 & 4 (the 25× bonus lock and the 4-ball multiball's relationship to RECESS MULTIBALL's own
 *    state) are rules/game.js's and rules/multiball.js's decisions respectively — see
 *    startFieldDay's doc comment in multiball.js and the SW_TREEHOUSE branch in game.js.
 */
export function startFieldDay(modesState, atS) {
  if (!modesState.fieldDayLit) return null;
  modesState.fieldDayLit = false;
  modesState.completed = [];
  modesState.fieldDay = { shotsHit: 0, value: FIELD_DAY_BASE_VALUE, bonusXBeforeFieldDay: null };
  return { kind: 'fieldDayStart', startAtS: atS };
}

/** Any of the 5 FIELD DAY shots (FIELD_DAY_SHOT_TAGS): scores the current value, then relights
 * (every shot is always lit — see the design doc's own "relighting"), and every
 * FIELD_DAY_DOUBLE_EVERY-th shot doubles the value for subsequent hits. Returns `{ points }`;
 * the caller (rules/game.js) is the one that knows whether this tag is even eligible (i.e.
 * whether FIELD DAY/multiball is active) — this function assumes the caller already checked. */
export function onFieldDayShot(modesState) {
  const fd = modesState.fieldDay;
  const points = fd.value;
  fd.shotsHit += 1;
  if (fd.shotsHit % FIELD_DAY_DOUBLE_EVERY === 0) fd.value *= 2;
  return { points, shotsHit: fd.shotsHit, nextValue: fd.value };
}

/** Called for every shot tag while a mode is active (independent of, and in addition to,
 * that shot's own normal score) — the mode-specific advance/hit logic. Returns
 * `{ points, display[], modesCompletedDelta }`. */
export function onModeShot(modesState, tag, atS) {
  const mode = modesState.activeMode;
  if (!mode) return { points: 0, display: [], modesCompletedDelta: 0 };

  if (mode.name === 'KICKBALL' && MODE_SHOT_TAGS.includes(tag)) {
    if (tag !== MODE_SHOT_TAGS[mode.base]) return { points: 0, display: [], modesCompletedDelta: 0 };
    mode.base += 1;
    if (mode.base >= MODE_SHOT_TAGS.length) {
      return { points: KICKBALL_HOME_RUN_POINTS, display: [{ kind: 'homeRun' }, finishMode(modesState, true)], modesCompletedDelta: 1 };
    }
    return { points: 0, display: [{ kind: 'kickballBase', base: mode.base }], modesCompletedDelta: 0 };
  }

  if (mode.name === 'HIDE_SEEK' && MODE_SHOT_TAGS.includes(tag)) {
    const idx = MODE_SHOT_TAGS.indexOf(tag);
    if (idx === mode.hider) {
      let next = mode.hider;
      while (next === mode.hider) next = Math.floor(modesState.rng() * MODE_SHOT_TAGS.length);
      mode.hider = next;
      return { points: HIDE_SEEK_FOUND_POINTS, display: [{ kind: 'hideSeekFound' }], modesCompletedDelta: 0 };
    }
    return {
      points: HIDE_SEEK_WRONG_POINTS,
      display: [{ kind: 'hideSeekHint', direction: Math.sign(mode.hider - idx) }],
      modesCompletedDelta: 0,
    };
  }

  return { points: 0, display: [], modesCompletedDelta: 0 };
}

/** DODGEBALL's pop/sling wiring is driven separately from onModeShot since pops/slings
 * aren't in MODE_SHOT_TAGS. `delta` is +1 for a pop hit, -1 for a slingshot hit. */
export function onDodgeballHit(modesState, delta) {
  const mode = modesState.activeMode;
  if (!mode || mode.name !== 'DODGEBALL') return { points: 0, display: [], modesCompletedDelta: 0 };
  mode.hits = Math.max(0, mode.hits + delta);
  if (mode.hits >= DODGEBALL_TARGET_HITS) {
    return { points: DODGEBALL_SUCCESS_POINTS, display: [finishMode(modesState, true)], modesCompletedDelta: 1 };
  }
  return { points: 0, display: [], modesCompletedDelta: 0 };
}

/** JUMP ROPE's spinner wiring: each TETHERBALL_SPIN while the mode is active adds time and
 * builds the multiplier, scored independently of the spinner's normal points. */
export function onJumpRopeSpin(modesState, atS) {
  const mode = modesState.activeMode;
  if (!mode || mode.name !== 'JUMP_ROPE') return { points: 0, display: [], modesCompletedDelta: 0 };
  mode.mult = Math.min(JUMP_ROPE_MAX_MULT, mode.mult + JUMP_ROPE_MULT_PER_REV);
  mode.remainingS += JUMP_ROPE_TIME_PER_REV_S;
  mode.lastRevAtS = atS;
  return { points: Math.round(JUMP_ROPE_REV_POINTS * mode.mult), display: [], modesCompletedDelta: 0 };
}

/** Time-based endings: KICKBALL/HIDE_SEEK/DODGEBALL timeout at MODE_DURATION_S; JUMP_ROPE
 * ends on either its (rev-extended) remaining time or a 4s spinner stall. Called once per
 * processEvents tick with the current `atS`. */
export function tickModes(modesState, atS) {
  const mode = modesState.activeMode;
  if (!mode) return [];

  if (mode.name === 'JUMP_ROPE') {
    const elapsed = atS - mode.startAtS;
    const stalled = atS - mode.lastRevAtS >= JUMP_ROPE_STALL_S;
    if (elapsed >= mode.remainingS || stalled) {
      const success = elapsed >= MODE_DURATION_S || mode.mult > 1;
      return [finishMode(modesState, success)];
    }
    return [];
  }

  if (atS - mode.startAtS >= MODE_DURATION_S) {
    return [finishMode(modesState, mode.name === 'HIDE_SEEK')];
  }
  return [];
}

/** RECESS METER: fed by every major shot (the same four §4.3 shots). Fills award EXTRA BALL
 * first, then SPECIAL. */
export function onMeterShot(modesState) {
  const m = modesState.meter;
  m.count += 1;
  if (m.count < METER_FILL) return null;
  m.count = 0;
  if (!m.extraBallAwarded) {
    m.extraBallAwarded = true;
    return { kind: 'extraBall' };
  }
  if (!m.specialAwarded) {
    m.specialAwarded = true;
    return { kind: 'special' };
  }
  return null;
}

/** The plunge-lit F-U-N lane for the skill shot: cycles through all of the lanes purely as a
 * function of elapsed time since launch, per SKILL_SHOT_CYCLE_S — no clock read, no stored
 * mutable pointer, so it's trivially deterministic for tests. */
export function skillShotLaneTag(launchAtS, atS) {
  const idx = Math.floor(Math.max(0, atS - launchAtS) / SKILL_SHOT_CYCLE_S) % SW_FUN.length;
  return SW_FUN[idx];
}
