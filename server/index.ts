import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApp } from './app.js';
import { SessionStore } from './store.js';

const dbPath = process.env.SESSION_DB_PATH ?? resolve(process.cwd(), 'data', 'sessions.sqlite');
const distDir = resolve(process.cwd(), 'dist');
const port = Number(process.env.PORT ?? '3001');
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error('PORT must be an integer from 0 to 65535.');
}

const store = new SessionStore(dbPath);
const app = createApp(store, { staticDir: existsSync(distDir) ? distDir : undefined });
const server = app.listen(port, () => {
  console.log(`GhostSignal server listening on http://localhost:${port}`);
});
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
