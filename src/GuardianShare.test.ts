import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import QRCode from 'qrcode';
import { GuardianShare } from './GuardianShare';
import { buildGuardianLink } from './guardian-link';
import { I18nProvider } from './i18n';

const sessionId = 'dc7c745a-4590-45c1-ae17-69e645a48608';
const guardianToken = 'guardian-private-token';

function render(origin: string): string {
  return renderToStaticMarkup(createElement(I18nProvider, { initialLocale: 'en', children:
    createElement(GuardianShare, { origin, sessionId, guardianToken, variant: 'inline' }),
  }));
}

test('share panel shows the complete private link in a readonly field', () => {
  const origin = 'https://ghostsignal.example';
  const link = buildGuardianLink(origin, sessionId, guardianToken);
  const html = render(origin);

  assert.match(html, /<textarea[^>]*class="guardian-share-url"[^>]*readOnly=""/);
  assert.ok(html.includes(`>${link}</textarea>`));
  assert.doesNotMatch(html, /guardian-share-preview|Preview on this device/);
  assert.match(html, /guardian-share-qr/);
  assert.match(html, /Preparing QR code/);
  assert.doesNotMatch(html, /<img[^>]+src="https?:/);
});

test('loopback link warns about another phone and does not offer an unusable QR', () => {
  const html = render('http://localhost:5173');
  assert.ok(html.includes(buildGuardianLink('http://localhost:5173', sessionId, guardianToken)));
  assert.match(html, /works only on this device/);
  assert.doesNotMatch(html, /guardian-share-qr/);
});

test('dialog variant contains the private link and a close control', () => {
  const origin = 'https://ghostsignal.example';
  const link = buildGuardianLink(origin, sessionId, guardianToken);
  const html = renderToStaticMarkup(createElement(I18nProvider, { initialLocale: 'en', children:
    createElement(GuardianShare, { origin, sessionId, guardianToken, variant: 'dialog', onClose: () => {} }),
  }));

  assert.match(html, /^<dialog[^>]*aria-label="Private guardian link"/);
  assert.ok(html.includes(`>${link}</textarea>`));
  assert.match(html, /aria-label="Close guardian sharing"/);
  assert.doesNotMatch(html, /guardian-share-panel/);
});

test('local QR encoder returns a data URI for the exact complete guardian link', async () => {
  const link = buildGuardianLink('https://ghostsignal.example', sessionId, guardianToken);
  const uri = await QRCode.toDataURL(link, { errorCorrectionLevel: 'M', margin: 2, width: 232 });
  assert.match(uri, /^data:image\/png;base64,/);
  assert.ok(uri.length > 100);
});
