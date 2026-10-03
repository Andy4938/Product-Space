import { createContext, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { translations } from './translations';

export type Locale = 'en' | 'es' | 'zh-CN' | 'hi';
export type TranslationParams = Record<string, string | number>;
export const LANGUAGES: { value: Locale; label: string }[] = [
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Español' },
  { value: 'zh-CN', label: '简体中文' },
  { value: 'hi', label: 'हिन्दी' },
];
const STORAGE_KEY = 'ghostsignal-language-v1';

export function isLocale(value: unknown): value is Locale {
  return LANGUAGES.some(language => language.value === value);
}

export function translate(source: string, locale: Locale = 'en', params: TranslationParams = {}): string {
  const template = locale === 'en' ? source : translations[source]?.[locale] ?? source;
  return template.replace(/\{(\w+)\}/g, (match, key: string) => Object.hasOwn(params, key) ? String(params[key]) : match);
}

type I18n = { locale: Locale; setLocale: (locale: Locale) => void; t: (source: string, params?: TranslationParams) => string };
const Context = createContext<I18n>({ locale: 'en', setLocale: () => {}, t: (source, params) => translate(source, 'en', params) });

function readLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isLocale(saved)) return saved;
  } catch { /* Language selection still works when storage is unavailable. */ }
  return 'en';
}

export function I18nProvider({ children, initialLocale }: { children: ReactNode; initialLocale?: Locale }) {
  const [locale, setLocale] = useState<Locale>(() => initialLocale ?? readLocale());
  useEffect(() => {
    document.documentElement.lang = locale;
    try { localStorage.setItem(STORAGE_KEY, locale); } catch { /* Optional preference storage. */ }
  }, [locale]);
  const value = useMemo<I18n>(() => ({ locale, setLocale, t: (source, params) => translate(source, locale, params) }), [locale]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useI18n() { return useContext(Context); }

export function LanguagePicker() {
  const { locale, setLocale, t } = useI18n();
  return <label className="language-picker"><span>{t('Language')}</span><select value={locale} onChange={event => { if (isLocale(event.target.value)) setLocale(event.target.value); }} aria-label={t('Language')}>
    {LANGUAGES.map(language => <option key={language.value} value={language.value} lang={language.value}>{language.label}</option>)}
  </select></label>;
}

export function SettingsButton() {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  return <>
    <button type="button" className="settings-trigger" aria-label={t('Settings')} aria-haspopup="dialog" onClick={() => dialog.current?.showModal()}>
      <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m9 3-1 3-3 1-2 4 2 2v3l4 3 3-1 3 1 4-3v-3l2-2-2-4-3-1-1-3Z" strokeLinejoin="round"/><circle cx="12" cy="11.5" r="3"/></svg>
      <span>{t('Settings')}</span>
    </button>
    <dialog ref={dialog} className="settings-dialog" aria-labelledby={titleId} onClick={event => { if (event.target === dialog.current) dialog.current?.close(); }}>
      <div className="settings-content">
        <div className="settings-heading"><h2 id={titleId}>{t('Settings')}</h2><button type="button" className="settings-close" aria-label={t('Close settings')} onClick={() => dialog.current?.close()}>×</button></div>
        <p>{t('Choose your display language.')}</p>
        <LanguagePicker />
      </div>
    </dialog>
  </>;
}
