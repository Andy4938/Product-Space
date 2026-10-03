import type { CreateSessionResponse, SessionSnapshot } from './api-types';

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

export function requestHelp(sessionId: string, token: string): Promise<SessionSnapshot> {
  return request(`/api/sessions/${encodeURIComponent(sessionId)}/help`, { method: 'POST' }, token);
}

export function endSession(sessionId: string, token: string): Promise<SessionSnapshot> {
  return request(`/api/sessions/${encodeURIComponent(sessionId)}/end`, { method: 'POST' }, token);
}
