import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Circle, CircleMarker, MapContainer, Polyline, TileLayer, useMap } from 'react-leaflet';
import type { SessionSnapshot } from './api-types';
import { ApiRequestError, endSession, getSession, postLocation, requestHelp, startSession, type OwnerCredentials } from './api';
import { demoLocation } from './demoPath';

const STORAGE_KEY = 'ghostsignal-owner-v1';
const CAMPUS_CENTER: [number, number] = [40.1077, -88.2274];
const POLL_MS = 2000;
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

type IconName = 'signal' | 'arrow' | 'pin' | 'shield' | 'link' | 'check' | 'alert' | 'eye' | 'clock' | 'x' | 'heart' | 'external';

function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true as const };
  const paths: Record<IconName, ReactNode> = {
    signal: <><path d="M3 16.5c4.5-6 13.5-6 18 0" /><path d="M6.5 19c3-4 8-4 11 0" /><circle cx="12" cy="21" r=".6" fill="currentColor" stroke="none" /></>,
    arrow: <><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></>,
    pin: <><path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z" /><circle cx="12" cy="10" r="2.5" /></>,
    shield: <><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" /><path d="m9 12 2 2 4-4" /></>,
    link: <><path d="M10 13a5 5 0 0 0 7.1 0l2-2A5 5 0 0 0 12 3.9l-1.2 1.2" /><path d="M14 11a5 5 0 0 0-7.1 0l-2 2A5 5 0 0 0 12 20.1l1.2-1.2" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    alert: <><path d="M12 3 2 21h20L12 3Z" /><path d="M12 9v5" /><path d="M12 17.5h.01" /></>,
    eye: <><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z" /><circle cx="12" cy="12" r="2.5" /></>,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    x: <><path d="M5 5l14 14" /><path d="M19 5 5 19" /></>,
    heart: <path d="M20.8 8.6c0 4.8-8.8 10.4-8.8 10.4S3.2 13.4 3.2 8.6a4.8 4.8 0 0 1 8.8-2.5 4.8 4.8 0 0 1 8.8 2.5Z" />,
    external: <><path d="M13 5h6v6" /><path d="m19 5-9 9" /><path d="M19 13v6H5V5h6" /></>,
  };
  return <svg {...common}>{paths[name]}</svg>;
}

