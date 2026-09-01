// The rules core (T6, design doc §3/§4.4/§9). A pure state machine: physics emits switch
// events into a queue; `processEvents` is the ONLY thing that consumes that queue and
// mutates score/ball/turn state. Nothing else in this module (or any caller) is allowed to
// reach into a player's score directly — that is the event-queue boundary the design doc
// calls load-bearing, and it is what keeps modes (T7), multiball (T8) and audio/render/ui
// independent of each other later: they all just subscribe to the display events this
// emits, the same way `rules/game.js` itself only subscribes to physics's switch events.
//
// T7 adds modes, skill shot and the RECESS METER (rules/modes.js) plus the four
// cross-mechanism linkages deferred from T6 — all still flowing through this same
// event-queue boundary, no second scoring route.
//
// Purity: no threejs import, no DOM, no wall-clock reads, no unseeded randomness (enforced by
// test/purity.test.mjs). Every time-based value is a caller-supplied timestamp (`atS`,
// seconds — the same "elapsed wall-clock seconds passed in by the RAF loop" convention
// already used by game/mechanisms.js's scoop/drop-bank timers), never read internally.
import {
  SW_DRAIN, SW_FUN_COMPLETE, SW_SOFT_PLUNGE, SW_FUN,
  SW_HOPSCOTCH_COMPLETE, SW_SAND_COMPLETE,
  SW_SLIDE_EXIT, SW_MONKEYBARS_EXIT, SW_TUNNEL_EXIT, SW_SANDBOX_ENTRY,
  SW_TETHERBALL_SPIN, SW_SLING_LEFT, SW_SLING_RIGHT,
  SW_TREEHOUSE, SW_MERRYGOROUND, SW_BALL_ADDED, SW_BALL_LOST,
} from '../table/switches.js';
import { POP_TAGS, POP_BASE_POINTS, POP_ESCALATOR, SWITCH_POINTS, fallbackPointsFor, SHOT_TAGS, BONUS_X_MAX } from './scoring.js';
import { computeBonus } from './bonus.js';
import * as modes from './modes.js';
import * as multiball from './multiball.js';

// DO-OVER ball save period, per §4.4: 10s from launch, 12s on ball 1.
const DO_OVER_S = 10;
const DO_OVER_FIRST_BALL_S = 12;

function createPlayer(seed) {
  return {
    score: 0,
    ball: 0,
    bonusX: 1,
    popHitsThisBall: 0,
    shotsThisBall: 0,
    ballActive: false,
    ballLaunchAtS: null,
    ballSaveUntilS: null,
    doOverUsed: false,
    freshLaunch: false,
    softPlunge: false,
    modesCompletedThisBall: 0,
    extraBallsPending: 0,
    modesState: modes.createModesState(seed),
    multiball: multiball.createMultiballState(),
  };
}

export function createGame({ numPlayers = 1, ballsPerPlayer = 3, seed = 1 } = {}) {
  if (!Number.isInteger(numPlayers) || numPlayers < 1 || numPlayers > 4) {
    throw new RangeError('numPlayers must be an integer 1-4');
  }
  return {
    numPlayers,
    ballsPerPlayer,
    turnIndex: 0, // increments once per completed ball, across all players — this is what
                  // makes turn order "alternate through balls" rather than "finish all of
                  // player 1's balls first".
    players: Array.from({ length: numPlayers }, (_, i) => createPlayer(seed + i * 97)),
    gameOver: false,
    credits: 0, // RECESS METER's SPECIAL award — a replay credit (§4.5 territory; full match/replay is T9)
  };
}

export function activePlayerIndex(state) {
  return state.turnIndex % state.numPlayers;
}
export function activePlayer(state) {
  return state.players[activePlayerIndex(state)];
}
export function ballNumber(state) {
  return Math.floor(state.turnIndex / state.numPlayers) + 1;
}

/** Serves a fresh ball to the current player (a new ball, not a DO-OVER save — see
 * saveBall below for the distinction). Resets this ball's progress (bonus X, shot/pop
 * counters, skill-shot period, mode combo multipliers) and arms the DO-OVER save period. */
export function launchBall(state, atS) {
  if (state.gameOver) return [];
  const p = activePlayer(state);
  p.ball = ballNumber(state);
  p.bonusX = 1;
  p.popHitsThisBall = 0;
  p.shotsThisBall = 0;
  p.doOverUsed = false;
  p.freshLaunch = true;
  p.softPlunge = false;
  p.modesCompletedThisBall = 0;
  p.ballLaunchAtS = atS;
  p.ballSaveUntilS = atS + (p.ball === 1 ? DO_OVER_FIRST_BALL_S : DO_OVER_S);
  p.ballActive = true;
  modes.resetForNewBall(p.modesState);
  return [{ kind: 'ballServed', player: activePlayerIndex(state), ball: p.ball }];
}

