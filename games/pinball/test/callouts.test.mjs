// ui/callouts.js's pure queue/scope logic (createCalloutLayer itself touches the DOM — see
// that file's own doc comment on why the bookkeeping is split out to be testable here without
// one).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCalloutQueue, enqueueCallout, clearScope, advanceCallout } from '../src/ui/callouts.js';

test('messages queue FIFO; unscoped messages are unaffected by clearScope', () => {
  const q = createCalloutQueue();
  enqueueCallout(q, 'first');
  enqueueCallout(q, 'second');
  assert.equal(clearScope(q, 'anything'), false, 'nothing in this queue has that scope');
  assert.equal(advanceCallout(q).text, 'first');
  assert.equal(advanceCallout(q).text, 'second');
  assert.equal(advanceCallout(q), null);
});

test('a queued-but-not-yet-shown message tied to an ended scope is dropped, never shown', () => {
  const q = createCalloutQueue();
  enqueueCallout(q, 'ball 1 warning', { scope: 'ball-1' });
  enqueueCallout(q, 'unrelated announcement'); // no scope — must survive
  // Ball 1 ends before its warning was ever displayed.
  clearScope(q, 'ball-1');
  const shown = advanceCallout(q);
  assert.equal(shown.text, 'unrelated announcement', 'the scoped message must never surface, not even briefly');
  assert.equal(advanceCallout(q), null);
});

test('a callout cleared when the state that produced it ends: the CURRENTLY SHOWING message is dismissed too', () => {
  const q = createCalloutQueue();
  enqueueCallout(q, "TEACHER'S WATCHING", { scope: 'ball-1' });
  advanceCallout(q); // now showing
  assert.equal(q.current.text, "TEACHER'S WATCHING");
  const mustAdvance = clearScope(q, 'ball-1');
  assert.equal(mustAdvance, true, 'the caller must be told to dismiss the visible message, not just the queue');
});

test('clearScope only touches its own scope — a different scope, or no scope, is left alone', () => {
  const q = createCalloutQueue();
  enqueueCallout(q, 'ball 1 warning', { scope: 'ball-1' });
  enqueueCallout(q, 'ball 2 warning', { scope: 'ball-2' });
  enqueueCallout(q, 'score announcement'); // unscoped
  clearScope(q, 'ball-1');
  const remaining = q.queue.map((m) => m.text);
  assert.deepEqual(remaining, ['ball 2 warning', 'score announcement']);
});

test('the queue survives multiple messages under the SAME scope — all are dropped together when it ends', () => {
  const q = createCalloutQueue();
  enqueueCallout(q, 'warning 1', { scope: 'ball-1' });
  enqueueCallout(q, 'warning 2', { scope: 'ball-1' });
  enqueueCallout(q, 'unrelated');
  clearScope(q, 'ball-1');
  assert.deepEqual(q.queue.map((m) => m.text), ['unrelated']);
});

test('an unscoped message (score/award-style) is never removed by any clearScope call', () => {
  const q = createCalloutQueue();
  enqueueCallout(q, 'SUPER JACKPOT!'); // scope: null by default
  advanceCallout(q);
  assert.equal(clearScope(q, null), false, 'null is not a real scope to clear against — an unscoped message is not "in" scope null for clearing purposes');
  assert.equal(q.current.text, 'SUPER JACKPOT!', 'still showing');
});
