import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { CreateSessionResponse, SessionSnapshot } from '../src/api-types.js';
import { createApp } from './app.js';
import { SessionStore } from './store.js';

interface JsonResponse<T = unknown> {
  status: number;
  cacheControl: string | null;
  referrerPolicy: string | null;
  body: T;
}

function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'ghostsignal-test-'));
  const dbPath = join(dir, 'sessions.sqlite');
  const clock = { now: Date.parse('2026-10-02T18:00:00.000Z') };
  const store = new SessionStore(dbPath, () => clock.now);
  const server = createApp(store).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    await new Promise<void>((done) => server.close(() => done()));
    store.close();
    const root = resolve(tmpdir()) + sep;
    assert.ok(resolve(dir).startsWith(root));
    rmSync(dir, { recursive: true, force: true });
  });
  return { base, clock, store, dbPath, server };
}

async function json<T = unknown>(base: string, path: string, options: {
  method?: string;
  token?: string;
  body?: unknown;
} = {}): Promise<JsonResponse<T>> {
  const response = await fetch(base + path, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return {
    status: response.status,
    cacheControl: response.headers.get('cache-control'),
    referrerPolicy: response.headers.get('referrer-policy'),
    body: await response.json() as T,
  };
}

test('guardian can read live updates but cannot mutate; end redacts coordinates and survives restart', async (t) => {
  const { base, clock, dbPath } = setup(t);
  const created = await json<CreateSessionResponse>(base, '/api/sessions', {
    method: 'POST', body: { mode: 'live' },
  });
  assert.equal(created.status, 201);
  assert.equal(created.cacheControl, 'no-store');
  assert.equal(created.referrerPolicy, 'strict-origin');
  const { sessionId, ownerToken, guardianToken } = created.body;
  assert.notEqual(ownerToken, guardianToken);
  assert.equal(created.body.session.mode, 'live');

  const path = `/api/sessions/${sessionId}`;
  const missingAuth = await json(base, path);
  assert.equal(missingAuth.status, 401);
  assert.equal(missingAuth.cacheControl, 'no-store');
  assert.equal((await json(base, path, { token: 'x'.repeat(43) })).status, 404);
  assert.equal((await json(base, path, { token: guardianToken })).status, 200);

  const location = { latitude: 40.1106, longitude: -88.2073, accuracy: 12, recordedAt: new Date(clock.now).toISOString() };
  assert.equal((await json(base, `${path}/locations`, { method: 'POST', token: guardianToken, body: location })).status, 403);
  assert.equal((await json(base, `${path}/help`, { method: 'POST', token: guardianToken })).status, 403);
  assert.equal((await json(base, `${path}/end`, { method: 'POST', token: guardianToken })).status, 403);

  const updated = await json<SessionSnapshot>(base, `${path}/locations`, { method: 'POST', token: ownerToken, body: location });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.location?.latitude, location.latitude);
  assert.equal(updated.body.trail.length, 1);
  assert.equal((await json<SessionSnapshot>(base, path, { token: guardianToken })).body.location?.longitude, location.longitude);

  const helped = await json<SessionSnapshot>(base, `${path}/help`, { method: 'POST', token: ownerToken });
  assert.equal(helped.body.status, 'help_requested');
  const helpedAgain = await json<SessionSnapshot>(base, `${path}/help`, { method: 'POST', token: ownerToken });
  assert.equal(helpedAgain.body.helpRequestedAt, helped.body.helpRequestedAt);

  const ended = await json<SessionSnapshot>(base, `${path}/end`, { method: 'POST', token: ownerToken });
  assert.equal(ended.body.status, 'ended');
  assert.equal(ended.body.endedReason, 'safe');
  assert.equal(ended.body.location, null);
  assert.deepEqual(ended.body.trail, []);
  assert.deepEqual((await json<SessionSnapshot>(base, `${path}/end`, { method: 'POST', token: ownerToken })).body, ended.body);
  assert.equal((await json<SessionSnapshot>(base, path, { token: guardianToken })).body.location, null);
  assert.equal((await json(base, `${path}/locations`, { method: 'POST', token: ownerToken, body: location })).status, 409);
  assert.equal((await json(base, `${path}/help`, { method: 'POST', token: ownerToken })).status, 409);

  const reopened = new SessionStore(dbPath, () => clock.now);
  try {
    assert.deepEqual(reopened.read(sessionId, guardianToken).trail, []);
    assert.equal(reopened.read(sessionId, ownerToken).location, null);
  } finally {
    reopened.close();
  }
});

test('a fixed two-hour expiry redacts location even when an owner has recently updated it', async (t) => {
  const { base, clock, store } = setup(t);
  const created = (await json<CreateSessionResponse>(base, '/api/sessions', {
    method: 'POST', body: { mode: 'demo' },
  })).body;
  const path = `/api/sessions/${created.sessionId}`;
  clock.now += 2 * 60 * 60 * 1000 - 30_000;
  const location = { latitude: 40.11, longitude: -88.2, accuracy: 15, recordedAt: new Date(clock.now).toISOString() };
  assert.equal((await json(base, `${path}/locations`, { method: 'POST', token: created.ownerToken, body: location })).status, 200);
  clock.now += 30_001;
  assert.equal(store.expireDue(), 1);
  const expired = await json<SessionSnapshot>(base, path, { token: created.guardianToken });
  assert.equal(expired.body.status, 'ended');
  assert.equal(expired.body.endedReason, 'expired');
  assert.equal(expired.body.location, null);
  assert.deepEqual(expired.body.trail, []);
  assert.equal((await json(base, `${path}/locations`, { method: 'POST', token: created.ownerToken, body: location })).status, 409);
  const endedAgain = await json<SessionSnapshot>(base, `${path}/end`, { method: 'POST', token: created.ownerToken });
  assert.equal(endedAgain.status, 200);
  assert.deepEqual(endedAgain.body, expired.body);
});

test('invalid, stale, future, and out-of-order locations are rejected', async (t) => {
  const { base, clock } = setup(t);
  const created = (await json<CreateSessionResponse>(base, '/api/sessions', {
    method: 'POST', body: { mode: 'live' },
  })).body;
  const path = `/api/sessions/${created.sessionId}/locations`;
  const valid = { latitude: 40.11, longitude: -88.2, accuracy: 8, recordedAt: new Date(clock.now).toISOString() };
  const send = (body: unknown) => json(base, path, { method: 'POST', token: created.ownerToken, body });
  assert.equal((await send({ ...valid, latitude: 91 })).status, 400);
  assert.equal((await send({ ...valid, longitude: -181 })).status, 400);
  assert.equal((await send({ ...valid, accuracy: -1 })).status, 400);
  assert.equal((await send({ ...valid, recordedAt: new Date(clock.now + 31_000).toISOString() })).status, 400);
  assert.equal((await send({ ...valid, recordedAt: new Date(clock.now - 121_000).toISOString() })).status, 400);
  assert.equal((await send(valid)).status, 200);
  assert.equal((await send({ ...valid, recordedAt: new Date(clock.now + 1).toISOString() })).status, 429);
  clock.now += 1000;
  assert.equal((await send(valid)).status, 409);
  assert.equal((await send({ ...valid, recordedAt: new Date(clock.now).toISOString() })).status, 200);
});
