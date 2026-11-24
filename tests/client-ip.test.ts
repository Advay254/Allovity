import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { getClientIp, normalizeIp, rateLimitKey } from '../src/lib/client-ip.js';
import express from 'express';

function appWithHops(hops: number) {
  const app = express();
  app.set('trust proxy', hops);
  app.get('/', (req, res) => {
    res.json({ ip: getClientIp(req) });
  });
  return app;
}

describe('client IP helper', () => {
  it('ignores forwarding headers when no proxy is trusted', async () => {
    const res = await request(appWithHops(0)).get('/').set('X-Forwarded-For', '203.0.113.9');
    expect(res.body.ip).toBe('127.0.0.1');
  });

  it('trusts only the hops it is told to trust', async () => {
    const res = await request(appWithHops(1))
      .get('/')
      .set('X-Forwarded-For', '1.1.1.1, 198.51.100.7');
    expect(res.body.ip).toBe('198.51.100.7');
  });

  it('cannot be spoofed by a client-supplied leftmost entry', async () => {
    const res = await request(appWithHops(1))
      .get('/')
      .set('X-Forwarded-For', '6.6.6.6, 6.6.6.6, 198.51.100.7');
    expect(res.body.ip).toBe('198.51.100.7');
  });

  it('normalises addresses and rejects junk', () => {
    expect(normalizeIp('::ffff:192.0.2.1')).toBe('192.0.2.1');
    expect(normalizeIp('fe80::1%eth0')).toBe('fe80::1');
    expect(normalizeIp('not-an-ip')).toBe('unknown');
    expect(normalizeIp(undefined)).toBe('unknown');
  });

  it('groups IPv6 clients by /64 for rate limiting', () => {
    expect(rateLimitKey('2001:db8:1:2:aaaa::1')).toBe(rateLimitKey('2001:db8:1:2:bbbb::9'));
    expect(rateLimitKey('2001:db8:1:2::1')).not.toBe(rateLimitKey('2001:db8:1:3::1'));
    expect(rateLimitKey('192.0.2.5')).toBe('192.0.2.5');
  });
});
