import express, { type ErrorRequestHandler, type Request, type RequestHandler } from 'express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionMode } from '../src/api-types.js';
import { ApiError, SessionStore } from './store.js';

function bearerToken(request: Request): string {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.get('authorization') ?? '');
  if (!match) throw new ApiError(401, 'Bearer token required.');
  return match[1];
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

export function createApp(store: SessionStore, options: { staticDir?: string } = {}): express.Express {
  const app = express();
  app.disable('x-powered-by');
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

  app.post('/api/sessions/:id/help', handle((request, response) => {
    response.json(store.requestHelp(request.params.id as string, bearerToken(request)));
  }));

  app.post('/api/sessions/:id/end', handle((request, response) => {
    response.json(store.end(request.params.id as string, bearerToken(request)));
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