function Brand() {
  return <div className="brand"><span className="brand-mark"><span /></span><span>Ghost<span className="brand-light">Signal</span></span></div>;
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

function relativeTime(date: string | null | undefined, now: number) {
  if (!date) return 'No update yet';
  const seconds = Math.max(0, Math.floor((now - Date.parse(date)) / 1000));
  if (!Number.isFinite(seconds)) return 'Time unknown';
  if (seconds < 5) return 'Just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

function locationHealth(snapshot: SessionSnapshot | null, now: number) {
  if (!snapshot?.location) return { level: 'waiting', label: 'Waiting for first location' };
  const age = now - Date.parse(snapshot.location.recordedAt);
  if (age > 60_000) return { level: 'stale', label: 'Location is stale' };
  if (age > 15_000) return { level: 'delayed', label: 'Location is delayed' };
  return { level: 'fresh', label: 'Location updating' };
}

function MapFollow({ latitude, longitude }: { latitude: number; longitude: number }) {
  const map = useMap();
  useEffect(() => { map.flyTo([latitude, longitude], 16, { duration: 0.7 }); }, [map, latitude, longitude]);
  return null;
}

function SessionMap({ snapshot, compact = false }: { snapshot: SessionSnapshot | null; compact?: boolean }) {
  const location = snapshot?.location;
  const trail = snapshot?.trail || [];
  const point: [number, number] = location ? [location.latitude, location.longitude] : CAMPUS_CENTER;
  const help = snapshot?.status === 'help_requested';
  return <div className={`map-shell ${compact ? 'map-compact' : ''}`}>
    <MapContainer center={point} zoom={location ? 16 : 14} scrollWheelZoom={false} zoomControl={false} className="map-canvas" aria-label="Map showing shared location near the University of Illinois campus">
      <TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' url="https://tile.openstreetmap.org/{z}/{x}/{y}.png" maxZoom={19} referrerPolicy="strict-origin" />
      {trail.length > 1 && <Polyline positions={trail.map(p => [p.latitude, p.longitude])} pathOptions={{ color: help ? '#bb684d' : '#3d7d70', weight: 5, opacity: .75 }} />}
      {location && <>
        <Circle center={point} radius={Math.max(location.accuracy, 1)} pathOptions={{ color: help ? '#c57459' : '#579581', fillColor: help ? '#c57459' : '#579581', fillOpacity: .13, weight: 1.5 }} />
        <CircleMarker center={point} radius={10} pathOptions={{ color: '#fffdf8', weight: 3, fillColor: help ? '#bd6b52' : '#286b5c', fillOpacity: 1 }} />
        <MapFollow latitude={location.latitude} longitude={location.longitude} />
      </>}
    </MapContainer>
    {!location && <div className="map-empty"><span className="map-empty-icon"><Icon name="pin" size={25} /></span><strong>Waiting for a location</strong><span>The map will update when a position is available.</span></div>}
    <div className="map-caption"><span className="map-caption-dot" /> UNIVERSITY OF ILLINOIS · URBANA-CHAMPAIGN</div>
  </div>;
}

function MiniStatus({ snapshot, now, connectionError }: { snapshot: SessionSnapshot | null; now: number; connectionError?: string | null }) {
  const health = locationHealth(snapshot, now);
  const label = connectionError ? 'Connection interrupted' : health.label;
  const level = connectionError ? 'stale' : health.level;
  return <div className={`mini-status ${level}`}><span className="status-pulse" /><span>{label}</span>{snapshot?.location && <span className="mini-time">{relativeTime(snapshot.location.recordedAt, now)}</span>}</div>;
}

function useNow() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  return now;
}

function geolocationError(error: GeolocationPositionError) {
  if (error.code === error.PERMISSION_DENIED) return 'Location access was denied. Enable it in your browser settings, then try again.';
  if (error.code === error.POSITION_UNAVAILABLE) return 'Your position is unavailable. Check location services and try again.';
  return 'Finding your position took too long. Move somewhere with a clearer signal and try again.';
}

function firstLocation(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }));
}

