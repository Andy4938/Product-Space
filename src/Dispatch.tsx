import L from 'leaflet';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Circle, MapContainer, Marker, Polyline, TileLayer, Tooltip, ZoomControl, useMap } from 'react-leaflet';
import { INCIDENT_OUTCOMES, type DispatchIncident, type IncidentEventKind, type IncidentOutcome, type IncidentStatus } from './api-types';
import { acknowledgeIncident, addIncidentNote, ApiRequestError, listIncidents, resolveIncident, respondToIncident } from './api';
import { describeNearLandmark } from './landmarks';
import { accuracyLabel, CAMPUS_CENTER, Icon, type IconName, elapsed, locationHealth, mapLink, movementSummary, playTones, relativeTime, useNow } from './shared';

const CODE_KEY = 'ghostsignal-dispatch-code';
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
  try { consoleAudio ??= new AudioContext(); await consoleAudio.resume(); } catch { /* Sound is optional. */ }
}

function readCode() {
  try { return sessionStorage.getItem(CODE_KEY); } catch { return null; }
}

export default function DispatchApp() {
  const [code, setCode] = useState<string | null>(readCode);
  const signOut = () => { try { sessionStorage.removeItem(CODE_KEY); } catch { /* Nothing stored. */ } setCode(null); };
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
      if ('Notification' in window && Notification.permission === 'default') void Notification.requestPermission();
      try { sessionStorage.setItem(CODE_KEY, value.trim()); } catch { /* Signed in for this page only. */ }
      onLogin(value.trim());
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  };
  return <div className="dispatch-shell dispatch-login-shell">
    <form className="dispatch-login" onSubmit={submit}>
      <div className="dispatch-brand"><span className="dispatch-mark"><Icon name="radio" size={20} /></span><span>GhostSignal<small>CAMPUS SAFETY CONSOLE</small></span></div>
      <h1>Dispatcher sign-in</h1>
      <p>Enter the console access code. In this prototype, the server prints the code to its console when it starts.</p>
      <label className="dispatch-field"><span>Access code</span><input autoFocus value={value} autoComplete="off" spellCheck={false} onChange={event => setValue(event.target.value)} /></label>
      <button className="dispatch-primary" disabled={busy || !value.trim()}>{busy ? 'Checking…' : 'Open console'}</button>
      {error && <p className="dispatch-login-error" role="alert">{error}</p>}
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
  const [tab, setTab] = useState<'open' | 'closed'>('open');
  const [soundOn, setSoundOn] = useState(() => consoleAudio?.state === 'running');
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
      try {
        const list = await listIncidents(code);
        if (!active) return;
        setOffset(Date.parse(list.serverTime) - Date.now());
        const fresh = list.incidents.filter(incident => incident.status === 'new' && known.current && !known.current.has(incident.id));
        if (fresh.length) {
          playTones(consoleAudio, 3, 988);
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
      } finally { requesting = false; }
    };
    void poll();
    const timer = window.setInterval(poll, POLL_MS);
    return () => { active = false; window.clearInterval(timer); };
  }, [code]);

  const sorted = useMemo(() => sortIncidents(incidents), [incidents]);
  const open = sorted.filter(incident => incident.status !== 'resolved');
  const closed = sorted.filter(incident => incident.status === 'resolved');
  const awaiting = open.filter(incident => incident.status === 'new').length;
  const responding = open.filter(incident => incident.status === 'responding').length;
  const selected = incidents.find(incident => incident.id === selectedId) ?? null;

  useEffect(() => {
    if (!selectedId && open.length) setSelectedId(open[0].id);
  }, [loaded]);

  // A new signal keeps sounding until someone acknowledges it.
  useEffect(() => {
    if (!awaiting) return;
    const timer = window.setInterval(() => playTones(consoleAudio, 2, 988), ALARM_REPEAT_MS);
    return () => window.clearInterval(timer);
  }, [awaiting]);

  useEffect(() => {
    document.title = awaiting ? `(${awaiting}) NEW SIGNAL · GhostSignal Dispatch` : 'GhostSignal · Campus Safety Console';
    return () => { document.title = baseTitle.current; };
  }, [awaiting]);

  const replace = (next: DispatchIncident) => setIncidents(list => list.map(incident => incident.id === next.id ? next : incident));
  const list = tab === 'open' ? open : closed;

  return <div className="dispatch-shell">
    <header className="dispatch-top">
      <div className="dispatch-brand"><span className="dispatch-mark"><Icon name="radio" size={20} /></span><span>GhostSignal<small>CAMPUS SAFETY CONSOLE</small></span></div>
      <div className="dispatch-stats" aria-live="polite">
        <div className={`dispatch-stat ${awaiting ? 'alarm' : ''}`}><strong>{awaiting}</strong><span>Awaiting acknowledgment</span></div>
        <div className="dispatch-stat"><strong>{open.length}</strong><span>Open signals</span></div>
        <div className="dispatch-stat"><strong>{responding}</strong><span>Units responding</span></div>
      </div>
      <div className="dispatch-top-right">
        <span className="dispatch-clock">{new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
        <span className={`dispatch-sync ${error ? 'bad' : ''}`}><i />{error ? 'Connection lost' : `Live · synced ${relativeTime(lastSync, clock).toLowerCase()}`}</span>
        <button className={`dispatch-ghost ${soundOn ? 'on' : ''}`} onClick={() => { void unlockAudio().then(() => { setSoundOn(true); playTones(consoleAudio, 1, 660); }); }}><Icon name="bell" size={16} />{soundOn ? 'Sound on' : 'Enable sound'}</button>
        <button className="dispatch-ghost" onClick={onSignOut}>Sign out</button>
      </div>
    </header>
    <div className="dispatch-proto-bar"><Icon name="alert" size={14} />PROTOTYPE CONSOLE · Signals come from GhostSignal walkers. Not connected to UIUC Police, METCOM, or 911.</div>
    {error && <div className="dispatch-error" role="alert"><Icon name="alert" size={16} />Updates interrupted: {error}. Showing the last data received.</div>}
    <div className="dispatch-grid">
      <aside className="dispatch-queue" aria-label="Signal queue">
        <div className="queue-tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'open'} className={tab === 'open' ? 'active' : ''} onClick={() => setTab('open')}>Open <b>{open.length}</b></button>
          <button role="tab" aria-selected={tab === 'closed'} className={tab === 'closed' ? 'active' : ''} onClick={() => setTab('closed')}>Closed today <b>{closed.length}</b></button>
        </div>
        <div className="queue-list">
          {!loaded && <div className="queue-empty">Connecting…</div>}
          {loaded && !list.length && <div className="queue-empty"><Icon name={tab === 'open' ? 'shield' : 'check'} size={22} />{tab === 'open' ? <><strong>No open signals</strong><span>Monitoring. New help signals will sound an alarm and appear here.</span></> : <span>No closed incidents in the last 12 hours.</span>}</div>}
          {list.map(incident => <QueueItem key={incident.id} incident={incident} now={now} selected={incident.id === selectedId} onSelect={() => setSelectedId(incident.id)} />)}
        </div>
      </aside>
      <section className="dispatch-map" aria-label="Signal map">
        <DispatchMap incidents={open} selected={selected?.status === 'resolved' ? null : selected} onSelect={setSelectedId} />
        <div className="map-legend"><span><i className="new" />New</span><span><i className="acknowledged" />Acknowledged</span><span><i className="responding" />Responding</span></div>
      </section>
      <section className="dispatch-panel" aria-label="Incident details">
        {selected ? <IncidentPanel key={selected.id} code={code} incident={selected} now={now} onUpdate={replace} /> : <div className="panel-empty"><Icon name="radio" size={30} /><strong>Select a signal</strong><span>Live location, who to look for, and response actions appear here.</span></div>}
      </section>
    </div>
  </div>;
}

