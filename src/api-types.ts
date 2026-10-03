import type { PresetMessageId } from './preset-messages.js';

export type SessionMode = 'live' | 'demo';
export type SessionStatus = 'active' | 'help_requested' | 'ended';

export interface LocationPoint {
  latitude: number;
  longitude: number;
  accuracy: number;
  recordedAt: string;
  receivedAt: string;
}

export type IncidentStatus = 'new' | 'acknowledged' | 'responding' | 'resolved';
// Every outcome is something a responder can establish in person, without the walker
// having to call, text, or speak to anyone while they may be at risk.
export type IncidentOutcome = 'escorted_to_safety' | 'no_threat_on_scene' | 'accidental_confirmed_in_person'
  | 'walker_reached_safety';

export const INCIDENT_OUTCOMES: Record<IncidentOutcome, string> = {
  escorted_to_safety: 'Responder reached walker and escorted them to safety',
  no_threat_on_scene: 'Responder on scene; no threat observed',
  accidental_confirmed_in_person: 'Accidental signal, confirmed in person by responder',
  walker_reached_safety: 'Walker ended the walk at a safe location',
};

export function isIncidentOutcome(value: unknown): value is IncidentOutcome {
  return typeof value === 'string' && Object.hasOwn(INCIDENT_OUTCOMES, value);
}

// Incidents closed with an outcome that has since been retired keep its ID; show them a neutral label.
export function outcomeLabel(outcome: string | null | undefined): string | null {
  if (!outcome) return null;
  return isIncidentOutcome(outcome) ? INCIDENT_OUTCOMES[outcome] : 'The dispatcher has closed this incident.';
}

// The part of a Campus Safety incident the walker and guardian can see.
export interface IncidentMessage {
  id: string;
  presetId: PresetMessageId;
  sentAt: string;
}

export interface IncidentSummary {
  id: string;
  reference: string;
  status: IncidentStatus;
  openedAt: string;
  acknowledgedAt: string | null;
  respondingAt: string | null;
  unit: string | null;
  resolvedAt: string | null;
  outcome: IncidentOutcome | null;
  walkerCancelledAt: string | null;
  messages: IncidentMessage[];
}

export interface SessionSnapshot {
  id: string;
  mode: SessionMode;
  status: SessionStatus;
  startedAt: string;
  updatedAt: string;
  expiresAt: string;
  helpRequestedAt: string | null;
  endedReason: 'safe' | 'expired' | null;
  location: LocationPoint | null;
  trail: LocationPoint[];
  textAlertsEnabled: boolean;
  descriptionProvided: boolean;
  // Set when the walker cancelled a signal before it reached dispatch; the walker's receipt for that cancel.
  signalWithdrawnAt?: string | null;
  incident: IncidentSummary | null;
}

export interface CreateSessionResponse {
  sessionId: string;
  ownerToken: string;
  guardianToken: string;
  session: SessionSnapshot;
}

export interface ContactsInput {
  walkerDescription?: string | null;
  guardianPhone?: string | null;
}

export type IncidentEventKind = 'opened' | 'acknowledged' | 'responding' | 'resolved' | 'note'
  | 'walker_cancelled' | 'walker_resent' | 'walker_ended' | 'session_expired' | 'guardian_note';

export interface IncidentEvent {
  at: string;
  kind: IncidentEventKind;
  text: string;
}

export type WalkerSessionState = 'sharing' | 'ended' | 'expired';

export interface DispatchIncident extends IncidentSummary {
  mode: SessionMode;
  walkerDescription: string | null;
  sessionState: WalkerSessionState;
  location: LocationPoint | null;
  trail: LocationPoint[];
  guardianTexted: boolean;
  guardianPushDevices: number;
  events: IncidentEvent[];
}

export interface DispatchIncidentList {
  serverTime: string;
  incidents: DispatchIncident[];
}

export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}
