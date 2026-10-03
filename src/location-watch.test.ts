import assert from 'node:assert/strict';
import test from 'node:test';
import { startLocationWatch } from './location-watch.js';

class FakeClock {
  time = 0;
  private nextId = 1;
  private tasks = new Map<number, { at: number; every: number | null; run: () => void }>();

  setTimeout = (run: () => void, delay: number): number => this.add(run, delay, null);
  clearTimeout = (id: unknown): void => { this.tasks.delete(id as number); };
  setInterval = (run: () => void, delay: number): number => this.add(run, delay, delay);
  clearInterval = (id: unknown): void => { this.tasks.delete(id as number); };

  private add(run: () => void, delay: number, every: number | null): number {
    const id = this.nextId++;
    this.tasks.set(id, { at: this.time + delay, every, run });
    return id;
  }

  advance(ms: number): void {
    const end = this.time + ms;
    while (true) {
      let next: [number, { at: number; every: number | null; run: () => void }] | null = null;
      for (const entry of this.tasks) {
        if (entry[1].at <= end && (!next || entry[1].at < next[1].at)) next = entry;
      }
      if (!next) break;
      const [id, task] = next;
      this.time = task.at;
      if (task.every === null) this.tasks.delete(id);
      else task.at += task.every;
      task.run();
    }
    this.time = end;
  }
}

type Success = PositionCallback;
type Failure = PositionErrorCallback;

class FakeGeolocation {
  watchSuccess: Success | null = null;
  watchFailure: Failure | null = null;
  recoveries: Array<{ success: Success; failure: Failure }> = [];
  watchOptions: PositionOptions | undefined;
  recoveryOptions: PositionOptions[] = [];
  cleared: number[] = [];

  watchPosition = (success: Success, failure?: Failure | null, options?: PositionOptions): number => {
    this.watchSuccess = success;
    this.watchFailure = failure ?? null;
    this.watchOptions = options;
    return 7;
  };
  clearWatch = (id: number): void => { this.cleared.push(id); };
  getCurrentPosition = (success: Success, failure?: Failure | null, options?: PositionOptions): void => {
    this.recoveries.push({ success, failure: failure! });
    this.recoveryOptions.push(options!);
  };
}

function position(timestamp: number): GeolocationPosition {
  return { timestamp, coords: { latitude: 40.1, longitude: -88.2, accuracy: 12 } } as GeolocationPosition;
}

function denied(): GeolocationPositionError {
  return { code: 1, message: 'denied', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 };
}

function unavailable(): GeolocationPositionError {
  return { code: 2, message: 'unavailable', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 };
}

function setup(visible = true) {
  const clock = new FakeClock();
  const geo = new FakeGeolocation();
  const captures: GeolocationPosition[] = [];
  const errors: Array<GeolocationPositionError | Error> = [];
  let foreground = visible;
  const start = () => startLocationWatch({
    geolocation: geo,
    onPosition: capture => captures.push(capture),
    onError: error => errors.push(error),
    isVisible: () => foreground,
    now: () => clock.time,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  return { clock, geo, captures, errors, start, setVisible: (value: boolean) => { foreground = value; } };
}

test('starts a high accuracy watch, recovers after stale capture, and keeps original timestamps', () => {
  const { clock, geo, captures, start } = setup();
  const watcher = start();
  assert.deepEqual(geo.watchOptions, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
  geo.watchSuccess!(position(0));
  clock.advance(9999);
  assert.equal(geo.recoveries.length, 0);
  clock.advance(1);
  assert.equal(geo.recoveries.length, 1);
  assert.deepEqual(geo.recoveryOptions[0], geo.watchOptions);
  const recovered = position(10000);
  geo.recoveries[0].success(recovered);
  geo.watchSuccess!(position(10000));
  geo.watchSuccess!(position(9000));
  assert.deepEqual(captures, [captures[0], recovered]);
  assert.equal(captures[1].timestamp, 10000);
  watcher.stop();
});

test('recovery waits while hidden and refresh checks immediately when visible', () => {
  const { clock, geo, start, setVisible } = setup(false);
  const watcher = start();
  clock.advance(15000);
  assert.equal(geo.recoveries.length, 0);
  setVisible(true);
  watcher.refresh();
  assert.equal(geo.recoveries.length, 1);
  watcher.refresh();
  assert.equal(geo.recoveries.length, 1);
  watcher.stop();
});

test('a silent recovery cannot pile up; its late callback is ignored after guard expiry', () => {
  const { clock, geo, captures, start } = setup();
  const watcher = start();
  clock.advance(10000);
  assert.equal(geo.recoveries.length, 1);
  clock.advance(15000);
  assert.equal(geo.recoveries.length, 1);
  clock.advance(1000);
  assert.equal(geo.recoveries.length, 2);
  geo.recoveries[0].success(position(26000));
  assert.equal(captures.length, 0);
  geo.recoveries[1].success(position(26001));
  assert.equal(captures.length, 1);
  watcher.stop();
});

test('permission denial blocks recovery and invalidates an in-flight request until restart', () => {
  const { clock, geo, errors, captures, start } = setup();
  const watcher = start();
  clock.advance(10000);
  geo.watchFailure!(denied());
  assert.equal(errors.length, 1);
  geo.recoveries[0].success(position(12000));
  assert.equal(captures.length, 0);
  clock.advance(40000);
  watcher.refresh();
  assert.equal(geo.recoveries.length, 1);
  watcher.stop();

  const restarted = start();
  clock.advance(10000);
  assert.equal(geo.recoveries.length, 2);
  restarted.stop();
});

test('a recovery failure does not override a newer fix from the normal watch', () => {
  const { clock, geo, errors, captures, start } = setup();
  const watcher = start();
  clock.advance(10000);
  geo.watchSuccess!(position(11000));
  geo.recoveries[0].failure(unavailable());
  assert.equal(captures.length, 1);
  assert.equal(errors.length, 0);
  watcher.stop();
});

test('stop clears timers and watch and ignores all subsequent callbacks', () => {
  const { clock, geo, errors, captures, start } = setup();
  const watcher = start();
  clock.advance(10000);
  watcher.stop();
  assert.deepEqual(geo.cleared, [7]);
  geo.watchSuccess!(position(11000));
  geo.watchFailure!(denied());
  geo.recoveries[0].success(position(12000));
  geo.recoveries[0].failure(denied());
  clock.advance(30000);
  watcher.refresh();
  assert.equal(captures.length, 0);
  assert.equal(errors.length, 0);
  assert.equal(geo.recoveries.length, 1);
});
