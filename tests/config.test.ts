import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config/env.js';

const valid = {
  DATABASE_URL: 'postgresql://user:s3cretPassw0rd@db.example.com:5432/app',
  PUBLIC_SITE_URL: 'https://allovity.example',
  ADMIN_PATH_SLUG: 'k3x9Qm7vT2pLw8Zr4NbY',
};

function failure(env: Record<string, string | undefined>): ConfigError {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error('expected loadConfig to throw');
}

describe('configuration validation', () => {
  it('loads a valid configuration with documented defaults', () => {
    const { config, warnings } = loadConfig(valid);
    expect(config.port).toBe(3000);
    expect(config.runMigrations).toBe(true);
    expect(config.trustedProxyHops).toBe(0);
    expect(config.publicSiteUrl).toBe('https://allovity.example');
    expect(warnings).toEqual([]);
  });

  for (const name of ['DATABASE_URL', 'PUBLIC_SITE_URL', 'ADMIN_PATH_SLUG']) {
    it(`stops startup naming ${name} when it is missing`, () => {
      const env: Record<string, string | undefined> = { ...valid, [name]: undefined };
      const error = failure(env);
      expect(error.message).toContain(name);
      expect(error.issues).toHaveLength(1);
    });
  }

  it('reports every problem at once', () => {
    expect(failure({}).issues).toHaveLength(3);
  });

  it('rejects a slug shorter than 16 characters or with unsafe characters', () => {
    expect(failure({ ...valid, ADMIN_PATH_SLUG: 'short' }).message).toContain('ADMIN_PATH_SLUG');
    expect(failure({ ...valid, ADMIN_PATH_SLUG: 'has spaces and/slashes!!' }).message).toContain(
      'ADMIN_PATH_SLUG',
    );
  });

  it('rejects the example placeholder slug', () => {
    expect(
      failure({ ...valid, ADMIN_PATH_SLUG: 'replace-with-a-long-random-value' }).message,
    ).toContain('placeholder');
  });

  it('rejects a site address that is not absolute http(s)', () => {
    expect(failure({ ...valid, PUBLIC_SITE_URL: 'allovity.example' }).message).toContain(
      'PUBLIC_SITE_URL',
    );
    expect(failure({ ...valid, PUBLIC_SITE_URL: 'ftp://allovity.example' }).message).toContain(
      'PUBLIC_SITE_URL',
    );
  });

  it('never prints secret values in error messages', () => {
    const bad = {
      DATABASE_URL: 'mysql://user:s3cretPassw0rd@db.example.com/app',
      PUBLIC_SITE_URL: 'nope',
      ADMIN_PATH_SLUG: 'tiny-SECRETVALUE',
    };
    const message = failure(bad).message;
    expect(message).not.toContain('s3cretPassw0rd');
    expect(message).not.toContain('SECRETVALUE');
    expect(message).not.toContain('db.example.com');
  });

  it('warns, and does not crash, for weak or odd optional settings', () => {
    const { config, warnings } = loadConfig({
      ...valid,
      PORT: 'abc',
      LOG_LEVEL: 'loud',
      TRUSTED_PROXY_HOPS: '-3',
      RUN_MIGRATIONS: 'maybe',
      DB_POOL_MAX: '0',
    });
    expect(config.port).toBe(3000);
    expect(config.logLevel).toBe('info');
    expect(config.trustedProxyHops).toBe(0);
    expect(config.runMigrations).toBe(true);
    expect(warnings.length).toBeGreaterThanOrEqual(5);
    for (const name of [
      'PORT',
      'LOG_LEVEL',
      'TRUSTED_PROXY_HOPS',
      'RUN_MIGRATIONS',
      'DB_POOL_MAX',
    ]) {
      expect(warnings.some((warning) => warning.startsWith(name))).toBe(true);
    }
  });

  it('warns about production settings that are risky', () => {
    const { warnings } = loadConfig({
      ...valid,
      NODE_ENV: 'production',
      PUBLIC_SITE_URL: 'http://allovity.example',
      DATABASE_SSL: 'disable',
    });
    expect(warnings.join(' ')).toContain('TRUSTED_PROXY_HOPS');
    expect(warnings.join(' ')).toContain('http in production');
    expect(warnings.join(' ')).toContain('DATABASE_SSL');
  });

  it('allows migrations to be switched off', () => {
    expect(loadConfig({ ...valid, RUN_MIGRATIONS: 'false' }).config.runMigrations).toBe(false);
  });
});