function StudentApp() {
  const [credentials, setCredentials] = useState<OwnerCredentials | null>(readOwner);
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [busy, setBusy] = useState<'live' | 'demo' | 'help' | 'end' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [ownerInvalid, setOwnerInvalid] = useState(false);
  const [copyNote, setCopyNote] = useState('');
  const [showLink, setShowLink] = useState(false);
  const now = useNow();
  const demoIndex = useRef(0);
  const startLock = useRef(false);
  const lastAcceptedFixAt = useRef(0);

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
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [credentials, ownerInvalid]);

  useEffect(() => {
    if (!credentials || credentials.mode !== 'live' || !snapshot || snapshot.status === 'ended') return;
    let active = true;
    let inFlight = false;
    let latest: ReturnType<typeof positionPayload> | null = null;
    let lastSentAt = Date.now();
    const flush = async () => {
      if (!latest || inFlight || !active) return;
      if (Date.parse(latest.recordedAt) <= lastAcceptedFixAt.current) { latest = null; return; }
      if (Date.now() - lastSentAt < 2100) return;
      if (Date.now() - Date.parse(latest.recordedAt) > 105_000) { latest = null; setLocationError('The latest position is too old. Waiting for a fresh GPS fix.'); return; }
      inFlight = true;
      const payload = latest;
      latest = null;
      let succeeded = false;
      try {
        const next = await postLocation(credentials.sessionId, credentials.ownerToken, payload);
        lastAcceptedFixAt.current = Math.max(lastAcceptedFixAt.current, Date.parse(payload.recordedAt));
        lastSentAt = Date.now();
        succeeded = true;
        if (active) { setSnapshot(previous => newerSnapshot(previous, next)); setLocationError(null); }
      } catch (cause) {
        if (active) {
          if (cause instanceof ApiRequestError && cause.status === 409) {
            // A cached GPS fix may duplicate the first accepted position.
            setLocationError(null);
          } else {
            latest = latest || payload;
            setLocationError((cause as Error).message);
          }
        }
      } finally {
        inFlight = false;
        if (latest && active && succeeded) window.setTimeout(flush, 1000);
      }
    };
    const id = navigator.geolocation.watchPosition(
      position => { latest = positionPayload(position); void flush(); },
      geoError => { if (active) setLocationError(geolocationError(geoError)); },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 },
    );
    const retry = window.setInterval(() => { if (latest) void flush(); }, 2000);
    return () => { active = false; navigator.geolocation.clearWatch(id); window.clearInterval(retry); };
  }, [credentials, snapshot?.status]);

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
      setCredentials(owner); setSnapshot(created.session);
      window.scrollTo(0, 0);
      try { const next = await postLocation(owner.sessionId, owner.ownerToken, first); lastAcceptedFixAt.current = Date.parse(first.recordedAt); setSnapshot(previous => newerSnapshot(previous, next)); }
      catch (cause) { setLocationError((cause as Error).message); }
    } catch (cause) { setError(typeof cause === 'object' && cause !== null && 'code' in cause ? geolocationError(cause as GeolocationPositionError) : (cause as Error).message); }
    finally { setBusy(null); startLock.current = false; }
  };

  const help = async () => {
    if (!credentials) return;
    setBusy('help'); setError(null);
    try { const next = await requestHelp(credentials.sessionId, credentials.ownerToken); setSnapshot(previous => newerSnapshot(previous, next)); }
    catch (cause) { setError((cause as Error).message); }
    finally { setBusy(null); }
  };

  const end = async () => {
    if (!credentials) return;
    setBusy('end'); setError(null);
    try { const next = await endSession(credentials.sessionId, credentials.ownerToken); setSnapshot(previous => newerSnapshot(previous, next)); }
    catch (cause) { setError((cause as Error).message); }
    finally { setBusy(null); }
  };

  const shareUrl = credentials ? `${window.location.origin}/watch/${encodeURIComponent(credentials.sessionId)}#${encodeURIComponent(credentials.guardianToken)}` : '';
  const copy = async () => {
    try { await navigator.clipboard.writeText(shareUrl); setCopyNote('Private link copied'); }
    catch { setShowLink(true); setCopyNote('Select and copy the link below'); }
  };

  const ended = snapshot?.status === 'ended';
  const helpRequested = snapshot?.status === 'help_requested';

  return <div className="site-shell">
    <header className="topbar"><Brand /><div className="topbar-right"><span className="campus-tag"><span /> BUILT FOR CAMPUS WALKS</span></div></header>
    {!credentials ? <main className="landing">
      <div className="landing-grid">
        <section className="hero-copy">
          <div className="eyebrow"><span className="eyebrow-line" /> A PRIVATE WALK COMPANION</div>
          <h1>Walk your way.<br /><em>Stay connected.</em></h1>
          <p className="hero-lead">For the walk when something feels off. Share your live location with someone you trust, send a quiet help signal if you need it, and stop sharing when you’re safe.</p>
          <div className="step-flow"><span><b>01</b> Start</span><span><b>02</b> Share</span><span><b>03</b> Keep moving</span></div>
          <div className="hero-assurance"><span className="assurance-icon"><Icon name="shield" size={19} /></span><span>Your guardian can view your walk only with the private link you choose to share.</span></div>
        </section>
        <section className="start-card" aria-label="Start a walk">
          <div className="start-card-top"><span className="card-step">01 / START YOUR WALK</span><span className="small-signal"><i /><i /><i /></span></div>
          <h2>A little peace of mind, on your terms.</h2>
          <p>We’ll ask for your location when you start. Keep this page open during your walk so updates can continue.</p>
          <button className="primary-button" disabled={busy !== null} onClick={() => void start('live')}><span>{busy === 'live' ? 'Finding your location…' : 'Start a live walk'}</span><Icon name="arrow" /></button>
          <div className="card-separator"><span>OR EXPLORE FIRST</span></div>
          <button className="secondary-button" disabled={busy !== null} onClick={() => void start('demo')}><span>Try a simulated walk</span><Icon name="arrow" size={18} /></button>
          <p className="demo-disclosure">Demo mode sends a clearly labeled simulated route. It does not use your device location.</p>
          {error && <div className="inline-error" role="alert"><Icon name="alert" size={17} />{error}</div>}
        </section>
      </div>
      <div className="landing-bottom"><span><span className="little-cross">✳</span> MADE FOR THE MOMENTS BETWEEN HERE AND THERE</span><span>URBANA · CHAMPAIGN</span></div>
    </main> : !snapshot ? <main className="session-layout"><div className="restore-card"><span className="round-icon"><Icon name={ownerInvalid ? 'alert' : 'signal'} size={22} /></span><h1>{ownerInvalid ? 'Walk unavailable.' : 'Reconnecting to your walk.'}</h1><p>{ownerInvalid ? 'This saved session could not be found or opened. You can return to the start screen.' : pollError ? `We could not verify this walk yet: ${pollError} We’ll keep trying while this page stays open.` : 'Checking the session before showing your sharing controls. Your browser may ask for location again.'}</p>{ownerInvalid && <button className="dark-button" onClick={() => { sessionStorage.removeItem(STORAGE_KEY); setCredentials(null); setOwnerInvalid(false); setPollError(null); window.scrollTo(0, 0); }}>Return to start <Icon name="arrow" size={17} /></button>}</div></main> : <main className="session-layout">
      <div className="session-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> {credentials.mode === 'demo' ? 'SIMULATED WALK · DEMO MODE' : 'YOUR LIVE WALK'}</div><h1>{ended ? snapshot.endedReason === 'expired' ? 'Walk expired.' : 'Walk complete.' : helpRequested ? 'Help signal sent.' : 'You’re on your way.'}</h1><p>{ended ? snapshot.endedReason === 'expired' ? 'The session time limit was reached. Location sharing stopped automatically.' : 'Your location is no longer being shared.' : helpRequested ? 'Anyone with your private link can see that you requested help. If you are in immediate danger, call emergency services.' : 'Your private link shows your latest location and path while this page stays open.'}</p></div><div className={`session-state ${ended ? 'ended' : helpRequested ? 'help' : ''}`}><span />{ended ? 'SHARING ENDED' : helpRequested ? 'HELP REQUESTED' : 'SESSION ACTIVE'}</div></div>
      {credentials.mode === 'demo' && <div className="demo-banner"><Icon name="eye" size={17} /><strong>Demo mode</strong><span>This route is simulated. No device location is being used.</span></div>}
      {helpRequested && !ended && <div className="help-banner"><Icon name="alert" size={20} /><div><strong>Your help status is visible on the guardian link.</strong><span>This site does not contact emergency services. Call local emergency services if you need immediate help.</span></div></div>}
      {error && <div className="inline-error session-error" role="alert"><Icon name="alert" size={17} />{error}</div>}
      {(pollError || locationError) && !ended && <div className="connection-notice" role="status"><Icon name="alert" size={17} /><span>Updates may be delayed: {locationError || pollError}</span></div>}
      {ended ? <div className="complete-card"><span className="complete-icon"><Icon name={snapshot.endedReason === 'expired' ? 'clock' : 'check'} size={27} /></span><h2>{snapshot.endedReason === 'expired' ? 'Session time limit reached' : 'Sharing stopped'}</h2><p>{snapshot.endedReason === 'expired' ? 'This walk expired automatically. The location and route have been removed from the private link.' : 'You ended this walk. The location and route have been removed from the private link.'}</p></div> : <div className="session-grid"><section className="map-card"><div className="panel-head"><div><span className="overline">YOUR ROUTE</span><h2>{snapshot.location ? 'Current location' : 'Location pending'}</h2></div><MiniStatus snapshot={snapshot} now={now} connectionError={pollError || locationError} /></div><SessionMap snapshot={snapshot} compact /><div className="map-foot"><span><Icon name="pin" size={16} />{snapshot.location ? `Accuracy ±${Math.round(snapshot.location.accuracy)} m` : 'Waiting for GPS'}</span><span><Icon name="clock" size={16} />{snapshot.location ? `Captured ${relativeTime(snapshot.location.recordedAt, now)}` : 'No location yet'}</span></div></section>
      <aside className="side-stack"><section className="share-card"><div className="round-icon"><Icon name="link" size={21} /></div><span className="overline">INVITE YOUR PERSON</span><h2>Share this walk.</h2><p>Send this private link to someone you trust. The link gives them a read-only view of your location and status.</p><button className="dark-button" onClick={() => void copy()}><span>{copyNote || 'Copy guardian link'}</span><Icon name={copyNote === 'Private link copied' ? 'check' : 'link'} size={18} /></button><a className="open-guardian" href={shareUrl} target="_blank" rel="noreferrer">Open guardian view <Icon name="external" size={16} /></a>{showLink && <input className="link-input" aria-label="Guardian link" readOnly value={shareUrl} onFocus={event => event.currentTarget.select()} />}<div className="card-note"><Icon name="shield" size={15} />Anyone with this link can view the walk. Share it privately. OpenStreetMap receives the map area your browser requests.</div></section>
      <section className="actions-card"><span className="overline">YOUR CONTROLS</span>{!helpRequested && <button className="action-row help-action" disabled={busy !== null} onClick={() => void help()}><span className="action-icon"><Icon name="alert" size={20} /></span><span><strong>{busy === 'help' ? 'Sending help signal…' : 'I need help'}</strong><small>Quietly update your guardian view</small></span><Icon name="arrow" size={19} /></button>}<button className="action-row safe-action" disabled={busy !== null} onClick={() => void end()}><span className="action-icon"><Icon name="heart" size={20} /></span><span><strong>{busy === 'end' ? 'Ending sharing…' : 'I’m safe — end walk'}</strong><small>Stop sharing your location</small></span><Icon name="arrow" size={19} /></button></section></aside></div>}
      {!ended && <div className="page-open-note"><Icon name="eye" size={18} /><div><strong>Keep this page open during your walk.</strong> Browser location updates may pause if you close the tab, lock your phone, or move the app to the background.</div></div>}
      {ended && <button className="new-walk" onClick={() => { sessionStorage.removeItem(STORAGE_KEY); setCredentials(null); setSnapshot(null); setError(null); window.scrollTo(0, 0); }}>Start another walk <Icon name="arrow" size={17} /></button>}
    </main>}
    <footer className="footer"><span>GHOSTSIGNAL · A CAMPUS SAFETY PROTOTYPE</span><span>Location sharing works while this page stays active.</span></footer>
  </div>;
}

