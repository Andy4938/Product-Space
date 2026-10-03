import { useEffect, useRef, useState } from 'react';
import { createEmergencyFlow, HOLD_MS, INITIAL_EMERGENCY_STATE } from './hold-progress';

export function EmergencyHold() {
  const [{ progress, phase, remaining }, setState] = useState(INITIAL_EMERGENCY_STATE);
  const cancelling = phase === 'cancel-ready' || phase === 'cancel-holding';
  const holding = phase === 'emergency-holding' || phase === 'cancel-holding';
  const input = useRef<number | string | null>(null);
  const [hold] = useState(() => createEmergencyFlow(setState, {
    now: () => performance.now(),
    request: callback => requestAnimationFrame(callback),
    cancel: id => cancelAnimationFrame(id),
  }));
  const cancel = () => {
    input.current = null;
    hold.release();
  };
  const begin = (source: number | string) => {
    if (input.current !== null) return;
    if (hold.begin()) input.current = source;
  };
  useEffect(() => {
    const interrupt = () => {
      input.current = null;
      hold.release();
    };
    const onVisibility = () => { if (document.hidden) interrupt(); };
    window.addEventListener('blur', interrupt);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      hold.dispose();
      window.removeEventListener('blur', interrupt);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [hold]);

  return <section className="emergency-focus" aria-label="Emergency help">
    <button type="button" className={`emergency-orb ${holding ? 'holding' : phase} ${cancelling ? 'cancel-mode' : ''}`} aria-label={`${cancelling ? 'Cancel emergency help' : 'Emergency help'} — hold for 3 seconds`} aria-describedby="hold-instructions hold-status"
      onPointerDown={event => {
        if (!event.isPrimary || event.button !== 0 || input.current !== null) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        begin(event.pointerId);
      }}
      onPointerMove={event => {
        if (input.current !== event.pointerId) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (Math.hypot(event.clientX - rect.left - rect.width / 2, event.clientY - rect.top - rect.height / 2) > rect.width / 2) cancel();
      }}
      onPointerUp={event => { if (input.current === event.pointerId) cancel(); }}
      onPointerCancel={cancel} onLostPointerCapture={cancel} onBlur={cancel}
      onContextMenu={event => event.preventDefault()}
      onKeyDown={event => {
        if (event.key === 'Escape') { cancel(); return; }
        if (event.key !== ' ' && event.key !== 'Enter') return;
        event.preventDefault();
        if (!event.repeat) begin(event.key);
      }}
      onKeyUp={event => {
        if (event.key !== ' ' && event.key !== 'Enter') return;
        event.preventDefault();
        if (input.current === event.key) cancel();
      }}>
      <svg className="emergency-hold-ring" viewBox="0 0 200 200" aria-hidden="true">
        <circle className="emergency-hold-track" cx="100" cy="100" r="96" />
        <circle className="emergency-hold-progress" cx="100" cy="100" r="96" pathLength="100" strokeDasharray="100" strokeDashoffset={100 - progress * 100} />
      </svg>
      <span className="orb-content">
        <svg className="orb-icon" viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">{cancelling ? <path d="m9 9 14 14m0-14L9 23" strokeLinecap="round" /> : <><path d="M16 3 5 7v9c0 7 11 13 11 13s11-6 11-13V7L16 3Z" /><path d="M16 10v8m0 4v.2" strokeLinecap="round" /></>}</svg>
        <span className="orb-title">{cancelling ? 'Cancel' : <>Emergency<br />help</>}</span>
        {(!cancelling || holding) && <span className="orb-hint" aria-hidden="true">{holding ? `${Math.max(1, Math.ceil(HOLD_MS / 1000 * (1 - progress)))}s · Keep holding` : 'Hold for 3 seconds'}</span>}
        <span className="cancel-window" aria-hidden="true">{cancelling ? phase === 'cancel-holding' ? 'COUNTDOWN PAUSED' : `${(remaining / 1000).toFixed(1)}s TO CANCEL` : '\u00a0'}</span>
      </span>
    </button>
    <span id="hold-instructions" className="sr-only">Hold with your finger, mouse, Space, or Enter. Hold for 3 seconds. Release early to stop the hold. After a help hold, you have 3 seconds to start holding Cancel. The countdown pauses while holding Cancel. This is a demo only.</span>
    <p id="hold-status" className={`hold-status ${phase === 'cancel-ready' ? 'cancel-prompt' : ''}`} role="status">{phase === 'complete' ? 'Demo complete. No alert was sent.' : phase === 'cancelled' ? 'Cancelled. No alert was sent.' : phase === 'cancel-holding' ? 'Cancel window paused · Release to stop.' : phase === 'cancel-ready' ? 'Changed your mind? Hold to cancel.' : holding ? 'Release to stop.' : 'Demo only · No calls or alerts are sent.'}</p>
  </section>;
}
