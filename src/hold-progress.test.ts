import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmergencyFlow, INITIAL_EMERGENCY_STATE } from './hold-progress';

function harness() {
  let now = 0;
  let id = 0;
  let state = { ...INITIAL_EMERGENCY_STATE };
  const frames = new Map<number, () => void>();
  const flow = createEmergencyFlow(value => { state = value; }, {
    now: () => now,
    request: callback => { frames.set(++id, callback); return id; },
    cancel: key => { frames.delete(key); },
  });
  return {
    flow,
    get state() { return state; },
    elapse(ms: number) { now += ms; },
    advance(ms: number) {
      now += ms;
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach(frame => frame());
    },
  };
}

test('three-second emergency hold opens a three-second cancel window', () => {
  const h = harness();
  h.flow.begin();
  h.advance(1500);
  assert.equal(h.state.progress, .5);
  h.advance(1499);
  assert.equal(h.state.phase, 'emergency-holding');
  h.advance(1);
  assert.deepEqual(h.state, { phase: 'cancel-ready', progress: 0, remaining: 3000 });
  h.flow.release(); // Original press must not cancel the new window.
  h.advance(2999);
  assert.equal(h.state.phase, 'cancel-ready');
  h.advance(1);
  assert.equal(h.state.phase, 'complete');
});

test('early emergency release resets the ring and retry needs a full hold', () => {
  const h = harness();
  h.flow.begin();
  h.advance(2900);
  h.flow.release();
  h.advance(4000);
  assert.equal(h.state.phase, 'idle');
  assert.equal(h.state.progress, 0);
  h.flow.begin();
  h.advance(1500);
  assert.equal(h.state.progress, .5);
});

test('starting cancel just before expiry pauses the deadline for a full three-second hold', () => {
  const h = harness();
  h.flow.begin();
  h.advance(3000);
  h.flow.release();
  h.advance(2900);
  h.flow.begin();
  h.advance(1500);
  assert.deepEqual(h.state, { phase: 'cancel-holding', progress: .5, remaining: 100 });
  h.advance(1499);
  assert.equal(h.state.phase, 'cancel-holding');
  h.advance(1);
  assert.equal(h.state.phase, 'cancelled');
  h.flow.release();
  h.advance(5000);
  assert.equal(h.state.phase, 'cancelled');
});

test('early cancel release resumes only the unspent window, not a fresh three seconds', () => {
  const h = harness();
  h.flow.begin();
  h.advance(3000);
  h.flow.release();
  h.advance(2000);
  h.flow.begin();
  h.advance(2500);
  h.flow.release();
  assert.deepEqual(h.state, { phase: 'cancel-ready', progress: 0, remaining: 1000 });
  h.advance(999);
  assert.equal(h.state.phase, 'cancel-ready');
  h.advance(1);
  assert.equal(h.state.phase, 'complete');
});

test('cancel retry starts a fresh hold but retains remaining window time', () => {
  const h = harness();
  h.flow.begin();
  h.advance(3000);
  h.flow.release();
  h.advance(1000);
  h.flow.begin();
  h.advance(2000);
  h.flow.release();
  h.advance(500);
  h.flow.begin();
  h.advance(1500);
  assert.equal(h.state.progress, .5);
  assert.equal(h.state.remaining, 1500);
  h.advance(1500);
  assert.equal(h.state.phase, 'cancelled');
});

test('expired window rejects a cancel press even before the next animation frame', () => {
  const h = harness();
  h.flow.begin();
  h.advance(3000);
  h.flow.release();
  h.elapse(3000);
  assert.equal(h.flow.begin(), false);
  assert.equal(h.state.phase, 'complete');
});

test('repeated input cannot restart an active hold; dispose stops pending work', () => {
  const h = harness();
  h.flow.begin();
  h.advance(2000);
  assert.equal(h.flow.begin(), false);
  h.advance(1000);
  assert.equal(h.state.phase, 'cancel-ready');
  h.flow.dispose();
  h.advance(5000);
  assert.equal(h.state.phase, 'cancel-ready');
});

test('completed and cancelled demos can start a new emergency hold', () => {
  for (const cancel of [false, true]) {
    const h = harness();
    h.flow.begin();
    h.advance(3000);
    h.flow.release();
    if (cancel) h.flow.begin();
    h.advance(3000);
    h.flow.release();
    h.flow.begin();
    assert.equal(h.state.phase, 'emergency-holding');
    assert.equal(h.state.progress, 0);
  }
});
