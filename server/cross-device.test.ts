import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { CreateSessionResponse, SessionSnapshot } from '../src/api-types.js';
import { buildGuardianLink } from '../src/guardian-link.js';
import { createApp } from './app.js';
import { SessionStore } from './store.js';

test('a second HTTP client follows owner updates using only the shared URL', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'ghostsignal-cross-device-'));
  const clock = { now: Date.parse('2026-10-03T18:00:00.000Z') };
  const store = new SessionStore(join(directory, 'sessions.sqlite'), () => clock.now);
  const server = createApp(store).listen(0);
  t.after(async () => {
    await new Promise<void>(done => server.close(() => done()));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const createdResponse = await fetch(`${base}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'live' }),
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json() as CreateSessionResponse;
  const ownerPath = `/api/sessions/${created.sessionId}`;
  const ownerPost = async (path: string, body?: unknown) => fetch(`${base}${ownerPath}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${created.ownerToken}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  // The guardian receives this URL alone; no owner token, account, or stored browser state.
  const shared = new URL(buildGuardianLink(base, created.sessionId, created.guardianToken));
  const guardianPath = shared.pathname.replace(/^\/watch\//, '/api/sessions/');
  const guardianToken = decodeURIComponent(shared.hash.slice(1));
  const guardianGet = async () => fetch(`${shared.origin}${guardianPath}`, {
    headers: { Authorization: `Bearer ${guardianToken}` },
  });
  const firstRead = await guardianGet();
  assert.equal(firstRead.status, 200);
  assert.equal((await firstRead.json() as SessionSnapshot).location, null);

  for (const [index, latitude] of [40.1106, 40.1108].entries()) {
    const posted = await ownerPost('/locations', {
      latitude,
      longitude: -88.2073,
      accuracy: 12,
      recordedAt: new Date(clock.now).toISOString(),
    });
    assert.equal(posted.status, 200);
    const guardianResponse = await guardianGet();
    assert.equal(guardianResponse.status, 200);
    const guardianView = await guardianResponse.json() as SessionSnapshot;
    assert.equal(guardianView.location?.latitude, latitude);
    assert.equal(guardianView.trail.length, index + 1);
    clock.now += 1200;
  }

  assert.equal((await ownerPost('/help')).status, 200);
  const guardianHelpResponse = await guardianGet();
  assert.equal(guardianHelpResponse.status, 200);
  const guardianHelp = await guardianHelpResponse.json() as SessionSnapshot;
  assert.equal(guardianHelp.status, 'help_requested');
  assert.equal(guardianHelp.incident?.status, 'new');
  assert.equal((await fetch(`${shared.origin}${guardianPath}/end`, {
    method: 'POST', headers: { Authorization: `Bearer ${guardianToken}` },
  })).status, 403);

  assert.equal((await ownerPost('/end')).status, 200);
  const endedResponse = await guardianGet();
  assert.equal(endedResponse.status, 200);
  const ended = await endedResponse.json() as SessionSnapshot;
  assert.equal(ended.status, 'ended');
  assert.equal(ended.location, null);
  assert.deepEqual(ended.trail, []);
});
