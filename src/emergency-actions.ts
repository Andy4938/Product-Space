import { getSession, requestHelp, retractHelp, startSession, type OwnerCredentials } from './api';
import type { SessionSnapshot } from './api-types';

export function createEmergencyActions(hooks: {
  readOwner: () => OwnerCredentials | null;
  saveOwner: (owner: OwnerCredentials, snapshot: SessionSnapshot) => void;
  onSnapshot: (snapshot: SessionSnapshot) => void;
}, api = { getSession, requestHelp, retractHelp, startSession }) {
  let pendingKind: 'send' | 'retract' | null = null;
  let pending: Promise<void> | null = null;
  const run = (kind: 'send' | 'retract') => {
    if (pending) return pendingKind === kind ? pending : Promise.reject(new Error('Another request is still being confirmed.'));
    pendingKind = kind;
    pending = (async () => {
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
      const expected = kind === 'send' ? 'help_requested' : 'active';
      try {
        next = await (kind === 'send' ? api.requestHelp : api.retractHelp)(owner.sessionId, owner.ownerToken);
      } catch (cause) {
        // A timed-out POST may have reached the server. Reconcile before asking
        // for a retry; never claim cancellation or delivery without confirmation.
        const current = await api.getSession(owner.sessionId, owner.ownerToken).catch(() => null);
        if (!current || current.status !== expected) throw cause;
        next = current;
      }
      hooks.onSnapshot(next);
      if (next.status !== expected || (kind === 'send' && !next.incident)) throw new Error('The server has not confirmed this action. Try again.');
    })().finally(() => { pending = null; pendingKind = null; });
    return pending;
  };
  return { send: () => run('send'), retract: () => run('retract') };
}