function QueueItem({ incident, now, selected, onSelect }: { incident: DispatchIncident; now: number; selected: boolean; onSelect: () => void }) {
  const health = locationHealth(incident.location, now);
  return <button className={`queue-item ${incident.status} ${selected ? 'selected' : ''}`} onClick={onSelect} aria-current={selected}>
    <div className="queue-row">
      <span className={`status-chip ${incident.status}`}>{STATUS_LABEL[incident.status]}</span>
      <span className="queue-ref">{incident.reference}</span>
      <span className="queue-timer">{incident.status === 'resolved' ? new Date(incident.resolvedAt!).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : elapsed(incident.openedAt, now)}</span>
    </div>
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

function MapView({ incidents, selected }: { incidents: DispatchIncident[]; selected: DispatchIncident | null }) {
  const map = useMap();
  const focused = useRef<string | null>(null);
  const located = incidents.filter(incident => incident.location);
  const lat = selected?.location?.latitude;
  const lon = selected?.location?.longitude;
  useEffect(() => {
    if (selected && lat !== undefined && lon !== undefined) {
      if (focused.current !== selected.id) { map.flyTo([lat, lon], 17, { duration: 0.6 }); focused.current = selected.id; }
      else map.panTo([lat, lon], { animate: true });
    } else if (!selected) {
      focused.current = null;
      if (located.length > 1) map.fitBounds(L.latLngBounds(located.map(incident => [incident.location!.latitude, incident.location!.longitude] as [number, number])).pad(0.3), { maxZoom: 17 });
      else if (located.length === 1) map.setView([located[0].location!.latitude, located[0].location!.longitude], 16);
    }
  }, [map, selected?.id, lat, lon, located.length]);
  return null;
}

function DispatchMap({ incidents, selected, onSelect }: { incidents: DispatchIncident[]; selected: DispatchIncident | null; onSelect: (id: string) => void }) {
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
    <MapView incidents={incidents} selected={selected} />
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
  const open = incident.status !== 'resolved';
  const location = incident.location;
  const health = locationHealth(location, now);
  const guardianNotes = incident.events.filter(event => event.kind === 'guardian_note');

  const run = async (name: string, action: () => Promise<DispatchIncident>) => {
    setBusy(name); setError(null);
    try { onUpdate(await action()); return true; }
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
