// AUDIO-T11 (design doc §3.2): maps game events to procedural sounds, built from
// audio/synth.js's shared primitives. Two lookup surfaces, matching the two places main.js
// already has a tag/event in hand:
//   - `playMechanismCue(synth, tag)` — a raw physics switch tag (a bumper, a sling, a ramp
//     exit) from the SAME `fired`/`frameMechanismTags` list processMechanismEvents already
//     builds in main.js. Physical-contact sounds: the thing that just happened, not what it
//     was worth.
//   - `playDisplayCue(synth, d)` — a display event from rules/game.js's own processRules
//     return value, the SAME array applyDisplayEvents already switches on for every visual
//     side effect. Named-moment sounds: a jackpot, a lock, a tilt, a mode ending.
//
// Scoped down from the design doc's own §3.2, per the dispatch: a full per-skin music loop
// is cut entirely (distinct sounds for every scoring event was the acceptance bar, not a
// soundtrack); the "ambience bed that ducks during modes" is cut too — both are recorded
// here, not silently dropped, so a future dispatch picking either back up isn't rediscovering
// that they were considered. Every event kind main.js's applyDisplayEvents actually switches
// on is accounted for below, one way or the other (a cue, or a stated reason it gets none) —
// SIGNAL-LOST found a display event with no consumer once already tonight; this file is
// checked against that same list, not written from memory of what "should" be there.
import {
  SW_POP_DUCK, SW_POP_HORSE, SW_POP_ROCKET,
  SW_SLING_LEFT, SW_SLING_RIGHT,
  SW_TETHERBALL_SPIN, SW_PINWHEEL_SPIN,
  SW_SANDBOX_ENTRY, SW_SANDBOX_EJECT,
  SW_KICKBACK, SW_MERRY_GO_ROUND, SW_TREEHOUSE,
  SW_SLIDE_EXIT, SW_MONKEYBARS_EXIT, SW_TUNNEL_EXIT, SW_ORBIT_EXIT,
  SW_HOPSCOTCH_COMPLETE, SW_SAND_COMPLETE,
  SW_FUN,
} from '../table/switches.js';

