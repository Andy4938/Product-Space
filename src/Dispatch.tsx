import L from 'leaflet';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Circle, MapContainer, Marker, Polyline, TileLayer, Tooltip, ZoomControl, useMap } from 'react-leaflet';
import { INCIDENT_OUTCOMES, type DispatchIncident, type IncidentEventKind, type IncidentOutcome, type IncidentStatus } from './api-types';
import { acknowledgeIncident, addIncidentNote, ApiRequestError, listIncidents, resolveIncident, respondToIncident } from './api';
import { describeNearLandmark } from './landmarks';
import { accuracyLabel, Brand, CAMPUS_CENTER, Icon, type IconName, elapsed, locationHealth, mapLink, movementSummary, playTones, relativeTime, useNow } from './shared';
import { PRESET_MESSAGES } from './preset-messages';
import { getIncomingMessageIds, getUnreadMessageCount } from './dispatch-messages';
import './DispatchUX.css';

const CODE_KEY = 'ghostsignal-dispatch-code';
const READ_KEY = 'ghostsignal-dispatch-message-reads-v1';
const POLL_MS = 2000;
const ALARM_REPEAT_MS = 10_000;
const UNIT_SUGGESTIONS = ['Patrol 1', 'Patrol 2', 'Patrol 3', 'CSO Safety Escort', 'Bike Patrol', 'Supervisor'];
const STATUS_LABEL: Record<IncidentStatus, string> = { new: 'NEW', acknowledged: 'ACKNOWLEDGED', responding: 'RESPONDING', resolved: 'CLOSED' };
const STATUS_ORDER: Record<IncidentStatus, number> = { new: 0, acknowledged: 1, responding: 2, resolved: 3 };
const EVENT_ICON: Record<IncidentEventKind, IconName> = {
  opened: 'radio', acknowledged: 'eye', responding: 'arrow', resolved: 'check', note: 'note',
  walker_cancelled: 'x', walker_resent: 'alert', walker_ended: 'heart', session_expired: 'clock', guardian_note: 'user',
};

let consoleAudio: AudioContext | null = null;

async function unlockAudio() {
  try { consoleAudio ??= new AudioContext(); await consoleAudio.resume(); return consoleAudio.state === 'running'; }
  catch { return false; }
}

function readCode() {
  try { return sessionStorage.getItem(CODE_KEY); } catch { return null; }
}

function readMessageReceipts(): Set<string> {
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(READ_KEY) ?? '[]');
    return new Set(Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string') : []);
  } catch { return new Set(); }
}

export default function DispatchApp() {
  const [code, setCode] = useState<string | null>(readCode);
  const signOut = () => { try { sessionStorage.removeItem(CODE_KEY); sessionStorage.removeItem(READ_KEY); } catch { /* Nothing stored. */ } setCode(null); };
  return code ? <DispatchConsole code={code} onSignOut={signOut} /> : <DispatchLogin onLogin={setCode} />;
}

function DispatchLogin({ onLogin }: { onLogin: (code: string) => void }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true); setError(null);
    void unlockAudio();
    try {
      await listIncidents(value.trim());
      try { sessionStorage.setItem(CODE_KEY, value.trim()); } catch { /* Signed in for this page only. */ }
      onLogin(value.trim());
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  };
  return <div className="dispatch-shell landing-site dispatch-login-shell" lang="en">
    <form className="dispatch-login" onSubmit={submit}>
      <div className="brand-lockup"><Brand /><span className="brand-descriptor dispatch-descriptor">CAMPUS SAFETY CONSOLE</span></div>
      <h1>Dispatcher sign-in</h1>
      <p>Use the access code printed next to “Campus Safety console” in the computer’s app terminal. The code is case-sensitive.</p>
      <label className="dispatch-field"><span>Access code</span><input autoFocus value={value} autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} onChange={event => setValue(event.target.value)} /></label>
      <button className="dispatch-primary" disabled={busy || !value.trim()}>{busy ? 'Checking…' : 'Open console'}</button>
      {error && <p className="dispatch-login-error" role="alert">{error}</p>}
      <p className="dispatch-login-hint">Following someone as a guardian? Open their private guardian link instead. No console code is needed.</p>
      <p className="dispatch-proto"><Icon name="alert" size={15} />Prototype. Not connected to UIUC Police, METCOM, or 911.</p>
    </form>
  </div>;
}

