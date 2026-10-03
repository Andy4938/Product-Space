import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import type { CreateSessionResponse, DispatchIncident, DispatchIncidentList, PushSubscriptionInput, SessionSnapshot } from '../src/api-types.js';
import { createApp } from './app.js';
import type { GuardianAlert, Notifier, PushPayload, PushResult } from './notify.js';
import { CANCEL_GRACE_MS, SessionStore } from './store.js';

interface JsonResponse<T = unknown> {
  status: number;
  cacheControl: string | null;
  referrerPolicy: string | null;
  body: T;
}

const DISPATCH_CODE = 'test-dispatch-code';

function recordingNotifier(pushResult: PushResult = 'sent') {
  const sms: GuardianAlert[] = [];
  const pushes: { subscription: PushSubscriptionInput; payload: PushPayload }[] = [];
  const notifier: Notifier = {
    publicPushKey: 'test-public-key',
    sms: (alert) => { sms.push(alert); },
    push: async (subscription, payload) => { pushes.push({ subscription, payload }); return pushResult; },
  };
  return { sms, pushes, notifier };
}

// Most suites test behavior after a signal reaches dispatch, so they release signals immediately.
function setup(t: TestContext, recorder = recordingNotifier(), cancelGraceMs = 0) {
  const dir = mkdtempSync(join(tmpdir(), 'ghostsignal-test-'));
  const dbPath = join(dir, 'sessions.sqlite');
  const clock = { now: Date.parse('2026-10-02T18:00:00.000Z') };
  const store = new SessionStore(dbPath, () => clock.now, recorder.notifier, cancelGraceMs);
  const server = createApp(store, { dispatchCode: DISPATCH_CODE }).listen(0);
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
  assert.equal((await json(base, `${path}/help/retract`, { method: 'POST', token: guardianToken })).status, 403);
  assert.equal((await json(base, `${path}/end`, { method: 'POST', token: guardianToken })).status, 403);

  const updated = await json<SessionSnapshot>(base, `${path}/locations`, { method: 'POST', token: ownerToken, body: location });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.location?.latitude, location.latitude);
  assert.equal(updated.body.trail.length, 1);
  assert.ok(Date.parse(updated.body.updatedAt) > Date.parse(created.body.session.updatedAt));
  assert.equal((await json<SessionSnapshot>(base, path, { token: guardianToken })).body.location?.longitude, location.longitude);

  const helped = await json<SessionSnapshot>(base, `${path}/help`, { method: 'POST', token: ownerToken });
  assert.equal(helped.body.status, 'help_requested');
  assert.ok(Date.parse(helped.body.updatedAt) > Date.parse(updated.body.updatedAt));
  assert.equal(helped.body.helpRequestedAt, new Date(clock.now).toISOString());
  const helpedAgain = await json<SessionSnapshot>(base, `${path}/help`, { method: 'POST', token: ownerToken });
  assert.equal(helpedAgain.body.helpRequestedAt, helped.body.helpRequestedAt);
  assert.equal(helpedAgain.body.updatedAt, helped.body.updatedAt);

  const retracted = await json<SessionSnapshot>(base, `${path}/help/retract`, { method: 'POST', token: ownerToken });
  assert.equal(retracted.body.status, 'active');
  assert.equal(retracted.body.helpRequestedAt, null);
  assert.deepEqual(retracted.body.location, helped.body.location);
  assert.deepEqual(retracted.body.trail, helped.body.trail);
  assert.equal(retracted.body.expiresAt, helped.body.expiresAt);
  assert.ok(Date.parse(retracted.body.updatedAt) > Date.parse(helped.body.updatedAt));
  assert.deepEqual((await json<SessionSnapshot>(base, path, { token: guardianToken })).body, retracted.body);
  const retractedAgain = await json<SessionSnapshot>(base, `${path}/help/retract`, { method: 'POST', token: ownerToken });
  assert.deepEqual(retractedAgain.body, retracted.body);

  const persistedRetract = new SessionStore(dbPath, () => clock.now);
  try {
    assert.equal(persistedRetract.read(sessionId, guardianToken).status, 'active');
    assert.equal(persistedRetract.read(sessionId, ownerToken).helpRequestedAt, null);
  } finally {
    persistedRetract.close();
  }

  clock.now += 1000;
  const nextLocation = { ...location, latitude: 40.1107, recordedAt: new Date(clock.now).toISOString() };
  const continued = await json<SessionSnapshot>(base, `${path}/locations`, { method: 'POST', token: ownerToken, body: nextLocation });
  assert.equal(continued.status, 200);
  assert.equal(continued.body.status, 'active');
  assert.equal(continued.body.trail.length, 2);
  assert.ok(Date.parse(continued.body.updatedAt) > Date.parse(retracted.body.updatedAt));

  const escalatedAgain = await json<SessionSnapshot>(base, `${path}/help`, { method: 'POST', token: ownerToken });
  assert.equal(escalatedAgain.body.status, 'help_requested');
  assert.equal(escalatedAgain.body.helpRequestedAt, new Date(clock.now).toISOString());
  assert.ok(Date.parse(escalatedAgain.body.updatedAt) > Date.parse(continued.body.updatedAt));

  const ended = await json<SessionSnapshot>(base, `${path}/end`, { method: 'POST', token: ownerToken });
  assert.equal(ended.body.status, 'ended');
  assert.equal(ended.body.endedReason, 'safe');
  assert.equal(ended.body.location, null);
  assert.deepEqual(ended.body.trail, []);
  assert.ok(Date.parse(ended.body.updatedAt) > Date.parse(escalatedAgain.body.updatedAt));
  assert.deepEqual((await json<SessionSnapshot>(base, `${path}/end`, { method: 'POST', token: ownerToken })).body, ended.body);
  assert.equal((await json<SessionSnapshot>(base, path, { token: guardianToken })).body.location, null);
  assert.equal((await json(base, `${path}/locations`, { method: 'POST', token: ownerToken, body: location })).status, 409);
  assert.equal((await json(base, `${path}/help`, { method: 'POST', token: ownerToken })).status, 409);
  assert.equal((await json(base, `${path}/help/retract`, { method: 'POST', token: ownerToken })).status, 409);

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
  clock.now += 2 * 60 * 60 * 1000 - 1;
  const location = { latitude: 40.11, longitude: -88.2, accuracy: 15, recordedAt: new Date(clock.now).toISOString() };
  assert.equal((await json(base, `${path}/locations`, { method: 'POST', token: created.ownerToken, body: location })).status, 200);
  const helped = await json<SessionSnapshot>(base, `${path}/help`, { method: 'POST', token: created.ownerToken });
  const retracted = await json<SessionSnapshot>(base, `${path}/help/retract`, { method: 'POST', token: created.ownerToken });
  assert.ok(Date.parse(retracted.body.updatedAt) > Date.parse(helped.body.updatedAt));
  clock.now += 2;
  assert.equal(store.expireDue(), 1);
  const expired = await json<SessionSnapshot>(base, path, { token: created.guardianToken });
  assert.equal(expired.body.status, 'ended');
  assert.equal(expired.body.endedReason, 'expired');
  assert.equal(expired.body.location, null);
  assert.deepEqual(expired.body.trail, []);
  assert.ok(Date.parse(expired.body.updatedAt) > Date.parse(retracted.body.updatedAt));
  assert.equal((await json(base, `${path}/locations`, { method: 'POST', token: created.ownerToken, body: location })).status, 409);
  assert.equal((await json(base, `${path}/help/retract`, { method: 'POST', token: created.ownerToken })).status, 409);
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

