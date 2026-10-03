import { useEffect, useState, type ReactNode } from 'react';
import type { LocationPoint } from './api-types';
import { translate, type Locale } from './i18n';

export const CAMPUS_CENTER: [number, number] = [40.1077, -88.2274];

export type IconName = 'signal' | 'arrow' | 'pin' | 'shield' | 'link' | 'check' | 'alert' | 'eye' | 'clock' | 'x' | 'heart' | 'external'
  | 'phone' | 'bell' | 'radio' | 'user' | 'copy' | 'note';

export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true as const };
  const paths: Record<IconName, ReactNode> = {
    signal: <><path d="M3 16.5c4.5-6 13.5-6 18 0" /><path d="M6.5 19c3-4 8-4 11 0" /><circle cx="12" cy="21" r=".6" fill="currentColor" stroke="none" /></>,
    arrow: <><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></>,
    pin: <><path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z" /><circle cx="12" cy="10" r="2.5" /></>,
    shield: <><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" /><path d="m9 12 2 2 4-4" /></>,
    link: <><path d="M10 13a5 5 0 0 0 7.1 0l2-2A5 5 0 0 0 12 3.9l-1.2 1.2" /><path d="M14 11a5 5 0 0 0-7.1 0l-2 2A5 5 0 0 0 12 20.1l1.2-1.2" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    alert: <><path d="M12 3 2 21h20L12 3Z" /><path d="M12 9v5" /><path d="M12 17.5h.01" /></>,
    eye: <><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z" /><circle cx="12" cy="12" r="2.5" /></>,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    x: <><path d="M5 5l14 14" /><path d="M19 5 5 19" /></>,
    heart: <path d="M20.8 8.6c0 4.8-8.8 10.4-8.8 10.4S3.2 13.4 3.2 8.6a4.8 4.8 0 0 1 8.8-2.5 4.8 4.8 0 0 1 8.8 2.5Z" />,
    external: <><path d="M13 5h6v6" /><path d="m19 5-9 9" /><path d="M19 13v6H5V5h6" /></>,
    phone: <path d="M5 3h4l2 5-2.5 1.5a11 11 0 0 0 6 6L16 13l5 2v4a2 2 0 0 1-2 2A17 17 0 0 1 3 5a2 2 0 0 1 2-2Z" />,
    bell: <><path d="M6 16V11a6 6 0 1 1 12 0v5l2 2H4l2-2Z" /><path d="M10 21h4" /></>,
    radio: <><circle cx="12" cy="12" r="2" /><path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4" /><path d="M4.9 4.9a10 10 0 0 0 0 14.2M19.1 4.9a10 10 0 0 1 0 14.2" /></>,
    user: <><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>,
    copy: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" /></>,
    note: <><path d="M5 3h10l4 4v14H5Z" /><path d="M9 12h6M9 16h6" /></>,
  };
  return <svg {...common}>{paths[name]}</svg>;
}

export function Brand() {
  return <div className="brand"><span className="brand-mark"><span /></span><span>Ghost<span className="brand-light">Signal</span></span></div>;
}

export function relativeTime(date: string | null | undefined, now: number, locale: Locale = 'en') {
  const t = (source: string, params?: Record<string, string | number>) => translate(source, locale, params);
  if (!date) return t('No update yet');
  const seconds = Math.max(0, Math.floor((now - Date.parse(date)) / 1000));
  if (!Number.isFinite(seconds)) return t('Time unknown');
  if (seconds < 5) return t('Just now');
  if (seconds < 60) return t('{count}s ago', { count: seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t('{count}m ago', { count: minutes });
  return t('{count}h ago', { count: Math.floor(minutes / 60) });
}

export function elapsed(from: string, now: number, _locale: Locale = 'en') {
  const total = Math.max(0, Math.floor((now - Date.parse(from)) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

export function clockTime(date: string, locale: Locale = 'en') {
  return new Date(date).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
}

export function locationHealth(location: LocationPoint | null | undefined, now: number, locale: Locale = 'en') {
  if (!location) return { level: 'waiting', label: translate('Waiting for first location', locale) };
  const age = now - Date.parse(location.recordedAt);
  if (age > 60_000) return { level: 'stale', label: translate('Location is stale', locale) };
  if (age > 15_000) return { level: 'delayed', label: translate('Location is delayed', locale) };
  return { level: 'fresh', label: translate('Location updating', locale) };
}

export function metersBetween(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) {
  const rad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * rad;
  const dLon = (b.longitude - a.longitude) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

// Describes received data only; it never claims the walker is safe.
export function movementSummary(location: LocationPoint | null, trail: LocationPoint[], locale: Locale = 'en') {
  if (!location) return translate('No position received yet', locale);
  const latestTime = Date.parse(location.recordedAt);
  const earlier = [...trail].reverse().find(point => latestTime - Date.parse(point.recordedAt) >= 60_000);
  if (!earlier) return translate('Not enough updates yet to tell movement', locale);
  return translate(metersBetween(earlier, location) > Math.max(25, location.accuracy) ? 'Moving over the last minute' : 'Little or no movement over the last minute', locale);
}

export function accuracyLabel(accuracy: number, locale: Locale = 'en') {
  const meters = `±${Math.round(accuracy)} m`;
  if (accuracy <= 20) return translate('Good ({meters})', locale, { meters });
  if (accuracy <= 60) return translate('Fair ({meters})', locale, { meters });
  return translate('Poor ({meters})', locale, { meters });
}

export function mapLink(point: { latitude: number; longitude: number }) {
  const lat = point.latitude.toFixed(5);
  const lon = point.longitude.toFixed(5);
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=18/${lat}/${lon}`;
}

export function useNow() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  return now;
}

export function playTones(context: AudioContext | null, count: number, frequency: number) {
  if (!context || context.state !== 'running') return;
  for (let index = 0; index < count; index++) {
    const start = context.currentTime + index * 0.35;
    const tone = context.createOscillator();
    const gain = context.createGain();
    tone.frequency.value = frequency;
    gain.gain.setValueAtTime(0.2, start);
    gain.gain.exponentialRampToValueAtTime(0.001, start + 0.25);
    tone.connect(gain).connect(context.destination);
    tone.start(start); tone.stop(start + 0.25);
  }
}
