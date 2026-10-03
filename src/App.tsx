import { EmergencyHold } from './EmergencyHold';
import { createEmergencyActions } from './emergency-actions';
import './landing.css';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Circle, CircleMarker, MapContainer, Polyline, TileLayer, ZoomControl, useMap } from 'react-leaflet';
import { INCIDENT_OUTCOMES, type ContactsInput, type IncidentStatus, type IncidentSummary, type SessionSnapshot } from './api-types';
import { addPushSubscription, ApiRequestError, endSession, getPushPublicKey, getSession, postLocation, sendGuardianNote, sendPresetMessage, setContacts, startSession, type OwnerCredentials } from './api';
import DispatchApp from './Dispatch';
import { demoLocation } from './demoPath';
import { createLocationUploader } from './location-upload';
import { startLocationWatch } from './location-watch';
import { accuracyLabel, Brand, CAMPUS_CENTER, clockTime, Icon, locationHealth, mapLink, movementSummary, playTones, relativeTime, useNow } from './shared';
import { SettingsButton, useI18n } from './i18n';
import { QuickMessages, ReceivedMessages } from './QuickMessages';
import './QuickMessages.css';
import { GuardianShare } from './GuardianShare';
import './GuardianShare.css';
import type { PresetMessageId } from './preset-messages';

const STORAGE_KEY = 'ghostsignal-owner-v1';
const TEXT_VIEW_KEY = 'ghostsignal-text-view';
const LINK_CACHE = 'ghostsignal-links';
const POLL_MS = 2000;
const GUARDIAN_POLL_MS = 1000;
const STATUS_RANK = { active: 0, help_requested: 1, ended: 2 };

function newerSnapshot(previous: SessionSnapshot | null, next: SessionSnapshot): SessionSnapshot {
  if (!previous) return next;
  const before = Date.parse(previous.updatedAt);
  const after = Date.parse(next.updatedAt);
  if (after < before || (after === before && STATUS_RANK[next.status] < STATUS_RANK[previous.status])) return previous;
  if (previous.status === 'ended' && next.status !== 'ended') return previous;
  return next;
}

function safeDecode(value: string) {
  try { return decodeURIComponent(value); } catch { return ''; }
}

function WalkGuide() {
  const dialog = useRef<HTMLDialogElement>(null);
  const { t } = useI18n();
  return <>
    <button className="guide-trigger" aria-label={t('How it works')} onClick={() => dialog.current?.showModal()}>{t('How it works')} <Icon name="arrow" size={15} /></button>
    <dialog ref={dialog} className="walk-guide" aria-labelledby="guide-title">
      <div className="guide-top"><span className="overline">{t('A LITTLE CLOSER, EVEN FROM AFAR')}</span><button className="icon-button" aria-label={t('Close guide')} onClick={() => dialog.current?.close()}><Icon name="x" /></button></div>
      <h2 id="guide-title">{t('Your walk. Your people.')}</h2>
      <ol className="guide-steps">
        <li><Icon name="pin" /><div><strong>{t('Start your walk')}</strong><p>{t('Allow location access, or explore a simulated UIUC walk without using your GPS.')}</p></div></li>
        <li><Icon name="link" /><div><strong>{t('Bring someone along')}</strong><p>{t('Send the private guardian link to someone you trust. Anyone with the link can view your location and status.')}</p></div></li>
        <li><Icon name="shield" /><div><strong>{t('Stay connected')}</strong><p>{t('Keep this page open and your screen unlocked. A help signal opens a request in the prototype safety console and updates your guardian. Guardian notifications require setup. This prototype is not connected to 911 or UIUC Police.')}</p></div></li>
      </ol>
      <div className="guide-note"><Icon name="clock" size={17} />{t('End sharing whenever you choose. Sessions expire after two hours.')}</div>
      <button className="primary-button" onClick={() => dialog.current?.close()}>{t('Got it. Let’s walk.')} <Icon name="arrow" /></button>
    </dialog>
  </>;
}


function readOwner(): OwnerCredentials | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as OwnerCredentials;
    return value.sessionId && value.ownerToken && value.guardianToken && (value.mode === 'live' || value.mode === 'demo') ? value : null;
  } catch {
    return null;
  }
}

function vibrate(pattern: number | number[]) {
  try { if ('vibrate' in navigator) navigator.vibrate(pattern); } catch { /* Haptics are optional. */ }
}

function MapFollow({ latitude, longitude }: { latitude: number; longitude: number }) {
  const map = useMap();
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) {
      map.setView([latitude, longitude], 16);
      focused.current = true;
    } else {
      map.panTo([latitude, longitude], { animate: true, duration: 0.7 });
    }
  }, [map, latitude, longitude]);
  return null;
}