const PUSH_SUBSCRIPTION = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/test-device',
  keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' },
};

test('a help press opens a Campus Safety incident the dispatcher can acknowledge, dispatch, and close', async (t) => {
  const recorder = recordingNotifier();
  const { base, clock, dbPath } = setup(t, recorder);
  const created = (await json<CreateSessionResponse>(base, '/api/sessions', { method: 'POST', body: { mode: 'live' } })).body;
  const path = `/api/sessions/${created.sessionId}`;
  const owner = created.ownerToken;
  const dispatch = (route: string, body?: unknown, token = DISPATCH_CODE) =>
    json<DispatchIncident>(base, `/api/dispatch/incidents${route}`, { method: body === undefined && !route ? 'GET' : 'POST', token, body });

  assert.equal((await json(base, '/api/dispatch/incidents')).status, 401);
  assert.equal((await json(base, '/api/dispatch/incidents', { token: 'wrong-code' })).status, 401);
  assert.deepEqual((await json<DispatchIncidentList>(base, '/api/dispatch/incidents', { token: DISPATCH_CODE })).body.incidents, []);

  await json(base, `${path}/contacts`, { method: 'POST', token: owner, body: { walkerDescription: '  red   jacket, black backpack ', guardianPhone: '(217) 555-0123' } });
  const location = { latitude: 40.1092, longitude: -88.2272, accuracy: 9, recordedAt: new Date(clock.now).toISOString() };
  await json(base, `${path}/locations`, { method: 'POST', token: owner, body: location });
  assert.equal((await json(base, `${path}/push-subscriptions`, { method: 'POST', token: created.guardianToken, body: PUSH_SUBSCRIPTION })).status, 201);

  const helped = (await json<SessionSnapshot>(base, `${path}/help`, { method: 'POST', token: owner })).body;
  assert.equal(helped.incident?.status, 'new');
  assert.equal(helped.incident?.walkerCancelledAt, null);
  assert.match(helped.incident!.reference, /^GS-[0-9A-F]{6}$/);
  await json(base, `${path}/help`, { method: 'POST', token: owner });

  const listed = (await json<DispatchIncidentList>(base, '/api/dispatch/incidents', { token: DISPATCH_CODE })).body.incidents;
  assert.equal(listed.length, 1);
  const incident = listed[0];
  assert.equal(incident.walkerDescription, 'red jacket, black backpack');
  assert.equal(incident.location?.latitude, location.latitude);
  assert.equal(incident.guardianTexted, true);
  assert.equal(incident.guardianPushDevices, 1);
  assert.deepEqual(incident.events.map((event) => event.kind), ['opened']);
  assert.equal(recorder.sms.length, 1);
  assert.match(recorder.sms[0].body, /SILENT help signal/);
  assert.match(recorder.sms[0].body, /do not call or text them/);
  assert.doesNotMatch(recorder.sms[0].body, /Call or text them now/);
  await new Promise((done) => setImmediate(done));
  assert.equal(recorder.pushes.length, 1);
  assert.equal(recorder.pushes[0].payload.title, 'Silent help signal');
  assert.match(recorder.pushes[0].payload.body, /Don’t call or text/);
  assert.equal(recorder.pushes[0].payload.sessionId, created.sessionId);

  // The guardian view never exposes the guardian number or the walker's description.
  const guardianView = JSON.stringify((await json(base, path, { token: created.guardianToken })).body);
  assert.equal(guardianView.includes('555'), false);
  assert.equal(guardianView.includes('backpack'), false);

  // The guardian can pass context to Campus Safety without contacting the walker.
  assert.equal((await json(base, `${path}/guardian-notes`, { method: 'POST', token: created.guardianToken, body: { text: ' ' } })).status, 400);
  assert.equal((await json(base, `${path}/guardian-notes`, { method: 'POST', token: created.guardianToken, body: { text: 'Walking home from Grainger to ISR.' } })).status, 201);
  const withNote = (await json<DispatchIncidentList>(base, '/api/dispatch/incidents', { token: DISPATCH_CODE })).body.incidents[0];
  assert.deepEqual(withNote.events.at(-1), { at: withNote.events.at(-1)!.at, kind: 'guardian_note', text: 'Walking home from Grainger to ISR.' });

  const id = `/${incident.id}`;
  assert.equal((await dispatch(`${id}/acknowledge`, undefined, 'wrong-code')).status, 401);
  const acknowledged = await dispatch(`${id}/acknowledge`, {});
  assert.equal(acknowledged.body.status, 'acknowledged');
  assert.equal((await json<SessionSnapshot>(base, path, { token: created.guardianToken })).body.incident?.status, 'acknowledged');
  assert.equal((await dispatch(`${id}/respond`, { unit: '  ' })).status, 400);
  const responding = await dispatch(`${id}/respond`, { unit: 'Patrol 2' });
  assert.equal(responding.body.status, 'responding');
  assert.equal(responding.body.unit, 'Patrol 2');
  assert.equal((await json<SessionSnapshot>(base, path, { token: owner })).body.incident?.unit, 'Patrol 2');
  assert.equal((await dispatch(`${id}/notes`, { text: 'Officer en route via Wright St.' })).body.events.at(-1)?.kind, 'note');

  const cancelled = (await json<SessionSnapshot>(base, `${path}/help/retract`, { method: 'POST', token: owner })).body;
  assert.equal(cancelled.incident?.status, 'responding');
  assert.equal(cancelled.incident?.walkerCancelledAt, new Date(clock.now).toISOString());
  const guardianCancelled = (await json<SessionSnapshot>(base, path, { token: created.guardianToken })).body;
  assert.equal(guardianCancelled.incident?.walkerCancelledAt, cancelled.incident?.walkerCancelledAt);
  assert.equal(guardianCancelled.incident?.status, 'responding');
  const guardianPublic = JSON.stringify(guardianCancelled);
  assert.equal(guardianPublic.includes('Officer en route via Wright St.'), false);
  assert.equal(guardianPublic.includes('Walking home from Grainger to ISR.'), false);
  assert.equal('events' in guardianCancelled.incident!, false);
  const restoredStore = new SessionStore(dbPath, () => clock.now);
  try {
    assert.equal(restoredStore.read(created.sessionId, owner).incident?.walkerCancelledAt, cancelled.incident?.walkerCancelledAt);
    assert.equal(restoredStore.read(created.sessionId, created.guardianToken).incident?.walkerCancelledAt, cancelled.incident?.walkerCancelledAt);
  } finally {
    restoredStore.close();
  }
  const afterCancel = (await json<DispatchIncidentList>(base, '/api/dispatch/incidents', { token: DISPATCH_CODE })).body.incidents[0];
  assert.ok(afterCancel.walkerCancelledAt);
  const resent = (await json<SessionSnapshot>(base, `${path}/help`, { method: 'POST', token: owner })).body;
  assert.equal(resent.incident?.id, incident.id);
  assert.equal(resent.incident?.walkerCancelledAt, null);
  assert.equal((await json<SessionSnapshot>(base, path, { token: created.guardianToken })).body.incident?.walkerCancelledAt, null);
  const afterResend = (await json<DispatchIncidentList>(base, '/api/dispatch/incidents', { token: DISPATCH_CODE })).body.incidents[0];
  assert.equal(afterResend.walkerCancelledAt, null);
  assert.equal(afterResend.events.at(-1)?.kind, 'walker_resent');

  assert.equal((await dispatch(`${id}/resolve`, { outcome: 'nope' })).status, 400);
  const resolved = await dispatch(`${id}/resolve`, { outcome: 'escorted_to_safety', note: 'Walked student to ISR.' });
  assert.equal(resolved.body.status, 'resolved');
  assert.equal(resolved.body.location, null);
  assert.equal(resolved.body.walkerDescription, null);
  assert.deepEqual(resolved.body.trail, []);
  assert.match(resolved.body.events.at(-1)!.text, /escorted them to safety\. Walked student to ISR\./);
  assert.equal((await dispatch(`${id}/respond`, { unit: 'Patrol 1' })).status, 409);
  assert.equal((await dispatch('/not-an-id/acknowledge', {})).status, 404);

  // The resolved incident cannot absorb a new help signal on the same walk.
  const resolvedPublic = (await json<SessionSnapshot>(base, path, { token: owner })).body;
  assert.equal(resolvedPublic.incident?.id, incident.id);
  const second = (await json<SessionSnapshot>(base, `${path}/help`, { method: 'POST', token: owner })).body;
  assert.notEqual(second.incident?.id, incident.id);
  assert.equal(second.incident?.status, 'new');
  assert.equal(second.status, 'help_requested');
  assert.equal(second.location?.latitude, location.latitude);
  assert.ok(Date.parse(second.updatedAt) > Date.parse(resolvedPublic.updatedAt));
  const repeatedSecond = (await json<SessionSnapshot>(base, `${path}/help`, { method: 'POST', token: owner })).body;
  assert.equal(repeatedSecond.incident?.id, second.incident?.id);
  assert.equal(repeatedSecond.updatedAt, second.updatedAt);
  assert.equal((await json<DispatchIncidentList>(base, '/api/dispatch/incidents', { token: DISPATCH_CODE })).body.incidents.length, 2);
});

