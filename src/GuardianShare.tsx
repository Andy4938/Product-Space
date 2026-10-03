import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { useI18n } from './i18n';
import { buildGuardianLink, classifyGuardianOrigin } from './guardian-link';

export type GuardianShareProps = {
  origin: string;
  sessionId: string;
  guardianToken: string;
  variant?: 'inline' | 'dialog';
  onClose?: () => void;
};

function GuardianShareContent({ origin, sessionId, guardianToken }: Omit<GuardianShareProps, 'variant' | 'onClose'>) {
  const { t } = useI18n();
  const link = buildGuardianLink(origin, sessionId, guardianToken);
  const originKind = classifyGuardianOrigin(origin);
  const [qr, setQr] = useState<string | null>(null);
  const [qrFailed, setQrFailed] = useState(false);
  const [copyStatus, setCopyStatus] = useState('');
  const [shareStatus, setShareStatus] = useState('');

  useEffect(() => {
    setQr(null);
    setQrFailed(false);
    if (originKind === 'loopback') return;
    let current = true;
    void QRCode.toDataURL(link, { errorCorrectionLevel: 'M', margin: 2, width: 232 })
      .then(data => { if (current) setQr(data); })
      .catch(() => { if (current) setQrFailed(true); });
    return () => { current = false; };
  }, [link, originKind]);

  const copy = async () => {
    setCopyStatus('');
    setShareStatus('');
    try {
      await navigator.clipboard.writeText(link);
      setCopyStatus('Link copied');
    } catch { setCopyStatus('Could not copy. Select the link above and copy it.'); }
  };

  const share = async () => {
    if (!navigator.share) return;
    setCopyStatus('');
    setShareStatus('');
    try { await navigator.share({ title: t('Follow my walk'), text: t('You can follow my walk here:'), url: link }); }
    catch (cause) { if (!(cause instanceof DOMException && cause.name === 'AbortError')) setShareStatus('Sharing unavailable. Copy the link instead.'); }
  };

  return <div className="guardian-share">
    <p className="guardian-share-intro">{t('Open this full private link on your friend’s phone. No account or new walk is needed.')}</p>
    <div className="guardian-share-url-label">{t('Friend’s phone link')}</div>
    <textarea className="guardian-share-url" aria-label={t('Friend’s phone link')} readOnly rows={Math.max(3, Math.ceil(link.length / 32))} value={link} onFocus={event => event.currentTarget.select()} />
    <div className="guardian-share-actions">
      <button type="button" className="guardian-share-primary" onClick={() => void copy()}>{t('Copy link')}</button>
      {typeof navigator !== 'undefined' && typeof navigator.share === 'function' && <button type="button" className="guardian-share-secondary" onClick={() => void share()}>{t('Share with your phone')}</button>}
    </div>
    {(copyStatus || shareStatus) && <p className="guardian-share-feedback" role="status">{t(copyStatus || shareStatus)}</p>}
    {originKind === 'loopback' && <p className="guardian-share-warning" role="note">{t('This localhost link works only on this device. Open PhanTomSignal from a public HTTPS address before sharing with another phone.')}</p>}
    {originKind === 'private-network' && <p className="guardian-share-warning" role="note">{t('On a private network, both phones need the same Wi-Fi. Live GPS on the walker’s phone also needs HTTPS.')}</p>}
    {originKind === 'other' && <p className="guardian-share-warning" role="note">{t('Live GPS on the walker’s phone needs HTTPS.')}</p>}
    {originKind !== 'loopback' && <div className="guardian-share-qr">
      {qr ? <><img src={qr} alt={t('Scan on another phone')} width="232" height="232" /><span>{t('Scan on another phone')}</span></> : qrFailed ? <p>{t('QR code unavailable. Copy the link instead.')}</p> : <p>{t('Preparing QR code…')}</p>}
    </div>}
    <p className="guardian-share-privacy">{t('Anyone with this link can see your walk. Share it only with someone you trust.')}</p>
  </div>;
}

export function GuardianShare({ origin, sessionId, guardianToken, variant = 'inline', onClose }: GuardianShareProps) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (variant !== 'dialog') return;
    if (!dialog.current?.open) dialog.current?.showModal();
  }, [variant]);

  if (variant === 'dialog') return <dialog ref={dialog} className="guardian-share-dialog" aria-label={t('Private guardian link')} onClose={() => { if (!dialog.current?.open) onClose?.(); }}>
    <div className="guardian-share-dialog-head"><h2>{t('Private guardian link')}</h2><button type="button" aria-label={t('Close guardian sharing')} onClick={() => dialog.current?.close()}>×</button></div>
    <GuardianShareContent origin={origin} sessionId={sessionId} guardianToken={guardianToken} />
  </dialog>;
  return <section className="guardian-share-panel" aria-label={t('Private guardian link')}><GuardianShareContent origin={origin} sessionId={sessionId} guardianToken={guardianToken} /></section>;
}
