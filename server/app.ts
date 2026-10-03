import express, { type ErrorRequestHandler, type Request, type RequestHandler } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionMode } from '../src/api-types.js';
import { ApiError, SessionStore } from './store.js';

function bearerToken(request: Request): string {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.get('authorization') ?? '');
  if (!match) throw new ApiError(401, 'Bearer token required.');
  return match[1];
}

function dispatchCodeMatches(request: Request, code: string): boolean {
  const match = /^Bearer (.{1,200})$/.exec(request.get('authorization') ?? '');
  if (!match) return false;
  const given = createHash('sha256').update(match[1]).digest();
  return timingSafeEqual(given, createHash('sha256').update(code).digest());
}

function handle(action: (request: Request, response: express.Response) => void): RequestHandler {
  return (request, response, next) => {
    try {
      action(request, response);
    } catch (error) {
      next(error);
    }
  };
}

export function createApp(store: SessionStore, options: { staticDir?: string; dispatchCode?: string } = {}): express.Express {
  const app = express();
  app.disable('x-powered-by');
  // Behind a local reverse proxy (Cloudflare Tunnel, Vite), every request arrives from loopback.
  // Trust only that hop so rate limits key on each visitor's forwarded address, not the proxy's.
  app.set('trust proxy', 'loopback');
  app.use((_, response, next) => {
    response.set('Referrer-Policy', 'strict-origin');
    response.set('X-Content-Type-Options', 'nosniff');
    next();
  });
  app.use('/api', (_, response, next) => {
    response.set('Cache-Control', 'no-store');
    next();
  });
  app.use('/api', express.json({ limit: '2kb', strict: true }));

  const creationsByIp = new Map<string, number[]>();
  app.post('/api/sessions', handle((request, response) => {
    const body = request.body as unknown;
    if (typeof body !== 'object' || body === null || Array.isArray(body) ||
        !('mode' in body) || (body.mode !== 'live' && body.mode !== 'demo')) {
      throw new ApiError(400, 'Mode must be live or demo.');
    }
    const ip = request.ip ?? 'unknown';
    const now = Date.now();
    const recent = (creationsByIp.get(ip) ?? []).filter((time) => now - time < 10 * 60 * 1000);
    if (recent.length >= 20) throw new ApiError(429, 'Too many sessions created. Try again later.');
    recent.push(now);
    creationsByIp.set(ip, recent);
    if (creationsByIp.size > 10000) {
      for (const [key, times] of creationsByIp) {
        if (times.every((time) => now - time >= 10 * 60 * 1000)) creationsByIp.delete(key);
      }
    }
    response.status(201).json(store.create(body.mode as SessionMode));
  }));

  app.get('/api/sessions/:id', handle((request, response) => {
    response.json(store.read(request.params.id as string, bearerToken(request)));
  }));

  app.post('/api/sessions/:id/locations', handle((request, response) => {
    response.json(store.updateLocation(request.params.id as string, bearerToken(request), request.body as unknown));
  }));

  app.post('/api/sessions/:id/contacts', handle((request, response) => {
    response.json(store.setContacts(request.params.id as string, bearerToken(request), request.body as unknown));
  }));

  app.get('/api/push/public-key', handle((_request, response) => {
    if (!store.publicPushKey) throw new ApiError(503, 'Push notifications are not configured.');
    response.json({ publicKey: store.publicPushKey });
  }));

  app.post('/api/sessions/:id/push-subscriptions', handle((request, response) => {
    response.status(201).json(store.addPushSubscription(request.params.id as string, bearerToken(request), request.body as unknown));
  }));

  app.post('/api/sessions/:id/guardian-notes', handle((request, response) => {
    response.status(201).json(store.addGuardianNote(request.params.id as string, bearerToken(request), request.body as unknown));
  }));

  app.post('/api/sessions/:id/help', handle((request, response) => {
    response.json(store.requestHelp(request.params.id as string, bearerToken(request), request.body as unknown));
  }));

  app.post('/api/sessions/:id/help/retract', handle((request, response) => {
    response.json(store.retractHelp(request.params.id as string, bearerToken(request)));
  }));

  app.post('/api/sessions/:id/messages', handle((request, response) => {
    response.json(store.sendPresetMessage(request.params.id as string, bearerToken(request), request.body as unknown));
  }));

  app.post('/api/sessions/:id/end', handle((request, response) => {
    response.json(store.end(request.params.id as string, bearerToken(request)));
  }));

  // Campus Safety console. Every route needs the shared dispatcher access code.
  const failedDispatchLogins = new Map<string, number[]>();
  app.use('/api/dispatch', (request, _response, next) => {
    const code = options.dispatchCode;
    if (!code) return next(new ApiError(503, 'The Campus Safety console is not enabled.'));
    const ip = request.ip ?? 'unknown';
    const now = Date.now();
    const failures = (failedDispatchLogins.get(ip) ?? []).filter((time) => now - time < 10 * 60 * 1000);
    if (failures.length >= 10) return next(new ApiError(429, 'Too many incorrect access codes. Try again later.'));
    if (!dispatchCodeMatches(request, code)) {
      failures.push(now);
      failedDispatchLogins.set(ip, failures);
      return next(new ApiError(401, 'Incorrect access code.'));
    }
    next();
  });

  app.get('/api/dispatch/incidents', handle((_request, response) => {
    response.json(store.listIncidents());
  }));

  app.post('/api/dispatch/incidents/:id/acknowledge', handle((request, response) => {
    response.json(store.acknowledgeIncident(request.params.id as string));
  }));

  app.post('/api/dispatch/incidents/:id/respond', handle((request, response) => {
    response.json(store.respondToIncident(request.params.id as string, request.body as unknown));
  }));

  app.post('/api/dispatch/incidents/:id/resolve', handle((request, response) => {
    response.json(store.resolveIncident(request.params.id as string, request.body as unknown));
  }));

  app.post('/api/dispatch/incidents/:id/notes', handle((request, response) => {
    response.json(store.addIncidentNote(request.params.id as string, request.body as unknown));
  }));

  app.use('/api', (_request, response) => {
    response.status(404).json({ error: 'Not found.' });
  });

  if (options.staticDir && existsSync(join(options.staticDir, 'index.html'))) {
    app.use(express.static(options.staticDir, { index: false }));
    app.use((request, response, next) => {
      if (request.method !== 'GET' || !request.accepts('html')) return next();
      response.sendFile(join(options.staticDir!, 'index.html'));
    });
  }

  app.use((_request, response) => {
    response.status(404).json({ error: 'Not found.' });
  });

  const errorHandler: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
    if (error instanceof ApiError) {
      response.status(error.status).json({ error: error.message });
      return;
    }
    if (typeof error === 'object' && error !== null && 'type' in error && error.type === 'entity.too.large') {
      response.status(413).json({ error: 'Request body is too large.' });
      return;
    }
    if (error instanceof SyntaxError && 'body' in error) {
      response.status(400).json({ error: 'Invalid JSON.' });
      return;
    }
    console.error('API error', error);
    response.status(500).json({ error: 'Internal server error.' });
  };
  app.use(errorHandler);
  return app;
}