/** A DO-OVER re-serve: the same ball continues, so progress (score, bonus X, shot/pop
 * counts, the original launch timestamp used for the bonus's playtime term, any mode in
 * progress) is left alone. Only usable once per ball — see handleDrain's `doOverUsed` gate.
 * The skill-shot period does NOT reopen — it's a plunge-only thing, not per re-serve. */
function saveBall(state) {
  const p = activePlayer(state);
  p.doOverUsed = true;
  p.ballActive = true;
  return [{ kind: 'ballSaved', player: activePlayerIndex(state) }];
}

function endOfBall(state, atS) {
  const p = activePlayer(state);
  modes.abandonActiveMode(p.modesState);
  const playtimeS = p.ballLaunchAtS !== null ? Math.max(0, atS - p.ballLaunchAtS) : 0;
  const bonus = computeBonus({ playtimeS, shots: p.shotsThisBall, modes: p.modesCompletedThisBall, bonusX: p.bonusX });
  p.score += bonus;
  p.ballActive = false;
  const playerIndex = activePlayerIndex(state);
  const display = [{ kind: 'bonus', playerIndex, amount: bonus, bonusX: p.bonusX, total: p.score }];

  // Safety net for a multiball still running when the ball ends outright (a tilt, most
  // plausibly) — it has no business surviving past the ball it started on.
  const forced = multiball.forceEnd(p.multiball);
  if (forced) display.push(forced);

  // RECESS METER's EXTRA BALL: the same player takes another ball at the same ball number
  // rather than the turn passing on — the classic pinball meaning of "extra ball".
  if (p.extraBallsPending > 0) {
    p.extraBallsPending -= 1;
    display.push({ kind: 'extraBallGranted', player: playerIndex });
    display.push(...launchBall(state, atS));
    return display;
  }

  state.turnIndex += 1;
  if (state.turnIndex >= state.numPlayers * state.ballsPerPlayer) {
    state.gameOver = true;
    display.push({ kind: 'gameOver', scores: state.players.map((pl) => pl.score) });
  } else {
    display.push({ kind: 'turnChange', player: activePlayerIndex(state), ball: ballNumber(state) });
  }
  return display;
}

function handleDrain(state, atS) {
  const p = activePlayer(state);
  if (!p.ballActive) return [];
  const withinSaveWindow = !p.doOverUsed && p.ballSaveUntilS !== null && atS <= p.ballSaveUntilS;
  if (withinSaveWindow) return saveBall(state);
  return endOfBall(state, atS);
}

/** Applies a mode-progression result (`{points, display}` from modes.js — see onModeShot /
 * onDodgeballHit / onJumpRopeSpin) to the player and returns its display events, crediting
 * modesCompletedThisBall for every 'modeEnd' the result carries. */
function applyModeResult(p, result) {
  if (result.points) p.score += result.points;
  p.modesCompletedThisBall += result.display.filter((d) => d.kind === 'modeEnd').length;
  return result.display;
}

/** RECESS METER: called for every major-shot tag (the four MODE_SHOT_TAGS). */
function applyMeter(state, p) {
  const award = modes.onMeterShot(p.modesState);
  if (!award) return [];
  if (award.kind === 'extraBall') {
    p.extraBallsPending += 1;
    return [award];
  }
  if (award.kind === 'special') {
    state.credits += 1;
    return [award];
  }
  return [];
}

/** Skill shot / super skill shot, at the plunge only (`p.freshLaunch`). Returns `{ handled,
 * display }` — `handled: true` means the tag is fully consumed and normal scoring must not
 * also run for it. */
function trySkillShot(state, p, tag, atS) {
  if (!p.freshLaunch) return { handled: false, display: [] };

  if (SW_FUN.includes(tag)) {
    const litTag = modes.skillShotLaneTag(p.ballLaunchAtS, atS);
    p.freshLaunch = false;
    if (tag !== litTag) return { handled: false, display: [] };
    const points = modes.SKILL_SHOT_BASE_POINTS * p.ball;
    p.score += points;
    return { handled: true, display: [{ kind: 'score', tag: 'skill_shot', points, total: p.score }] };
  }

  if (tag === SW_SANDBOX_ENTRY && p.softPlunge) {
    p.freshLaunch = false;
    p.softPlunge = false;
    p.score += modes.SUPER_SKILL_SHOT_POINTS;
    modes.preLightNextMode(p.modesState);
    return {
      handled: true,
      display: [{ kind: 'score', tag: 'super_skill_shot', points: modes.SUPER_SKILL_SHOT_POINTS, total: p.score }],
    };
  }

  p.freshLaunch = false; // period used by an unrelated first switch
  return { handled: false, display: [] };
}

