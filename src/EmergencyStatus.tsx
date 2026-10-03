import { useI18n } from './i18n';
import { useState, type ReactNode } from 'react';
import { translate, type Locale } from './i18n';
import { INCIDENT_OUTCOMES, type IncidentSummary, type SessionSnapshot } from './api-types';

type Action = 'cancel' | 'location' | 'share' | 'stop' | null;

export function incidentHeadline(incident: IncidentSummary): string {
  if (incident.status === 'new') return 'Signal received.';
  if (incident.status === 'acknowledged') return 'A dispatcher has acknowledged your signal.';
  if (incident.status === 'responding') return 'Responder dispatched.';
  return 'Incident closed.';
}

function capturedAgo(recordedAt: string, now: number, locale: Locale): string {
  const t = (source: string, params?: Record<string, string | number>) => translate(source, locale, params);
  const seconds = Math.max(0, Math.floor((now - Date.parse(recordedAt)) / 1000));
  if (!Number.isFinite(seconds)) return t('Capture time unavailable');
  if (seconds < 5) return t('Captured just now');
  if (seconds < 60) return t('Captured {count}s ago', { count: seconds });
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? t('Captured {count}m ago', { count: minutes }) : t('Captured {count}h ago', { count: Math.floor(minutes / 60) });
}

