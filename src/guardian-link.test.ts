import assert from 'node:assert/strict';
import test from 'node:test';
import { buildGuardianLink, classifyGuardianOrigin } from './guardian-link';

test('classifies loopback addresses as links that cannot reach another phone', () => {
  for (const origin of [
    'http://localhost:5173',
    'https://walk.localhost',
    'http://127.0.0.1:5173',
    'http://127.255.255.254',
    'http://[::1]:5173',
    'http://[::]',
    'http://0.0.0.0:5173',
  ]) {
    assert.equal(classifyGuardianOrigin(origin), 'loopback', origin);
  }
});

test('distinguishes LAN addresses from non-local HTTPS origins', () => {
  for (const origin of [
    'http://192.168.1.4:5173',
    'https://10.0.0.4',
    'http://172.16.0.1',
    'http://172.31.255.254',
    'http://169.254.1.2',
    'http://walk.local',
    'http://[fc00::1]',
    'https://[fd12::1]',
    'http://[fe80::1]',
  ]) {
    assert.equal(classifyGuardianOrigin(origin), 'private-network', origin);
  }
  for (const origin of ['https://ghostsignal.example', 'https://[2001:db8::1]']) {
    assert.equal(classifyGuardianOrigin(origin), 'public-https', origin);
  }
  for (const origin of ['http://ghostsignal.example', 'http://172.32.0.1']) {
    assert.equal(classifyGuardianOrigin(origin), 'other', origin);
  }
});

test('builds a complete guardian URL with only the guardian capability in the fragment', () => {
  const origin = 'https://ghostsignal.example';
  const sessionId = 'session/id?with spaces';
  const guardianToken = 'guardian#token/with?symbols';
  const ownerToken = 'secret-owner-token';
  const link = buildGuardianLink(origin, sessionId, guardianToken);
  const url = new URL(link);

  assert.equal(url.origin, origin);
  assert.equal(url.pathname, `/watch/${encodeURIComponent(sessionId)}`);
  assert.equal(decodeURIComponent(url.hash.slice(1)), guardianToken);
  assert.equal(url.search, '');
  assert.equal(url.href.split('#')[0].includes(guardianToken), false);
  assert.equal(link.includes(ownerToken), false);
  assert.equal(buildGuardianLink('http://localhost:5173', 'abc', 'token'), 'http://localhost:5173/watch/abc#token');
  assert.throws(() => buildGuardianLink('file:///walk', 'abc', 'token'), /web address/i);
});
