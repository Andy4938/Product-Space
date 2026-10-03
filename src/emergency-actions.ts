import { getSession, requestHelp, retractHelp, startSession, type OwnerCredentials } from './api';
import type { SessionSnapshot } from './api-types';
import { newClientMessageId, type PresetMessageId } from './preset-messages';

function confirmsAction(kind: 'send' | 'retract', snapshot: SessionSnapshot, presetId?: PresetMessageId, clientMessageId?: string): boolean {
  if (kind === 'send') {
    if (snapshot.status !== 'help_requested' || snapshot.incident === null || snapshot.incident.status === 'resolved') return false;
    return presetId === undefined || (Array.isArray(snapshot.incident.messages) && snapshot.incident.messages.some(
      message => message.id === clientMessageId && message.presetId === presetId,
    ));
  }
  return snapshot.status === 'active' && snapshot.incident?.walkerCancelledAt != null;
}

export function createEmergencyActions(hooks: {
  readOwner: () => OwnerCredentials | null;
  saveOwner: (owner: OwnerCredentials, snapshot: SessionSnapshot) => void;
  onSnapshot: (snapshot: SessionSnapshot) => void;
}, api = { getSession, requestHelp, retractHelp, startSession }) {
  let pendingKind: 'send' | 'retract' | null = null;
  let pendingPresetId: PresetMessageId | null = null;
  let pending: Promise<void> | null = null;
  let retryPresetId: PresetMessageId | null = null;
  let retryClientMessageId: string | null = null;
  const run = (kind: 'send' | 'retract', presetId?: PresetMessageId) => {
    if (pending) return pendingKind === kind && pendingPresetId === (presetId ?? null)
      ? pending : Promise.reject(new Error('Another request is still being confirmed.'));
    pendingKind = kind;
    pendingPresetId = presetId ?? null;
    pending = (async () => {
      let clientMessageId: string | undefined;
      if (kind === 'send') {
        if (presetId !== undefined) {
          clientMessageId = retryPresetId === presetId && retryClientMessageId !== null
            ? retryClientMessageId : newClientMessageId();
          retryPresetId = presetId;
          retryClientMessageId = clientMessageId;
        } else {
          retryPresetId = null;
          retryClientMessageId = null;
        }
      }
      let owner = hooks.readOwner();
      if (!owner) {
        if (kind === 'retract') throw new Error('No active request to cancel.');
        // Do not delay an incident for GPS permission or a first fix. The existing
        // live watcher starts immediately and adds real positions when available.
        const created = await api.startSession('live');
        owner = { sessionId: created.sessionId, ownerToken: created.ownerToken, guardianToken: created.guardianToken, mode: created.session.mode };
        hooks.saveOwner(owner, created.session);
      }
      let next: SessionSnapshot;
      try {
        next = kind === 'send'
          ? await api.requestHelp(owner.sessionId, owner.ownerToken, presetId, clientMessageId)
          : await api.retractHelp(owner.sessionId, owner.ownerToken);
      } catch (cause) {
        // A timed-out POST may have reached the server. Reconcile before asking
        // for a retry; never claim cancellation or delivery without confirmation.
        const current = await api.getSession(owner.sessionId, owner.ownerToken).catch(() => null);
        if (!current || !confirmsAction(kind, current, presetId, clientMessageId)) throw cause;
        next = current;
      }
      if (!confirmsAction(kind, next, presetId, clientMessageId)) throw new Error('The server has not confirmed this action. Try again.');
      hooks.onSnapshot(next);
      retryPresetId = null;
      retryClientMessageId = null;
    })().finally(() => { pending = null; pendingKind = null; pendingPresetId = null; });
    return pending;
  };
  return { send: (presetId?: PresetMessageId) => run('send', presetId), retract: () => run('retract') };
}
