import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  INCIDENT_OUTCOMES, isIncidentOutcome,
  type DispatchIncident, type DispatchIncidentList, type IncidentEvent, type IncidentEventKind, type IncidentOutcome,
  type IncidentMessage, type IncidentStatus, type IncidentSummary, type LocationPoint, type PushSubscriptionInput, type SessionMode,
  type SessionSnapshot, type SessionStatus,
} from '../src/api-types.js';
import { isPresetMessageId, type PresetMessageId } from '../src/preset-messages.js';
import { silentNotifier, type Notifier, type PushPayload } from './notify.js';

type EndedReason = 'safe' | 'expired' | null;

export interface LocationInput {
  latitude: number;
  longitude: number;
  accuracy: number;
  recordedAt: string;
}

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

interface SessionRow {
  id: string;
  mode: SessionMode;
  status: SessionStatus;
  started_at: number;
  updated_at: number;
  expires_at: number;
  help_requested_at: number | null;
  ended_reason: EndedReason;
  location_json: string | null;
  trail_json: string;
  owner_hash: string;
  guardian_hash: string;
  guardian_phone: string | null;
  alerts_sent: number;
  walker_description: string | null;
}

interface IncidentRow {
  id: string;
  session_id: string;
  reference: string;
  status: IncidentStatus;
  opened_at: number;
  updated_at: number;
  acknowledged_at: number | null;
  responding_at: number | null;
  unit: string | null;
  resolved_at: number | null;
  outcome: IncidentOutcome | null;
  walker_cancelled_at: number | null;
  final_location_json: string | null;
  final_trail_json: string | null;
  final_walker_description: string | null;
  events_json: string;
  messages_json: string;
}

const SESSION_LIFETIME_MS = 2 * 60 * 60 * 1000;
const MIN_LOCATION_INTERVAL_MS = 1000;
const MAX_LOCATION_AGE_MS = 2 * 60 * 1000;
const MAX_LOCATION_FUTURE_MS = 30 * 1000;
const MAX_TRAIL_POINTS = 100;
const MAX_ALERTS_PER_SESSION = 10;
const MAX_PUSH_DEVICES = 5;
const MAX_INCIDENT_EVENTS = 100;
const MAX_GUARDIAN_NOTES = 20;
const MAX_PUBLIC_MESSAGES = 20;
const MESSAGE_INTERVAL_MS = 2000;
const RESOLVED_VISIBLE_MS = 12 * 60 * 60 * 1000;

const ADDED_SESSION_COLUMNS: Record<string, string> = {
  guardian_phone: 'TEXT',
  alerts_sent: 'INTEGER NOT NULL DEFAULT 0',
  walker_description: 'TEXT',
};

const ADDED_INCIDENT_COLUMNS: Record<string, string> = {
  final_walker_description: 'TEXT',
  messages_json: "TEXT NOT NULL DEFAULT '[]'",
};

// Clearing a session removes everything that could locate or identify the walker or guardian.
const CLEARED_STATE = `location_json = NULL, trail_json = '[]', guardian_phone = NULL, walker_description = NULL`;

const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /\.notify\.windows\.com$/, /(^|\.)push\.apple\.com$/];

function hashToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

function tokenMatches(tokenHash: Buffer, storedHex: string): boolean {
  const stored = Buffer.from(storedHex, 'hex');
  return stored.length === tokenHash.length && timingSafeEqual(tokenHash, stored);
}

function iso(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

function isoOrNull(timestamp: number | null): string | null {
  return timestamp === null ? null : iso(timestamp);
}

function toIncidentSummary(row: IncidentRow): IncidentSummary {
  return {
    id: row.id,
    reference: row.reference,
    status: row.status,
    openedAt: iso(row.opened_at),
    acknowledgedAt: isoOrNull(row.acknowledged_at),
    respondingAt: isoOrNull(row.responding_at),
    unit: row.unit,
    resolvedAt: isoOrNull(row.resolved_at),
    outcome: row.outcome,
    walkerCancelledAt: isoOrNull(row.walker_cancelled_at),
    messages: JSON.parse(row.messages_json) as IncidentMessage[],
  };
}

function lastLocationText(locationJson: string | null, now: number): string {
  if (locationJson === null) return 'No location has been shared yet.';
  const point = JSON.parse(locationJson) as LocationPoint;
  const ageSeconds = Math.max(0, Math.round((now - Date.parse(point.recordedAt)) / 1000));
  const age = ageSeconds < 60 ? `${ageSeconds}s` : `${Math.round(ageSeconds / 60)} min`;
  const lat = point.latitude.toFixed(5);
  const lon = point.longitude.toFixed(5);
  return `Last shared location: ${lat}, ${lon} (±${Math.round(point.accuracy)} m, ${age} old) https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=18/${lat}/${lon}`;
}

function normalizePhone(value: unknown): string | null {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 32) throw new ApiError(400, 'Invalid phone number.');
  let digits = value.replace(/[\s().-]/g, '');
  if (/^\d{10}$/.test(digits)) digits = `+1${digits}`;
  if (!/^\+[1-9]\d{7,14}$/.test(digits)) throw new ApiError(400, 'Enter a phone number with country code, such as +1 217 555 0123.');
  return digits;
}