export function EmergencyStatus({ snapshot, now, locationError, pollError, cancellationError, onRetryLocation, onRequestCancellation, onStopSharing, onShare, onReset, onSendAnotherSignal, onBusyChange, messageControls, disabled = false }: {
  messageControls?: ReactNode;
  snapshot: SessionSnapshot;
  now: number;
  locationError: string | null;
  pollError: string | null;
  cancellationError?: string | null;
  onRetryLocation: () => Promise<void>;
  onRequestCancellation?: () => Promise<void>;
  onStopSharing?: () => void | Promise<void>;
  onShare?: () => void | Promise<void>;
  onReset?: () => void;
  onSendAnotherSignal?: () => void;
  onBusyChange?: (busy: boolean) => void;
  disabled?: boolean;
}) {
  const { t, locale } = useI18n();
  const incident = snapshot.incident;
  const [busy, setBusy] = useState<Action>(null);
  const [actionError, setActionError] = useState<{ action: Action; message: string } | null>(null);
  if (!incident) return null;

  const cancelledAt = (incident as IncidentSummary & { walkerCancelledAt?: string | null }).walkerCancelledAt ?? null;
  const cancellationPending = Boolean(cancelledAt && incident.status !== 'resolved');
  const sharing = snapshot.status !== 'ended';
  const capturedAge = snapshot.location ? Math.max(0, now - Date.parse(snapshot.location.recordedAt)) : Infinity;
  const locationDelayed = capturedAge >= 20000;
  const milestones = [
    { label: t("Signal received"), time: incident.openedAt },
    { label: t("Dispatcher acknowledged"), time: incident.acknowledgedAt },
    { label: incident.unit ? t('{unit} responding', { unit: incident.unit }) : t("Responder responding"), time: incident.respondingAt },
    { label: t("Incident closed"), time: incident.resolvedAt },
  ];

  const run = async (action: Exclude<Action, null>, callback: () => void | Promise<void>) => {
    if (busy || disabled) return;
    setBusy(action);
    setActionError(null);
    onBusyChange?.(true);
    try { await callback(); }
    catch (cause) { setActionError({ action, message: cause instanceof Error ? cause.message : t("The action was not confirmed. Please try again.") }); }
    finally { setBusy(null); onBusyChange?.(false); }
  };

  const cancelError = actionError?.action === 'cancel' ? actionError.message : cancellationError;
  return <section className={`emergency-status-card status-${incident.status}`} aria-label={t("Emergency request status")}>
    <div className="emergency-status-top">
      <span className="emergency-received-mark" aria-hidden="true">✓</span>
      <span className="emergency-status-kicker">{t("PROTOTYPE CAMPUS SAFETY")} · {incident.reference}</span>
      {snapshot.mode === 'demo' && <span className="emergency-demo-tag">{t("SIMULATED WALK")}</span>}
    </div>
    <h1 aria-live="polite">{t(incidentHeadline(incident))}</h1>
    <p className="emergency-status-summary">{incident.status === 'new' ? t("Your request reached the prototype safety console. A dispatcher has not yet acknowledged it.") : incident.status === 'acknowledged' ? t("The dispatcher has seen your request. Keep your phone with you and your location page open if you can.") : incident.status === 'responding' ? t('{unit} has been marked as responding to your shared location.', { unit: incident.unit ?? t("A responder") }) : incident.outcome ? t(INCIDENT_OUTCOMES[incident.outcome]) : t("The dispatcher has closed this incident.")}</p>

    {cancellationPending && <div className="emergency-cancel-pending" role="status"><strong>{t("Cancellation requested — awaiting dispatcher confirmation")}</strong><span>{t("Dispatch may still check on you in person. This does not close the incident or stop location sharing.")}</span></div>}
    {cancelError && !cancellationPending && incident.status !== 'resolved' && <div className="emergency-action-error" role="alert"><strong>{t("Cancellation was not confirmed.")}</strong><span>{t(cancelError)}</span></div>}
    {pollError && <div className="emergency-transport-warning" role="status"><strong>{t("Status connection interrupted")}</strong><span>{t("Showing the last confirmed update.")} {t(pollError)}</span></div>}

    <ol className="emergency-milestones" aria-label={t("Request progress")}>
      {milestones.map((step, index) => <li key={index} className={step.time ? 'reached' : ''}>
        <span className="milestone-track" aria-hidden="true"><span /></span>
        <span className="milestone-copy"><strong>{step.label}</strong><small>{step.time ? new Date(step.time).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' }) : incident.status === 'resolved' ? t("Not recorded") : t("Waiting")}</small></span>
      </li>)}
    </ol>

    <div className={`emergency-location ${locationError || locationDelayed ? 'needs-attention' : ''}`}>
      <div><span className="emergency-section-label">{t("LOCATION SHARING")}</span><strong>{!sharing ? t("Sharing stopped") : locationError ? t("Location updates need attention") : !snapshot.location ? t("Waiting for first location") : locationDelayed ? t("Latest location is delayed") : t("Location updating")}</strong><p>{!sharing ? incident.status === 'resolved' ? t("Your walk has ended and the dispatcher has closed the incident.") : t("Live updates have stopped. The dispatcher keeps your last known location until they close this incident.") : snapshot.location ? t('{captured} · accuracy ±{meters} m', { captured: capturedAgo(snapshot.location.recordedAt, now, locale), meters: Math.round(snapshot.location.accuracy) }) : t("No position has been confirmed yet.")}</p>{sharing && locationError && <p className="emergency-location-error" role="alert">{t(locationError)}</p>}</div>
      {sharing && (locationError || locationDelayed || !snapshot.location) && <button type="button" disabled={disabled || busy !== null} onClick={() => void run('location', onRetryLocation)}>{busy === 'location' ? t("Retrying…") : t("Retry location")}</button>}
    </div>
    {actionError?.action === 'location' && <p className="emergency-inline-error" role="alert">{t('Location retry failed: {error}', { error: t(actionError.message) })}</p>}

    {messageControls}
    <div className="emergency-status-actions">
      {incident.status !== 'resolved' && sharing && !cancellationPending && onRequestCancellation && <button type="button" className="emergency-cancel-action" disabled={disabled || busy !== null} onClick={() => void run('cancel', onRequestCancellation)}>{busy === 'cancel' ? t("Requesting cancellation…") : cancelError ? t("Retry cancellation request") : t("Request cancellation")}</button>}
      {incident.status === 'resolved' && sharing && onSendAnotherSignal && <button type="button" className="emergency-resend-action" disabled={disabled || busy !== null} onClick={onSendAnotherSignal}>{t("Send another signal")}</button>}
      {onShare && <button type="button" className="emergency-secondary-action" disabled={disabled || busy !== null} onClick={() => void run('share', onShare)}>{t("Share guardian link")}</button>}
      {sharing && onStopSharing && <button type="button" className="emergency-secondary-action" disabled={disabled || busy !== null} onClick={() => void run('stop', onStopSharing)}>{t("Stop sharing location")}</button>}
      {!sharing && incident.status === 'resolved' && onReset && <button type="button" className="emergency-secondary-action" disabled={disabled || busy !== null} onClick={onReset}>{t("Start another walk")}</button>}
    </div>
    {(actionError?.action === 'share' || actionError?.action === 'stop') && <p className="emergency-inline-error" role="alert">{t(actionError.message)}</p>}
    <p className="emergency-status-foot">{t("This is a prototype safety console. It does not call 911. For immediate danger, contact emergency services.")}</p>
  </section>;
}
