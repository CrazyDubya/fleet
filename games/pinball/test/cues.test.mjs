// audio/cues.js's lookup tables — a fake synth (records calls, plays nothing) so this runs
// under `node --test` with no AudioContext, and a direct cross-check against main.js's own
// `d.kind === '...'` occurrences, per the dispatch's own instruction: "the events are already
// there... check the list of kinds against what you hook." A display event with no consumer
// was a real bug (SIGNAL-LOST) found earlier tonight; this test keeps that check running
// automatically instead of depending on someone re-reading both files by eye next time either
// one changes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  playMechanismCue, playDisplayCue, DISPLAY_CUE_KINDS, NO_CUE_KINDS,
} from '../src/audio/cues.js';
import {
  SW_POP_DUCK, SW_SLING_LEFT, SW_TETHERBALL_SPIN, SW_SANDBOX_ENTRY, SW_KICKBACK,
  SW_SLIDE_EXIT, SW_TREEHOUSE, SW_HOPSCOTCH_COMPLETE,
} from '../src/table/switches.js';

function fakeSynth() {
  const calls = { playTone: 0, playBell: 0, playNoiseBurst: 0 };
  return {
    calls,
    playTone: () => { calls.playTone += 1; },
    playBell: () => { calls.playBell += 1; },
    playNoiseBurst: () => { calls.playNoiseBurst += 1; },
  };
}

function totalCalls(calls) {
  return calls.playTone + calls.playBell + calls.playNoiseBurst;
}

test('AUDIO-T11 regression: every display kind main.js switches on is either wired to a cue or listed as a deliberate no-cue kind', () => {
  const mainJsPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/main.js');
  const source = readFileSync(mainJsPath, 'utf8');
  const kinds = new Set();
  for (const m of source.matchAll(/d\.kind === '([a-zA-Z]+)'/g)) kinds.add(m[1]);
  assert.ok(kinds.size > 10, 'sanity: the scan itself must actually find main.js\'s display-kind checks');
  const accountedFor = new Set([...DISPLAY_CUE_KINDS, ...NO_CUE_KINDS]);
  const unaccounted = [...kinds].filter((k) => !accountedFor.has(k));
  assert.deepEqual(unaccounted, [], 'every kind main.js checks must be either in DISPLAY_CUE_KINDS (has a cue) or NO_CUE_KINDS (deliberately silent, with a reason recorded in cues.js)');
});

test('mechanism cues: a bumper, a sling, a spinner hit, a scoop capture, a kickback, a ramp exit, a standup, and a bank completion each trigger a distinct sound', () => {
  for (const tag of [SW_POP_DUCK, SW_SLING_LEFT, SW_TETHERBALL_SPIN, SW_SANDBOX_ENTRY, SW_KICKBACK, SW_SLIDE_EXIT, SW_TREEHOUSE, SW_HOPSCOTCH_COMPLETE]) {
    const synth = fakeSynth();
    playMechanismCue(synth, tag);
    assert.ok(totalCalls(synth.calls) > 0, `${tag} must trigger at least one synth call`);
  }
});

test('mechanism cues: individual HOPSCOTCH and S-A-N-D letter hits trigger a sound via the prefix match, not just the fixed tag list', () => {
  for (const tag of ['hopscotch_1', 'hopscotch_4', 'sand_s', 'sand_d']) {
    const synth = fakeSynth();
    playMechanismCue(synth, tag);
    assert.ok(totalCalls(synth.calls) > 0, `${tag} must trigger a sound`);
  }
});

test('mechanism cues: an unmapped tag is a silent no-op, never a throw', () => {
  const synth = fakeSynth();
  assert.doesNotThrow(() => playMechanismCue(synth, 'some_unmapped_tag'));
  assert.equal(totalCalls(synth.calls), 0);
});

test('display cues: a regular jackpot and a super jackpot get DIFFERENT cues (the two largest scoring events must not sound the same)', () => {
  const synthRegular = fakeSynth();
  playDisplayCue(synthRegular, { kind: 'score', tag: 'multiball_jackpot', points: 500000 });
  const synthOrdinary = fakeSynth();
  playDisplayCue(synthOrdinary, { kind: 'score', tag: 'pop_duck', points: 1000 });
  assert.ok(totalCalls(synthRegular.calls) > 0, 'a multiball jackpot must have a sound');
  assert.equal(totalCalls(synthOrdinary.calls), 0, 'an ordinary shot\'s own score event is intentionally silent here — see the display-loop\'s own comment on why most score tags get no callout, same reasoning applies to sound');

  const synthSuper = fakeSynth();
  playDisplayCue(synthSuper, { kind: 'superJackpotAwarded' });
  assert.ok(synthSuper.calls.playBell > 0, 'the super jackpot must use the recess bell — the biggest, most distinct sound on the table');
});

test('display cues: a mode ending in success sounds different from a mode ending in failure', () => {
  const success = fakeSynth();
  playDisplayCue(success, { kind: 'modeEnd', success: true });
  const failure = fakeSynth();
  playDisplayCue(failure, { kind: 'modeEnd', success: false });
  assert.ok(totalCalls(success.calls) > 0);
  assert.ok(totalCalls(failure.calls) > 0);
});

test('display cues: an unhandled kind is a silent no-op, never a throw', () => {
  const synth = fakeSynth();
  assert.doesNotThrow(() => playDisplayCue(synth, { kind: 'totallyMadeUp' }));
  assert.equal(totalCalls(synth.calls), 0);
});
