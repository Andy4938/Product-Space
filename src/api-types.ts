export type SessionMode = 'live' | 'demo';
export type SessionStatus = 'active' | 'help_requested' | 'ended';

export interface LocationPoint {
  latitude: number;
  longitude: number;
  accuracy: number;
  recordedAt: string;
  receivedAt: string;
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
}

export interface CreateSessionResponse {
  sessionId: string;
  ownerToken: string;
  guardianToken: string;
  session: SessionSnapshot;
}
