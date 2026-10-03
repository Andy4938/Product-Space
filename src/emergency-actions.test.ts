import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { OwnerCredentials } from './api.js';
import type { IncidentSummary, SessionSnapshot } from './api-types.js';
import { createEmergencyActions } from './emergency-actions.js';

const at = '2026-10-03T18:00:00.000Z';
const owner: OwnerCredentials = {
  sessionId: 'test-session', ownerToken: 'owner-secret', guardianToken: 'guardian-secret', mode: 'live',
};
const incident: IncidentSummary = {
  id: 'incident-1', reference: 'GS-ABC123', status: 'new', openedAt: at,
  acknowledgedAt: null, respondingAt: null, unit: null, resolvedAt: null,
  outcome: null, walkerCancelledAt: null,
};

function snapshot(status: SessionSnapshot['status'], currentIncident: IncidentSummary | null): SessionSnapshot {
  return {
    id: owner.sessionId, mode: 'live', status, startedAt: at, updatedAt: at,
    expiresAt: '2026-10-03T20:00:00.000Z', helpRequestedAt: status === 'help_requested' ? at : null,
    endedReason: null, location: null, trail: [], textAlertsEnabled: false,
    descriptionProvided: false, incident: currentIncident,
  };
}

function harness(options: {
  send?: () => Promise<SessionSnapshot>;
  retract?: () => Promise<SessionSnapshot>;
  read?: () => Promise<SessionSnapshot>;
}) {
  const accepted: SessionSnapshot[] = [];
  const actions = createEmergencyActions({
    readOwner: () => owner,
    saveOwner: () => assert.fail('An existing owner must be reused.'),
    onSnapshot: next => accepted.push(next),
  }, {
    startSession: async () => assert.fail('An existing session must be reused.'),
    getSession: async () => options.read ? options.read() : snapshot('active', null),
    requestHelp: async () => options.send ? options.send() : snapshot('help_requested', incident),
    retractHelp: async () => options.retract ? options.retract() : snapshot('active', { ...incident, walkerCancelledAt: at }),
  });
  return { actions, accepted };
}

test('a lost send response reconciles only an open incident, without a second POST', async () => {
  let posts = 0;
  const confirmed = snapshot('help_requested', incident);
  const { actions, accepted } = harness({
    send: async () => { posts++; throw new Error('response lost'); },
    read: async () => confirmed,
  });
  await actions.send();
  assert.equal(posts, 1);
  assert.deepEqual(accepted, [confirmed]);
});

test('a resolved incident cannot confirm a new send, directly or after a lost response', async () => {
  const resolved = snapshot('help_requested', { ...incident, status: 'resolved', resolvedAt: at, outcome: 'no_threat_on_scene' });
  const direct = harness({ send: async () => resolved });
  await assert.rejects(direct.actions.send(), /server has not confirmed/i);
  assert.deepEqual(direct.accepted, []);

  const reconciled = harness({
    send: async () => { throw new Error('response lost'); },
    read: async () => resolved,
  });
  await assert.rejects(reconciled.actions.send(), /response lost/);
  assert.deepEqual(reconciled.accepted, []);
});

test('an active state without a cancellation receipt cannot confirm retraction', async () => {
  const withoutReceipt = snapshot('active', incident);
  const direct = harness({ retract: async () => withoutReceipt });
  await assert.rejects(direct.actions.retract(), /server has not confirmed/i);
  assert.deepEqual(direct.accepted, []);

  const reconciled = harness({
    retract: async () => { throw new Error('response lost'); },
    read: async () => snapshot('active', null),
  });
  await assert.rejects(reconciled.actions.retract(), /response lost/);
  assert.deepEqual(reconciled.accepted, []);
});

test('cancellation receipt confirms retraction directly and after a lost POST response', async () => {
  const confirmed = snapshot('active', { ...incident, status: 'responding', respondingAt: at, walkerCancelledAt: at });
  const direct = harness({ retract: async () => confirmed });
  await direct.actions.retract();
  assert.deepEqual(direct.accepted, [confirmed]);

  const reconciled = harness({
    retract: async () => { throw new Error('response lost'); },
    read: async () => confirmed,
  });
  await reconciled.actions.retract();
  assert.deepEqual(reconciled.accepted, [confirmed]);
});