// --- Cue definitions: one function per named sound, each a thin call into synth.js's ------
// --- shared primitives (playTone/playBell/playNoiseBurst). ---------------------------------
const CUES = {
  // Spring-riders (§3.2: "sine with fast pitch drop + tremolo" — approximated here as a fast
  // exponential pitch drop; a true tremolo (amplitude oscillation) is cut, see the module doc
  // comment's own scoping note). Three base pitches so duck/horse/rocket read as different
  // creatures, not the same sound three times.
  boingDuck: (s) => s.playTone({ freq: 520, endFreq: 180, type: 'sine', duration: 0.16, peakGain: 0.35 }),
  boingHorse: (s) => s.playTone({ freq: 380, endFreq: 130, type: 'sine', duration: 0.18, peakGain: 0.35 }),
  boingRocket: (s) => s.playTone({ freq: 700, endFreq: 220, type: 'sine', duration: 0.14, peakGain: 0.32 }),
  // Slingshot — not individually named in §3.2's own list, but a scoring event needs its own
  // sound (this dispatch's own acceptance bar): a sharper, faster kick than a bumper's boing.
  twang: (s) => s.playTone({ freq: 300, endFreq: 140, type: 'triangle', duration: 0.09, peakGain: 0.3 }),
  // Spinner (§3.2: "retriggered click... the most satisfying sound in pinball, and free
  // here") — a genuine rate-follows-angular-velocity click (the design's own phrasing) needs
  // a continuous per-substep hook this dispatch's two per-frame hook points don't have;
  // approximated as one short click per registered hit, which is what's actually reachable
  // from main.js's existing SW_TETHERBALL_SPIN/SW_PINWHEEL_SPIN tags (one per spin
  // registration, not per substep) — cut noted, not silently approximated as the full thing.
  spinnerClick: (s) => s.playNoiseBurst({ duration: 0.035, filterHz: 4200, filterType: 'highpass', peakGain: 0.16 }),
  // THE SANDBOX (§3.2: "scoop thud — filtered noise burst") — noise plus a low sine thump for
  // real low-end weight a noise burst alone doesn't have.
  scoopThud: (s) => { s.playNoiseBurst({ duration: 0.22, filterHz: 450, peakGain: 0.32 }); s.playTone({ freq: 90, endFreq: 60, type: 'sine', duration: 0.2, peakGain: 0.3 }); },
  scoopWhoosh: (s) => s.playNoiseBurst({ duration: 0.15, filterHz: 900, peakGain: 0.18 }),
  // Kickback — a real, physical kick, not a chime; noise plus a short punchy sine.
  kick: (s) => { s.playNoiseBurst({ duration: 0.1, filterHz: 1600, peakGain: 0.28 }); s.playTone({ freq: 220, endFreq: 80, type: 'sine', duration: 0.14, peakGain: 0.32 }); },
  // Drop targets (HOPSCOTCH/S-A-N-D letters), TREEHOUSE, a merry-go-round capture contact — a
  // short mechanical clack, distinct from every tonal cue below.
  clack: (s) => s.playNoiseBurst({ duration: 0.05, filterHz: 1000, peakGain: 0.28 }),
  // A bank fully completed (§3.2's "chime": "two detuned triangles, exponential decay").
  chime: (s) => { s.playTone({ freq: 660, type: 'triangle', duration: 0.4, peakGain: 0.22, detune: -6 }); s.playTone({ freq: 660, type: 'triangle', duration: 0.4, peakGain: 0.22, detune: 6 }); },
  // A made ramp shot — the same detuned-triangle chime family, shorter and brighter.
  rampChime: (s) => { s.playTone({ freq: 880, type: 'triangle', duration: 0.22, peakGain: 0.2, detune: -6 }); s.playTone({ freq: 880, type: 'triangle', duration: 0.22, peakGain: 0.2, detune: 6 }); },
  // F-U-N lane rollover — a light, quiet ding; the smallest tonal cue on the table.
  lightDing: (s) => s.playTone({ freq: 1100, type: 'sine', duration: 0.08, peakGain: 0.14 }),
  // §3.2's "knocker: short noise + low sine thump" — reserved for EXTRA BALL/SPECIAL, the
  // biggest situational awards, matching a real machine's own use of the knocker.
  knocker: (s) => { s.playNoiseBurst({ duration: 0.07, filterHz: 2600, peakGain: 0.4 }); s.playTone({ freq: 70, type: 'sine', duration: 0.3, peakGain: 0.5 }); },
  // §3.2's "recess bell: FM bell, two operators" — the biggest tonal award (a jackpot-class
  // collection, FIELD DAY starting) gets the biggest, most distinct sound on the table.
  recessBell: (s) => s.playBell({ freq: 660, ratio: 2.4, modIndex: 220, duration: 0.9, peakGain: 0.4 }),
  // Tilt — the one deliberately harsh, negative sound: two dissonant sawtooths.
  buzzer: (s) => { s.playTone({ freq: 110, endFreq: 90, type: 'sawtooth', duration: 0.5, peakGain: 0.3 }); s.playTone({ freq: 110, endFreq: 90, type: 'sawtooth', duration: 0.5, peakGain: 0.25, detune: 35 }); },
  // Bonus multiplier changed.
  blipUp: (s) => s.playTone({ freq: 440, endFreq: 880, type: 'square', duration: 0.1, peakGain: 0.18 }),
  // A mode ended without completing, multiball/FIELD DAY ending.
  blipDown: (s) => s.playTone({ freq: 440, endFreq: 220, type: 'triangle', duration: 0.22, peakGain: 0.18 }),
  // A lock attempt refused (not lit) — quiet and muted, a "no," not a penalty.
  mutedThud: (s) => s.playNoiseBurst({ duration: 0.08, filterHz: 260, peakGain: 0.14 }),
  // 3 quick ascending tones — RECESS MULTIBALL starting.
  multiballFanfare: (s) => { s.playTone({ freq: 523, type: 'triangle', duration: 0.15, peakGain: 0.25 }); s.playTone({ freq: 659, type: 'triangle', duration: 0.15, peakGain: 0.25, delay: 0.08 }); s.playTone({ freq: 784, type: 'triangle', duration: 0.18, peakGain: 0.25, delay: 0.16 }); },
  // A ball saved — a short, reassuring two-note rise, distinct from every other cue: this is
  // the one PLAYTEST-2 fixed as a silent VISUAL gap; giving it a sound closes the same gap the
  // other way.
  saveChime: (s) => { s.playTone({ freq: 440, type: 'sine', duration: 0.15, peakGain: 0.22 }); s.playTone({ freq: 660, type: 'sine', duration: 0.2, peakGain: 0.22, delay: 0.09 }); },
};

