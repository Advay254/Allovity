import net from 'node:net';
import type { Request } from 'express';

/**
 * Normalises an address string: strips IPv6 zone ids, unwraps IPv4-mapped IPv6
 * and lowercases. Returns "unknown" for anything that is not an IP address.
 */
export function normalizeIp(raw: string | undefined): string {
  if (!raw) return 'unknown';
  let value = raw.trim().toLowerCase();
  const zone = value.indexOf('%');
  if (zone !== -1) value = value.slice(0, zone);
  if (value.startsWith('::ffff:') && net.isIPv4(value.slice(7))) value = value.slice(7);
  return net.isIP(value) === 0 ? 'unknown' : value;
}

/**
 * The one place that decides who the client is. Express derives req.ip from the
 * "trust proxy" setting, which the app sets from TRUSTED_PROXY_HOPS. With 0 hops
 * forwarding headers are ignored entirely, so they cannot be used to spoof an IP.
 */
export function getClientIp(req: Pick<Request, 'ip' | 'socket'>): string {
  return normalizeIp(req.ip ?? req.socket?.remoteAddress);
}

/** Expands an IPv6 address into eight 16-bit groups. */
function expandIpv6(ip: string): number[] {
  const [head = '', tail = ''] = ip.split('::');
  const headParts = head ? head.split(':') : [];
  const tailParts = tail ? tail.split(':') : [];
  const missing = ip.includes('::') ? 8 - headParts.length - tailParts.length : 0;
  const parts = [...headParts, ...Array<string>(Math.max(missing, 0)).fill('0'), ...tailParts];
  return parts.map((part) => parseInt(part || '0', 16));
}

/**
 * Key used for rate limiting. IPv6 clients are grouped by /64 so one network
 * cannot dodge the limit by rotating through addresses inside its own prefix.
 */
export function rateLimitKey(ip: string): string {
  if (net.isIPv6(ip)) {
    return `v6:${expandIpv6(ip)
      .slice(0, 4)
      .map((group) => group.toString(16))
      .join(':')}`;
  }
  return ip;
}
