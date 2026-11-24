import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT_DIR } from '../src/lib/paths.js';

const SKIP = new Set(['node_modules', 'dist', 'build', '.git', 'package-lock.json']);
const TEXT = new Set([
  '.ts',
  '.js',
  '.cjs',
  '.mjs',
  '.ejs',
  '.css',
  '.md',
  '.json',
  '.sql',
  '.yaml',
  '.yml',
  '.svg',
  '.example',
  '',
]);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (SKIP.has(name)) return [];
    const full = join(dir, name);
    return statSync(full).isDirectory() ? files(full) : [full];
  });
}

describe('copy rules', () => {
  const all = files(ROOT_DIR).filter((f) => TEXT.has(extname(f)) && !f.endsWith('copy.test.ts'));

  it('uses no em dashes or en dashes anywhere in the project', () => {
    const offenders = all.filter((f) => /[\u2013\u2014]/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('uses no emoji anywhere in the project', () => {
    const offenders = all.filter((f) => /\p{Extended_Pictographic}/u.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