function SessionMap({ snapshot }: { snapshot: SessionSnapshot | null }) {
  const { t, locale } = useI18n();
  const location = snapshot?.location;
  const trail = snapshot?.trail || [];
  const point: [number, number] = location ? [location.latitude, location.longitude] : CAMPUS_CENTER;
  const help = snapshot?.status === 'help_requested';
  return <div className="app-map">
    <MapContainer center={point} zoom={location ? 16 : 14} scrollWheelZoom={false} zoomControl={false} className="map-canvas" aria-label={t('Map showing shared location near the University of Illinois campus')}>
      <TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' url="https://tile.openstreetmap.org/{z}/{x}/{y}.png" maxZoom={19} referrerPolicy="strict-origin" />
      <ZoomControl key={locale} position="bottomright" zoomInTitle={t('Zoom in')} zoomOutTitle={t('Zoom out')} />
      {trail.length > 1 && <Polyline positions={trail.map(p => [p.latitude, p.longitude])} pathOptions={{ color: help ? '#bb684d' : '#3d7d70', weight: 5, opacity: .75 }} />}
      {location && <>
        <Circle center={point} radius={Math.max(location.accuracy, 1)} pathOptions={{ color: help ? '#c57459' : '#579581', fillColor: help ? '#c57459' : '#579581', fillOpacity: .13, weight: 1.5 }} />
        <CircleMarker center={point} radius={10} pathOptions={{ color: '#fffdf8', weight: 3, fillColor: help ? '#bd6b52' : '#286b5c', fillOpacity: 1 }} />
        <MapFollow latitude={location.latitude} longitude={location.longitude} />
      </>}
    </MapContainer>
    {!location && <div className="map-empty"><span className="map-empty-icon"><Icon name="pin" size={25} /></span><strong>{t('Finding your location')}</strong><span>{t('The map updates when a position is available.')}</span></div>}
  </div>;
}

function geolocationError(error: GeolocationPositionError) {
  if (error.code === error.PERMISSION_DENIED) return 'Location access was denied. Enable it in your browser settings, then try again.';
  if (error.code === error.POSITION_UNAVAILABLE) return 'Your position is unavailable. Check location services and try again.';
  return 'Finding your position took too long. Move somewhere with a clearer signal and try again.';
}

function firstLocation(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }));
}

function Fold({ title, summary, icon, children, defaultOpen = false }: { title: string; summary?: string; icon: Parameters<typeof Icon>[0]['name']; children: ReactNode; defaultOpen?: boolean }) {
  return <details className="app-fold" open={defaultOpen}>
    <summary><span className="fold-icon"><Icon name={icon} size={18} /></span><span className="fold-title"><strong>{title}</strong>{summary && <small>{summary}</small>}</span><Icon name="arrow" size={16} /></summary>
    <div className="fold-body">{children}</div>
  </details>;
}

function useStatusHaptics(status: IncidentStatus | null) {
  const previous = useRef(status);
  useEffect(() => {
    if (status !== previous.current) {
      if (status === 'acknowledged') vibrate(120);
      if (status === 'responding') vibrate([120, 100, 120]);
      if (status === 'resolved') vibrate(60);
    }
    previous.current = status;
  }, [status]);
}

function ResponderDetails({ credentials, snapshot, onSnapshot }: {
  credentials: OwnerCredentials;
  snapshot: SessionSnapshot;
  onSnapshot: (next: SessionSnapshot) => void;
}) {
  const { t } = useI18n();
  const [description, setDescription] = useState('');
  const [guardianPhone, setGuardianPhone] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (contacts: ContactsInput) => {
    setSaving(true); setError(null); setSaved(false);
    try {
      onSnapshot(await setContacts(credentials.sessionId, credentials.ownerToken, contacts));
      setDescription(''); setGuardianPhone(''); setSaved(true);
    } catch (cause) { setError((cause as Error).message); }
    finally { setSaving(false); }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const contacts: ContactsInput = {};
    if (description.trim()) contacts.walkerDescription = description.trim();
    if (guardianPhone.trim()) contacts.guardianPhone = guardianPhone.trim();
    if (Object.keys(contacts).length) void save(contacts);
  };

  return <form className="plan-form" onSubmit={submit}>
    <label className="field"><span>{t('What are you wearing?')}</span><textarea rows={2} maxLength={120} value={description} placeholder={snapshot.descriptionProvided ? t('Saved. Type to replace it') : t('e.g. red jacket, black backpack, glasses')} onChange={event => setDescription(event.target.value)} /></label>
    <p className="field-hint">{t('Responders use this to find you without calling you.')}</p>
    <label className="field"><span>{t('Guardian’s phone for text alerts')}</span><input type="tel" inputMode="tel" autoComplete="off" value={guardianPhone} placeholder={snapshot.textAlertsEnabled ? t('Saved. Type to replace it') : '+1 217 555 0123'} onChange={event => setGuardianPhone(event.target.value)} /></label>
    <button className="dark-button" type="submit" disabled={saving || (!description.trim() && !guardianPhone.trim())}><span>{saving ? t('Saving…') : saved ? t('Saved') : t('Save')}</span><Icon name="check" size={18} /></button>
    {(snapshot.descriptionProvided || snapshot.textAlertsEnabled) && <div className="plan-buttons">
      {snapshot.descriptionProvided && <button type="button" className="text-button" disabled={saving} onClick={() => void save({ walkerDescription: null })}>{t('Clear description')}</button>}
      {snapshot.textAlertsEnabled && <button type="button" className="text-button" disabled={saving} onClick={() => void save({ guardianPhone: null })}>{t('Stop guardian texts')}</button>}
    </div>}
    <p className="field-hint">{t('Deleted when your walk ends.')}</p>
    {error && <div className="inline-error" role="alert"><Icon name="alert" size={17} />{t(error)}</div>}
  </form>;
}

