import assert from 'node:assert/strict';
import test from 'node:test';
import type { DispatchIncident } from './api-types';
import { getIncomingMessageIds, getUnreadMessageCount } from './dispatch-messages';

type IncomingIncident = Pick<DispatchIncident, 'id' | 'messages' | 'events'>;

function incident(id = 'incident-a'): IncomingIncident {
  return { id, messages: [], events: [] };
}

test('counts walker presets and guardian notes, excluding dispatcher and system events', () => {
  const value = incident();
  value.messages.push({ id: 'receipt-1', presetId: 'cannot_talk', sentAt: '2026-10-03T12:00:00.000Z' });
  value.events.push(
    { at: '2026-10-03T12:00:00.000Z', kind: 'opened', text: 'Silent help signal received.' },
    { at: '2026-10-03T12:00:01.000Z', kind: 'note', text: 'Dispatcher private note' },
    { at: '2026-10-03T12:00:02.000Z', kind: 'guardian_note', text: 'Walker has a blue jacket' },
    { at: '2026-10-03T12:00:03.000Z', kind: 'responding', text: 'Unit dispatched' },
  );

  const ids = getIncomingMessageIds(value);
  assert.equal(ids.length, 2);
  assert.equal(ids[0], 'preset:incident-a:receipt-1');
  assert.match(ids[1], /^guardian:incident-a:2026-10-03T12:00:02\.000Z:[0-9a-f]{32}:0$/);
  assert.ok(ids.every(id => !id.includes('Walker has a blue jacket') && !id.includes('Dispatcher private note')));
  assert.equal(getUnreadMessageCount(value, new Set()), 2);
});

test('polling preserves IDs; new messages stay unread until explicitly marked', () => {
  const value = incident();
  value.messages.push({ id: 'receipt-1', presetId: 'cannot_talk', sentAt: '2026-10-03T12:00:00.000Z' });
  const initial = getIncomingMessageIds(value);
  assert.deepEqual(getIncomingMessageIds(value), initial);
  assert.equal(getUnreadMessageCount(value, new Set(initial)), 0);

  value.events.push({ at: '2026-10-03T12:00:02.000Z', kind: 'guardian_note', text: 'At the north entrance' });
  const readIds = new Set(initial); // Selection alone does not add the new ID.
  assert.equal(getUnreadMessageCount(value, readIds), 1);
  assert.equal(getUnreadMessageCount(value, readIds), 1);
  const afterNote = getIncomingMessageIds(value);
  afterNote.forEach(id => readIds.add(id));
  assert.equal(getUnreadMessageCount(value, readIds), 0);

  value.messages.push({ id: 'receipt-2', presetId: 'need_escort', sentAt: '2026-10-03T12:00:03.000Z' });
  assert.equal(getUnreadMessageCount(value, readIds), 1);
});

test('same-millisecond duplicate guardian notes get distinct stable markers', () => {
  const value = incident();
  const note = { at: '2026-10-03T12:00:02.000Z', kind: 'guardian_note' as const, text: 'Same note' };
  value.events.push(note, { ...note });
  const ids = getIncomingMessageIds(value);
  assert.equal(ids.length, 2);
  assert.ok(ids[0].endsWith(':0'));
  assert.ok(ids[1].endsWith(':1'));
  assert.deepEqual(getIncomingMessageIds(value), ids);

  value.events.splice(1, 0, { at: note.at, kind: 'note', text: 'Internal dispatch note' });
  assert.deepEqual(getIncomingMessageIds(value), ids);
});

test('normal bounded-history trimming and another incident do not reuse read markers', () => {
  const value = incident();
  value.events.push(
    { at: '2026-10-03T11:59:59.000Z', kind: 'opened', text: 'Opened' },
    { at: '2026-10-03T12:00:00.000Z', kind: 'guardian_note', text: 'Distinct note' },
  );
  const first = getIncomingMessageIds(value);
  value.events.shift(); // The server bounds old event history.
  assert.deepEqual(getIncomingMessageIds(value), first);

  const other = { ...value, id: 'incident-b' };
  const otherIds = getIncomingMessageIds(other);
  assert.notDeepEqual(otherIds, first);
  assert.equal(getUnreadMessageCount(other, new Set(first)), 1);
});