function sortIncidents(incidents: DispatchIncident[]) {
  return [...incidents].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
    (a.status === 'resolved' ? Date.parse(b.resolvedAt!) - Date.parse(a.resolvedAt!) : Date.parse(a.openedAt) - Date.parse(b.openedAt)));
}

function place(incident: DispatchIncident) {
  return incident.location ? describeNearLandmark(incident.location.latitude, incident.location.longitude) : incident.status === 'resolved' ? 'Location access ended' : 'Waiting for first location';
}

function DispatchConsole({ code, onSignOut }: { code: string; onSignOut: () => void }) {
  const [incidents, setIncidents] = useState<DispatchIncident[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [readMessageIds, setReadMessageIds] = useState(readMessageReceipts);
  const [tab, setTab] = useState<'open' | 'closed'>('open');
  const [mobileView, setMobileView] = useState<'signals' | 'details' | 'map'>('signals');
  const [syncing, setSyncing] = useState(false);
  const [soundOn, setSoundOn] = useState(() => consoleAudio?.state === 'running');
  const [soundError, setSoundError] = useState(false);
  const soundEnabled = useRef(soundOn);
  soundEnabled.current = soundOn;
  const refreshNow = useRef<() => void>(() => {});
  const detailsPanel = useRef<HTMLElement>(null);
  const [notificationState, setNotificationState] = useState(() => 'Notification' in window ? Notification.permission : 'unsupported');
  const [notificationError, setNotificationError] = useState(false);
  const known = useRef<Set<string> | null>(null);
  const baseTitle = useRef(document.title);
  const clock = useNow();
  const now = clock + offset;

  useEffect(() => {
    let active = true;
    let requesting = false;
    const poll = async () => {
      if (requesting) return;
      requesting = true;
      setSyncing(true);
      try {
        const list = await listIncidents(code);
        if (!active) return;
        setOffset(Date.parse(list.serverTime) - Date.now());
        const fresh = list.incidents.filter(incident => incident.status === 'new' && known.current && !known.current.has(incident.id));
        if (fresh.length) {
          if (soundEnabled.current) playTones(consoleAudio, 3, 988);
          if ('Notification' in window && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
            try { new Notification('New help signal', { body: `${fresh[0].reference} · ${place(fresh[0])}`, tag: 'ghostsignal-dispatch', requireInteraction: true }); } catch { /* Notifications are optional. */ }
          }
          setSelectedId(current => current ?? fresh[0].id);
          setTab('open');
        }
        known.current = new Set(list.incidents.map(incident => incident.id));
        setIncidents(list.incidents);
        setLoaded(true);
        setLastSync(new Date().toISOString());
        setError(null);
      } catch (cause) {
        if (!active) return;
        if (cause instanceof ApiRequestError && cause.status === 401) { onSignOut(); return; }
        setError((cause as Error).message);
      } finally { requesting = false; if (active) setSyncing(false); }
    };
    refreshNow.current = () => { void poll(); };
    void poll();
    const timer = window.setInterval(poll, POLL_MS);
    const refresh = () => { if (document.visibilityState === 'visible') void poll(); };
    window.addEventListener('online', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => { active = false; window.clearInterval(timer); refreshNow.current = () => {}; window.removeEventListener('online', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, [code]);

  const sorted = useMemo(() => sortIncidents(incidents), [incidents]);
  const open = sorted.filter(incident => incident.status !== 'resolved');
  const closed = sorted.filter(incident => incident.status === 'resolved');
  const awaiting = open.filter(incident => incident.status === 'new').length;
  const responding = open.filter(incident => incident.status === 'responding').length;
  const list = tab === 'open' ? open : closed;
  const selected = list.find(incident => incident.id === selectedId) ?? null;
  const unreadByIncident = useMemo(() => new Map(incidents.map(incident => [incident.id, getUnreadMessageCount(incident, readMessageIds)])), [incidents, readMessageIds]);
  const totalUnread = [...unreadByIncident.values()].reduce((sum, count) => sum + count, 0);

  useEffect(() => {
    if (loaded && !list.some(incident => incident.id === selectedId)) setSelectedId(list[0]?.id ?? null);
  }, [loaded, list, selectedId]);

  useEffect(() => {
    if (mobileView === 'details' && window.matchMedia('(max-width: 760px)').matches) {
      detailsPanel.current?.scrollIntoView({ block: 'start' });
      detailsPanel.current?.focus({ preventScroll: true });
    }
  }, [mobileView, selectedId]);

  // A new signal keeps sounding until someone acknowledges it.
  useEffect(() => {
    if (!awaiting || !soundOn) return;
    const timer = window.setInterval(() => { if (soundEnabled.current) playTones(consoleAudio, 2, 988); }, ALARM_REPEAT_MS);
    return () => window.clearInterval(timer);
  }, [awaiting, soundOn]);

  useEffect(() => {
    document.title = awaiting ? `(${awaiting}) NEW SIGNAL · PhanTomSignal Dispatch` : 'PhanTomSignal · Campus Safety Console';
    return () => { document.title = baseTitle.current; };
  }, [awaiting]);

  const replace = (next: DispatchIncident) => {
    setIncidents(current => current.map(incident => incident.id === next.id ? next : incident));
    if (next.status === 'resolved') setTab('closed');
  };
  const markOpened = (id: string) => {
    const incident = incidents.find(item => item.id === id);
    if (!incident) return;
    // Only an officer opening details clears messages. Polling and automatic
    // initial selection must not hide a new arrival before someone sees it.
    const available = new Set(incidents.flatMap(getIncomingMessageIds));
    setReadMessageIds(current => {
      const next = new Set([...current].filter(receipt => available.has(receipt)));
      for (const receipt of getIncomingMessageIds(incident)) next.add(receipt);
      try { sessionStorage.setItem(READ_KEY, JSON.stringify([...next])); } catch { /* Read state lasts for this page. */ }
      return next;
    });
  };
  const selectIncident = (id: string) => { markOpened(id); setSelectedId(id); setMobileView('details'); };
  const selectTab = (next: 'open' | 'closed') => {
    setTab(next); setSelectedId((next === 'open' ? open : closed)[0]?.id ?? null);
  };
  const toggleSound = async () => {
    if (soundOn) { soundEnabled.current = false; setSoundOn(false); return; }
    const ready = await unlockAudio();
    soundEnabled.current = ready; setSoundOn(ready); setSoundError(!ready);
    if (ready) playTones(consoleAudio, 1, 660);
  };
  const enableNotifications = async () => {
    try { setNotificationError(false); setNotificationState(await Notification.requestPermission()); }
    catch { setNotificationError(true); }
  };

  return <div className="dispatch-shell landing-site" lang="en">
    <header className="dispatch-top">
      <div className="brand-lockup"><Brand /><span className="brand-descriptor dispatch-descriptor">CAMPUS SAFETY CONSOLE</span></div>
      <div className="dispatch-stats" aria-live="polite">
        <div className={`dispatch-stat ${awaiting ? 'alarm' : ''}`}><strong>{awaiting}</strong><span>Awaiting acknowledgment</span></div>
        <div className="dispatch-stat"><strong>{open.length}</strong><span>Open signals</span></div>
        <div className="dispatch-stat"><strong>{responding}</strong><span>Units responding</span></div>
      </div>
      <div className="dispatch-top-right">
        <span className="dispatch-clock">{new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
        <span className={`dispatch-sync ${error ? 'bad' : !lastSync ? 'pending' : ''}`}><i />{error ? 'Connection interrupted' : lastSync ? `Synced ${relativeTime(lastSync, clock).toLowerCase()}` : 'Connecting…'}</span>
        <button className={`dispatch-ghost ${soundOn ? 'on' : ''}`} aria-pressed={soundOn} aria-label={soundOn ? 'Mute alert sound' : 'Enable alert sound'} onClick={() => void toggleSound()}><Icon name="bell" size={16} />{soundOn ? 'Sound on' : 'Sound off'}</button>
        <button className="dispatch-ghost" onClick={onSignOut}>Sign out</button>
      </div>
    </header>
    <div className="dispatch-proto-bar"><Icon name="alert" size={14} />PROTOTYPE CONSOLE · Signals come from PhanTomSignal walkers. Not connected to UIUC Police, METCOM, or 911.</div>
    {error && <div className="dispatch-error" role="alert"><Icon name="alert" size={16} /><span>{loaded ? 'Updates interrupted. Showing the last received data.' : 'Could not connect to the console.'} {error}</span><button className="dispatch-ghost" disabled={syncing} onClick={() => refreshNow.current()}>{syncing ? 'Retrying…' : 'Retry now'}</button></div>}
    {soundError && <div className="dispatch-error" role="status">Alert sound could not start. Keep this console visible and try enabling sound again.</div>}
    <nav className="dispatch-mobile-nav" aria-label="Console views">
      <button type="button" aria-pressed={mobileView === 'signals'} onClick={() => setMobileView('signals')}><Icon name="radio" size={16} />Signals <b>{open.length}</b>{totalUnread > 0 && <span className="dispatch-unread-dot" aria-label={`${totalUnread} unread messages`} />}</button>
      <button type="button" aria-pressed={mobileView === 'details'} onClick={() => { if (selected) markOpened(selected.id); setMobileView('details'); }}><Icon name="note" size={16} />Details{selected && (unreadByIncident.get(selected.id) ?? 0) > 0 && <span className="dispatch-unread-dot" aria-label="New messages in this incident" />}</button>
      <button type="button" aria-pressed={mobileView === 'map'} onClick={() => setMobileView('map')}><Icon name="pin" size={16} />Map</button>
    </nav>
    <div className="dispatch-grid" data-mobile-view={mobileView}>
      <aside className="dispatch-queue" aria-label="Signal queue">
        <div className="queue-tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'open'} className={tab === 'open' ? 'active' : ''} onClick={() => selectTab('open')}>Open <b>{open.length}</b></button>
          <button role="tab" aria-selected={tab === 'closed'} className={tab === 'closed' ? 'active' : ''} onClick={() => selectTab('closed')}>Closed · 12h <b>{closed.length}</b></button>
        </div>
        <div className="queue-list">
          {!loaded && <div className="queue-empty">Connecting…</div>}
          {loaded && !list.length && <div className="queue-empty"><Icon name={tab === 'open' ? 'shield' : 'check'} size={22} />{tab === 'open' ? <><strong>No open signals</strong><span>{error ? 'Waiting to reconnect. New signals may not appear until the connection returns.' : soundOn ? 'New help signals appear here and sound an alert while this console is open.' : 'New help signals appear here. Enable sound to hear an alert.'}</span></> : <span>No closed incidents in the last 12 hours.</span>}</div>}
          {list.map(incident => <QueueItem key={incident.id} incident={incident} now={now} selected={incident.id === selectedId} unreadCount={unreadByIncident.get(incident.id) ?? 0} onSelect={() => selectIncident(incident.id)} />)}
        </div>
        <div className="dispatch-alert-options">
          {notificationState === 'default' && <button className="dispatch-ghost" onClick={() => void enableNotifications()}><Icon name="bell" size={15} />Enable browser alerts</button>}
          <p>{notificationState === 'granted' ? 'Browser alerts enabled. Keep the console open to receive updates.' : notificationState === 'denied' ? 'Browser alerts are blocked. Keep the console visible or allow alerts in your browser settings.' : 'Keep this console open to receive new signals.'}</p>
          {notificationError && <p role="status">Browser alerts could not be enabled. You can still follow signals here.</p>}
        </div>
      </aside>
      <section className="dispatch-map" aria-label="Signal map">
        <DispatchMap incidents={open} selected={selected?.status === 'resolved' ? null : selected} panelView={mobileView} onSelect={id => { setTab('open'); selectIncident(id); }} />
        {!open.some(incident => incident.location) && <div className="dispatch-map-empty">{open.length ? 'Signals received. Waiting for a shared location.' : 'No active locations to display.'}</div>}
        <div className="map-legend"><span><i className="new" />New</span><span><i className="acknowledged" />Acknowledged</span><span><i className="responding" />Responding</span></div>
      </section>
      <section ref={detailsPanel} tabIndex={-1} className="dispatch-panel" aria-label="Incident details">
        {selected ? <IncidentPanel key={selected.id} code={code} incident={selected} now={now} onUpdate={replace} /> : <div className="panel-empty"><Icon name="radio" size={30} /><strong>Select a signal</strong><span>Live location, who to look for, and response actions appear here.</span></div>}
      </section>
    </div>
  </div>;
}

function QueueItem({ incident, now, selected, unreadCount, onSelect }: { incident: DispatchIncident; now: number; selected: boolean; unreadCount: number; onSelect: () => void }) {
  const health = locationHealth(incident.location, now);
  return <button className={`queue-item ${incident.status} ${selected ? 'selected' : ''}`} onClick={onSelect} aria-current={selected}>
    <div className="queue-row">
      <span className={`status-chip ${incident.status}`}>{STATUS_LABEL[incident.status]}</span>
      <span className="queue-ref">{incident.reference}</span>
      <span className="queue-timer">{incident.status === 'resolved' ? new Date(incident.resolvedAt!).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : elapsed(incident.openedAt, now)}</span>
    </div>
    {unreadCount > 0 && <span className="dispatch-message-badge" role="status" aria-label={`${unreadCount} unread ${unreadCount === 1 ? 'message' : 'messages'}`}><Icon name="note" size={15} /><strong>{unreadCount}</strong> new {unreadCount === 1 ? 'message' : 'messages'}</span>}
    <div className="queue-place">{place(incident)}</div>
    <div className="queue-meta">
      {incident.status !== 'resolved' && incident.location && <span className={`fresh-dot ${health.level}`}>{relativeTime(incident.location.recordedAt, now)}</span>}
      {incident.unit && incident.status === 'responding' && <span className="queue-tag unit">{incident.unit}</span>}
      {incident.outcome && <span className="queue-tag">{INCIDENT_OUTCOMES[incident.outcome]}</span>}
      {incident.walkerCancelledAt && incident.status !== 'resolved' && <span className="queue-tag warn">Walker cancelled</span>}
      {incident.events.some(event => event.kind === 'guardian_note') && incident.status !== 'resolved' && <span className="queue-tag">Guardian note</span>}
      {incident.sessionState !== 'sharing' && incident.status !== 'resolved' && <span className="queue-tag">{incident.sessionState === 'ended' ? 'Walker ended walk' : 'Session expired'}</span>}
      {incident.mode === 'demo' && <span className="queue-tag demo">DEMO</span>}
    </div>
  </button>;
}

function pinIcon(status: IncidentStatus, selected: boolean) {
  return L.divIcon({ className: 'incident-pin-wrap', html: `<span class="incident-pin ${status}${selected ? ' selected' : ''}"><i></i></span>`, iconSize: [30, 30], iconAnchor: [15, 15] });
}

function MapView({ incidents, selected, panelView }: { incidents: DispatchIncident[]; selected: DispatchIncident | null; panelView: string }) {
  const map = useMap();
  useEffect(() => { map.stop(); map.invalidateSize(); }, [map, panelView]);
  const focused = useRef<string | null>(null);
  const located = incidents.filter(incident => incident.location);
  const lat = selected?.location?.latitude;
  const lon = selected?.location?.longitude;
  useEffect(() => {
    // Leaflet's flyTo cannot project an animation from a zero-sized hidden panel.
    // Focus it when the map is opened instead of animating it behind Details.
    if (!map.getContainer().clientWidth || !map.getContainer().clientHeight) return;
    if (selected && lat !== undefined && lon !== undefined) {
      if (focused.current !== selected.id) { map.flyTo([lat, lon], 17, { duration: 0.6 }); focused.current = selected.id; }
      else map.panTo([lat, lon], { animate: true });
    } else if (!selected) {
      focused.current = null;
      if (located.length > 1) map.fitBounds(L.latLngBounds(located.map(incident => [incident.location!.latitude, incident.location!.longitude] as [number, number])).pad(0.3), { maxZoom: 17 });
      else if (located.length === 1) map.setView([located[0].location!.latitude, located[0].location!.longitude], 16);
    }
  }, [map, selected?.id, lat, lon, located.length, panelView]);
  return null;
}

function DispatchMap({ incidents, selected, panelView, onSelect }: { incidents: DispatchIncident[]; selected: DispatchIncident | null; panelView: string; onSelect: (id: string) => void }) {
  return <MapContainer center={CAMPUS_CENTER} zoom={15} zoomControl={false} className="dispatch-map-canvas" aria-label="Map of open help signals on the University of Illinois campus">
    <TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' url="https://tile.openstreetmap.org/{z}/{x}/{y}.png" maxZoom={19} referrerPolicy="strict-origin" />
    <ZoomControl position="bottomright" />
    {selected?.location && <>
      {selected.trail.length > 1 && <Polyline positions={selected.trail.map(point => [point.latitude, point.longitude])} pathOptions={{ color: '#ff8a65', weight: 4, opacity: 0.85, dashArray: '6 6' }} />}
      <Circle center={[selected.location.latitude, selected.location.longitude]} radius={Math.max(selected.location.accuracy, 1)} pathOptions={{ color: '#ff8a65', fillColor: '#ff8a65', fillOpacity: 0.12, weight: 1.5 }} />
    </>}
    {incidents.filter(incident => incident.location).map(incident => <Marker key={incident.id} position={[incident.location!.latitude, incident.location!.longitude]} icon={pinIcon(incident.status, incident.id === selected?.id)} eventHandlers={{ click: () => onSelect(incident.id) }} zIndexOffset={incident.status === 'new' ? 1000 : 0}>
      <Tooltip direction="top" offset={[0, -14]} permanent={incident.id === selected?.id || incident.status === 'new'}>{incident.reference}</Tooltip>
    </Marker>)}
    <MapView incidents={incidents} selected={selected} panelView={panelView} />
  </MapContainer>;
}

function IncidentPanel({ code, incident, now, onUpdate }: { code: string; incident: DispatchIncident; now: number; onUpdate: (next: DispatchIncident) => void }) {
  const [unit, setUnit] = useState(incident.unit ?? '');
  const [outcome, setOutcome] = useState<IncidentOutcome | ''>('');
  const [closeNote, setCloseNote] = useState('');
  const [confirmClose, setConfirmClose] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [feedback, setFeedback] = useState('');
  const open = incident.status !== 'resolved';
  const location = incident.location;
  const health = locationHealth(location, now);
  const guardianNotes = incident.events.filter(event => event.kind === 'guardian_note');
  const presetLabel = (id: string) => PRESET_MESSAGES.find(preset => preset.id === id)?.en ?? 'Message unavailable';

  const run = async (name: string, action: () => Promise<DispatchIncident>) => {
    if (busy) return false;
    setBusy(name); setError(null); setFeedback('');
    try {
      onUpdate(await action());
      setFeedback(name === 'ack' ? 'Signal acknowledged. The student and guardian can see this update.' : name === 'respond' ? 'Response recorded. The student and guardian can see the assigned unit.' : name === 'resolve' ? 'Incident closed. Location access has ended.' : 'Note saved to the incident timeline.');
      return true;
    }
    catch (cause) { setError((cause as Error).message); return false; }
    finally { setBusy(null); }
  };

  const copyCoordinates = async () => {
    if (!location) return;
    try { await navigator.clipboard.writeText(`${location.latitude.toFixed(6)}, ${location.longitude.toFixed(6)}`); setCopied(true); window.setTimeout(() => setCopied(false), 1500); } catch { /* Coordinates remain visible. */ }
  };

  return <div className={`incident-panel ${incident.status}`}>
    <header className="incident-head">
      <div className="incident-head-row"><span className={`status-chip ${incident.status}`}>{STATUS_LABEL[incident.status]}</span><span className="incident-ref">{incident.reference}</span>{incident.mode === 'demo' && <span className="queue-tag demo">DEMO · SIMULATED WALK</span>}</div>
      <div className="incident-timer">{open ? elapsed(incident.openedAt, now) : 'Closed'}<small>{open ? `since signal at ${new Date(incident.openedAt).toLocaleTimeString()}` : `${new Date(incident.openedAt).toLocaleTimeString()} – ${new Date(incident.resolvedAt!).toLocaleTimeString()}`}</small></div>
    </header>

    {open && <div className="panel-alert silent"><Icon name="x" size={16} /><span><strong>Silent signal. Do not call or text the walker.</strong> They may not be able to respond safely, and a ringing phone could alert someone nearby. Send a responder to the live location, approaching like a routine patrol.</span></div>}
    {open && incident.walkerCancelledAt && <div className="panel-alert warn"><Icon name="x" size={16} /><span><strong>Walker cancelled</strong> at {new Date(incident.walkerCancelledAt).toLocaleTimeString()}. Someone could have forced them to cancel; verify in person before closing.</span></div>}
    {open && incident.sessionState !== 'sharing' && <div className="panel-alert"><Icon name={incident.sessionState === 'ended' ? 'heart' : 'clock'} size={16} /><span>{incident.sessionState === 'ended' ? 'Walker ended the walk.' : 'Walker’s session expired.'} Live updates stopped; showing last known location. {incident.sessionState === 'ended' ? 'Ending can also be coerced.' : 'Their phone may have died or closed the app.'}</span></div>}
    {open && location && health.level === 'stale' && incident.sessionState === 'sharing' && <div className="panel-alert bad"><Icon name="alert" size={16} /><span><strong>Location is stale.</strong> Last update {relativeTime(location.recordedAt, now)}. The walker’s phone may be locked, offline, or out of battery.</span></div>}

    {incident.messages.length > 0 && <section className="panel-section dispatch-quick-messages" aria-label="Quick messages from the walker">
      <h3><Icon name="note" size={15} />Quick messages from the walker</h3>
      <ol>{incident.messages.map(message => <li key={message.id}><time dateTime={message.sentAt}>{new Date(message.sentAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time><strong>{presetLabel(message.presetId)}</strong></li>)}</ol>
    </section>}

    <section className="panel-section">
      <h3><Icon name="pin" size={15} />{open && incident.sessionState === 'sharing' ? 'Live location' : 'Last known location'}</h3>
      {open ? location ? <>
        <p className="panel-place">{describeNearLandmark(location.latitude, location.longitude)}</p>
        <div className="panel-coords"><code>{location.latitude.toFixed(6)}, {location.longitude.toFixed(6)}</code><button className="dispatch-ghost small" onClick={() => void copyCoordinates()}><Icon name={copied ? 'check' : 'copy'} size={14} />{copied ? 'Copied' : 'Copy'}</button><a className="dispatch-ghost small" href={mapLink(location)} target="_blank" rel="noreferrer"><Icon name="external" size={14} />Map</a></div>
        <dl className="panel-facts">
          <div><dt>Updated</dt><dd className={health.level}>{relativeTime(location.recordedAt, now)}</dd></div>
          <div><dt>Accuracy</dt><dd>{accuracyLabel(location.accuracy)}</dd></div>
          <div className="wide"><dt>Movement</dt><dd>{movementSummary(location, incident.trail)}</dd></div>
        </dl>
      </> : <p className="panel-muted">No location received yet. The walker’s phone may still be finding GPS.</p> : <p className="panel-muted">Location access ended when this incident was closed.</p>}
    </section>

    <section className="panel-section">
      <h3><Icon name="user" size={15} />Who to look for</h3>
      {open ? <>
        {incident.walkerDescription ? <p className="panel-caller">“{incident.walkerDescription}”</p> : <p className="panel-muted">No description provided. Look for a person moving with the live marker.</p>}
        {guardianNotes.length > 0 && <div className="guardian-notes">
          <span>From the guardian</span>
          {guardianNotes.map((note, index) => <p key={`${note.at}-${index}`}><time>{new Date(note.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time>{note.text}</p>)}
        </div>}
        <p className="panel-muted small">Guardian: {incident.guardianTexted || incident.guardianPushDevices ? [incident.guardianTexted && 'texted', incident.guardianPushDevices && `push to ${incident.guardianPushDevices} device${incident.guardianPushDevices === 1 ? '' : 's'}`].filter(Boolean).join(' · ') + ', and asked not to contact the walker' : 'not set up for alerts'}</p>
      </> : <p className="panel-muted">The walker’s description was removed when this incident was closed.</p>}
    </section>

    {open && <section className="panel-section">
      <h3><Icon name="radio" size={15} />Response</h3>
      <p className="dispatch-next-step">{incident.status === 'new' ? 'Acknowledge the signal, then assign a responding unit.' : incident.status === 'acknowledged' ? 'Assign a unit when a responder is ready to go.' : 'Record the outcome after the response is complete.'}</p>
      {incident.status === 'new' && <button className="dispatch-primary alarm" disabled={busy !== null} onClick={() => void run('ack', () => acknowledgeIncident(code, incident.id))}>{busy === 'ack' ? 'Acknowledging…' : 'Acknowledge signal'}</button>}
      <form className="dispatch-inline" onSubmit={event => { event.preventDefault(); if (unit.trim()) void run('respond', () => respondToIncident(code, incident.id, unit.trim())); }}>
        <label className="dispatch-field"><span>{incident.status === 'responding' ? `Responding: ${incident.unit}` : 'Assign unit'}</span><input list="unit-suggestions" value={unit} maxLength={40} placeholder="e.g. Patrol 2" onChange={event => setUnit(event.target.value)} /></label>
        <datalist id="unit-suggestions">{UNIT_SUGGESTIONS.map(option => <option key={option} value={option} />)}</datalist>
        <button className="dispatch-secondary" disabled={busy !== null || !unit.trim() || unit.trim() === incident.unit}>{busy === 'respond' ? 'Dispatching…' : incident.status === 'responding' ? 'Reassign' : 'Dispatch'}</button>
      </form>
      <div className="dispatch-close">
        <label className="dispatch-field"><span>Close with outcome</span><select value={outcome} onChange={event => { setOutcome(event.target.value as IncidentOutcome | ''); setConfirmClose(false); }}><option value="">Choose outcome…</option>{Object.entries(INCIDENT_OUTCOMES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        {outcome && <input className="dispatch-input" value={closeNote} maxLength={280} placeholder="Closing note (optional)" onChange={event => setCloseNote(event.target.value)} />}
        {outcome && (!confirmClose
          ? <button className="dispatch-secondary" onClick={() => setConfirmClose(true)}>Close incident…</button>
          : <div className="confirm-row"><span>Closing ends access to this walker’s location and description.</span><button className="dispatch-primary" disabled={busy !== null} onClick={() => void run('resolve', () => resolveIncident(code, incident.id, outcome, closeNote.trim()))}>{busy === 'resolve' ? 'Closing…' : 'Confirm close'}</button><button className="dispatch-ghost" onClick={() => setConfirmClose(false)}>Back</button></div>)}
      </div>
    </section>}

    {feedback && <p className="dispatch-feedback" role="status">{feedback}</p>}
    {error && <div className="panel-alert bad" role="alert"><Icon name="alert" size={16} />{error}</div>}

    <section className="panel-section">
      <h3><Icon name="note" size={15} />Timeline</h3>
      <form className="dispatch-inline" onSubmit={async event => { event.preventDefault(); if (note.trim() && await run('note', () => addIncidentNote(code, incident.id, note.trim()))) setNote(''); }}>
        <input className="dispatch-input" value={note} maxLength={280} placeholder="Add a note for the log" onChange={event => setNote(event.target.value)} aria-label="Incident note" />
        <button className="dispatch-secondary" disabled={busy !== null || !note.trim()}>Add</button>
      </form>
      <ol className="timeline">
        {[...incident.events].reverse().map((event, index) => <li key={`${event.at}-${index}`} className={event.kind}>
          <span className="timeline-icon"><Icon name={EVENT_ICON[event.kind]} size={13} /></span>
          <div><time>{new Date(event.at).toLocaleTimeString()}</time><p>{event.kind === 'guardian_note' ? `Guardian: ${event.text}` : event.text}</p></div>
        </li>)}
      </ol>
    </section>
  </div>;
}