test('an initial preset is validated and recorded once with the help transition for guardian and dispatch', async (t) => {
  const { base, clock, dbPath } = setup(t);
  const created = (await json<CreateSessionResponse>(base, '/api/sessions', { method: 'POST', body: { mode: 'live' } })).body;
  const path = `/api/sessions/${created.sessionId}`;
  const clientMessageId = randomUUID();
  const initial = { presetId: 'being_followed', clientMessageId };
  assert.equal((await json(base, `${path}/help`, { method: 'POST', token: created.ownerToken, body: { ...initial, text: 'arbitrary text' } })).status, 400);
  assert.equal((await json(base, `${path}/help`, { method: 'POST', token: created.ownerToken, body: { ...initial, presetId: 'made_up' } })).status, 400);
  assert.equal((await json(base, `${path}/help`, { method: 'POST', token: created.ownerToken, body: { ...initial, clientMessageId: 'bad' } })).status, 400);
  assert.equal((await json<SessionSnapshot>(base, path, { token: created.ownerToken })).body.incident, null);

  const sent = await json<SessionSnapshot>(base, `${path}/help`, { method: 'POST', token: created.ownerToken, body: initial });
  assert.equal(sent.status, 200);
  assert.equal(sent.body.status, 'help_requested');
  assert.deepEqual(sent.body.incident?.messages, [{ id: clientMessageId, presetId: 'being_followed', sentAt: new Date(clock.now).toISOString() }]);
  assert.deepEqual((await json<SessionSnapshot>(base, `${path}/help`, { method: 'POST', token: created.ownerToken, body: initial })).body, sent.body);
  assert.equal((await json(base, `${path}/help`, { method: 'POST', token: created.ownerToken, body: { ...initial, presetId: 'cannot_talk' } })).status, 409);
  assert.equal((await json(base, `${path}/help`, { method: 'POST', token: created.ownerToken, body: { ...initial, clientMessageId: randomUUID() } })).status, 409);

  const guardian = (await json<SessionSnapshot>(base, path, { token: created.guardianToken })).body;
  assert.deepEqual(guardian.incident?.messages, sent.body.incident?.messages);
  const dispatch = (await json<DispatchIncidentList>(base, '/api/dispatch/incidents', { token: DISPATCH_CODE })).body.incidents[0];
  assert.deepEqual(dispatch.messages, sent.body.incident?.messages);
  await json(base, `/api/dispatch/incidents/${dispatch.id}/notes`, { method: 'POST', token: DISPATCH_CODE, body: { text: 'PRIVATE DISPATCH NOTE' } });
  assert.equal(JSON.stringify((await json<SessionSnapshot>(base, path, { token: created.guardianToken })).body).includes('PRIVATE DISPATCH NOTE'), false);

  const restored = new SessionStore(dbPath, () => clock.now);
  try {
    assert.deepEqual(restored.read(created.sessionId, created.ownerToken).incident?.messages, sent.body.incident?.messages);
  } finally {
    restored.close();
  }
});

