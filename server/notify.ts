import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import webpush from 'web-push';
import type { PushSubscriptionInput } from '../src/api-types.js';

export interface GuardianAlert {
  to: string;
  body: string;
}

export interface PushPayload {
  title: string;
  body: string;
  sessionId: string;
  tag: string;
  urgent: boolean;
}

export type PushResult = 'sent' | 'expired' | 'failed';

export interface Notifier {
  publicPushKey: string | null;
  sms(alert: GuardianAlert): void;
  push(subscription: PushSubscriptionInput, payload: PushPayload): Promise<PushResult>;
}

export const silentNotifier: Notifier = {
  publicPushKey: null,
  sms: () => {},
  push: async () => 'failed',
};

function maskPhone(phone: string): string {
  return `•••${phone.slice(-4)}`;
}

// Sends text alerts through Twilio when all three variables are set; otherwise logs a
// clearly labeled simulated message so the flow can be demonstrated without an account.
function createSmsSender(env: NodeJS.ProcessEnv): Notifier['sms'] {
  const sid = env.TWILIO_ACCOUNT_SID;
  const authToken = env.TWILIO_AUTH_TOKEN;
  const from = env.TWILIO_FROM_NUMBER;
  if (!sid || !authToken || !from) {
    return ({ to, body }) => console.log(`[simulated SMS to ${maskPhone(to)}] ${body}`);
  }
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`;
  const auth = `Basic ${Buffer.from(`${sid}:${authToken}`).toString('base64')}`;
  return ({ to, body }) => {
    void fetch(url, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ To: to, From: from, Body: body }),
      signal: AbortSignal.timeout(10000),
    }).then(async (response) => {
      if (!response.ok) console.error(`SMS to ${maskPhone(to)} failed (${response.status}): ${await response.text()}`);
    }).catch((error: unknown) => console.error(`SMS to ${maskPhone(to)} failed`, error));
  };
}

// Uses VAPID keys from the environment, or creates a key pair once and keeps it beside the
// database so guardian subscriptions survive restarts.
function loadVapidKeys(env: NodeJS.ProcessEnv, keyPath: string): { publicKey: string; privateKey: string } {
  if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) {
    return { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY };
  }
  if (existsSync(keyPath)) return JSON.parse(readFileSync(keyPath, 'utf8')) as { publicKey: string; privateKey: string };
  const keys = webpush.generateVAPIDKeys();
  mkdirSync(dirname(keyPath), { recursive: true });
  writeFileSync(keyPath, JSON.stringify(keys), { mode: 0o600 });
  return keys;
}

export function createNotifier(options: { env?: NodeJS.ProcessEnv; vapidKeyPath: string }): Notifier {
  const env = options.env ?? process.env;
  const keys = loadVapidKeys(env, options.vapidKeyPath);
  webpush.setVapidDetails(env.VAPID_SUBJECT ?? 'mailto:ghostsignal@example.invalid', keys.publicKey, keys.privateKey);
  return {
    publicPushKey: keys.publicKey,
    sms: createSmsSender(env),
    async push(subscription, payload) {
      try {
        await webpush.sendNotification(subscription, JSON.stringify(payload), { TTL: 600, urgency: payload.urgent ? 'high' : 'normal' });
        return 'sent';
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) return 'expired';
        console.error('Push notification failed', status ?? error);
        return 'failed';
      }
    },
  };
}
