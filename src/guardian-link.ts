export type GuardianOriginKind = 'loopback' | 'private-network' | 'public-https' | 'other';

function ipv4Parts(hostname: string): number[] | null {
  const parts = hostname.split('.');
  if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part))) return null;
  const octets = parts.map(Number);
  return octets.every(part => part >= 0 && part <= 255) ? octets : null;
}

export function classifyGuardianOrigin(origin: string): GuardianOriginKind {
  const url = new URL(origin);
  const host = url.hostname.toLowerCase();
  const ipv4 = ipv4Parts(host);
  if (host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || host === '[::]' || host === '0.0.0.0' || (ipv4 && ipv4[0] === 127)) return 'loopback';
  if (host.endsWith('.local') || host.startsWith('[fc') || host.startsWith('[fd') || /^\[fe[89ab]/.test(host) ||
    (ipv4 && (ipv4[0] === 10 || (ipv4[0] === 172 && ipv4[1] >= 16 && ipv4[1] <= 31) ||
      (ipv4[0] === 192 && ipv4[1] === 168) || (ipv4[0] === 169 && ipv4[1] === 254)))) return 'private-network';
  return url.protocol === 'https:' ? 'public-https' : 'other';
}

export function buildGuardianLink(origin: string, sessionId: string, guardianToken: string): string {
  const site = new URL(origin);
  if (site.protocol !== 'https:' && site.protocol !== 'http:') throw new Error('Guardian links require a web address.');
  return `${site.origin}/watch/${encodeURIComponent(sessionId)}#${encodeURIComponent(guardianToken)}`;
}
