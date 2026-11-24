import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { palette } = require('../tailwind.theme.cjs') as {
  palette: Record<'dark' | 'light', Record<string, string>>;
};

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return (
    0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
  );
}
export function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

// [foreground, background, minimum ratio, description]
const pairs: Array<[string, string, number, string]> = [
  ['fg', 'bg', 4.5, 'body text on page'],
  ['fg', 'surface', 4.5, 'body text on surface'],
  ['fg', 'raised', 4.5, 'text on raised surface'],
  ['muted', 'bg', 4.5, 'muted text on page'],
  ['muted', 'surface', 4.5, 'muted text on surface'],
  ['muted', 'raised', 4.5, 'muted text on raised surface'],
  ['link', 'bg', 4.5, 'link text on page'],
  ['link', 'surface', 4.5, 'link text on surface'],
  ['primary-fg', 'primary', 4.5, 'button text on primary'],
  ['primary-fg', 'primary-hover', 4.5, 'button text on primary hover'],
  ['success', 'bg', 4.5, 'success text on page'],
  ['success', 'surface', 4.5, 'success text on surface'],
  ['warning', 'bg', 4.5, 'warning text on page'],
  ['warning', 'surface', 4.5, 'warning text on surface'],
  ['danger', 'bg', 4.5, 'danger text on page'],
  ['danger', 'surface', 4.5, 'danger text on surface'],
  ['line-strong', 'bg', 3, 'control border on page'],
  ['line-strong', 'surface', 3, 'control border on surface'],
  ['primary', 'bg', 3, 'brand symbol on page'],
];

describe('WCAG 2.2 AA contrast', () => {
  for (const theme of ['dark', 'light'] as const) {
    for (const [fg, bg, min, label] of pairs) {
      it(`${theme}: ${label} is at least ${min}:1`, () => {
        const value = ratio(palette[theme][fg] as string, palette[theme][bg] as string);
        expect(value, `${fg} on ${bg} = ${value.toFixed(2)}`).toBeGreaterThanOrEqual(min);
      });
    }
  }
});