function normalizeText(value: unknown, maxLength: number, label: string, required = false): string | null {
  if (value === null || value === undefined) {
    if (required) throw new ApiError(400, `${label} is required.`);
    return null;
  }
  if (typeof value !== 'string') throw new ApiError(400, `Invalid ${label.toLowerCase()}.`);
  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (trimmed.length > maxLength || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new ApiError(400, `${label} must be ${maxLength} characters or fewer.`);
  }
  if (required && !trimmed) throw new ApiError(400, `${label} is required.`);
  return trimmed || null;
}

function parsePresetId(value: unknown): PresetMessageId {
  if (!isPresetMessageId(value)) throw new ApiError(400, 'Choose a preset message.');
  return value;
}

function parseClientMessageId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new ApiError(400, 'Invalid message ID.');
  }
  return value.toLowerCase();
}

function parseHelpPreset(input: unknown): { presetId: PresetMessageId; clientMessageId: string } | null {
  if (input === undefined) return null;
  const body = asObject(input, 'Invalid help request.');
  if (!('presetId' in body) || Object.keys(body).some((key) => key !== 'presetId' && key !== 'clientMessageId')) {
    throw new ApiError(400, 'Invalid help request.');
  }
  return {
    presetId: parsePresetId(body.presetId),
    clientMessageId: body.clientMessageId === undefined ? randomUUID() : parseClientMessageId(body.clientMessageId),
  };
}

function asObject(input: unknown, message: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new ApiError(400, message);
  return input as Record<string, unknown>;
}

function validatePushSubscription(input: unknown): PushSubscriptionInput {
  const body = asObject(input, 'Invalid push subscription.');
  const keys = typeof body.keys === 'object' && body.keys !== null ? body.keys as Record<string, unknown> : {};
  const { endpoint } = body;
  const { p256dh, auth } = keys;
  let host = '';
  try {
    const url = new URL(typeof endpoint === 'string' ? endpoint : '');
    if (url.protocol === 'https:') host = url.hostname;
  } catch {
    // Reported below.
  }
  if (typeof endpoint !== 'string' || endpoint.length > 1000 || !PUSH_HOSTS.some((pattern) => pattern.test(host)) ||
      typeof p256dh !== 'string' || !/^[A-Za-z0-9_-]{20,200}=*$/.test(p256dh) ||
      typeof auth !== 'string' || !/^[A-Za-z0-9_-]{8,100}=*$/.test(auth)) {
    throw new ApiError(400, 'Invalid push subscription.');
  }
  return { endpoint, keys: { p256dh, auth } };
}

function validateLocation(input: unknown, now: number): LocationInput {
  const point = asObject(input, 'Invalid location.');
  const latitude = point.latitude;
  const longitude = point.longitude;
  const accuracy = point.accuracy;
  const recordedAt = point.recordedAt;
  if (typeof latitude !== 'number' || !Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
      typeof longitude !== 'number' || !Number.isFinite(longitude) || longitude < -180 || longitude > 180 ||
      typeof accuracy !== 'number' || !Number.isFinite(accuracy) || accuracy < 0 || accuracy > 10000 ||
      typeof recordedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(recordedAt)) {
    throw new ApiError(400, 'Invalid location.');
  }
  const recordedTime = Date.parse(recordedAt);
  if (!Number.isFinite(recordedTime) || recordedTime < now - MAX_LOCATION_AGE_MS || recordedTime > now + MAX_LOCATION_FUTURE_MS) {
    throw new ApiError(400, 'Location timestamp is stale or in the future.');
  }
  return { latitude, longitude, accuracy, recordedAt: iso(recordedTime) };
}

