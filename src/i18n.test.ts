import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider, LanguagePicker, LANGUAGES, SettingsButton, translate, type Locale } from './i18n';
import { PRESET_MESSAGES } from './preset-messages';
import { translations } from './translations';

const nonEnglishLocales = ['es', 'zh-CN', 'hi'] as const;

function placeholders(value: string): string[] {
  return [...value.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
}

test('each translated string preserves every source placeholder and has visible text', () => {
  for (const [source, localized] of Object.entries(translations)) {
    for (const locale of nonEnglishLocales) {
      assert.ok(localized[locale]?.trim(), `Missing ${locale} text for ${source}`);
      assert.deepEqual(placeholders(localized[locale]), placeholders(source), `${locale} placeholders differ for ${source}`);
    }
  }
});

test('every preset, delivery instruction, and settings control is translated in all supported languages', () => {
  const criticalCopy = [
    ...PRESET_MESSAGES.map(message => message.en),
    'Optional. Select one before sending help. Selecting a message alone does not alert anyone.',
    'Only a server-confirmed message appears below.',
    'Message not confirmed. Retry to send it.',
    'Message unavailable',
    'Settings',
    'Close settings',
    'Choose your display language.',
  ];
  for (const source of criticalCopy) {
    for (const locale of nonEnglishLocales) {
      assert.ok(translations[source]?.[locale]?.trim(), `Missing ${locale} text for ${source}`);
      assert.notEqual(translate(source, locale), source, `Untranslated ${locale} text for ${source}`);
    }
  }
});

test('language picker renders the chosen locale without changing the supported options', () => {
  for (const locale of LANGUAGES.map(language => language.value)) {
    const html = renderToStaticMarkup(createElement(I18nProvider, { initialLocale: locale, children: createElement(LanguagePicker) }));
    assert.match(html, new RegExp(`<option value="${locale}" lang="${locale}" selected=""`));
    for (const language of LANGUAGES) assert.match(html, new RegExp(`value="${language.value}"`));
    assert.match(html, new RegExp(translate('Language', locale)));
  }
});

test('settings is discoverable in every language and opens a labelled native dialog with a close action', () => {
  for (const locale of LANGUAGES.map(language => language.value)) {
    const html = renderToStaticMarkup(createElement(I18nProvider, { initialLocale: locale, children: createElement(SettingsButton) }));
    const settings = translate('Settings', locale);
    const close = translate('Close settings', locale);
    const guidance = translate('Choose your display language.', locale);
    assert.match(html, /<button[^>]*class="settings-trigger"[^>]*aria-haspopup="dialog"/);
    assert.ok(html.includes(`aria-label="${settings}"`));
    assert.ok(html.includes(`<span>${settings}</span>`));
    const dialog = html.match(/<dialog[^>]*aria-labelledby="([^"]+)"[^>]*>/);
    assert.ok(dialog, `${locale} settings dialog missing accessible title`);
    assert.doesNotMatch(dialog[0], /\sopen(?:=|\s|>)/);
    assert.ok(html.includes(`<h2 id="${dialog[1]}">${settings}</h2>`));
    assert.ok(html.includes(`aria-label="${close}"`));
    assert.ok(html.includes(guidance));
    assert.ok(html.includes(`aria-label="${translate('Language', locale)}"`));
    for (const language of LANGUAGES) assert.ok(html.includes(`value="${language.value}"`));
  }
});

test('translation interpolates selected language and falls back to English for unknown copy', () => {
  for (const locale of LANGUAGES.map(language => language.value)) {
    assert.equal(translate('{count}m ago', locale, { count: 3 }), translate('{count}m ago', locale).replace('{count}', '3'));
    assert.equal(translate('Uncatalogued {name}', locale, { name: 'Sam' }), 'Uncatalogued Sam');
  }
  assert.deepEqual(LANGUAGES.map(language => language.value), ['en', 'es', 'zh-CN', 'hi'] satisfies Locale[]);
});