test('a delayed initial preset retry cannot re-escalate a cancelled or resolved incident', async (t) => {
  const recorder = recordingNotifier();
  const { base } = setup(t, recorder);
  const created = (await json<CreateSessionResponse>(base, '/api/sessions', { method: 'POST', body: { mode: 'live' } })).body;
  const path = `/api/sessions/${created.sessionId}`;
  await json(base, `${path}/contacts`, { method: 'POST', token: created.ownerToken, body: { guardianPhone: '+12175550123' } });
  const initial = { presetId: 'cannot_talk', clientMessageId: randomUUID() };
  const help = (input: unknown) => json<SessionSnapshot>(base, `${path}/help`, { method: 'POST', token: created.ownerToken, body: input });
  const first = await help(initial);
  const originalIncidentId = first.body.incident!.id;
  assert.equal(recorder.sms.length, 1);

  const cancelled = (await json<SessionSnapshot>(base, `${path}/help/retract`, { method: 'POST', token: created.ownerToken })).body;
  assert.equal(cancelled.status, 'active');
  assert.ok(cancelled.incident?.walkerCancelledAt);
  assert.equal(recorder.sms.length, 2);
  const delayedAfterCancel = await help(initial);
  assert.equal(delayedAfterCancel.status, 200);
  assert.deepEqual(delayedAfterCancel.body, cancelled);
  assert.equal(recorder.sms.length, 2);
  const dispatchPath = `/api/dispatch/incidents/${originalIncidentId}`;
  const original = (await json<DispatchIncidentList>(base, '/api/dispatch/incidents', { token: DISPATCH_CODE })).body.incidents[0];
  assert.deepEqual(original.events.map(event => event.kind), ['opened', 'walker_cancelled']);

  await json(base, `${dispatchPath}/resolve`, { method: 'POST', token: DISPATCH_CODE, body: { outcome: 'no_threat_on_scene' } });
  assert.equal(recorder.sms.length, 3);
  const delayedAfterResolve = await help(initial);
  assert.equal(delayedAfterResolve.body.status, 'active');
  assert.equal(delayedAfterResolve.body.incident?.status, 'resolved');
  assert.equal(delayedAfterResolve.body.incident?.id, originalIncidentId);
  assert.equal(recorder.sms.length, 3);
  assert.equal((await json<DispatchIncidentList>(base, '/api/dispatch/incidents', { token: DISPATCH_CODE })).body.incidents.length, 1);

  const fresh = await help({ presetId: 'cannot_talk', clientMessageId: randomUUID() });
  assert.equal(fresh.body.status, 'help_requested');
  assert.notEqual(fresh.body.incident?.id, originalIncidentId);
  assert.equal(recorder.sms.length, 4);
  assert.equal((await help(initial)).status, 409);
  assert.equal((await json<DispatchIncidentList>(base, '/api/dispatch/incidents', { token: DISPATCH_CODE })).body.incidents.length, 2);
});