export class SessionStore {
  private readonly database: DatabaseSync;

  constructor(
    dbPath: string,
    private readonly now: () => number = Date.now,
    private readonly notifier: Notifier = silentNotifier,
  ) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.database = new DatabaseSync(dbPath);
    this.database.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        mode TEXT NOT NULL CHECK (mode IN ('live', 'demo')),
        status TEXT NOT NULL CHECK (status IN ('active', 'help_requested', 'ended')),
        started_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        help_requested_at INTEGER,
        ended_reason TEXT CHECK (ended_reason IN ('safe', 'expired')),
        location_json TEXT,
        trail_json TEXT NOT NULL,
        owner_hash TEXT NOT NULL,
        guardian_hash TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(status, expires_at);
      CREATE TABLE IF NOT EXISTS incidents (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        reference TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('new', 'acknowledged', 'responding', 'resolved')),
        opened_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        acknowledged_at INTEGER,
        responding_at INTEGER,
        unit TEXT,
        resolved_at INTEGER,
        outcome TEXT,
        walker_cancelled_at INTEGER,
        final_location_json TEXT,
        final_trail_json TEXT,
        final_walker_description TEXT,
        events_json TEXT NOT NULL,
        messages_json TEXT NOT NULL DEFAULT '[]'
      );
      CREATE INDEX IF NOT EXISTS incidents_session ON incidents(session_id, opened_at);
      CREATE INDEX IF NOT EXISTS incidents_status ON incidents(status, resolved_at);
      CREATE TABLE IF NOT EXISTS incident_message_receipts (
        client_message_id TEXT PRIMARY KEY,
        incident_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        preset_id TEXT NOT NULL,
        received_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS incident_message_receipts_session ON incident_message_receipts(session_id);
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        session_id TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        subscription_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, endpoint)
      );
    `);
    for (const [table, columns] of [['sessions', ADDED_SESSION_COLUMNS], ['incidents', ADDED_INCIDENT_COLUMNS]] as const) {
      const existing = new Set((this.database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((column) => column.name));
      for (const [name, type] of Object.entries(columns)) {
        if (!existing.has(name)) this.database.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
      }
    }
    this.expireDue();
  }

  close(): void {
    this.database.close();
  }

  get publicPushKey(): string | null {
    return this.notifier.publicPushKey;
  }

  expireDue(): number {
    const timestamp = this.now();
    const due = this.database.prepare(`SELECT * FROM sessions WHERE status != 'ended' AND expires_at <= ?`)
      .all(timestamp) as unknown as SessionRow[];
    for (const row of due) {
      this.finalizeIncident(row, 'session_expired', 'Walk reached its time limit; live location stopped.', timestamp);
      this.database.prepare(`
        UPDATE sessions SET status = 'ended', ended_reason = 'expired',
          updated_at = MAX(updated_at + 1, ?), ${CLEARED_STATE} WHERE id = ?
      `).run(timestamp, row.id);
      this.database.prepare('DELETE FROM push_subscriptions WHERE session_id = ?').run(row.id);
    }
    return due.length;
  }

  create(mode: SessionMode): { sessionId: string; ownerToken: string; guardianToken: string; session: SessionSnapshot } {
    const timestamp = this.now();
    const id = randomUUID();
    const ownerToken = randomBytes(32).toString('base64url');
    const guardianToken = randomBytes(32).toString('base64url');
    this.database.prepare(`
      INSERT INTO sessions (id, mode, status, started_at, updated_at, expires_at,
        help_requested_at, ended_reason, location_json, trail_json, owner_hash, guardian_hash)
      VALUES (?, ?, 'active', ?, ?, ?, NULL, NULL, NULL, '[]', ?, ?)
    `).run(id, mode, timestamp, timestamp, timestamp + SESSION_LIFETIME_MS,
      hashToken(ownerToken).toString('hex'), hashToken(guardianToken).toString('hex'));
    return { sessionId: id, ownerToken, guardianToken, session: this.read(id, ownerToken) };
  }

  read(id: string, token: string): SessionSnapshot {
    this.expireDue();
    return this.toSnapshot(this.authorize(id, token));
  }

  updateLocation(id: string, token: string, input: unknown): SessionSnapshot {
    this.expireDue();
    const row = this.authorize(id, token, true);
    if (row.status === 'ended') throw new ApiError(409, 'Session has ended.');
    const timestamp = this.now();
    const validated = validateLocation(input, timestamp);
    const previous = row.location_json === null ? null : JSON.parse(row.location_json) as LocationPoint;
    if (previous && timestamp - Date.parse(previous.receivedAt) < MIN_LOCATION_INTERVAL_MS) {
      throw new ApiError(429, 'Location updates are too frequent.');
    }
    if (previous && Date.parse(validated.recordedAt) <= Date.parse(previous.recordedAt)) {
      throw new ApiError(409, 'Location timestamp must move forward.');
    }
    const point: LocationPoint = { ...validated, receivedAt: iso(timestamp) };
    const trail = [...(JSON.parse(row.trail_json) as LocationPoint[]), point].slice(-MAX_TRAIL_POINTS);
    this.database.prepare(`
      UPDATE sessions SET updated_at = MAX(updated_at + 1, ?), location_json = ?, trail_json = ? WHERE id = ?
    `).run(timestamp, JSON.stringify(point), JSON.stringify(trail), id);
    return this.read(id, token);
  }

  setContacts(id: string, token: string, input: unknown): SessionSnapshot {
    this.expireDue();
    const row = this.authorize(id, token, true);
    if (row.status === 'ended') throw new ApiError(409, 'Session has ended.');
    const contacts = asObject(input, 'Invalid contact details.');
    const description = 'walkerDescription' in contacts ? normalizeText(contacts.walkerDescription, 120, 'Description') : row.walker_description;
    const guardianPhone = 'guardianPhone' in contacts ? normalizePhone(contacts.guardianPhone) : row.guardian_phone;
    this.database.prepare(`
      UPDATE sessions SET walker_description = ?, guardian_phone = ?,
        updated_at = MAX(updated_at + 1, ?) WHERE id = ?
    `).run(description, guardianPhone, this.now(), id);
    return this.read(id, token);
  }

  addPushSubscription(id: string, token: string, input: unknown): { devices: number } {
    this.expireDue();
    const row = this.authorize(id, token);
    if (row.status === 'ended') throw new ApiError(409, 'Session has ended.');
    const subscription = validatePushSubscription(input);
    const known = this.database.prepare('SELECT 1 FROM push_subscriptions WHERE session_id = ? AND endpoint = ?').get(id, subscription.endpoint);
    if (!known && this.pushDeviceCount(id) >= MAX_PUSH_DEVICES) throw new ApiError(429, 'Too many devices are already receiving alerts for this walk.');
    this.database.prepare(`
      INSERT INTO push_subscriptions (session_id, endpoint, subscription_json, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (session_id, endpoint) DO UPDATE SET subscription_json = excluded.subscription_json
    `).run(id, subscription.endpoint, JSON.stringify(subscription), this.now());
    return { devices: this.pushDeviceCount(id) };
  }

  requestHelp(id: string, token: string, input?: unknown): SessionSnapshot {
    this.expireDue();
    let row: SessionRow;
    let notification: { reference: string; timestamp: number } | null = null;
    this.database.exec('BEGIN IMMEDIATE');
    try {
      row = this.authorize(id, token, true);
      if (row.status === 'ended') throw new ApiError(409, 'Session has ended.');
      const initial = parseHelpPreset(input);
      const latest = this.database.prepare('SELECT id, updated_at FROM incidents WHERE session_id = ? ORDER BY rowid DESC LIMIT 1')
        .get(id) as unknown as Pick<IncidentRow, 'id' | 'updated_at'> | undefined;
      const receipt = initial ? this.messageReceipt(initial.clientMessageId) : undefined;
      if (receipt && (receipt.session_id !== id || receipt.incident_id !== latest?.id || receipt.preset_id !== initial!.presetId)) {
        throw new ApiError(409, 'Message ID was already used.');
      }
      if (!receipt) {
        const open = this.openIncident(id);
        if (row.status === 'help_requested' && open && initial) {
          throw new ApiError(409, 'Help is already active. Send the preset as a message.');
        }
        if (row.status === 'active' || !open) {
          const timestamp = this.now();
          this.database.prepare(`
            UPDATE sessions SET status = 'help_requested', help_requested_at = ?,
              updated_at = MAX(updated_at + 1, ?) WHERE id = ?
          `).run(timestamp, timestamp, id);
          let reference: string;
          let incidentId: string;
          if (open) {
            reference = open.reference;
            incidentId = open.id;
            this.database.prepare('UPDATE incidents SET walker_cancelled_at = NULL WHERE id = ?').run(open.id);
            this.addEvent(open.id, 'walker_resent', 'Walker sent the silent help signal again after cancelling.', timestamp);
          } else {
            reference = `GS-${randomBytes(3).toString('hex').toUpperCase()}`;
            incidentId = randomUUID();
            const opened: IncidentEvent = { at: iso(timestamp), kind: 'opened', text: 'Silent help signal received from walker.' };
            const revision = Math.max(timestamp, row.updated_at + 1, (latest?.updated_at ?? -Infinity) + 1);
            this.database.prepare(`
              INSERT INTO incidents (id, session_id, reference, status, opened_at, updated_at, events_json)
              VALUES (?, ?, ?, 'new', ?, ?, ?)
            `).run(incidentId, id, reference, timestamp, revision, JSON.stringify([opened]));
          }
          if (initial) {
            const incident = this.database.prepare('SELECT * FROM incidents WHERE id = ?').get(incidentId) as unknown as IncidentRow;
            this.appendPresetMessage(incident, id, initial.presetId, initial.clientMessageId, timestamp);
          }
          notification = { reference, timestamp };
        }
      }
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    if (notification !== null) {
      const { reference, timestamp } = notification;
      this.notifyGuardian(row!, {
        sms: `PhanTomSignal: the walker sent a SILENT help signal. Campus Safety is notified (${reference}). Please do not call or text them; it could alert someone nearby. ${lastLocationText(row!.location_json, timestamp)}`,
        push: { title: 'Silent help signal', body: 'Campus Safety is notified. Don’t call or text the walker; it could alert someone nearby. Tap to follow their location.', tag: 'help', urgent: true },
      });
    }
    return this.read(id, token);
  }

  retractHelp(id: string, token: string): SessionSnapshot {
    this.expireDue();
    const row = this.authorize(id, token, true);
    if (row.status === 'ended') throw new ApiError(409, 'Session has ended.');
    if (row.status === 'help_requested') {
      const timestamp = this.now();
      this.database.prepare(`
        UPDATE sessions SET status = 'active', help_requested_at = NULL,
          updated_at = MAX(updated_at + 1, ?) WHERE id = ?
      `).run(timestamp, id);
      const open = this.openIncident(id);
      if (open) {
        this.database.prepare('UPDATE incidents SET walker_cancelled_at = ? WHERE id = ?').run(timestamp, open.id);
        this.addEvent(open.id, 'walker_cancelled', 'Walker cancelled the signal. A cancellation can be coerced; verify in person before closing.', timestamp);
      }
      this.notifyGuardian(row, {
        sms: 'PhanTomSignal: the walker cancelled their help signal. Campus Safety will still verify they are okay. Please keep not calling them for now.',
        push: { title: 'Signal cancelled', body: 'The walker cancelled their signal. Campus Safety will still check on them in person.', tag: 'help', urgent: false },
      });
    }
    return this.read(id, token);
  }

  sendPresetMessage(id: string, token: string, input: unknown): SessionSnapshot {
    this.expireDue();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const row = this.authorize(id, token, true);
      if (row.status !== 'help_requested') throw new ApiError(409, 'An active help signal is required.');
      const incident = this.openIncident(id);
      if (!incident || incident.walker_cancelled_at !== null) throw new ApiError(409, 'An active incident is required.');
      const body = asObject(input, 'Invalid preset message.');
      if (Object.keys(body).length !== 2 || !('presetId' in body) || !('clientMessageId' in body)) {
        throw new ApiError(400, 'Invalid preset message.');
      }
      const presetId = parsePresetId(body.presetId);
      const clientMessageId = parseClientMessageId(body.clientMessageId);
      const existing = this.messageReceipt(clientMessageId);
      if (existing) {
        if (existing.session_id !== id || existing.incident_id !== incident.id || existing.preset_id !== presetId) {
          throw new ApiError(409, 'Message ID was already used.');
        }
      } else {
        const timestamp = this.now();
        const messages = JSON.parse(incident.messages_json) as IncidentMessage[];
        const last = messages.at(-1);
        if (last && timestamp - Date.parse(last.sentAt) < MESSAGE_INTERVAL_MS) {
          throw new ApiError(429, 'Wait before sending another preset message.');
        }
        this.appendPresetMessage(incident, id, presetId, clientMessageId, timestamp);
      }
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    return this.read(id, token);
  }

  end(id: string, token: string): SessionSnapshot {
    this.expireDue();
    const row = this.authorize(id, token, true);
    if (row.status === 'ended') return this.toSnapshot(row);
    const timestamp = this.now();
    this.finalizeIncident(row, 'walker_ended', 'Walker ended the walk. Live location stopped. Ending can be coerced; verify if the situation was unresolved.', timestamp);
    this.database.prepare(`
      UPDATE sessions SET status = 'ended', ended_reason = 'safe',
        updated_at = MAX(updated_at + 1, ?), ${CLEARED_STATE} WHERE id = ?
    `).run(timestamp, id);
    this.database.prepare('DELETE FROM push_subscriptions WHERE session_id = ?').run(id);
    return this.read(id, token);
  }

  // ---- Campus Safety console ----

  listIncidents(): DispatchIncidentList {
    this.expireDue();
    const timestamp = this.now();
    const rows = this.database.prepare(`
      SELECT * FROM incidents WHERE status != 'resolved' OR resolved_at > ? ORDER BY opened_at DESC, rowid DESC LIMIT 200
    `).all(timestamp - RESOLVED_VISIBLE_MS) as unknown as IncidentRow[];
    return { serverTime: iso(timestamp), incidents: rows.map((row) => this.toDispatchIncident(row)) };
  }

  acknowledgeIncident(incidentId: string): DispatchIncident {
    this.expireDue();
    const incident = this.incidentForDispatch(incidentId);
    if (incident.status === 'new') {
      const timestamp = this.now();
      this.database.prepare(`UPDATE incidents SET status = 'acknowledged', acknowledged_at = ? WHERE id = ?`).run(timestamp, incidentId);
      this.addEvent(incidentId, 'acknowledged', 'Campus Safety acknowledged the signal.', timestamp);
      this.notifyIncidentChange(incident, 'Campus Safety has the signal', 'A dispatcher is watching the walker’s live location.');
    }
    return this.toDispatchIncident(this.incidentForDispatch(incidentId));
  }

  respondToIncident(incidentId: string, input: unknown): DispatchIncident {
    this.expireDue();
    const incident = this.incidentForDispatch(incidentId);
    if (incident.status === 'resolved') throw new ApiError(409, 'Incident is already resolved.');
    const unit = normalizeText(asObject(input, 'Invalid unit.').unit, 40, 'Unit', true)!;
    const timestamp = this.now();
    this.database.prepare(`
      UPDATE incidents SET status = 'responding', unit = ?, responding_at = COALESCE(responding_at, ?),
        acknowledged_at = COALESCE(acknowledged_at, ?) WHERE id = ?
    `).run(unit, timestamp, timestamp, incidentId);
    this.addEvent(incidentId, 'responding', `${unit} assigned and responding.`, timestamp);
    this.notifyIncidentChange(incident, 'Responder on the way', `${unit} is heading to the walker’s live location.`);
    return this.toDispatchIncident(this.incidentForDispatch(incidentId));
  }

  resolveIncident(incidentId: string, input: unknown): DispatchIncident {
    this.expireDue();
    const incident = this.incidentForDispatch(incidentId);
    if (incident.status === 'resolved') throw new ApiError(409, 'Incident is already resolved.');
    const body = asObject(input, 'Invalid outcome.');
    const outcome = body.outcome;
    if (!isIncidentOutcome(outcome)) throw new ApiError(400, 'Choose an outcome.');
    const note = normalizeText(body.note, 280, 'Note');
    const timestamp = this.now();
    // Resolution ends Campus Safety's access to the walker's location and description.
    this.database.prepare(`
      UPDATE incidents SET status = 'resolved', resolved_at = ?, outcome = ?, final_location_json = NULL,
        final_trail_json = NULL, final_walker_description = NULL WHERE id = ?
    `).run(timestamp, outcome, incidentId);
    const label = INCIDENT_OUTCOMES[outcome];
    this.addEvent(incidentId, 'resolved', note ? `Resolved: ${label}. ${note}` : `Resolved: ${label}.`, timestamp);
    this.notifyIncidentChange(incident, 'Campus Safety closed the incident', `Outcome: ${label}.`);
    return this.toDispatchIncident(this.incidentForDispatch(incidentId));
  }

  addIncidentNote(incidentId: string, input: unknown): DispatchIncident {
    this.expireDue();
    this.incidentForDispatch(incidentId);
    const text = normalizeText(asObject(input, 'Invalid note.').text, 280, 'Note', true)!;
    this.addEvent(incidentId, 'note', text, this.now());
    return this.toDispatchIncident(this.incidentForDispatch(incidentId));
  }

  // Lets a guardian pass context to Campus Safety without contacting the walker.
  addGuardianNote(id: string, token: string, input: unknown): SessionSnapshot {
    this.expireDue();
    const row = this.authorize(id, token);
    const open = this.openIncident(id);
    if (!open) throw new ApiError(409, 'There is no open Campus Safety incident for this walk.');
    const text = normalizeText(asObject(input, 'Invalid note.').text, 280, 'Note', true)!;
    const events = JSON.parse(open.events_json) as IncidentEvent[];
    if (events.filter((event) => event.kind === 'guardian_note').length >= MAX_GUARDIAN_NOTES) {
      throw new ApiError(429, 'Too many notes have been sent for this incident.');
    }
    this.addEvent(open.id, 'guardian_note', text, this.now());
    return this.toSnapshot(row);
  }

  // ---- internals ----

  private toSnapshot(row: SessionRow): SessionSnapshot {
    const incident = this.database.prepare('SELECT * FROM incidents WHERE session_id = ? ORDER BY rowid DESC LIMIT 1')
      .get(row.id) as unknown as IncidentRow | undefined;
    return {
      id: row.id,
      mode: row.mode,
      status: row.status,
      startedAt: iso(row.started_at),
      updatedAt: iso(Math.max(row.updated_at, incident?.updated_at ?? 0)),
      expiresAt: iso(row.expires_at),
      helpRequestedAt: isoOrNull(row.help_requested_at),
      endedReason: row.ended_reason,
      location: row.location_json === null ? null : JSON.parse(row.location_json) as LocationPoint,
      trail: JSON.parse(row.trail_json) as LocationPoint[],
      textAlertsEnabled: row.guardian_phone !== null,
      descriptionProvided: row.walker_description !== null,
      incident: incident ? toIncidentSummary(incident) : null,
    };
  }

  private toDispatchIncident(row: IncidentRow): DispatchIncident {
    const session = this.database.prepare('SELECT * FROM sessions WHERE id = ?').get(row.session_id) as unknown as SessionRow;
    const open = row.status !== 'resolved';
    const sharing = session.status !== 'ended';
    const locationJson = !open ? null : sharing ? session.location_json : row.final_location_json;
    const trailJson = !open ? null : sharing ? session.trail_json : row.final_trail_json;
    return {
      ...toIncidentSummary(row),
      mode: session.mode,
      walkerDescription: !open ? null : sharing ? session.walker_description : row.final_walker_description,
      sessionState: sharing ? 'sharing' : session.ended_reason === 'expired' ? 'expired' : 'ended',
      location: locationJson === null ? null : JSON.parse(locationJson) as LocationPoint,
      trail: trailJson === null ? [] : JSON.parse(trailJson) as LocationPoint[],
      guardianTexted: session.guardian_phone !== null,
      guardianPushDevices: this.pushDeviceCount(session.id),
      events: JSON.parse(row.events_json) as IncidentEvent[],
    };
  }

  private openIncident(sessionId: string): IncidentRow | undefined {
    return this.database.prepare(`SELECT * FROM incidents WHERE session_id = ? AND status != 'resolved' ORDER BY rowid DESC LIMIT 1`)
      .get(sessionId) as unknown as IncidentRow | undefined;
  }

  private incidentForDispatch(incidentId: string): IncidentRow {
    const row = /^[0-9a-f-]{36}$/i.test(incidentId)
      ? this.database.prepare('SELECT * FROM incidents WHERE id = ?').get(incidentId) as unknown as IncidentRow | undefined
      : undefined;
    if (!row) throw new ApiError(404, 'Incident not found.');
    return row;
  }

  private addEvent(incidentId: string, kind: IncidentEventKind, text: string, timestamp: number): void {
    const row = this.database.prepare('SELECT events_json, updated_at FROM incidents WHERE id = ?').get(incidentId) as unknown as Pick<IncidentRow, 'events_json' | 'updated_at'>;
    const events = [...(JSON.parse(row.events_json) as IncidentEvent[]), { at: iso(timestamp), kind, text }].slice(-MAX_INCIDENT_EVENTS);
    this.database.prepare('UPDATE incidents SET events_json = ?, updated_at = MAX(updated_at + 1, ?) WHERE id = ?')
      .run(JSON.stringify(events), timestamp, incidentId);
  }

  private messageReceipt(clientMessageId: string): { incident_id: string; session_id: string; preset_id: string } | undefined {
    return this.database.prepare(`
      SELECT incident_id, session_id, preset_id FROM incident_message_receipts WHERE client_message_id = ?
    `).get(clientMessageId) as unknown as { incident_id: string; session_id: string; preset_id: string } | undefined;
  }

  private appendPresetMessage(incident: IncidentRow, sessionId: string, presetId: PresetMessageId, id: string, timestamp: number): void {
    const messages = [...(JSON.parse(incident.messages_json) as IncidentMessage[]),
      { id, presetId, sentAt: iso(timestamp) }].slice(-MAX_PUBLIC_MESSAGES);
    this.database.prepare(`
      INSERT INTO incident_message_receipts (client_message_id, incident_id, session_id, preset_id, received_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, incident.id, sessionId, presetId, timestamp);
    this.database.prepare(`
      UPDATE incidents SET messages_json = ?, updated_at = MAX(updated_at + 1, ?) WHERE id = ?
    `).run(JSON.stringify(messages), timestamp, incident.id);
  }

  // Keeps the last known location and description for Campus Safety until the incident is resolved.
  private finalizeIncident(session: SessionRow, kind: IncidentEventKind, text: string, timestamp: number): void {
    const open = this.openIncident(session.id);
    if (!open) return;
    this.database.prepare(`
      UPDATE incidents SET final_location_json = ?, final_trail_json = ?, final_walker_description = ? WHERE id = ?
    `).run(session.location_json, session.trail_json, session.walker_description, open.id);
    this.addEvent(open.id, kind, text, timestamp);
  }

  private pushDeviceCount(sessionId: string): number {
    return Number((this.database.prepare('SELECT COUNT(*) AS count FROM push_subscriptions WHERE session_id = ?').get(sessionId) as { count: number }).count);
  }

  private notifyIncidentChange(incident: IncidentRow, title: string, body: string): void {
    const session = this.database.prepare('SELECT * FROM sessions WHERE id = ?').get(incident.session_id) as unknown as SessionRow;
    if (session.status === 'ended') return;
    this.notifyGuardian(session, { sms: `PhanTomSignal (${incident.reference}): ${title}. ${body}`, push: { title, body, tag: 'dispatch', urgent: false } });
  }

  private notifyGuardian(row: SessionRow, message: { sms: string; push: Omit<PushPayload, 'sessionId'> }): void {
    const demo = row.mode === 'demo';
    if (row.guardian_phone !== null && row.alerts_sent < MAX_ALERTS_PER_SESSION) {
      this.database.prepare('UPDATE sessions SET alerts_sent = alerts_sent + 1 WHERE id = ?').run(row.id);
      this.notifier.sms({ to: row.guardian_phone, body: (demo ? '[DEMO - simulated walk] ' : '') + message.sms });
    }
    const subscriptions = this.database.prepare('SELECT endpoint, subscription_json FROM push_subscriptions WHERE session_id = ?')
      .all(row.id) as { endpoint: string; subscription_json: string }[];
    const payload: PushPayload = { ...message.push, title: (demo ? '[Demo] ' : '') + message.push.title, sessionId: row.id };
    for (const { endpoint, subscription_json } of subscriptions) {
      void this.notifier.push(JSON.parse(subscription_json) as PushSubscriptionInput, payload).then((result) => {
        if (result !== 'expired') return;
        try {
          this.database.prepare('DELETE FROM push_subscriptions WHERE session_id = ? AND endpoint = ?').run(row.id, endpoint);
        } catch {
          // The store may have closed before the push service answered.
        }
      });
    }
  }

  private authorize(id: string, token: string, ownerOnly = false): SessionRow {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
      throw new ApiError(404, 'Session not found.');
    }
    const row = this.database.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as unknown as SessionRow | undefined;
    if (!row) throw new ApiError(404, 'Session not found.');
    const tokenHash = hashToken(token);
    const isOwner = tokenMatches(tokenHash, row.owner_hash);
    const isGuardian = tokenMatches(tokenHash, row.guardian_hash);
    if (!isOwner && !isGuardian) throw new ApiError(404, 'Session not found.');
    if (ownerOnly && !isOwner) throw new ApiError(403, 'Owner access required.');
    return row;
  }
}
