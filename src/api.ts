import type { ContactsInput, CreateSessionResponse, DispatchIncident, DispatchIncidentList, IncidentOutcome, PushSubscriptionInput, SessionSnapshot } from './api-types';
import { newClientMessageId, type PresetMessageId } from './preset-messages';

export type OwnerCredentials = {
  sessionId: string;
  ownerToken: string;
  guardianToken: string;
  mode: 'live' | 'demo';
};

export class ApiRequestError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

async function request<T>(path: string, options: RequestInit = {}, token?: string): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body) headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);
  let response: Response;
  try {
    response = await fetch(path, { ...options, headers, cache: 'no-store', signal: AbortSignal.timeout(10000) });
  } catch (cause) {
    if (cause instanceof DOMException && (cause.name === 'TimeoutError' || cause.name === 'AbortError')) {
      throw new Error('The request timed out. We’ll retry automatically where possible.');
    }
    throw new Error('Connection lost. Check your internet connection and try again.');
  }
  if (!response.ok) {
    let detail = '';
    try {
      detail = (await response.json() as { error?: string }).error || '';
    } catch {
      // The server may return no response body.
    }
    throw new ApiRequestError(detail || `Request failed (${response.status}). Please try again.`, response.status);
  }
  return response.json() as Promise<T>;
}

export function startSession(mode: 'live' | 'demo'): Promise<CreateSessionResponse> {
  return request('/api/sessions', { method: 'POST', body: JSON.stringify({ mode }) });
}

export function getSession(sessionId: string, token: string): Promise<SessionSnapshot> {
  return request(`/api/sessions/${encodeURIComponent(sessionId)}`, {}, token);
}

export function postLocation(
  sessionId: string,
  token: string,
  location: { latitude: number; longitude: number; accuracy: number; recordedAt: string },
): Promise<SessionSnapshot> {
  return request(`/api/sessions/${encodeURIComponent(sessionId)}/locations`, {
    method: 'POST', body: JSON.stringify(location),
  }, token);
}

export function setContacts(sessionId: string, token: string, contacts: ContactsInput): Promise<SessionSnapshot> {
  return request(`/api/sessions/${encodeURIComponent(sessionId)}/contacts`, {
    method: 'POST', body: JSON.stringify(contacts),
  }, token);
}

export function getPushPublicKey(): Promise<{ publicKey: string }> {
  return request('/api/push/public-key');
}

export function addPushSubscription(sessionId: string, token: string, subscription: PushSubscriptionInput): Promise<{ devices: number }> {
  return request(`/api/sessions/${encodeURIComponent(sessionId)}/push-subscriptions`, {
    method: 'POST', body: JSON.stringify(subscription),
  }, token);
}

export function sendGuardianNote(sessionId: string, token: string, text: string): Promise<SessionSnapshot> {
  return request(`/api/sessions/${encodeURIComponent(sessionId)}/guardian-notes`, { method: 'POST', body: JSON.stringify({ text }) }, token);
}

export function requestHelp(sessionId: string, token: string, presetId?: PresetMessageId, clientMessageId?: string): Promise<SessionSnapshot> {
  return request(`/api/sessions/${encodeURIComponent(sessionId)}/help`, {
    method: 'POST', body: presetId === undefined ? undefined : JSON.stringify({ presetId, clientMessageId: clientMessageId ?? newClientMessageId() }),
  }, token);
}

export function sendPresetMessage(sessionId: string, token: string, presetId: PresetMessageId, clientMessageId: string): Promise<SessionSnapshot> {
  return request(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
    method: 'POST', body: JSON.stringify({ presetId, clientMessageId }),
  }, token);
}

export function retractHelp(sessionId: string, token: string): Promise<SessionSnapshot> {
  return request(`/api/sessions/${encodeURIComponent(sessionId)}/help/retract`, { method: 'POST' }, token);
}

export function endSession(sessionId: string, token: string): Promise<SessionSnapshot> {
  return request(`/api/sessions/${encodeURIComponent(sessionId)}/end`, { method: 'POST' }, token);
}

// Campus Safety console. The access code is sent as a bearer credential.
export function listIncidents(code: string): Promise<DispatchIncidentList> {
  return request('/api/dispatch/incidents', {}, code);
}

function incidentAction(code: string, incidentId: string, action: string, body?: unknown): Promise<DispatchIncident> {
  return request(`/api/dispatch/incidents/${encodeURIComponent(incidentId)}/${action}`, {
    method: 'POST', body: body === undefined ? undefined : JSON.stringify(body),
  }, code);
}

export const acknowledgeIncident = (code: string, id: string) => incidentAction(code, id, 'acknowledge');
export const respondToIncident = (code: string, id: string, unit: string) => incidentAction(code, id, 'respond', { unit });
export const resolveIncident = (code: string, id: string, outcome: IncidentOutcome, note?: string) => incidentAction(code, id, 'resolve', { outcome, note: note || null });
export const addIncidentNote = (code: string, id: string, text: string) => incidentAction(code, id, 'notes', { text });
