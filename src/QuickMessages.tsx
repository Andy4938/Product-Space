import { useRef, useState } from 'react';
import type { IncidentMessage } from './api-types';
import { useI18n } from './i18n';
import { newClientMessageId, PRESET_MESSAGES, type PresetMessageId } from './preset-messages';

export type QuickMessagesProps = {
  mode: 'prepare' | 'incident';
  selectedId: PresetMessageId | null;
  onSelect: (id: PresetMessageId | null) => void;
  onSend?: (id: PresetMessageId, clientMessageId: string) => Promise<void>;
  sent?: IncidentMessage[];
  disabled?: boolean;
};

export function ReceivedMessages({ messages, audience = 'walker' }: { messages: IncidentMessage[]; audience?: 'walker' | 'guardian' }) {
  const { t, locale } = useI18n();
  if (!messages.length) return null;
  return <section className="received-messages" aria-label={t('Received quick messages')}>
    <strong className="quick-kicker">{audience === 'walker' ? t('RECEIVED BY CAMPUS SAFETY') : t('QUICK MESSAGES FROM THE WALKER')}</strong>
    <ol>{messages.map(message => {
      const preset = PRESET_MESSAGES.find(option => option.id === message.presetId);
      return <li key={message.id}><span>{preset ? t(preset.en) : t('Message unavailable')}</span><time dateTime={message.sentAt}>{new Date(message.sentAt).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })}</time></li>;
    })}</ol>
  </section>;
}

export function QuickMessages({ mode, selectedId, onSelect, onSend, sent = [], disabled = false }: QuickMessagesProps) {
  const { t } = useI18n();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const retry = useRef<{ presetId: PresetMessageId; clientMessageId: string } | null>(null);

  const choose = (id: PresetMessageId) => {
    if (disabled || sending) return;
    onSelect(selectedId === id ? null : id);
    retry.current = null;
    setError(null);
  };

  const send = async () => {
    if (!selectedId || !onSend || disabled || sending) return;
    setSending(true); setError(null);
    try {
      const attempt = retry.current?.presetId === selectedId
        ? retry.current
        : { presetId: selectedId, clientMessageId: newClientMessageId() };
      retry.current = attempt;
      await onSend(attempt.presetId, attempt.clientMessageId);
      retry.current = null;
      onSelect(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Message not confirmed. Retry to send it.');
    } finally { setSending(false); }
  };

  return <section className={`quick-messages ${mode}`} aria-label={mode === 'prepare' ? t('Optional message before help') : t('Quick messages to Campus Safety')}>
    <div className="quick-head"><strong>{mode === 'prepare' ? t('Say it without speaking') : t('Send a quick message')}</strong><p>{mode === 'prepare' ? t('Optional. Select one before sending help. Selecting a message alone does not alert anyone.') : t('Choose a short message and tap Send. No call or conversation is needed.')}</p></div>
    <div className="quick-options" role="group" aria-label={t('Choose a quick message')}>
      {PRESET_MESSAGES.map(option => <button key={option.id} type="button" className={selectedId === option.id ? 'selected' : ''} aria-pressed={selectedId === option.id} disabled={disabled || sending} onClick={() => choose(option.id)}>{t(option.en)}<span aria-hidden="true">{selectedId === option.id ? '✓' : '+'}</span></button>)}
    </div>
    {mode === 'incident' && <div className="quick-send-row"><button type="button" className="quick-send" disabled={!selectedId || !onSend || disabled || sending} onClick={() => void send()}>{sending ? t('Sending…') : error ? t('Retry send') : t('Send message')}</button><span>{t('Only a server-confirmed message appears below.')}</span></div>}
    {error && <p className="quick-error" role="alert">{t('Message not confirmed.')} {t(error)}</p>}
    {mode === 'incident' && <ReceivedMessages messages={sent} />}
  </section>;
}