test('standalone preset messages enforce owner access, exact UUID retries, rate limit, and bounded ordered history', async (t) => {
  const { base, clock } = setup(t);
  const created = (await json<CreateSessionResponse>(base, '/api/sessions', { method: 'POST', body: { mode: 'live' } })).body;
  const path = `/api/sessions/${created.sessionId}`;
  const messagesPath = `${path}/messages`;
  const body = { presetId: 'cannot_talk', clientMessageId: randomUUID() };
  const send = (input: unknown, token = created.ownerToken) => json<SessionSnapshot>(base, messagesPath, { method: 'POST', token, body: input });
  assert.equal((await send(body)).status, 409);
  await json(base, `${path}/help`, { method: 'POST', token: created.ownerToken });
  assert.equal((await send(body, created.guardianToken)).status, 403);
  assert.equal((await send({ ...body, presetId: 'custom_message' })).status, 400);
  assert.equal((await send({ ...body, clientMessageId: 'not-a-uuid' })).status, 400);
  assert.equal((await send({ ...body, text: 'raw text' })).status, 400);

  const first = await send(body);
  assert.equal(first.status, 200);
  assert.equal(first.body.incident?.messages.length, 1);
  const firstDispatch = (await json<DispatchIncidentList>(base, '/api/dispatch/incidents', { token: DISPATCH_CODE })).body.incidents[0];
  assert.deepEqual(firstDispatch.messages, first.body.incident?.messages);
  const retry = await send(body);
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.body, first.body);
  assert.equal((await send({ ...body, presetId: 'need_medical_help' })).status, 409);
  assert.equal((await send({ presetId: 'need_escort', clientMessageId: randomUUID() })).status, 429);
  const ids = [body.clientMessageId];
  for (let index = 0; index < 20; index++) {
    clock.now += 2000;
    const nextId = randomUUID();
    ids.push(nextId);
    assert.equal((await send({ presetId: 'need_escort', clientMessageId: nextId })).status, 200);
  }
  const current = (await json<SessionSnapshot>(base, path, { token: created.guardianToken })).body;
  assert.deepEqual(current.incident?.messages.map(message => message.id), ids.slice(-20));
  const dispatch = (await json<DispatchIncidentList>(base, '/api/dispatch/incidents', { token: DISPATCH_CODE })).body.incidents[0];
  assert.deepEqual(dispatch.messages, current.incident?.messages);
  assert.equal(current.incident?.messages.some(message => message.id === body.clientMessageId), false);
  assert.deepEqual((await send(body)).body, current);
  assert.equal((await send({ ...body, presetId: 'need_escort' })).status, 409);
});

test('preset sends reject cancelled, resolved, ended, and old-incident message IDs', async (t) => {
  const { base } = setup(t);
  const created = (await json<CreateSessionResponse>(base, '/api/sessions', { method: 'POST', body: { mode: 'live' } })).body;
  const path = `/api/sessions/${created.sessionId}`;
  const body = { presetId: 'need_medical_help', clientMessageId: randomUUID() };
  const send = (input: unknown = body) => json<SessionSnapshot>(base, `${path}/messages`, { method: 'POST', token: created.ownerToken, body: input });
  await json(base, `${path}/help`, { method: 'POST', token: created.ownerToken });
  assert.equal((await send()).status, 200);
  await json(base, `${path}/help/retract`, { method: 'POST', token: created.ownerToken });
  assert.equal((await send({ presetId: 'need_escort', clientMessageId: randomUUID() })).status, 409);
  await json(base, `${path}/help`, { method: 'POST', token: created.ownerToken });
  const oldIncidentId = (await json<SessionSnapshot>(base, path, { token: created.ownerToken })).body.incident!.id;
  await json(base, `/api/dispatch/incidents/${oldIncidentId}/resolve`, { method: 'POST', token: DISPATCH_CODE, body: { outcome: 'no_threat_on_scene' } });
  assert.equal((await send({ presetId: 'need_escort', clientMessageId: randomUUID() })).status, 409);
  const fresh = (await json<SessionSnapshot>(base, `${path}/help`, { method: 'POST', token: created.ownerToken })).body;
  assert.notEqual(fresh.incident?.id, oldIncidentId);
  assert.equal((await send()).status, 409);
  assert.deepEqual(fresh.incident?.messages, []);
  await json(base, `${path}/end`, { method: 'POST', token: created.ownerToken });
  assert.equal((await send({ presetId: 'cannot_talk', clientMessageId: randomUUID() })).status, 409);
});

test('ending or expiring a walk keeps the last known location for an open incident until it is closed', async (t) => {
  const { base, clock, store } = setup(t);
  const start = async () => {
    const created = (await json<CreateSessionResponse>(base, '/api/sessions', { method: 'POST', body: { mode: 'demo' } })).body;
    const path = `/api/sessions/${created.sessionId}`;
    await json(base, `${path}/contacts`, { method: 'POST', token: created.ownerToken, body: { walkerDescription: 'grey hoodie' } });
    await json(base, `${path}/locations`, { method: 'POST', token: created.ownerToken, body: { latitude: 40.11, longitude: -88.23, accuracy: 10, recordedAt: new Date(clock.now).toISOString() } });
    await json(base, `${path}/help`, { method: 'POST', token: created.ownerToken });
    return { ...created, path };
  };
  const ended = await start();
  await json(base, `${ended.path}/help/retract`, { method: 'POST', token: ended.ownerToken });
  const endedSnapshot = (await json<SessionSnapshot>(base, `${ended.path}/end`, { method: 'POST', token: ended.ownerToken })).body;
  assert.equal(endedSnapshot.location, null);
  assert.equal(endedSnapshot.descriptionProvided, false);
  assert.ok(endedSnapshot.incident?.walkerCancelledAt);
  assert.equal((await json<SessionSnapshot>(base, ended.path, { token: ended.guardianToken })).body.incident?.walkerCancelledAt,
    endedSnapshot.incident?.walkerCancelledAt);
  let incidents = (await json<DispatchIncidentList>(base, '/api/dispatch/incidents', { token: DISPATCH_CODE })).body.incidents;
  assert.equal(incidents[0].sessionState, 'ended');
  assert.equal(incidents[0].location?.latitude, 40.11);
  assert.equal(incidents[0].walkerDescription, 'grey hoodie');
  assert.equal(incidents[0].events.at(-1)?.kind, 'walker_ended');

  clock.now += 1000;
  const expiring = await start();
  await json(base, `${expiring.path}/help/retract`, { method: 'POST', token: expiring.ownerToken });
  clock.now += 2 * 60 * 60 * 1000;
  assert.equal(store.expireDue(), 1);
  incidents = (await json<DispatchIncidentList>(base, '/api/dispatch/incidents', { token: DISPATCH_CODE })).body.incidents;
  const expired = incidents.find((incident) => incident.sessionState === 'expired')!;
  assert.equal(expired.location?.longitude, -88.23);
  assert.equal(expired.events.at(-1)?.kind, 'session_expired');
  const expiredPublic = (await json<SessionSnapshot>(base, expiring.path, { token: expiring.guardianToken })).body;
  assert.equal(expiredPublic.status, 'ended');
  assert.equal(expiredPublic.endedReason, 'expired');
  assert.equal(expiredPublic.incident?.walkerCancelledAt, expired.walkerCancelledAt);
  assert.equal((await json(base, `${expiring.path}/push-subscriptions`, { method: 'POST', token: expiring.guardianToken, body: PUSH_SUBSCRIPTION })).status, 409);

  const closed = (await json<DispatchIncident>(base, `/api/dispatch/incidents/${expired.id}/resolve`, { method: 'POST', token: DISPATCH_CODE, body: { outcome: 'no_threat_on_scene' } })).body;
  assert.equal(closed.location, null);
  assert.equal(closed.walkerDescription, null);
  assert.equal((await json<SessionSnapshot>(base, expiring.path, { token: expiring.guardianToken })).body.incident?.status, 'resolved');
  assert.equal((await json(base, `${expiring.path}/guardian-notes`, { method: 'POST', token: expiring.guardianToken, body: { text: 'late note' } })).status, 409);
});

