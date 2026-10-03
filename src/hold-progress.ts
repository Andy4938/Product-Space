export const HOLD_MS = 3000;
export const CANCEL_WINDOW_MS = 3000;
export type HoldClock = {
  now: () => number;
  request: (callback: () => void) => number;
  cancel: (id: number) => void;
};
export type EmergencyPhase = 'idle' | 'emergency-holding' | 'cancel-ready' | 'cancel-holding' | 'cancelled' | 'complete' | 'sending' | 'cancel-sending' | 'send-error' | 'cancel-error';
export type EmergencyState = { phase: EmergencyPhase; progress: number; remaining: number; error?: string };
export const INITIAL_EMERGENCY_STATE: EmergencyState = { phase: 'idle', progress: 0, remaining: CANCEL_WINDOW_MS };

// The cancel window spends time only while waiting, never while cancelling.
// Async actions must be confirmed before showing success or starting the undo window.
export function createEmergencyFlow(onChange: (state: EmergencyState) => void, clock: HoldClock, actions?: { send: () => Promise<void>; retract: () => Promise<void> }) {
  let state = { ...INITIAL_EMERGENCY_STATE };
  let started = 0;
  let deadline = 0;
  let frame = 0;
  let generation = 0;
  const emit = () => onChange({ ...state });
  const stopFrame = () => { clock.cancel(frame); frame = 0; };
  const action = (kind: 'send' | 'retract') => {
    const version = ++generation;
    state = { ...state, phase: kind === 'send' ? 'sending' : 'cancel-sending', progress: 1, error: undefined };
    emit();
    const success = () => {
      if (version !== generation) return;
      if (kind === 'send') {
        deadline = clock.now() + CANCEL_WINDOW_MS;
        state = { phase: 'cancel-ready', progress: 0, remaining: CANCEL_WINDOW_MS };
        frame = clock.request(tick);
      } else state = { phase: 'cancelled', progress: 0, remaining: 0 };
      emit();
    };
    if (!actions) { success(); return; }
    Promise.resolve().then(() => actions[kind]()).then(success, cause => {
      if (version !== generation) return;
      state = { ...state, phase: kind === 'send' ? 'send-error' : 'cancel-error', progress: 0,
        error: cause instanceof Error ? cause.message : 'Connection interrupted. Try again.' };
      emit();
    });
  };
  const tick = () => {
    frame = 0;
    const now = clock.now();
    if (state.phase === 'emergency-holding' || state.phase === 'cancel-holding') {
      const progress = Math.min(1, Math.max(0, (now - started) / HOLD_MS));
      if (progress === 1) {
        action(state.phase === 'emergency-holding' ? 'send' : 'retract');
        return;
      } else state = { ...state, progress };
    } else if (state.phase === 'cancel-ready') {
      const remaining = Math.max(0, deadline - now);
      state = remaining ? { ...state, remaining } : { phase: 'complete', progress: 1, remaining: 0 };
    }
    emit();
    if (state.phase === 'emergency-holding' || state.phase === 'cancel-ready' || state.phase === 'cancel-holding') frame = clock.request(tick);
  };
  return {
    begin() {
      if (state.phase === 'emergency-holding' || state.phase === 'cancel-holding' || state.phase === 'sending' || state.phase === 'cancel-sending') return false;
      stopFrame();
      const now = clock.now();
      if (state.phase === 'cancel-ready' || state.phase === 'cancel-error') {
        const remaining = state.phase === 'cancel-error' ? CANCEL_WINDOW_MS : Math.max(0, deadline - now);
        if (!remaining) {
          state = { phase: 'complete', progress: 1, remaining: 0 };
          emit();
          return false;
        }
        state = { phase: 'cancel-holding', progress: 0, remaining };
      } else state = { ...INITIAL_EMERGENCY_STATE, phase: 'emergency-holding' };
      started = now;
      emit();
      frame = clock.request(tick);
      return true;
    },
    release() {
      if (state.phase !== 'emergency-holding' && state.phase !== 'cancel-holding') return;
      stopFrame();
      if (state.phase === 'cancel-holding') {
        deadline = clock.now() + state.remaining;
        state = { ...state, phase: 'cancel-ready', progress: 0 };
        frame = clock.request(tick);
      } else state = { ...INITIAL_EMERGENCY_STATE };
      emit();
    },
    dispose() { stopFrame(); generation++; },
  };
}
