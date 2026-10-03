import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { IncidentStatus, SessionSnapshot } from './api-types';
import { emergencySurface } from './EmergencyHold';
import { EmergencyStatus, incidentHeadline } from './EmergencyStatus';

function snapshot(status: IncidentStatus = 'new'): SessionSnapshot {
  return {
    id: 'session', mode: 'live', status: 'help_requested', startedAt: '2026-01-01T12:00:00.000Z',
    updatedAt: '2026-01-01T12:01:00.000Z', expiresAt: '2026-01-02T12:00:00.000Z',
    helpRequestedAt: '2026-01-01T12:01:00.000Z', endedReason: null, location: null, trail: [],
    textAlertsEnabled: false, descriptionProvided: false,
    incident: {
      id: 'incident', reference: 'GS-102', status, openedAt: '2026-01-01T12:01:00.000Z',
      acknowledgedAt: status === 'new' ? null : '2026-01-01T12:02:00.000Z',
      respondingAt: status === 'responding' || status === 'resolved' ? '2026-01-01T12:03:00.000Z' : null,
      unit: null, resolvedAt: status === 'resolved' ? '2026-01-01T12:04:00.000Z' : null,
      outcome: status === 'resolved' ? 'unable_to_locate' : null, walkerCancelledAt: null,
    },
  };
}

function renderStatus(value: SessionSnapshot, extra: Partial<Parameters<typeof EmergencyStatus>[0]> = {}) {
  return renderToStaticMarkup(createElement(EmergencyStatus, {
    snapshot: value, now: Date.parse('2026-01-01T12:05:00.000Z'),
    locationError: null, pollError: null, onRetryLocation: async () => {},
    onRequestCancellation: async () => {}, onStopSharing: async () => {}, onReset: () => {},
    onSendAnotherSignal: () => {}, ...extra,
  }));
}

test('restored confirmed incident renders status; unconfirmed failed send retains hold retry', () => {
  const confirmed = snapshot().incident!;
  assert.equal(emergencySurface('idle', confirmed, null), 'status');
  assert.equal(emergencySurface('complete', confirmed, null), 'status');
  assert.equal(emergencySurface('cancel-error', confirmed, null), 'status');
  assert.equal(emergencySurface('send-error', null, null), 'hold');
  assert.equal(emergencySurface('cancel-ready', confirmed, null), 'hold');
  assert.equal(emergencySurface('sending', confirmed, null), 'hold');
  assert.equal(emergencySurface('idle', confirmed, confirmed.id), 'hold');
});

test('public stages update from new to acknowledged, responding, and resolved without claiming safety', () => {
  const headings = [
    'Signal received.', 'A dispatcher has acknowledged your signal.',
    'Responder dispatched.', 'Incident closed.',
  ];
  for (const [index, status] of (['new', 'acknowledged', 'responding', 'resolved'] as IncidentStatus[]).entries()) {
    const value = snapshot(status);
    assert.equal(incidentHeadline(value.incident!), headings[index]);
    const html = renderStatus(value);
    assert.match(html, new RegExp(headings[index].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(html, /GS-102/);
    if (status === 'new') {
      assert.match(html, /Signal received/);
      assert.match(html, /No position has been confirmed yet/);
      assert.doesNotMatch(html, /Responder dispatched/);
    }
    if (status === 'resolved') {
      assert.match(html, /Unable to locate walker/);
      assert.doesNotMatch(html, /You are safe|All clear/i);
      value.incident!.respondingAt = null;
      assert.match(renderStatus(value), /Not recorded/);
    }
  }
});

test('failed cancellation keeps confirmed incident and retry action visible', () => {
  const html = renderStatus(snapshot('new'), { cancellationError: 'Connection lost.' });
  assert.match(html, /Signal received/);
  assert.match(html, /Cancellation was not confirmed/);
  assert.match(html, /Retry cancellation request/);
});

test('pending cancellation and ended sharing keep incident status without offering invalid actions', () => {
  const pending = snapshot('responding');
  pending.incident!.walkerCancelledAt = '2026-01-01T12:04:00.000Z';
  const pendingHtml = renderStatus(pending);
  assert.match(pendingHtml, /Cancellation requested — awaiting dispatcher confirmation/);
  assert.doesNotMatch(pendingHtml, /Request cancellation<\/button>/);
  const ended = snapshot('responding');
  ended.status = 'ended';
  ended.endedReason = 'safe';
  const endedHtml = renderStatus(ended);
  assert.match(endedHtml, /Sharing stopped/);
  assert.match(endedHtml, /keeps your last known location/);
  assert.doesNotMatch(endedHtml, /Request cancellation<\/button>|Start another walk<\/button>/);
  ended.incident!.status = 'resolved';
  ended.incident!.resolvedAt = '2026-01-01T12:05:00.000Z';
  assert.match(renderStatus(ended), /Start another walk/);
  assert.match(renderStatus(ended), /dispatcher has closed the incident/);
  assert.doesNotMatch(renderStatus(ended), /keeps your last known location/);
});

test('location and transport problems stay separate from the last confirmed incident stage', () => {
  const value = snapshot('acknowledged');
  const html = renderStatus(value, { locationError: 'GPS unavailable', pollError: 'Network interrupted' });
  assert.match(html, /A dispatcher has acknowledged your signal/);
  assert.match(html, /Status connection interrupted/);
  assert.match(html, /Location updates need attention/);
  assert.match(html, /Retry location/);
});