function StudentApp() {
  const { t, locale } = useI18n();
  const [credentials, setCredentials] = useState<OwnerCredentials | null>(readOwner);
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [busy, setBusy] = useState<'live' | 'demo' | 'end' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [ownerInvalid, setOwnerInvalid] = useState(false);
  const [showShareDialog, setShowShareDialog] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [emergencyBusy, setEmergencyBusy] = useState(false);
  const [locationAttempt, setLocationAttempt] = useState(0);
  const [selectedPreset, setSelectedPreset] = useState<PresetMessageId | null>(null);
  const emergencyOwner = useRef(credentials);
  emergencyOwner.current = credentials;
  const now = useNow();
  const demoIndex = useRef(0);
  const startLock = useRef(false);
  const lastAcceptedFixAt = useRef(0);
  const trackingActive = Boolean(snapshot && snapshot.status !== 'ended' && !ownerInvalid);
  useStatusHaptics(snapshot?.incident?.status ?? null);
  const [emergencyActions] = useState(() => createEmergencyActions({
    readOwner: () => emergencyOwner.current,
    saveOwner: (owner, initial) => {
      emergencyOwner.current = owner;
      try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(owner)); }
      catch { setLocationError('Browser storage is unavailable. Keep this page open to retain your session.'); }
      lastAcceptedFixAt.current = 0;
      setCredentials(owner);
      setSnapshot(initial);
    },
    onSnapshot: next => setSnapshot(previous => newerSnapshot(previous, next)),
  }));
  const emergencyRequest = async () => {
    await emergencyActions.send(selectedPreset ?? undefined);
    setSelectedPreset(null);
  };
  const retryLocation = async () => {
    setLocationError(null);
    setLocationAttempt(attempt => attempt + 1);
  };


  useEffect(() => {
    if (!credentials || ownerInvalid) return;
    let cancelled = false;
    let requesting = false;
    const poll = async () => {
      if (requesting) return;
      requesting = true;
      try {
        const next = await getSession(credentials.sessionId, credentials.ownerToken);
        if (!cancelled) { if (next.location) lastAcceptedFixAt.current = Math.max(lastAcceptedFixAt.current, Date.parse(next.location.recordedAt)); setSnapshot(previous => newerSnapshot(previous, next)); setPollError(null); }
      } catch (cause) {
        if (!cancelled) {
          if (cause instanceof ApiRequestError && (cause.status === 401 || cause.status === 404)) setOwnerInvalid(true);
          setPollError((cause as Error).message);
        }
      } finally { requesting = false; }
    };
    void poll();
    const timer = window.setInterval(poll, POLL_MS);
    const refresh = () => { if (document.visibilityState === 'visible') void poll(); };
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('online', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      cancelled = true; window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('online', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [credentials, ownerInvalid]);

  useEffect(() => {
    if (!credentials || credentials.mode !== 'live' || !trackingActive) return;
    if (!navigator.geolocation || !window.isSecureContext) {
      setLocationError('Location is unavailable on this page. Use HTTPS and enable location access; the safety console may not have your position.');
      return;
    }
    const uploader = createLocationUploader({
      send: (point: ReturnType<typeof positionPayload>) => postLocation(credentials.sessionId, credentials.ownerToken, point),
      getAcceptedRecordedAt: () => lastAcceptedFixAt.current,
      // The first position was sent by start(), or was just restored from the server.
      initialLastSuccessAt: Date.now(),
      onSuccess: (next, point) => {
        lastAcceptedFixAt.current = Math.max(lastAcceptedFixAt.current, Date.parse(point.recordedAt));
        setSnapshot(previous => newerSnapshot(previous, next));
        setLocationError(null);
      },
      onError: cause => {
        // A duplicate or an ended session is resolved by the next status poll.
        if (!(cause instanceof ApiRequestError && cause.status === 409)) setLocationError((cause as Error).message);
      },
      shouldRetry: cause => !(cause instanceof ApiRequestError) || cause.status === 429 || cause.status >= 500,
    });
    const watch = startLocationWatch({
      geolocation: navigator.geolocation,
      onPosition: position => uploader.push(positionPayload(position)),
      onError: cause => setLocationError(cause instanceof Error ? cause.message : geolocationError(cause)),
      isVisible: () => document.visibilityState === 'visible',
    });
    const refresh = () => {
      if (document.visibilityState !== 'visible') return;
      watch.refresh();
      uploader.retry();
    };
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('online', refresh);
    return () => {
      watch.stop(); uploader.stop();
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('online', refresh);
    };
  }, [credentials, trackingActive, locationAttempt]);

  useEffect(() => {
    if (!credentials || credentials.mode !== 'demo' || !snapshot || snapshot.status === 'ended') return;
    let active = true;
    const step = async () => {
      const point = demoLocation(demoIndex.current++);
      try { await postLocation(credentials.sessionId, credentials.ownerToken, point); if (active) setLocationError(null); }
      catch (cause) { if (active) setLocationError((cause as Error).message); }
    };
    const timer = window.setInterval(step, 4000);
    return () => { active = false; window.clearInterval(timer); };
  }, [credentials, snapshot?.status]);

  const start = async (mode: 'live' | 'demo') => {
    if (startLock.current) return;
    startLock.current = true;
    setShowShareDialog(false);
    setBusy(mode); setError(null); setPollError(null); setLocationError(null);
    try {
      let first: ReturnType<typeof positionPayload>;
      if (mode === 'live') {
        if (!navigator.geolocation || !window.isSecureContext) throw new Error('Live location needs a secure browser page (HTTPS or localhost) with location services enabled.');
        first = positionPayload(await firstLocation());
      } else {
        demoIndex.current = 1;
        first = demoLocation(0);
      }
      const created = await startSession(mode);
      const owner = { sessionId: created.sessionId, ownerToken: created.ownerToken, guardianToken: created.guardianToken, mode: created.session.mode };
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(owner));
      let initial = created.session;
      lastAcceptedFixAt.current = 0;
      try { initial = await postLocation(owner.sessionId, owner.ownerToken, first); lastAcceptedFixAt.current = Date.parse(first.recordedAt); }
      catch (cause) { setLocationError((cause as Error).message); }
      setCredentials(owner); setSnapshot(initial);
      window.scrollTo(0, 0);
    } catch (cause) { setError(typeof cause === 'object' && cause !== null && 'code' in cause ? geolocationError(cause as GeolocationPositionError) : (cause as Error).message); }
    finally { setBusy(null); startLock.current = false; }
  };

  const stopSharing = async () => {
    if (!credentials) return;
    setBusy('end'); setError(null);
    try { const next = await endSession(credentials.sessionId, credentials.ownerToken); setSnapshot(previous => newerSnapshot(previous, next)); }
    finally { setBusy(null); }
  };

  const end = async () => {
    try { await stopSharing(); }
    catch (cause) { setError((cause as Error).message); }
    finally { setConfirmEnd(false); }
  };

  const sendQuickMessage = async (presetId: PresetMessageId, clientMessageId: string) => {
    if (!credentials) throw new Error('Start a walk before sending a message.');
    const next = await sendPresetMessage(credentials.sessionId, credentials.ownerToken, presetId, clientMessageId);
    setSnapshot(previous => newerSnapshot(previous, next));
    if (!next.incident?.messages.some(message => message.id === clientMessageId && message.presetId === presetId)) {
      throw new Error('Message not confirmed. Retry to send it.');
    }
  };
  const resetToStart = () => { setEmergencyBusy(false); setShowShareDialog(false); sessionStorage.removeItem(STORAGE_KEY); setCredentials(null); setSnapshot(null); setError(null); setOwnerInvalid(false); setPollError(null); setSelectedPreset(null); window.scrollTo(0, 0); };

  const ended = snapshot?.status === 'ended';
  const helpRequested = snapshot?.status === 'help_requested';
  const incident = snapshot?.incident ?? null;
  const canSendIncidentMessage = Boolean(incident && incident.status !== 'resolved' && !incident.walkerCancelledAt && helpRequested && !ended);
  const canPrepareMessage = !incident || (incident.status === 'resolved' && !ended);
  const messageControls = canSendIncidentMessage
    ? <QuickMessages mode="incident" selectedId={selectedPreset} onSelect={setSelectedPreset} onSend={sendQuickMessage} sent={incident?.messages ?? []} disabled={emergencyBusy || busy !== null} />
    : canPrepareMessage
      ? <QuickMessages mode="prepare" selectedId={selectedPreset} onSelect={setSelectedPreset} disabled={emergencyBusy || busy !== null} />
      : <div className="quick-readonly"><ReceivedMessages messages={incident?.messages ?? []} /><p>{t('Messages are unavailable while cancellation is pending or the walk has ended.')}</p></div>;
  const displayedError = error ? t(error) : null;

  // Restore the server-confirmed request before deciding which controls to show.
  if (credentials && (!snapshot || ownerInvalid)) {
    return <div className="app">
      <header className="app-bar"><Brand /><SettingsButton /></header>
      <main className="app-body"><div className="restore-card"><span className="round-icon"><Icon name={ownerInvalid ? 'alert' : 'signal'} size={22} /></span><h1>{ownerInvalid ? t('Walk unavailable.') : t('Reconnecting…')}</h1><p>{ownerInvalid ? t('This saved walk could not be opened.') : pollError ? t('Still trying: {error}', { error: t(pollError) }) : t('Checking your walk. Your browser may ask for location again.')}</p>{ownerInvalid && <button className="dark-button" onClick={resetToStart}>{t('Back to start')} <Icon name="arrow" size={17} /></button>}</div></main>
    </div>;
  }

  const showWalkSummary = Boolean(credentials && snapshot && !ended && !incident);
  const location = snapshot?.location ?? null;
  const health = locationHealth(location, now, locale);
  return <div className="site-shell landing-site">
    <header className="topbar"><div className="brand-lockup"><Brand /><span className="brand-descriptor">{t('YOUR QUIET CONNECTION')}</span></div><div className="topbar-right"><SettingsButton /><WalkGuide /><span className="campus-tag"><span /> {t('BUILT AT UIUC')}</span></div></header>
    <main className="landing">
      <h1 className="sr-only">{t('Emergency help and walk companion')}</h1>
      {ended && !incident ? <section className="student-complete" aria-labelledby="student-complete-title">
        <span className="round-icon"><Icon name={snapshot?.endedReason === 'expired' ? 'clock' : 'check'} size={22} /></span>
        <h2 id="student-complete-title">{snapshot?.endedReason === 'expired' ? t('Walk timed out.') : t('Walk ended.')}</h2>
        <p>{t('Your location is no longer shared, and your saved details were deleted.')}</p>
        <button className="primary-button" onClick={resetToStart}>{t('Start another walk')} <Icon name="arrow" size={17} /></button>
      </section> : <>
      {snapshot?.mode === 'demo' && !ended && <div className="demo-banner student-demo-banner"><Icon name="eye" size={16} />{t('Simulated walk. No device location is used.')}</div>}
      <EmergencyHold onRequest={emergencyRequest} onRetract={emergencyActions.retract}
        onRequestCancellation={emergencyActions.retract} onBusyChange={setEmergencyBusy}
        snapshot={snapshot} now={now} locationError={locationError} pollError={pollError}
        onRetryLocation={retryLocation} onShare={() => setShowShareDialog(true)} onStopSharing={() => setConfirmEnd(true)}
        onReset={resetToStart} messageControls={messageControls} disabled={busy !== null} />
      {showWalkSummary && <section className="student-walk-summary" aria-label={t('Walk sharing status')}>
        <div className="student-walk-summary-head"><span className="status-pulse" aria-hidden="true" /><strong>{health.level === 'fresh' && !locationError && !pollError ? t('Location sharing is on') : t('Location updates need attention')}</strong></div>
        <p className={`student-location-health ${health.level}`}>{location ? t('Location received {age}', { age: relativeTime(location.recordedAt, now, locale) }) : t('Waiting for location')}</p>
        {(locationError || pollError) && <p className="student-location-error" role="status">{t('Updates delayed: {error}', { error: t(locationError || pollError || '') })}</p>}
        {credentials?.mode === 'live' && (locationError || health.level !== 'fresh') && <button type="button" className="student-location-retry" disabled={busy !== null || emergencyBusy} onClick={() => void retryLocation()}>{t('Retry location')}</button>}
        <div className="student-walk-actions">
          <button type="button" className="student-share-button" disabled={busy !== null || emergencyBusy} onClick={() => setShowShareDialog(true)}><Icon name="link" size={17} />{t('Share guardian link')}</button>
          <button type="button" className="student-stop-button" disabled={busy !== null || emergencyBusy} onClick={() => setConfirmEnd(true)}><Icon name="heart" size={17} />{t('Stop sharing')}</button>
        </div>
        <p className="student-page-open-note">{t('Keep GhostSignal open while you walk. Updates may pause if the screen locks or you switch apps.')}</p>
      </section>}
      {snapshot && !ended && <div className="student-responder-fold"><Fold title={t('Help responders find you')} summary={snapshot.descriptionProvided ? t('Description saved') : t('Optional. Add what you’re wearing.')} icon="user">
        <ResponderDetails credentials={credentials!} snapshot={snapshot} onSnapshot={next => setSnapshot(previous => newerSnapshot(previous, next))} />
      </Fold></div>}
      {confirmEnd && !ended && <section className="walk-shortcuts emergency-stop-confirm" aria-label={t('Confirm stopping location sharing')}>
        <h2>{t('Stop sharing your location?')}</h2>
        <p>{incident && incident.status !== 'resolved' ? t('Your emergency request will stay open. The dispatcher keeps your last known location until they close it.') : t('This ends your walk and removes live location from the guardian link.')}</p>
        <div className="walk-shortcut-buttons">
          <button className="primary-button" disabled={busy !== null} onClick={() => void end()}>{busy === 'end' ? t('Stopping…') : t('Stop sharing')}</button>
          <button className="secondary-button" disabled={busy !== null} onClick={() => setConfirmEnd(false)}>{t('Keep sharing')}</button>
        </div>
      </section>}
      {!credentials && <section className="walk-shortcuts" aria-label={t('Start a walk')}>
        <div className="walk-shortcut-buttons">
          <button className="primary-button" disabled={busy !== null || emergencyBusy} onClick={() => void start('live')}><span><Icon name="pin" size={18} />{busy === 'live' ? t('Finding your location…') : t('Start a live walk')}</span><Icon name="arrow" size={18} /></button>
          <button className="secondary-button" disabled={busy !== null || emergencyBusy} onClick={() => void start('demo')}><span>{busy === 'demo' ? t('Starting demo…') : t('Try a simulated walk')}</span><Icon name="arrow" size={18} /></button>
        </div>
        <p>{t('Share your walk with someone you trust.')}</p>
      </section>}
      </>}
      {error && <div className="inline-error student-home-error" role="alert"><Icon name="alert" size={17} />{displayedError}</div>}
    </main>
    <footer className="footer"><span>{t('GHOSTSIGNAL · A CAMPUS SAFETY PROTOTYPE')}</span><span>{t('Location sharing works while this page stays active.')}</span></footer>
    {showShareDialog && credentials && <GuardianShare origin={window.location.origin} sessionId={credentials.sessionId} guardianToken={credentials.guardianToken} variant="dialog" onClose={() => setShowShareDialog(false)} />}
    </div>;
}

function positionPayload(position: GeolocationPosition) {
  return { latitude: position.coords.latitude, longitude: position.coords.longitude, accuracy: position.coords.accuracy, recordedAt: new Date(position.timestamp).toISOString() };
}

// Shows the guardian how far Campus Safety has progressed with the signal.
function IncidentTracker({ incident, sharing, now }: { incident: IncidentSummary; sharing: boolean; now: number }) {
  const { t, locale } = useI18n();
  const steps = [
    { label: t('Signal sent'), at: incident.openedAt, detail: t('Ref {reference}', { reference: incident.reference }) },
    { label: t('Campus Safety has it'), at: incident.acknowledgedAt, detail: sharing ? t('Watching live location') : t('Live sharing stopped') },
    { label: incident.unit ? t('{unit} on the way', { unit: incident.unit }) : t('Responder on the way'), at: incident.respondingAt, detail: sharing ? t('Heading to live location') : t('Heading to the last known location') },
    { label: t('Closed'), at: incident.resolvedAt, detail: incident.outcome ? t(INCIDENT_OUTCOMES[incident.outcome]) : '' },
  ];
  const current = steps.findIndex(step => !step.at);
  const waiting = incident.status === 'new' && now - Date.parse(incident.openedAt) > 60_000;
  return <section className={`tracker-card ${incident.status}`} aria-labelledby="tracker-title" aria-live="polite">
    <span className="overline">{t('CAMPUS SAFETY · {reference}', { reference: incident.reference })}</span>
    <h2 id="tracker-title">{incident.status === 'new' ? t('Delivered. Waiting for a dispatcher.') : incident.status === 'acknowledged' ? sharing ? t('Campus Safety is watching.') : t('Campus Safety saw the request.') : incident.status === 'responding' ? t('A responder is on the way.') : t('Closed.')}</h2>
    <ol className="tracker-steps">
      {steps.map((step, index) => <li key={step.label} className={step.at ? 'done' : index === current ? 'current' : ''}>
        <span className="tracker-dot">{step.at ? <Icon name="check" size={13} /> : null}</span>
        <div><strong>{step.label}</strong><span>{step.at ? t('{time} · {detail}', { time: clockTime(step.at, locale), detail: step.detail }) : index === current ? t('Waiting…') : ''}</span></div>
      </li>)}
    </ol>
    {incident.status !== 'resolved' && incident.walkerCancelledAt && <p className="tracker-note">{t('The walker cancelled. Campus Safety will still check on them in person.')}</p>}
    {waiting && <p className="tracker-warn"><Icon name="alert" size={16} />{sharing ? t('Not seen by a dispatcher yet. If you believe they’re in immediate danger, call 911 yourself and give this location. Don’t call the walker.') : t('Not seen by a dispatcher yet. If you believe they’re in immediate danger, call 911 yourself and share the last location you saw. Don’t call the walker.')}</p>}
  </section>;
}

function GuardianNote({ sessionId, token }: { sessionId: string; token: string }) {
  const { t } = useI18n();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!text.trim()) return;
    setBusy(true); setError(null);
    try { await sendGuardianNote(sessionId, token, text.trim()); setText(''); setSent(count => count + 1); }
    catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  };
  return <form className="plan-card note-card" onSubmit={submit}>
    <span className="overline">{t('HELP CAMPUS SAFETY')}</span>
    <h2>{t('Share what you know')}</h2>
    <p>{t('This goes straight to the dispatcher, not to the walker.')}</p>
    <label className="field"><span className="sr-only">{t('Note for Campus Safety')}</span><textarea rows={3} maxLength={280} value={text} placeholder={t('Where they were headed, what they’re wearing, who they were with…')} onChange={event => setText(event.target.value)} /></label>
    <button className="dark-button" disabled={busy || !text.trim()}><span>{busy ? t('Sending…') : t('Send to Campus Safety')}</span><Icon name="arrow" size={18} /></button>
    {sent > 0 && <p className="note-sent"><Icon name="check" size={15} />{t('Sent to Campus Safety{count}.', { count: sent > 1 ? ` (${sent})` : '' })}</p>}
    {error && <div className="inline-error" role="alert"><Icon name="alert" size={17} />{t(error)}</div>}
  </form>;
}