test('contacts and push subscriptions are validated, capped, and cleared when a walk ends', async (t) => {
  const recorder = recordingNotifier();
  const { base } = setup(t, recorder);
  const created = (await json<CreateSessionResponse>(base, '/api/sessions', { method: 'POST', body: { mode: 'demo' } })).body;
  const path = `/api/sessions/${created.sessionId}`;
  const contacts = (body: unknown, token = created.ownerToken) => json<SessionSnapshot>(base, `${path}/contacts`, { method: 'POST', token, body });
  const subscribe = (body: unknown) => json<{ devices: number }>(base, `${path}/push-subscriptions`, { method: 'POST', token: created.guardianToken, body });

  assert.equal((await contacts({ guardianPhone: '+12175550123' }, created.guardianToken)).status, 403);
  assert.equal((await contacts({ guardianPhone: '12345' })).status, 400);
  assert.equal((await contacts({ walkerDescription: 'x'.repeat(121) })).status, 400);
  assert.equal((await contacts([])).status, 400);
  const saved = await contacts({ guardianPhone: '+12175550123', walkerDescription: 'blue coat' });
  assert.equal(saved.body.textAlertsEnabled, true);
  assert.equal(saved.body.descriptionProvided, true);
  assert.equal((await contacts({ walkerDescription: null })).body.descriptionProvided, false);

  assert.equal((await subscribe({ ...PUSH_SUBSCRIPTION, endpoint: 'https://attacker.example/push' })).status, 400);
  assert.equal((await subscribe({ ...PUSH_SUBSCRIPTION, endpoint: 'http://fcm.googleapis.com/fcm/send/x' })).status, 400);
  assert.equal((await subscribe({ endpoint: PUSH_SUBSCRIPTION.endpoint, keys: { p256dh: 'short', auth: 'x' } })).status, 400);
  assert.equal((await subscribe(PUSH_SUBSCRIPTION)).body.devices, 1);
  assert.equal((await subscribe(PUSH_SUBSCRIPTION)).body.devices, 1);
  for (let index = 2; index <= 5; index++) {
    assert.equal((await subscribe({ ...PUSH_SUBSCRIPTION, endpoint: `${PUSH_SUBSCRIPTION.endpoint}-${index}` })).body.devices, index);
  }
  assert.equal((await subscribe({ ...PUSH_SUBSCRIPTION, endpoint: `${PUSH_SUBSCRIPTION.endpoint}-6` })).status, 429);

  for (let index = 0; index < 8; index++) {
    await json(base, `${path}/help`, { method: 'POST', token: created.ownerToken });
    await json(base, `${path}/help/retract`, { method: 'POST', token: created.ownerToken });
  }
  assert.equal(recorder.sms.length, 10);
  assert.ok(recorder.sms.every((alert) => alert.body.startsWith('[DEMO - simulated walk] ')));
  await new Promise((done) => setImmediate(done));
  assert.ok(recorder.pushes.every((push) => push.payload.title.startsWith('[Demo] ')));

  const ended = (await json<SessionSnapshot>(base, `${path}/end`, { method: 'POST', token: created.ownerToken })).body;
  assert.equal(ended.textAlertsEnabled, false);
  assert.equal((await contacts({ guardianPhone: '+12175550123' })).status, 409);
});

test('push subscriptions the push service reports as gone are removed', async (t) => {
  const recorder = recordingNotifier('expired');
  const { base } = setup(t, recorder);
  const created = (await json<CreateSessionResponse>(base, '/api/sessions', { method: 'POST', body: { mode: 'live' } })).body;
  const path = `/api/sessions/${created.sessionId}`;
  await json(base, `${path}/push-subscriptions`, { method: 'POST', token: created.guardianToken, body: PUSH_SUBSCRIPTION });
  await json(base, `${path}/help`, { method: 'POST', token: created.ownerToken });
  await new Promise((done) => setImmediate(done));
  const incident = (await json<DispatchIncidentList>(base, '/api/dispatch/incidents', { token: DISPATCH_CODE })).body.incidents[0];
  assert.equal(incident.guardianPushDevices, 0);
});

test('an existing database without the new columns is migrated', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ghostsignal-migrate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'sessions.sqlite');
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`CREATE TABLE sessions (
    id TEXT PRIMARY KEY, mode TEXT NOT NULL, status TEXT NOT NULL, started_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, help_requested_at INTEGER,
    ended_reason TEXT, location_json TEXT, trail_json TEXT NOT NULL, owner_hash TEXT NOT NULL, guardian_hash TEXT NOT NULL)`);
  legacy.close();
  const store = new SessionStore(dbPath);
  try {
    const created = store.create('demo');
    assert.equal(store.setContacts(created.sessionId, created.ownerToken, { walkerDescription: 'green scarf' }).descriptionProvided, true);
    assert.equal(store.requestHelp(created.sessionId, created.ownerToken).incident?.status, 'new');
  } finally {
    store.close();
  }
});

