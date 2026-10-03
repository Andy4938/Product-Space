import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { LocationPoint, SessionMode, SessionSnapshot, SessionStatus } from '../src/api-types.js';

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
}

const SESSION_LIFETIME_MS = 2 * 60 * 60 * 1000;
const MIN_LOCATION_INTERVAL_MS = 1000;
const MAX_LOCATION_AGE_MS = 2 * 60 * 1000;
const MAX_LOCATION_FUTURE_MS = 30 * 1000;
const MAX_TRAIL_POINTS = 100;

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

function toSnapshot(row: SessionRow): SessionSnapshot {
  return {
    id: row.id,
    mode: row.mode,
    status: row.status,
    startedAt: iso(row.started_at),
    updatedAt: iso(row.updated_at),
    expiresAt: iso(row.expires_at),
    helpRequestedAt: row.help_requested_at === null ? null : iso(row.help_requested_at),
    endedReason: row.ended_reason,
    location: row.location_json === null ? null : JSON.parse(row.location_json) as LocationPoint,
    trail: JSON.parse(row.trail_json) as LocationPoint[],
  };
}

function validateLocation(input: unknown, now: number): LocationInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ApiError(400, 'Invalid location.');
  }
  const point = input as Record<string, unknown>;
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

  constructor(dbPath: string, private readonly now: () => number = Date.now) {
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
    `);
    this.expireDue();
  }

  close(): void {
    this.database.close();
  }

  expireDue(): number {
    const timestamp = this.now();
    const result = this.database.prepare(`
      UPDATE sessions SET status = 'ended', ended_reason = 'expired',
        updated_at = expires_at, location_json = NULL, trail_json = '[]'
      WHERE status != 'ended' AND expires_at <= ?
    `).run(timestamp);
    return Number(result.changes);
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
    const row = this.authorize(id, token);
    return toSnapshot(row);
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
      UPDATE sessions SET updated_at = ?, location_json = ?, trail_json = ? WHERE id = ?
    `).run(timestamp, JSON.stringify(point), JSON.stringify(trail), id);
    return this.read(id, token);
  }

  requestHelp(id: string, token: string): SessionSnapshot {
    this.expireDue();
    const row = this.authorize(id, token, true);
    if (row.status === 'ended') throw new ApiError(409, 'Session has ended.');
    if (row.status === 'active') {
      const timestamp = this.now();
      this.database.prepare(`
        UPDATE sessions SET status = 'help_requested', help_requested_at = ?, updated_at = ? WHERE id = ?
      `).run(timestamp, timestamp, id);
    }
    return this.read(id, token);
  }

  end(id: string, token: string): SessionSnapshot {
    this.expireDue();
    const row = this.authorize(id, token, true);
    if (row.status === 'ended') return toSnapshot(row);
    const timestamp = this.now();
    this.database.prepare(`
      UPDATE sessions SET status = 'ended', ended_reason = 'safe', updated_at = ?,
        location_json = NULL, trail_json = '[]' WHERE id = ?
    `).run(timestamp, id);
    return this.read(id, token);
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
