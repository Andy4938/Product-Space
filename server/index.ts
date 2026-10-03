import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createApp } from './app.js';
import { createNotifier } from './notify.js';
import { SessionStore } from './store.js';

const dbPath = process.env.SESSION_DB_PATH ?? resolve(process.cwd(), 'data', 'sessions.sqlite');
const distDir = resolve(process.cwd(), 'dist');
const port = Number(process.env.PORT ?? '3001');
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error('PORT must be an integer from 0 to 65535.');
}

const configuredCode = process.env.DISPATCH_ACCESS_CODE;
const dispatchCode = configuredCode || randomBytes(6).toString('base64url');

const notifier = createNotifier({ vapidKeyPath: join(dirname(dbPath), 'vapid-keys.json') });
const store = new SessionStore(dbPath, Date.now, notifier);
const app = createApp(store, { staticDir: existsSync(distDir) ? distDir : undefined, dispatchCode });
const server = app.listen(port, () => {
  console.log(`GhostSignal server listening on http://localhost:${port}`);
  console.log(configuredCode
    ? 'Campus Safety console: /dispatch (access code from DISPATCH_ACCESS_CODE)'
    : `Campus Safety console: /dispatch  access code: ${dispatchCode}  (set DISPATCH_ACCESS_CODE to keep it fixed)`);
});
// Expires sessions even when no client is polling.
const sweep = setInterval(() => store.expireDue(), 60_000);
sweep.unref();

function shutdown(): void {
  clearInterval(sweep);
  server.close(() => {
    store.close();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