type PushState = 'checking' | 'unsupported' | 'idle' | 'working' | 'on' | 'blocked' | 'error';

function urlBase64ToUint8Array(value: string) {
  const padded = (value + '='.repeat((4 - value.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(padded), char => char.charCodeAt(0));
}

// Registers this device for push notifications about one walk, and plays in-tab sounds.
function useGuardianAlerts(sessionId: string, token: string, active: { help: boolean; stale: boolean; incidentStatus: string | null }) {
  const { t } = useI18n();
  const supported = typeof window !== 'undefined' && window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const [pushState, setPushState] = useState<PushState>(supported ? 'checking' : 'unsupported');
  const [pushError, setPushError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const audio = useRef<AudioContext | null>(null);
  const previous = useRef(active);
  const baseTitle = useRef(document.title);

  const register = async (subscription: PushSubscription) => {
    const json = subscription.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
    await addPushSubscription(sessionId, token, { endpoint: json.endpoint, keys: json.keys });
    try { await (await caches.open(LINK_CACHE)).put(`/links/${encodeURIComponent(sessionId)}`, new Response(window.location.href)); } catch { /* Tapping a notification then opens the page without the key. */ }
  };

  useEffect(() => {
    if (!supported || !token) return;
    let cancelled = false;
    void (async () => {
      try {
        if (Notification.permission !== 'granted') { if (!cancelled) setPushState(Notification.permission === 'denied' ? 'blocked' : 'idle'); return; }
        const registration = await navigator.serviceWorker.register('/sw.js');
        const existing = await registration.pushManager.getSubscription();
        if (existing) { await register(existing); if (!cancelled) setPushState('on'); }
        else if (!cancelled) setPushState('idle');
      } catch { if (!cancelled) setPushState('idle'); }
    })();
    return () => { cancelled = true; };
  }, [sessionId, token]);

  const enable = async () => {
    try { audio.current ??= new AudioContext(); await audio.current.resume(); } catch { /* Sound is optional. */ }
    if (!supported) return;
    setPushState('working'); setPushError(null);
    try {
      const registration = await navigator.serviceWorker.register('/sw.js');
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') { setPushState('blocked'); return; }
      await navigator.serviceWorker.ready;
      const { publicKey } = await getPushPublicKey();
      const subscription = await registration.pushManager.getSubscription()
        ?? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
      await register(subscription);
      setPushState('on');
    } catch (cause) {
      setPushError((cause as Error).message);
      setPushState('error');
    }
  };

  useEffect(() => {
    const before = previous.current;
    if (active.help && !before.help) { setAnnouncement('Silent help signal from the walker. Campus Safety is notified. Do not call or text them.'); playTones(audio.current, 3, 880); }
    else if (active.incidentStatus !== before.incidentStatus && active.incidentStatus === 'acknowledged') { setAnnouncement('Campus Safety is watching the walker’s location.'); playTones(audio.current, 1, 660); }
    else if (active.incidentStatus !== before.incidentStatus && active.incidentStatus === 'responding') { setAnnouncement('A responder is on the way.'); playTones(audio.current, 2, 660); }
    else if (active.stale && !before.stale) { setAnnouncement('The walker’s location is over a minute old.'); playTones(audio.current, 1, 520); }
    previous.current = active;
    const title = active.help ? t('Silent help signal') : active.stale ? t('Location stale') : null;
    document.title = title ? `⚠ ${title} · GhostSignal` : baseTitle.current;
  }, [active.help, active.stale, active.incidentStatus, t]);

  useEffect(() => () => { document.title = baseTitle.current; }, []);

  return { pushState, pushError, announcement: t(announcement), enable };
}

function TextStatus({ snapshot, now }: { snapshot: SessionSnapshot; now: number }) {
  const { t, locale } = useI18n();
  const location = snapshot.location;
  const help = snapshot.status === 'help_requested';
  const health = locationHealth(location, now, locale);
  return <div className="text-status">
    <p className={`text-status-lead ${help ? 'warn' : ''}`}>{help ? t('Silent help signal.') : t('Walk in progress.')}</p>
    <dl>
      <div><dt>{t('Last update')}</dt><dd>{location ? t('{age} · {status}', { age: relativeTime(location.recordedAt, now, locale), status: health.label }) : t('Waiting for location')}</dd></div>
      <div><dt>{t('Movement')}</dt><dd>{movementSummary(location, snapshot.trail, locale)}</dd></div>
      {location && <div><dt>{t('Accuracy')}</dt><dd>{accuracyLabel(location.accuracy, locale)}</dd></div>}
      {snapshot.incident && snapshot.incident.status !== 'resolved' && <div><dt>{t('Campus Safety')}</dt><dd>{snapshot.incident.status === 'new' ? t('Delivered, not yet seen') : snapshot.incident.status === 'acknowledged' ? t('Watching') : t('{unit} on the way', { unit: snapshot.incident.unit ?? t('A responder') })}</dd></div>}
      {location && <div><dt>{t('Coordinates')}</dt><dd>{location.latitude.toFixed(5)}, {location.longitude.toFixed(5)}</dd></div>}
    </dl>
    {location && <a className="text-status-link" href={mapLink(location)} target="_blank" rel="noreferrer">{t('Open this location in a map')} <Icon name="external" size={18} /></a>}
  </div>;
}

function GuardianApp({ sessionId }: { sessionId: string }) {
  const { t, locale } = useI18n();
  const token = safeDecode(window.location.hash.slice(1));
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [lastCheckedAt, setLastCheckedAt] = useState<string | null>(null);
  const now = useNow();

  useEffect(() => {
    if (!token) return;
    let active = true;
    let requesting = false;
    const poll = async () => {
      if (requesting) return;
      requesting = true;
      try { const next = await getSession(sessionId, token); if (active) { setSnapshot(previous => newerSnapshot(previous, next)); setLastCheckedAt(new Date().toISOString()); setError(null); } }
      catch (cause) { if (active) setError((cause as Error).message); }
      finally { requesting = false; }
    };
    void poll();
    const timer = window.setInterval(poll, GUARDIAN_POLL_MS);
    const refresh = () => { if (document.visibilityState === 'visible') void poll(); };
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('online', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      active = false; window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('online', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [sessionId, token]);

  const retryConnection = async () => {
    if (!token || retrying) return;
    setRetrying(true);
    try {
      const next = await getSession(sessionId, token);
      setSnapshot(previous => newerSnapshot(previous, next));
      setLastCheckedAt(new Date().toISOString());
      setError(null);
    } catch (cause) { setError((cause as Error).message); }
    finally { setRetrying(false); }
  };

  const [textView, setTextView] = useState(() => { try { return localStorage.getItem(TEXT_VIEW_KEY) === '1'; } catch { return false; } });
  const toggleTextView = () => {
    setTextView(value => {
      try { localStorage.setItem(TEXT_VIEW_KEY, value ? '0' : '1'); } catch { /* Preference is optional. */ }
      return !value;
    });
  };

  const ended = snapshot?.status === 'ended';
  const help = snapshot?.status === 'help_requested';
  const health = locationHealth(snapshot?.location, now, locale);
  const incident = snapshot?.incident ?? null;
  const incidentOpen = Boolean(incident && incident.status !== 'resolved');
  const alerts = useGuardianAlerts(sessionId, token, { help: Boolean(help), stale: Boolean(snapshot && !ended && health.level === 'stale'), incidentStatus: incident?.status ?? null });
  const isApple = /iPhone|iPad|iPod/.test(navigator.userAgent);

  return <div className={`app watch-app ${help ? 'alerting' : ''}`}>
    <div className="sr-only" role="alert" aria-live="assertive">{alerts.announcement}</div>
    <header className="app-bar"><Brand /><SettingsButton /><span className="app-bar-meta"><Icon name="eye" size={15} />{t('Guardian')}</span></header>
    <main className="app-body">
      {!token && <div className="restore-card"><span className="round-icon"><Icon name="link" size={22} /></span><h1>{t('Link incomplete.')}</h1><p>{t('Ask the walker to share the full link again.')}</p></div>}
      {token && error && !snapshot && <div className="restore-card"><span className="round-icon"><Icon name="alert" size={22} /></span><h1>{t('Couldn’t load this walk.')}</h1><p>{t(error)}</p><button className="dark-button" disabled={retrying} onClick={() => void retryConnection()}>{retrying ? t('Retrying…') : t('Retry connection')}</button></div>}
      {token && !error && !snapshot && <div className="loading-view"><span className="loader" />{t('Connecting…')}</div>}
      {snapshot && <>
        <section className="watch-hero">
          <span className={`watch-badge ${ended ? 'ended' : help ? 'help' : ''}`}><span />{ended ? t('WALK ENDED') : help ? t('SILENT HELP SIGNAL') : t('WALK IN PROGRESS')}</span>
          <h1>{ended ? snapshot.endedReason === 'expired' ? t('This walk timed out.') : t('This walk has ended.') : help ? t('They quietly asked for help.') : t('You’re following a walk.')}</h1>
          {!ended && !help && <p>{alerts.pushState === 'on' ? t('Help notifications are on for this phone.') : alerts.pushState === 'unsupported' ? t('Keep this page open for help updates on this phone.') : t('Turn on notifications below to get help alerts on this phone.')}</p>}
        </section>
        {snapshot.mode === 'demo' && <div className="demo-strip"><Icon name="eye" size={15} />{t('Simulated walk for a demo.')}</div>}
        {help && !ended && <section className="guardian-alert" role="status">
          <strong><Icon name="x" size={18} />{t('Don’t call or text them')}</strong>
          <p>{t('They sent a silent help request. Calling or texting may be unsafe or inaccessible for them. Follow the dispatcher updates here.')}</p>
          <p>{snapshot.location && health.level === 'fresh' ? t('Campus Safety is notified and can see their live location.') : t('Campus Safety is notified. Live location is still being established or may be delayed.')}</p>
        </section>}
        {error && <div className="quiet-warning guardian-connection-warning" role="status"><Icon name="alert" size={15} /><span>{t('Updates interrupted: {error}', { error: t(error) })}</span><button type="button" disabled={retrying} onClick={() => void retryConnection()}>{retrying ? t('Retrying…') : t('Retry connection')}</button></div>}
        {ended ? <div className="restore-card"><span className="round-icon"><Icon name={snapshot.endedReason === 'expired' ? 'clock' : 'check'} size={22} /></span><p>{t('Location and route details are no longer available through this link.')}</p></div> : <>
          <section className="watch-map-card">
            <div className="watch-map-head">
              <span className={`fresh ${error ? 'stale' : health.level}`}>{error ? t('Connection interrupted') : snapshot.location ? t('Updated {age}', { age: relativeTime(snapshot.location.recordedAt, now, locale) }) : t('Waiting for location')}</span>
              <button className="toolbar-button small" onClick={toggleTextView} aria-pressed={textView}><Icon name={textView ? 'pin' : 'eye'} size={16} />{textView ? t('Map') : t('Text only')}</button>
            </div>
            {textView ? <TextStatus snapshot={snapshot} now={now} /> : <SessionMap snapshot={snapshot} />}
          </section>
          {!error && health.level === 'stale' && <div className="quiet-warning" role="status"><Icon name="clock" size={15} />{t('Location is over a minute old. Their phone may be locked, offline, or out of battery.')}</div>}
        </>}
        {incident && <ReceivedMessages messages={incident.messages} audience="guardian" />}
        {incident && <IncidentTracker incident={incident} sharing={!ended} now={now} />}
        {!ended && incidentOpen && <GuardianNote sessionId={sessionId} token={token} />}
        {!ended && alerts.pushState !== 'on' && <section className="notify-card" aria-labelledby="notify-title">
          <span className="notify-icon"><Icon name="bell" size={22} /></span>
          <div>
            <h2 id="notify-title">{t('Get notified on this phone')}</h2>
            <p>{alerts.pushState === 'unsupported' ? isApple ? t('On iPhone, add this page to your Home Screen first: tap Share, then “Add to Home Screen,” and open the link from there.') : t('This browser can’t receive notifications. Keep this page open to hear an alert.') : alerts.pushState === 'blocked' ? t('Notifications are blocked for this site. Allow them in your browser settings.') : t('Turn on notifications here to receive help updates on this device.')}</p>
            {alerts.pushError && <p className="notify-error">{t(alerts.pushError)}</p>}
          </div>
          <button className="dark-button" disabled={alerts.pushState === 'working' || alerts.pushState === 'checking'} onClick={() => void alerts.enable()}><span>{alerts.pushState === 'working' ? t('Turning on…') : alerts.pushState === 'unsupported' ? t('Turn on alert sound') : t('Turn on notifications')}</span><Icon name="bell" size={18} /></button>
        </section>}
        {!ended && alerts.pushState === 'on' && <p className="notify-on"><Icon name="check" size={15} />{t('Notifications on for this phone')}{snapshot.textAlertsEnabled ? t(' · text alerts on') : ''}</p>}
        {!ended && <Fold title={t('Walk details')} icon="clock">
            <div className="detail-row"><span>{t('Started')}</span><strong>{new Date(snapshot.startedAt).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })}</strong></div>
            <div className="detail-row"><span>{t('Accuracy')}</span><strong>{snapshot.location ? accuracyLabel(snapshot.location.accuracy, locale) : '—'}</strong></div>
            <div className="detail-row"><span>{t('Movement')}</span><strong>{movementSummary(snapshot.location, snapshot.trail, locale)}</strong></div>
            <div className="detail-row"><span>{t('View refreshed')}</span><strong>{relativeTime(lastCheckedAt, now, locale)}</strong></div>
            <p className="fold-text">{t('Positions arrive while the walker’s app is open. Campus Safety status comes from the prototype dispatch console. OpenStreetMap receives the map area your browser loads.')}</p>
          </Fold>}
      </>}
    </main>
  </div>;
}

export default function App() {
  if (/^\/dispatch\/?$/.test(window.location.pathname)) return <DispatchApp />;
  const match = window.location.pathname.match(/^\/watch\/([^/]+)\/?$/);
  if (match) return <GuardianApp sessionId={safeDecode(match[1])} />;
  return <StudentApp />;
}