function scoreSwitchTag(state, p, tag, atS) {
  const display = [];

  if (POP_TAGS.has(tag)) {
    const points = POP_BASE_POINTS + POP_ESCALATOR * p.popHitsThisBall;
    p.popHitsThisBall += 1;
    p.score += points;
    display.push({ kind: 'score', tag, points, total: p.score });
    modes.onPopHit(p.modesState);
    display.push(...applyModeResult(p, modes.onDodgeballHit(p.modesState, +1)));
    return display;
  }

  if (tag === SW_SLING_LEFT || tag === SW_SLING_RIGHT) {
    const points = SWITCH_POINTS.get(tag);
    p.score += points;
    display.push({ kind: 'score', tag, points, total: p.score });
    display.push(...applyModeResult(p, modes.onDodgeballHit(p.modesState, -1)));
    return display;
  }

  if (tag === SW_TREEHOUSE) {
    const points = SWITCH_POINTS.get(tag);
    p.score += points;
    display.push({ kind: 'score', tag, points, total: p.score });
    const lamp = multiball.onTreehouseHit(p.multiball);
    if (lamp) display.push(lamp);
    return display;
  }

  if (tag === SW_MERRYGOROUND) {
    const result = multiball.onMerryGoRoundEntry(p.multiball, atS);
    if (result.action === 'eject') {
      display.push({ kind: 'merryGoRoundEject' });
    } else if (result.action === 'relock') {
      display.push({ kind: 'merryGoRoundEject' });
      display.push({ kind: 'jackpotValue', value: result.jackpotValue });
    } else if (result.action === 'lock') {
      // "locking ball N serves a new ball" (T8 dispatch) — the locked ball is out of play,
      // so main.js auto-plunges a fresh one rather than leaving the player with nothing.
      display.push({ kind: 'lock', locks: result.locks });
      display.push({ kind: 'lockedBallServed' });
    } else if (result.action === 'startMultiball') {
      // Mirrors onMonkeyBarsExit's 'ballSave' HANG TIME reward: multiball.js reports the
      // period, this module is the only thing that touches player fields.
      p.ballSaveUntilS = result.saveUntilS;
      p.doOverUsed = false;
      display.push({ kind: 'multiballStart' });
    }
    return display;
  }

  if (tag === SW_HOPSCOTCH_COMPLETE) {
    modes.onHopscotchComplete(p.modesState);
    display.push({ kind: 'lamp', id: 'slide_jackpot', lit: true });
    return display;
  }

  if (tag === SW_SAND_COMPLETE) {
    const points = SWITCH_POINTS.get(tag);
    p.score += points;
    display.push({ kind: 'score', tag, points, total: p.score });
    modes.onSandComplete(p.modesState);
    return display;
  }

  if (tag === SW_SLIDE_EXIT || tag === SW_MONKEYBARS_EXIT || tag === SW_TUNNEL_EXIT || tag === SW_SANDBOX_ENTRY) {
    // Lights this shot toward the multiball jackpot *before* the tag-specific scoring below
    // runs — so if this SLIDE shot is itself the 4th one that lights the set, it's also the
    // one that collects it, matching how a real machine's last qualifying shot both lights
    // and banks the jackpot in the same hit rather than requiring a 5th shot.
    multiball.onModeShotDuringMultiball(p.multiball, tag);

    let points = 0;
    if (tag === SW_SLIDE_EXIT) {
      // Priority, an interpretive call (§4.4 gives neither jackpot a documented precedence
      // over the other): the multiball jackpot outranks the HOPSCOTCH jackpot outranks the
      // plain combo — multiball is the highest-stakes moment on the table, and the
      // HOPSCOTCH jackpot stays lit (unlike this cashed-in multiball jackpot) so it isn't
      // lost by being deferred a shot.
      const mbJackpot = multiball.collectJackpot(p.multiball);
      if (mbJackpot > 0) {
        points = mbJackpot;
        p.score += points;
        display.push({ kind: 'score', tag: 'multiball_jackpot', points, total: p.score });
      } else if (p.modesState.hopscotchJackpot.lit) {
        points = modes.hopscotchJackpotValue(p.modesState);
        p.modesState.hopscotchJackpot.lit = false;
        p.score += points;
        display.push({ kind: 'score', tag: 'hopscotch_jackpot', points, total: p.score });
      } else {
        points = modes.onSlideExit(p.modesState, atS);
        p.score += points;
        display.push({ kind: 'score', tag, points, total: p.score });
      }
    } else if (tag === SW_MONKEYBARS_EXIT) {
      points = SWITCH_POINTS.get(tag);
      p.score += points;
      display.push({ kind: 'score', tag, points, total: p.score });
      const hangTime = modes.onMonkeyBarsExit(p.modesState);
      if (hangTime) {
        if (hangTime.reward === 'points') {
          p.score += hangTime.points;
          display.push({ kind: 'score', tag: 'hang_time', points: hangTime.points, total: p.score });
        } else if (hangTime.reward === 'bonusX') {
          p.bonusX = Math.min(BONUS_X_MAX, p.bonusX + 1);
          display.push({ kind: 'bonusX', player: activePlayerIndex(state), value: p.bonusX });
        } else if (hangTime.reward === 'ballSave') {
          p.ballSaveUntilS = Math.max(p.ballSaveUntilS ?? atS, atS) + DO_OVER_S;
        }
        display.push({ kind: 'hangTime', reward: hangTime.reward });
      }
    } else if (tag === SW_TUNNEL_EXIT) {
      points = SWITCH_POINTS.get(tag);
      p.score += points;
      display.push({ kind: 'score', tag, points, total: p.score });
      modes.onTunnelExit(p.modesState, atS);
    } else if (tag === SW_SANDBOX_ENTRY) {
      // Modes don't start during multiball — running a 40s mode timer concurrently with
      // the multiball flow isn't specified in §4.4, and it would overload what a SANDBOX
      // shot means at the exact moment it's also the add-a-ball shot. Interpretive call.
      if (multiball.onSandboxDuringMultiball(p.multiball)) {
        display.push({ kind: 'addABall' });
      } else if (!p.multiball.active) {
        const modeStart = modes.tryStartMode(p.modesState, atS);
        if (modeStart) display.push(modeStart);
      }
    }

    p.shotsThisBall += 1;
    display.push(...applyMeter(state, p));
    display.push(...applyModeResult(p, modes.onModeShot(p.modesState, tag, atS)));
    return display;
  }

  if (tag === SW_TETHERBALL_SPIN) {
    const points = modes.tetherballSpinValue(p.modesState, atS);
    p.score += points;
    display.push({ kind: 'score', tag, points, total: p.score });
    display.push(...applyModeResult(p, modes.onJumpRopeSpin(p.modesState, atS)));
    return display;
  }

  const points = SWITCH_POINTS.has(tag) ? SWITCH_POINTS.get(tag) : fallbackPointsFor(tag);
  if (points <= 0) return display;
  p.score += points;
  display.push({ kind: 'score', tag, points, total: p.score });
  return display;
}