function positionPayload(position: GeolocationPosition) {
  return { latitude: position.coords.latitude, longitude: position.coords.longitude, accuracy: position.coords.accuracy, recordedAt: new Date(position.timestamp).toISOString() };
}

function GuardianApp({ sessionId }: { sessionId: string }) {
  const token = safeDecode(window.location.hash.slice(1));
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = useNow();

  useEffect(() => {
    if (!token) return;
    let active = true;
    let requesting = false;
    const poll = async () => {
      if (requesting) return;
      requesting = true;
      try { const next = await getSession(sessionId, token); if (active) { setSnapshot(previous => newerSnapshot(previous, next)); setError(null); } }
      catch (cause) { if (active) setError((cause as Error).message); }
      finally { requesting = false; }
    };
    void poll();
    const timer = window.setInterval(poll, POLL_MS);
    return () => { active = false; window.clearInterval(timer); };
  }, [sessionId, token]);

  const ended = snapshot?.status === 'ended';
  const help = snapshot?.status === 'help_requested';
  const health = locationHealth(snapshot, now);
  return <div className="site-shell watch-site"><header className="topbar"><Brand /><span className="watch-header-label"><Icon name="eye" size={17} /> PRIVATE GUARDIAN VIEW</span></header>
    <main className="watch-main"><div className="watch-intro"><div><div className="eyebrow"><span className="eyebrow-line" /> A WALK SHARED WITH YOU</div><h1>{ended ? snapshot?.endedReason === 'expired' ? 'This walk expired.' : 'This walk has ended.' : help ? 'Help has been requested.' : 'Stay in the loop.'}</h1><p>{ended ? snapshot?.endedReason === 'expired' ? 'The session time limit was reached. Sharing stopped automatically and location details were removed.' : 'The walker ended sharing. Location details and the route have been removed.' : help ? 'The walker used “I need help.” Check in with them directly. If there is immediate danger, contact emergency services.' : 'You can see the walker’s latest shared location and movement path here.'}</p></div>{snapshot && <div className={`watch-badge ${ended ? 'ended' : help ? 'help' : ''}`}><span />{ended ? 'WALK ENDED' : help ? 'HELP REQUESTED' : 'WALK IN PROGRESS'}</div>}</div>
    {snapshot?.mode === 'demo' && <div className="demo-banner"><Icon name="eye" size={17} /><strong>Simulated walk</strong><span>These locations are generated for a demo, not from a person’s device.</span></div>}
    {help && !ended && <div className="guardian-help"><span className="guardian-help-icon"><Icon name="alert" size={25} /></span><div><strong>The walker requested help</strong><p>Reach out to them now. This app does not alert emergency services or verify that anyone is responding.</p></div></div>}
    {!token && <div className="watch-error"><Icon name="link" size={23} /><strong>Private link incomplete</strong><span>Ask the walker to send you the full guardian link.</span></div>}
    {token && error && !snapshot && <div className="watch-error"><Icon name="alert" size={23} /><strong>Couldn’t load this walk</strong><span>{error}</span></div>}
    {token && !error && !snapshot && <div className="loading-view"><span className="loader" />Connecting to the walk…</div>}
    {snapshot && (ended ? <div className="complete-card"><span className="complete-icon"><Icon name={snapshot.endedReason === 'expired' ? 'clock' : 'check'} size={27} /></span><h2>{snapshot.endedReason === 'expired' ? 'Session expired' : 'The walker ended this walk'}</h2><p>Location and route details are no longer available through this link.</p></div> : <div className="watch-grid"><section className="watch-map-card"><div className="panel-head"><div><span className="overline">LIVE MAP</span><h2>Shared location</h2></div><MiniStatus snapshot={snapshot} now={now} connectionError={error} /></div><SessionMap snapshot={snapshot} /><div className="map-foot"><span><Icon name="pin" size={16} />{snapshot.location ? `Accuracy ±${Math.round(snapshot.location.accuracy)} m` : 'No position received yet'}</span><span><Icon name="clock" size={16} />{snapshot.location ? `Captured ${relativeTime(snapshot.location.recordedAt, now)}` : 'Waiting for location'}</span></div></section><aside className="watch-side"><div className="detail-card"><span className="overline">WALK DETAILS</span><div className="detail-row"><span>Started</span><strong>{new Date(snapshot.startedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</strong></div><div className="detail-row"><span>Location</span><strong>{snapshot.location ? `${snapshot.location.latitude.toFixed(5)}, ${snapshot.location.longitude.toFixed(5)}` : 'Waiting'}</strong></div><div className="detail-row"><span>Signal</span><strong className={health.level === 'stale' || error ? 'detail-warn' : ''}>{error ? 'Connection interrupted' : health.label}</strong></div><div className="detail-row"><span>Sharing</span><strong>Active</strong></div></div><div className="guardian-note"><Icon name="shield" size={20} /><div><strong>What this view means</strong><p>Positions update when the walker’s browser sends them. An old timestamp may mean their page is closed, their phone is locked, or their connection is lost. This view does not confirm that anyone is watching or responding. OpenStreetMap receives the map area your browser requests.</p></div></div></aside></div>)}
    {snapshot && error && <div className="connection-notice" role="status"><Icon name="alert" size={17} />Updates are interrupted: {error}</div>}
    {snapshot && !ended && health.level === 'stale' && <div className="stale-notice" role="status"><Icon name="clock" size={18} />This location is over a minute old. Contact the walker directly if you are concerned.</div>}
    </main><footer className="footer"><span>GHOSTSIGNAL · PRIVATE WALK VIEW</span><span>Only people with this link can open this view.</span></footer></div>;
}

export default function App() {
  const match = window.location.pathname.match(/^\/watch\/([^/]+)\/?$/);
  if (match) return <GuardianApp sessionId={safeDecode(match[1])} />;
  return <StudentApp />;
}
