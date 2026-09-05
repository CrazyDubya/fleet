import test from 'node:test';
import assert from 'node:assert/strict';
import { drainTagFor, mechanismTags, SW_DRAIN, SW_BALL_LOST } from '../src/table/switches.js';

test('drainTagFor: SW_DRAIN iff no live balls remain, SW_BALL_LOST otherwise', () => {
  for (let liveBallsRemaining = 0; liveBallsRemaining <= 5; liveBallsRemaining++) {
    const tag = drainTagFor({ liveBallsRemaining });
    assert.ok(tag === SW_DRAIN || tag === SW_BALL_LOST, `unexpected tag ${tag}`);
    assert.equal(tag === SW_DRAIN, liveBallsRemaining === 0, `liveBallsRemaining=${liveBallsRemaining}`);
  }
});

test('mechanismTags includes each supplied ramp id\'s exit and rollback tags', () => {
  const tags = mechanismTags({ slide: 'slide', monkeyBars: 'monkey_bars', tunnel: 'tunnel', orbit: 'orbit' });
  for (const id of ['slide', 'monkey_bars', 'tunnel', 'orbit']) {
    assert.ok(tags.has(`${id}_exit`), `expected ${id}_exit in mechanismTags`);
    assert.ok(tags.has(`${id}_rollback`), `expected ${id}_rollback in mechanismTags`);
  }
});