/**
 * The event-queue boundary in full: consumes the physics switch-event queue (as returned
 * by physics/world.js's `advance()`, plus a synthesized `{tag: SW_DRAIN}`/`{tag:
 * SW_SOFT_PLUNGE}` the caller appends when the geometric drain check or a soft plunge fires
 * — see main.js) and returns the display events every other subsystem (render/audio/ui)
 * subscribes to. `events` accepts either raw tag strings or `{tag}`-shaped objects, matching
 * what physics/world.js's events already look like — no caller needs to reshape anything.
 */
export function processEvents(state, events, atS) {
  if (state.gameOver) return [];
  const display = [];

  for (const raw of events) {
    const tag = typeof raw === 'string' ? raw : raw?.tag;
    if (!tag) continue;

    if (tag === SW_DRAIN) {
      display.push(...handleDrain(state, atS));
      if (state.gameOver) break;
      continue;
    }

    if (tag === SW_FUN_COMPLETE) {
      const p = activePlayer(state);
      p.bonusX = Math.min(BONUS_X_MAX, p.bonusX + 1);
      display.push({ kind: 'bonusX', player: activePlayerIndex(state), value: p.bonusX });
      continue;
    }

    const p = activePlayer(state);

    if (tag === SW_SOFT_PLUNGE) {
      p.softPlunge = true;
      continue;
    }

    if (tag === SW_BALL_ADDED) {
      multiball.onBallAdded(p.multiball);
      continue;
    }

    if (tag === SW_BALL_LOST) {
      const ended = multiball.onBallLost(p.multiball);
      if (ended) display.push(ended);
      continue;
    }

    const skillShot = trySkillShot(state, p, tag, atS);
    display.push(...skillShot.display);
    if (skillShot.handled) continue;

    display.push(...scoreSwitchTag(state, p, tag, atS));
  }

  const activeP = activePlayer(state);
  if (activeP.ballActive) {
    const timedOut = modes.tickModes(activeP.modesState, atS);
    activeP.modesCompletedThisBall += timedOut.filter((d) => d.kind === 'modeEnd').length;
    display.push(...timedOut);
  }

  return display;
}
