// Stable wire IDs. Interfaces translate these labels; the server stores IDs only.
export const PRESET_MESSAGES = [
  { id: 'being_followed', en: 'I think someone is following me' },
  { id: 'cannot_talk', en: 'I cannot speak right now' },
  { id: 'need_medical_help', en: 'I need medical help' },
  { id: 'need_escort', en: 'Please send someone to meet me' },
] as const;

export type PresetMessageId = (typeof PRESET_MESSAGES)[number]['id'];

export function isPresetMessageId(value: unknown): value is PresetMessageId {
  return typeof value === 'string' && PRESET_MESSAGES.some((message) => message.id === value);
}

export function newClientMessageId(): string {
  const random = globalThis.crypto;
  if (!random) throw new Error('Secure message IDs are unavailable.');
  if (typeof random.randomUUID === 'function') return random.randomUUID();
  const bytes = random.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
