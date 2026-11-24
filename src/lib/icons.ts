import { ICON_BODIES, type IconName } from './icon-data.js';

export type { IconName };

/**
 * Returns inline SVG markup for a Lucide icon. Names come from a fixed list in
 * code (icon-data.ts), never from user input, so the output is safe to print raw.
 */
export function icon(name: IconName, className = ''): string {
  const body = ICON_BODIES[name];
  if (!body) throw new Error(`Unknown icon: ${String(name)}`);
  const cls = className.replace(/[^A-Za-z0-9 _:./[\]-]/g, '');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="${cls}" aria-hidden="true" focusable="false">${body}</svg>`;
}