test('homepage emergency flow creates one live incident without waiting for GPS and retracts it for guardian and dispatch', async (t) => {
  const { createEmergencyActions } = await import('../src/emergency-actions.js');
  const { createEmergencyFlow, INITIAL_EMERGENCY_STATE } = await import('../src/hold-progress.js');
  const { base } = setup(t);
  let owner: import('../src/api.js').OwnerCredentials | null = null;
  let snapshot: SessionSnapshot | null = null;
  let creations = 0;
  let loseSendResponse = true;
  let loseRetractResponse = true;
  const actions = createEmergencyActions({
    readOwner: () => owner,
    saveOwner: (value, initial) => { owner = value; snapshot = initial; },
    onSnapshot: next => { snapshot = next; },
  }, {
    startSession: async mode => {
      creations++;
      const result = await json<CreateSessionResponse>(base, '/api/sessions', { method: 'POST', body: { mode } });
      assert.equal(result.status, 201);
      return result.body;
    },
    getSession: async (id, token) => (await json<SessionSnapshot>(base, `/api/sessions/${id}`, { token })).body,
    requestHelp: async (id, token) => {
      const result = await json<SessionSnapshot>(base, `/api/sessions/${id}/help`, { method: 'POST', token });
      assert.equal(result.status, 200);
      if (loseSendResponse) { loseSendResponse = false; throw new Error('Response lost'); }
      return result.body;
    },
    retractHelp: async (id, token) => {
      const result = await json<SessionSnapshot>(base, `/api/sessions/${id}/help/retract`, { method: 'POST', token });
      assert.equal(result.status, 200);
      if (loseRetractResponse) { loseRetractResponse = false; throw new Error('Response lost'); }
      return result.body;
    },
  });
  let state = { ...INITIAL_EMERGENCY_STATE };
  let now = 0;
  let frameId = 0;
  const frames = new Map<number, () => void>();
  const flow = createEmergencyFlow(next => { state = next; }, {
    now: () => now,
    request: callback => { frames.set(++frameId, callback); return frameId; },
    cancel: id => { frames.delete(id); },
  }, actions);
  t.after(() => flow.dispose());
  const advance = (ms: number) => { now += ms; const queued = [...frames.values()]; frames.clear(); queued.forEach(fn => fn()); };
  const settle = async (phase: string) => {
    for (let i = 0; i < 100 && state.phase !== phase; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(state.phase, phase);
  };
  flow.begin(); advance(3000);
  await settle('cancel-ready');
  assert.ok(owner); assert.ok(snapshot);
  const saved = owner as import('../src/api.js').OwnerCredentials;
  const received = snapshot as SessionSnapshot;
  assert.equal(received.mode, 'live');
  assert.equal(received.location, null);
  assert.equal(received.status, 'help_requested');
  assert.equal(creations, 1);
  let guardian = await json<SessionSnapshot>(base, `/api/sessions/${saved.sessionId}`, { token: saved.guardianToken });
  assert.equal(guardian.body.status, 'help_requested');
  let queue = await json<DispatchIncidentList>(base, '/api/dispatch/incidents', { token: DISPATCH_CODE });
  assert.equal(queue.body.incidents.length, 1);
  const incidentId = queue.body.incidents[0].id;
  flow.release(); advance(2900); flow.begin(); advance(3000);
  await settle('cancelled');
  guardian = await json<SessionSnapshot>(base, `/api/sessions/${saved.sessionId}`, { token: saved.guardianToken });
  assert.equal(guardian.body.status, 'active');
  queue = await json<DispatchIncidentList>(base, '/api/dispatch/incidents', { token: DISPATCH_CODE });
  assert.ok(queue.body.incidents[0].walkerCancelledAt);
  assert.equal(queue.body.incidents[0].id, incidentId);
  assert.equal(queue.body.incidents[0].events.filter(event => event.kind === 'walker_cancelled').length, 1);
  // A retry reuses the existing session and incident; it never creates duplicates.
  await Promise.all([actions.send(), actions.send()]);
  assert.equal(creations, 1);
  queue = await json<DispatchIncidentList>(base, '/api/dispatch/incidents', { token: DISPATCH_CODE });
  assert.equal(queue.body.incidents.length, 1);
  assert.equal(queue.body.incidents[0].id, incidentId);
  assert.equal(queue.body.incidents[0].walkerCancelledAt, null);
});

test('rate limits key on the forwarded visitor address when requests come through a local proxy', async (t) => {
  const { base } = setup(t);
  const create = (visitor: string) => fetch(`${base}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': visitor },
    body: JSON.stringify({ mode: 'demo' }),
  });
  for (let index = 0; index < 20; index++) assert.equal((await create('203.0.113.7')).status, 201);
  assert.equal((await create('203.0.113.7')).status, 429);
  // A different visitor behind the same tunnel is unaffected.
  assert.equal((await create('198.51.100.9')).status, 201);

  const wrongCode = (visitor: string) => fetch(`${base}/api/dispatch/incidents`, {
    headers: { Authorization: 'Bearer wrong-code', 'X-Forwarded-For': visitor },
  });
  for (let index = 0; index < 10; index++) assert.equal((await wrongCode('203.0.113.7')).status, 401);
  assert.equal((await wrongCode('203.0.113.7')).status, 429);
  const dispatcher = await fetch(`${base}/api/dispatch/incidents`, {
    headers: { Authorization: `Bearer ${DISPATCH_CODE}`, 'X-Forwarded-For': '198.51.100.9' },
  });
  assert.equal(dispatcher.status, 200);
});

test('dispatch cannot close an incident as unable to locate, or with a non-outcome value', async (t) => {
  const { base } = setup(t);
  const created = (await json<CreateSessionResponse>(base, '/api/sessions', { method: 'POST', body: { mode: 'demo' } })).body;
  await json(base, `/api/sessions/${created.sessionId}/help`, { method: 'POST', token: created.ownerToken });
  const incident = (await json<DispatchIncidentList>(base, '/api/dispatch/incidents', { token: DISPATCH_CODE })).body.incidents[0];
  const resolve = (outcome: unknown) => json<DispatchIncident>(base, `/api/dispatch/incidents/${incident.id}/resolve`, {
    method: 'POST', token: DISPATCH_CODE, body: { outcome },
  });
  for (const outcome of ['unable_to_locate', 'escalated_to_police', 'toString', 'constructor', '__proto__', 42]) {
    assert.equal((await resolve(outcome)).status, 400, `outcome ${String(outcome)} must be rejected`);
  }
  assert.equal((await resolve('escorted_to_safety')).body.status, 'resolved');
});

async function startGraceWalk(t: TestContext) {
  const recorder = recordingNotifier();
  const ctx = setup(t, recorder, CANCEL_GRACE_MS);
  const created = (await json<CreateSessionResponse>(ctx.base, '/api/sessions', { method: 'POST', body: { mode: 'live' } })).body;
  const path = `/api/sessions/${created.sessionId}`;
  await json(ctx.base, `${path}/contacts`, { method: 'POST', token: created.ownerToken, body: { guardianPhone: '+12175550123' } });
  await json(ctx.base, `${path}/push-subscriptions`, { method: 'POST', token: created.guardianToken, body: PUSH_SUBSCRIPTION });
  const dispatched = async () => (await json<DispatchIncidentList>(ctx.base, '/api/dispatch/incidents', { token: DISPATCH_CODE })).body.incidents;
  const settle = () => new Promise((done) => setImmediate(done));
  return { ...ctx, recorder, created, path, dispatched, settle };
}

test('a signal cancelled within the grace period never reaches dispatch or the guardian', async (t) => {
  const { base, clock, recorder, created, path, dispatched, settle } = await startGraceWalk(t);
  const helped = (await json<SessionSnapshot>(base, `${path}/help`, { method: 'POST', token: created.ownerToken })).body;
  assert.equal(helped.status, 'help_requested');
  assert.equal(helped.incident?.status, 'new', 'the walker sees their own pending signal');

  assert.deepEqual(await dispatched(), [], 'dispatch sees nothing during the grace period');
  const guardianDuring = (await json<SessionSnapshot>(base, path, { token: created.guardianToken })).body;
  assert.equal(guardianDuring.status, 'active');
  assert.equal(guardianDuring.incident, null);
  assert.equal(guardianDuring.helpRequestedAt, null);
  assert.equal((await json(base, `/api/dispatch/incidents/${helped.incident!.id}/acknowledge`, { method: 'POST', token: DISPATCH_CODE })).status, 404);
  assert.equal((await json(base, `${path}/guardian-notes`, { method: 'POST', token: created.guardianToken, body: { text: 'early' } })).status, 409);
  await json(base, `${path}/messages`, { method: 'POST', token: created.ownerToken, body: { presetId: 'cannot_talk', clientMessageId: crypto.randomUUID() } });

  clock.now += 6_000; // still inside the grace period, as after a full cancel hold
  const cancelled = (await json<SessionSnapshot>(base, `${path}/help/retract`, { method: 'POST', token: created.ownerToken })).body;
  assert.equal(cancelled.status, 'active');
  assert.equal(cancelled.incident, null, 'the withdrawn signal is deleted');
  assert.ok(cancelled.signalWithdrawnAt, 'the walker gets a withdrawal receipt');
  assert.equal((await json<SessionSnapshot>(base, path, { token: created.guardianToken })).body.signalWithdrawnAt, null);

  clock.now += CANCEL_GRACE_MS * 2;
  assert.deepEqual(await dispatched(), [], 'a withdrawn signal is never released');
  await settle();
  assert.equal(recorder.sms.length, 0, 'the guardian is not texted');
  assert.equal(recorder.pushes.length, 0, 'the guardian gets no push notification');
});

test('a signal that is not cancelled is released to dispatch and the guardian after the grace period', async (t) => {
  const { base, clock, recorder, created, path, dispatched, settle } = await startGraceWalk(t);
  const presetId = crypto.randomUUID();
  await json(base, `${path}/help`, { method: 'POST', token: created.ownerToken, body: { presetId: 'being_followed', clientMessageId: presetId } });
  await settle();
  assert.equal(recorder.sms.length, 0);

  clock.now += CANCEL_GRACE_MS;
  const released = await dispatched();
  assert.equal(released.length, 1, 'dispatch sees the signal once the grace period ends');
  assert.equal(released[0].messages[0].id, presetId, 'a message sent with the signal arrives with it');
  await settle();
  assert.equal(recorder.sms.length, 1);
  assert.match(recorder.sms[0].body, /SILENT help signal/);
  assert.equal(recorder.pushes.length, 1);
  assert.equal((await json<SessionSnapshot>(base, path, { token: created.guardianToken })).body.status, 'help_requested');

  // A cancel after release cannot be silent: dispatch keeps the incident and verifies in person.
  const late = (await json<SessionSnapshot>(base, `${path}/help/retract`, { method: 'POST', token: created.ownerToken })).body;
  assert.ok(late.incident?.walkerCancelledAt);
  assert.equal(late.signalWithdrawnAt, null);
  assert.ok((await dispatched())[0].walkerCancelledAt);
});

test('sending again after a silent cancel starts a fresh grace period and dispatch receives one incident', async (t) => {
  const { base, clock, created, path, dispatched } = await startGraceWalk(t);
  await json(base, `${path}/help`, { method: 'POST', token: created.ownerToken });
  await json(base, `${path}/help/retract`, { method: 'POST', token: created.ownerToken });
  const again = (await json<SessionSnapshot>(base, `${path}/help`, { method: 'POST', token: created.ownerToken })).body;
  assert.equal(again.signalWithdrawnAt, null, 'a new signal clears the old withdrawal receipt');
  assert.deepEqual(await dispatched(), []);
  clock.now += CANCEL_GRACE_MS;
  const incidents = await dispatched();
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].id, again.incident!.id);
});
