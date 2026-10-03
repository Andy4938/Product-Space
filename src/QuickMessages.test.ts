import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider, translate, type Locale } from './i18n';
import { QuickMessages, ReceivedMessages } from './QuickMessages';
import { PRESET_MESSAGES } from './preset-messages';

const receipt = { id: 'server-confirmed-1', presetId: 'cannot_talk' as const, sentAt: '2026-10-03T16:00:00.000Z' };

test('guardian and walker render only server-confirmed preset receipts in each language', () => {
  for (const locale of ['en', 'es', 'zh-CN', 'hi'] satisfies Locale[]) {
    const html = renderToStaticMarkup(createElement(I18nProvider, { initialLocale: locale, children:
      createElement(ReceivedMessages, { audience: 'guardian', messages: [receipt] }),
    }));
    assert.match(html, new RegExp(translate('I cannot speak right now', locale)));
    assert.match(html, /dateTime="2026-10-03T16:00:00.000Z"/);
    assert.doesNotMatch(html, /I need medical help/);
  }
});

test('preparing a preset does not claim delivery or expose a send action', () => {
  const html = renderToStaticMarkup(createElement(I18nProvider, { initialLocale: 'en', children:
    createElement(QuickMessages, { mode: 'prepare', selectedId: 'being_followed', onSelect: () => {}, sent: [receipt] }),
  }));
  assert.match(html, /Selecting a message alone does not alert anyone/);
  assert.match(html, /aria-pressed="true"/);
  assert.doesNotMatch(html, /Send message/);
  assert.doesNotMatch(html, /RECEIVED BY CAMPUS SAFETY/);
});

test('incident message send remains disabled without a selection', () => {
  const html = renderToStaticMarkup(createElement(I18nProvider, { initialLocale: 'en', children:
    createElement(QuickMessages, { mode: 'incident', selectedId: null, onSelect: () => {}, onSend: async () => {}, sent: [receipt] }),
  }));
  assert.match(html, /class="quick-send" disabled=""/);
  assert.match(html, /I cannot speak right now/);
});

test('incident composer renders every preset in each language without adding a receipt for a selection', () => {
  for (const locale of ['en', 'es', 'zh-CN', 'hi'] satisfies Locale[]) {
    const html = renderToStaticMarkup(createElement(I18nProvider, { initialLocale: locale, children:
      createElement(QuickMessages, { mode: 'incident', selectedId: 'cannot_talk', onSelect: () => {}, onSend: async () => {} }),
    }));
    for (const preset of PRESET_MESSAGES) {
      assert.ok(html.includes(translate(preset.en, locale)), `${locale} missing ${preset.id}`);
    }
    assert.ok(html.includes(translate('Only a server-confirmed message appears below.', locale)));
    assert.doesNotMatch(html, /<ol>/);
  }
});

test('disabled composer cannot send; received messages have no interactive controls', () => {
  const disabled = renderToStaticMarkup(createElement(I18nProvider, { initialLocale: 'en', children:
    createElement(QuickMessages, { mode: 'incident', selectedId: 'cannot_talk', onSelect: () => {}, onSend: async () => {}, disabled: true }),
  }));
  assert.match(disabled, /class="quick-send" disabled=""/);
  assert.equal((disabled.match(/disabled=""/g) ?? []).length, PRESET_MESSAGES.length + 1);

  const readonly = renderToStaticMarkup(createElement(I18nProvider, { initialLocale: 'es', children:
    createElement(ReceivedMessages, { audience: 'guardian', messages: [receipt] }),
  }));
  assert.ok(readonly.includes(translate('I cannot speak right now', 'es')));
  assert.doesNotMatch(readonly, /<button|<textarea|<input/);
});

test('an unknown stored preset renders a safe fallback instead of its wire ID', () => {
  const unknown = { ...receipt, presetId: 'unsupported_future_id' as typeof receipt.presetId };
  const html = renderToStaticMarkup(createElement(I18nProvider, { initialLocale: 'hi', children:
    createElement(ReceivedMessages, { messages: [unknown] }),
  }));
  assert.ok(html.includes(translate('Message unavailable', 'hi')));
  assert.doesNotMatch(html, /unsupported_future_id/);
});
