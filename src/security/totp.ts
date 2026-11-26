import { Secret, TOTP } from 'otpauth';
import QRCode from 'qrcode';

export const TOTP_PERIOD = 30;
export const TOTP_DIGITS = 6;
/** Accept the previous and next 30 second step to allow for clock drift. */
export const TOTP_WINDOW = 1;

function build(secretBase32: string, label: string, issuer: string): TOTP {
  return new TOTP({
    issuer,
    label,
    algorithm: 'SHA1',
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD,
    secret: Secret.fromBase32(secretBase32),
  });
}

export function generateSecretBase32(): string {
  return new Secret({ size: 20 }).base32;
}

export function otpauthUri(secretBase32: string, label: string, issuer: string): string {
  return build(secretBase32, label, issuer).toString();
}

/** Current code for a secret. Used by tests and by the setup check. */
export function codeAt(secretBase32: string, timestampMs: number): string {
  return build(secretBase32, 'x', 'x').generate({ timestamp: timestampMs });
}

/**
 * Checks a six digit code. Returns the time step that matched so the caller can
 * refuse the same step twice, or null when the code is wrong.
 */
export function matchStep(
  secretBase32: string,
  code: string,
  nowMs: number = Date.now(),
): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const delta = build(secretBase32, 'x', 'x').validate({
    token: code,
    timestamp: nowMs,
    window: TOTP_WINDOW,
  });
  if (delta === null) return null;
  return Math.floor(nowMs / 1000 / TOTP_PERIOD) + delta;
}

/** Renders the QR code on the server as inline SVG markup, so no script or data address is needed. */
export async function qrSvg(uri: string): Promise<string> {
  return QRCode.toString(uri, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
}

/** Groups a base32 key for easier manual entry. */
export function groupKey(secretBase32: string): string {
  return secretBase32.replace(/(.{4})/g, '$1 ').trim();
}
