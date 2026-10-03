import type { DispatchIncident } from './api-types';

type IncomingIncident = Pick<DispatchIncident, 'id' | 'messages' | 'events'>;

const MASK_64 = (1n << 64n) - 1n;
const FNV_PRIME = 1099511628211n;

// Opaque UI read marker only. This is not a security hash or a server receipt.
function noteFingerprint(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let forward = 14695981039346656037n;
  let reverse = 7809847782465536322n;
  for (const byte of bytes) forward = ((forward ^ BigInt(byte)) * FNV_PRIME) & MASK_64;
  for (let index = bytes.length - 1; index >= 0; index -= 1) {
    reverse = ((reverse ^ BigInt(bytes[index])) * FNV_PRIME) & MASK_64;
  }
  return `${forward.toString(16).padStart(16, '0')}${reverse.toString(16).padStart(16, '0')}`;
}

export function getIncomingMessageIds(incident: IncomingIncident): string[] {
  const ids = new Set<string>();
  for (const message of incident.messages) ids.add(`preset:${incident.id}:${message.id}`);

  // Legacy guardian events have no ID. The ordinal distinguishes equal notes
  // created in the same millisecond while both remain in the bounded history.
  const occurrences = new Map<string, number>();
  for (const event of incident.events) {
    if (event.kind !== 'guardian_note') continue;
    const fingerprint = noteFingerprint(event.text);
    const identity = JSON.stringify([event.at, fingerprint]);
    const ordinal = occurrences.get(identity) ?? 0;
    occurrences.set(identity, ordinal + 1);
    ids.add(`guardian:${incident.id}:${event.at}:${fingerprint}:${ordinal}`);
  }
  return [...ids];
}

export function getUnreadMessageCount(incident: IncomingIncident, readIds: ReadonlySet<string>): number {
  return getIncomingMessageIds(incident).filter(id => !readIds.has(id)).length;
}
