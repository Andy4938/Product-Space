import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLocationUploader } from './location-upload.js';

interface Point { recordedAt: string; name: string }

function point(time: number, name: string): Point {
  return { recordedAt: new Date(time).toISOString(), name };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

class FakeClock {
  time = 1_700_000_000_000;
  private nextId = 0;
  private timers = new Map<number, { due: number; callback: () => void }>();

  now = () => this.time;
  setTimer = (callback: () => void, delayMs: number): ReturnType<typeof setTimeout> => {
    const id = ++this.nextId;
    this.timers.set(id, { due: this.time + delayMs, callback });
    return id as unknown as ReturnType<typeof setTimeout>;
  };
  clearTimer = (handle: ReturnType<typeof setTimeout>): void => {
    this.timers.delete(handle as unknown as number);
  };

  async advance(ms: number): Promise<void> {
    const target = this.time + ms;
    while (true) {
      const next = [...this.timers.entries()].sort((a, b) => a[1].due - b[1].due)[0];
      if (!next || next[1].due > target) break;
      this.time = next[1].due;
      this.timers.delete(next[0]);
      next[1].callback();
      await flush();
    }
    this.time = target;
    await flush();
  }
}

test('waits 1100 ms after initial and later successful uploads', async () => {
  const clock = new FakeClock();
  const sent: string[] = [];
  const uploaded = createLocationUploader<Point, string>({
    send: async item => { sent.push(item.name); return item.name; },
    onSuccess: () => {}, onError: () => {}, getAcceptedRecordedAt: () => -Infinity,
    initialLastSuccessAt: clock.time, now: clock.now,
    setTimer: clock.setTimer, clearTimer: clock.clearTimer,
  });
  uploaded.push(point(clock.time, 'first'));
  assert.deepEqual(sent, []);
  await clock.advance(1099);
  assert.deepEqual(sent, []);
  await clock.advance(1);
  assert.deepEqual(sent, ['first']);
  uploaded.push(point(clock.time + 1, 'second'));
  await clock.advance(1099);
  assert.deepEqual(sent, ['first']);
  await clock.advance(1);
  assert.deepEqual(sent, ['first', 'second']);
  uploaded.stop();
});

test('keeps the latest sample during a slow request and never overlaps sends', async () => {
  const clock = new FakeClock();
  const first = deferred<string>();
  const second = deferred<string>();
  const sent: string[] = [];
  let active = 0;
  let maximumActive = 0;
  const uploaded = createLocationUploader<Point, string>({
    send: async item => {
      sent.push(item.name);
      active++;
      maximumActive = Math.max(maximumActive, active);
      try { return await (sent.length === 1 ? first.promise : second.promise); }
      finally { active--; }
    },
    onSuccess: () => {}, onError: () => {}, getAcceptedRecordedAt: () => -Infinity,
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
  });
  uploaded.push(point(clock.time, 'first'));
  uploaded.push(point(clock.time + 1, 'older pending'));
  uploaded.push(point(clock.time + 2, 'latest pending'));
  await clock.advance(5000);
  assert.deepEqual(sent, ['first']);
  first.resolve('ok');
  await flush();
  await clock.advance(1099);
  assert.deepEqual(sent, ['first']);
  await clock.advance(1);
  assert.deepEqual(sent, ['first', 'latest pending']);
  assert.equal(maximumActive, 1);
  second.resolve('ok');
  await flush();
  uploaded.stop();
});

test('failure backs off and retries the newest pending point; manual retry clears backoff', async () => {
  const clock = new FakeClock();
  const first = deferred<string>();
  const sent: string[] = [];
  const errors: unknown[] = [];
  const uploaded = createLocationUploader<Point, string>({
    send: item => {
      sent.push(item.name);
      return sent.length === 1 ? first.promise : Promise.resolve('ok');
    },
    onSuccess: () => {}, onError: error => errors.push(error), getAcceptedRecordedAt: () => -Infinity,
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
  });
  uploaded.push(point(clock.time, 'failed'));
  uploaded.push(point(clock.time + 1, 'newer'));
  first.reject(new Error('offline'));
  await flush();
  assert.equal(errors.length, 1);
  await clock.advance(500);
  uploaded.push(point(clock.time, 'newest'));
  await clock.advance(1499);
  assert.deepEqual(sent, ['failed']);
  await clock.advance(1);
  assert.deepEqual(sent, ['failed', 'newest']);
  uploaded.stop();

  const retryClock = new FakeClock();
  const retrySent: string[] = [];
  const retryUploader = createLocationUploader<Point, string>({
    send: async item => {
      retrySent.push(item.name);
      if (retrySent.length === 1) throw new Error('offline');
      return 'ok';
    },
    onSuccess: () => {}, onError: () => {}, getAcceptedRecordedAt: () => -Infinity,
    now: retryClock.now, setTimer: retryClock.setTimer, clearTimer: retryClock.clearTimer,
  });
  retryUploader.push(point(retryClock.time, 'retry me'));
  await flush();
  assert.deepEqual(retrySent, ['retry me']);
  retryUploader.retry();
  await flush();
  assert.deepEqual(retrySent, ['retry me', 'retry me']);
  retryUploader.stop();
});

test('drops points already accepted elsewhere or too old when their timer fires', async () => {
  const clock = new FakeClock();
  const sent: string[] = [];
  let accepted = -Infinity;
  const uploaded = createLocationUploader<Point, string>({
    send: async item => { sent.push(item.name); return 'ok'; },
    onSuccess: () => {}, onError: () => {}, getAcceptedRecordedAt: () => accepted,
    initialLastSuccessAt: clock.time, now: clock.now,
    setTimer: clock.setTimer, clearTimer: clock.clearTimer,
  });
  const alreadyAccepted = point(clock.time + 100, 'accepted elsewhere');
  uploaded.push(alreadyAccepted);
  accepted = Date.parse(alreadyAccepted.recordedAt);
  await clock.advance(1100);
  assert.deepEqual(sent, []);
  uploaded.push(point(clock.time - 105_001, 'stale'));
  uploaded.push(alreadyAccepted);
  assert.deepEqual(sent, []);
  uploaded.push(point(clock.time, 'fresh'));
  await flush();
  assert.deepEqual(sent, ['fresh']);
  uploaded.stop();
});

test('stop drops queued work and suppresses late callbacks', async () => {
  const clock = new FakeClock();
  const first = deferred<string>();
  const sent: string[] = [];
  const callbacks: string[] = [];
  const uploaded = createLocationUploader<Point, string>({
    send: item => { sent.push(item.name); return first.promise; },
    onSuccess: () => callbacks.push('success'),
    onError: () => callbacks.push('error'),
    getAcceptedRecordedAt: () => -Infinity,
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
  });
  uploaded.push(point(clock.time, 'in flight'));
  uploaded.push(point(clock.time + 1, 'queued'));
  uploaded.stop();
  first.resolve('ok');
  await flush();
  uploaded.push(point(clock.time + 2, 'after stop'));
  uploaded.retry();
  await clock.advance(10_000);
  assert.deepEqual(sent, ['in flight']);
  assert.deepEqual(callbacks, []);
});
