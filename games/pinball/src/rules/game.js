// The rules core (T6, design doc §3/§4.4/§9). A pure state machine: physics emits switch
// events into a queue; `processEvents` is the ONLY thing that consumes that queue and
// mutates score/ball/turn state. Nothing else in this module (or any caller) is allowed to
// reach into a player's score directly — that is the event-queue boundary the design doc
// calls load-bearing, and it is what keeps modes (T7), multiball (T8) and audio/render/ui
// independent of each other later: they all just subscribe to the display events this
// emits, the same way `rules/game.js` itself only subscribes to physics's switch events.
//
// Purity: no threejs import, no DOM, no wall-clock reads, no unseeded randomness (enforced by
// test/purity.test.mjs). Every time-based value is a caller-supplied timestamp (`atS`,
// seconds — the same "elapsed wall-clock seconds passed in by the RAF loop" convention
// already used by game/mechanisms.js's scoop/drop-bank timers), never read internally.
import { SW_DRAIN, SW_FUN_COMPLETE } from '../table/switches.js';
import { POP_TAGS, POP_BASE_POINTS, POP_ESCALATOR, SWITCH_POINTS, fallbackPointsFor, SHOT_TAGS, BONUS_X_MAX } from './scoring.js';
import { computeBonus } from './bonus.js';

// DO-OVER ball save period, per §4.4: 10s from launch, 12s on ball 1.
const DO_OVER_S = 10;
const DO_OVER_FIRST_BALL_S = 12;

function createPlayer() {
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
  };
}

export function createGame({ numPlayers = 1, ballsPerPlayer = 3 } = {}) {
  if (!Number.isInteger(numPlayers) || numPlayers < 1 || numPlayers > 4) {
    throw new RangeError('numPlayers must be an integer 1-4');
  }
  return {
    numPlayers,
    ballsPerPlayer,
    turnIndex: 0, // increments once per completed ball, across all players — this is what
                  // makes turn order "alternate through balls" rather than "finish all of
                  // player 1's balls first".
    players: Array.from({ length: numPlayers }, createPlayer),
    gameOver: false,
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
 * counters) and arms the DO-OVER save period. */
export function launchBall(state, atS) {
  if (state.gameOver) return [];
  const p = activePlayer(state);
  p.ball = ballNumber(state);
  p.bonusX = 1;
  p.popHitsThisBall = 0;
  p.shotsThisBall = 0;
  p.doOverUsed = false;
  p.ballLaunchAtS = atS;
  p.ballSaveUntilS = atS + (p.ball === 1 ? DO_OVER_FIRST_BALL_S : DO_OVER_S);
  p.ballActive = true;
  return [{ kind: 'ballServed', player: activePlayerIndex(state), ball: p.ball }];
}

/** A DO-OVER re-serve: the same ball continues, so progress (score, bonus X, shot/pop
 * counts, the original launch timestamp used for the bonus's playtime term) is left alone.
 * Only usable once per ball — see handleDrain's `doOverUsed` gate. */
function saveBall(state) {
  const p = activePlayer(state);
  p.doOverUsed = true;
  p.ballActive = true;
  return [{ kind: 'ballSaved', player: activePlayerIndex(state) }];
}

function endOfBall(state, atS) {
  const p = activePlayer(state);
  const playtimeS = p.ballLaunchAtS !== null ? Math.max(0, atS - p.ballLaunchAtS) : 0;
  const bonus = computeBonus({ playtimeS, shots: p.shotsThisBall, modes: 0, bonusX: p.bonusX });
  p.score += bonus;
  p.ballActive = false;
  const playerIndex = activePlayerIndex(state);
  const display = [{ kind: 'bonus', playerIndex, amount: bonus, bonusX: p.bonusX, total: p.score }];

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

function scoreSwitch(state, tag) {
  const p = activePlayer(state);

  if (POP_TAGS.has(tag)) {
    const points = POP_BASE_POINTS + POP_ESCALATOR * p.popHitsThisBall;
    p.popHitsThisBall += 1;
    p.score += points;
    return { kind: 'score', tag, points, total: p.score };
  }

  if (SHOT_TAGS.has(tag)) p.shotsThisBall += 1;

  const points = SWITCH_POINTS.has(tag) ? SWITCH_POINTS.get(tag) : fallbackPointsFor(tag);
  if (points <= 0) return null;
  p.score += points;
  return { kind: 'score', tag, points, total: p.score };
}

/**
 * The event-queue boundary in full: consumes the physics switch-event queue (as returned
 * by physics/world.js's `advance()`, plus a synthesized `{tag: SW_DRAIN}` the caller
 * appends when the geometric drain check fires — see main.js) and returns the display
 * events every other subsystem (render/audio/ui, and later modes/multiball) subscribes to.
 * `events` accepts either raw tag strings or `{tag}`-shaped objects, matching what
 * physics/world.js's events already look like — no caller needs to reshape anything.
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

    const scored = scoreSwitch(state, tag);
    if (scored) display.push(scored);
  }

  return display;
}
