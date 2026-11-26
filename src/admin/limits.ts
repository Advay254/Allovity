import { rateLimitKey } from '../lib/client-ip.js';
import { hmacHex } from '../security/crypto.js';
import { secondsUntilBelow } from '../security/rate-limit-store.js';
import type { AdminServices } from './services.js';

/** Per-account and per-network limits are looser than the per-pair limit (see docs). */
const WIDE_MULTIPLIER = 4;
/** Each throttled attempt adds a minute of delay, up to three minutes. */
const ESCALATION_STEP_SECONDS = 60;
const ESCALATION_MAX_STEPS = 3;

/** A short stable identifier for an email, so raw emails never become storage keys or log fields. */
export function accountId(svc: AdminServices, email: string): string {
  return hmacHex(svc.keys.identifier, `email|${email}`).slice(0, 32);
}

export interface LimitKeys {
  pair: string;
  account: string;
  network: string;
  escalation: string;
}

export function signInKeys(
  svc: AdminServices,
  email: string,
  ip: string,
  scope: string,
): LimitKeys {
  const id = accountId(svc, email);
  const net = rateLimitKey(ip);
  return {
    pair: `adm:${scope}:pair:${id}:${net}`,
    account: `adm:${scope}:acct:${id}`,
    network: `adm:${scope}:net:${net}`,
    escalation: `adm:${scope}:esc:${id}:${net}`,
  };
}

export type LimitState =
  { blocked: false } | { blocked: true; retryAfterSeconds: number; firstBlock: boolean };

/**
 * Reads the three failure counters without counting anything. If any is at its limit the
 * attempt is blocked: no password is checked and the wait time is returned. The wait is
 * how long until the sliding count falls below the limit, plus a small escalation for
 * people who keep trying while blocked. It always ends: nobody is locked out for good.
 */
export async function checkFailureLimits(svc: AdminServices, keys: LimitKeys): Promise<LimitState> {
  const { loginMaxFailures: max, loginWindowMs: windowMs } = svc.config.admin;
  const now = svc.now();
  const peek = (key: string) => svc.store.peek?.(key, windowMs, now);
  const [pair, account, network] = await Promise.all([
    peek(keys.pair),
    peek(keys.account),
    peek(keys.network),
  ]);
  const checks: Array<[typeof pair, number]> = [
    [pair, max],
    [account, max * WIDE_MULTIPLIER],
    [network, max * WIDE_MULTIPLIER],
  ];
  let wait = 0;
  for (const [hit, limit] of checks) {
    if (hit && hit.count >= limit) {
      wait = Math.max(wait, secondsUntilBelow(hit, limit, windowMs, now));
    }
  }
  if (wait === 0) return { blocked: false };

  const escalation = await svc.store.increment(keys.escalation, windowMs, now);
  const steps = Math.min(Math.max(escalation.count - 1, 0), ESCALATION_MAX_STEPS);
  return {
    blocked: true,
    retryAfterSeconds: Math.max(1, wait + steps * ESCALATION_STEP_SECONDS),
    firstBlock: escalation.count === 1,
  };
}

export async function recordFailure(svc: AdminServices, keys: LimitKeys): Promise<void> {
  const { loginWindowMs: windowMs } = svc.config.admin;
  const now = svc.now();
  await Promise.all([
    svc.store.increment(keys.pair, windowMs, now),
    svc.store.increment(keys.account, windowMs, now),
    svc.store.increment(keys.network, windowMs, now),
  ]);
}

/** Formats a wait as "2 minutes" or "45 seconds" for the person waiting. */
export function describeWait(seconds: number): string {
  if (seconds < 90) return `${Math.max(1, seconds)} ${seconds === 1 ? 'second' : 'seconds'}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minutes`;
}
