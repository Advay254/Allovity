import type { Request, Response } from 'express';
import { describeWait } from '../../admin/limits.js';
import type { ReauthResult } from '../../admin/auth.js';

/** Reads a form field as a bounded string. Anything that is not a string becomes empty. */
export function field(req: Request, name: string, max = 500): string {
  const value = (req.body as Record<string, unknown> | undefined)?.[name];
  return typeof value === 'string' ? value.slice(0, max) : '';
}

export interface FormState {
  values: Record<string, string>;
  errors: Record<string, string>;
}

export const emptyForm = (): FormState => ({ values: {}, errors: {} });

export function throttleMessage(seconds: number): string {
  return `Too many attempts. Try again in ${describeWait(seconds)}.`;
}

/** Turns a failed re-entry of the password into a status code and a field error. */
export function reauthFailure(
  res: Response,
  result: Exclude<ReauthResult, { kind: 'ok' }>,
): { status: number; message: string } {
  if (result.kind === 'throttled') {
    res.setHeader('Retry-After', String(result.retryAfterSeconds));
    return { status: 429, message: throttleMessage(result.retryAfterSeconds) };
  }
  return { status: 401, message: 'That password is not correct.' };
}

const FLASH: Record<string, string> = {
  password: 'Your password was changed. Your other sessions were signed out.',
  'two-step-disabled': 'Two-step verification was turned off.',
  'session-revoked': 'That session was signed out.',
  'others-revoked': 'Your other sessions were signed out.',
  created: 'The account was created. They must change the temporary password at first sign-in.',
  role: 'The role was changed. Their sessions were signed out.',
  deactivated: 'The account was deactivated and its sessions were signed out.',
  reactivated: 'The account was reactivated.',
  'two-step-reset': 'Two-step verification was reset. Their sessions were signed out.',
};

/** Success messages come from a fixed list, never from the query string itself. */
export function flashFrom(req: Request): string | null {
  const key = typeof req.query.done === 'string' ? req.query.done : '';
  return FLASH[key] ?? null;
}