// --- Mechanism-tag lookup (raw physics tags) -----------------------------------------------
const MECHANISM_CUES = new Map([
  [SW_POP_DUCK, 'boingDuck'], [SW_POP_HORSE, 'boingHorse'], [SW_POP_ROCKET, 'boingRocket'],
  [SW_SLING_LEFT, 'twang'], [SW_SLING_RIGHT, 'twang'],
  [SW_TETHERBALL_SPIN, 'spinnerClick'], [SW_PINWHEEL_SPIN, 'spinnerClick'],
  [SW_SANDBOX_ENTRY, 'scoopThud'], [SW_SANDBOX_EJECT, 'scoopWhoosh'],
  [SW_KICKBACK, 'kick'],
  [SW_MERRY_GO_ROUND, 'clack'], [SW_TREEHOUSE, 'clack'],
  [SW_SLIDE_EXIT, 'rampChime'], [SW_MONKEYBARS_EXIT, 'rampChime'], [SW_TUNNEL_EXIT, 'rampChime'], [SW_ORBIT_EXIT, 'rampChime'],
  [SW_HOPSCOTCH_COMPLETE, 'chime'], [SW_SAND_COMPLETE, 'chime'],
]);
for (const t of SW_FUN) MECHANISM_CUES.set(t, 'lightDing');
// Individual HOPSCOTCH/S-A-N-D letter hits: string-shaped, not a fixed constant list this
// module imports table config to build (see game/mechanisms.js's own drop-bank targets) — a
// prefix check on the tag's own literal name (table/switches.js: 'hopscotch_1'..'_4',
// 'sand_s'..'_d') is the same information without importing the table just for this.
function mechanismCueName(tag) {
  if (MECHANISM_CUES.has(tag)) return MECHANISM_CUES.get(tag);
  if (tag.startsWith('hopscotch_') || tag.startsWith('sand_')) return 'clack';
  return null;
}

export function playMechanismCue(synth, tag) {
  const name = mechanismCueName(tag);
  if (name) CUES[name](synth);
}

// --- Display-event lookup (rules/game.js's own display kinds) ------------------------------
// Every kind applyDisplayEvents (main.js) switches on, accounted for: a cue name, or an entry
// in NO_CUE_KINDS with the reason it gets none — never an omission this file's own reader
// would have to re-derive by diffing against main.js by hand.
const DISPLAY_CUES = {
  modeStart: () => 'lightDing',
  modeEnd: (d) => (d.success ? 'chime' : 'blipDown'),
  extraBall: () => 'knocker',
  special: () => 'knocker',
  bonusX: () => 'blipUp',
  lockNotLit: () => 'mutedThud',
  jackpotValue: () => 'chime',
  lock: () => 'clack',
  multiballStart: () => 'multiballFanfare',
  multiballEnd: () => 'blipDown',
  tilt: () => 'buzzer',
  slamTilt: () => 'buzzer',
  superJackpotAwarded: () => 'recessBell',
  fieldDayStart: () => 'recessBell',
  fieldDayEnd: () => 'blipDown',
  ballSaved: () => 'saveChime',
};
DISPLAY_CUES['score'] = (d) => (d.tag === 'multiball_jackpot' ? 'recessBell' : null);

// Kinds main.js's applyDisplayEvents consumes that deliberately get NO sound here, and why —
// same discipline SIGNAL-LOST's own comments record at each site for VISUAL feedback,
// applied here for audio:
//   ballServed, turnChange   — silent scene-setting (a fresh ball being served); not an event
//                              a sound should punctuate, and turnChange's own next ball
//                              serving is already covered by ballServed if it fires.
//   gameOver                 — the HUD already carries this permanently (unlike a transient
//                              callout); a final sound was considered and cut as a scoping
//                              choice, not an oversight — recorded here rather than silently
//                              dropped.
//   bonus                    — the moment-screen breakdown is itself the feedback; a per-line
//                              count-up sound (what a real bonus tally sounds like) is a
//                              bigger feature than "every SCORING event has a sound" asks for
//                              tonight — cut, recorded, not built partially.
//   lockedBallServed, addABall, merryGoRoundEject, multiballForceEnd, fieldDayForceEnd
//                             — each is a physical consequence of an event that ALREADY has
//                              its own cue one step earlier in the same sequence (a lock or a
//                              tilt), so a second sound here would be the same moment twice.
export const NO_CUE_KINDS = [
  'ballServed', 'turnChange', 'gameOver', 'bonus',
  'lockedBallServed', 'addABall', 'merryGoRoundEject', 'multiballForceEnd', 'fieldDayForceEnd',
];
// Exported so a test can check this list against main.js's own `d.kind === '...'` occurrences
// directly — the exact discipline the dispatch asked for ("check the list of kinds against
// what you hook"), kept true automatically rather than by someone remembering to re-check it
// the next time a kind is added to either file.
export const DISPLAY_CUE_KINDS = Object.keys(DISPLAY_CUES);

export function playDisplayCue(synth, d) {
  const fn = DISPLAY_CUES[d.kind];
  if (!fn) return;
  const name = fn(d);
  if (name) CUES[name](synth);
}
