import type { Server } from 'node:http';
import type pg from 'pg';
import { createApp } from './app.js';
import { ConfigError, loadConfig, type AppConfig } from './config/env.js';
import { createPool } from './db/pool.js';
import { runMigrations } from './db/migrate.js';
import { createLogger, type Logger } from './lib/logger.js';
import { MIGRATIONS_DIR } from './lib/paths.js';
import { MemoryRateLimitStore } from './security/rate-limit-store.js';

const CONNECT_ATTEMPTS = 5;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A database that is still starting is common right after a deploy, so retry briefly. */
async function migrateWithRetry(pool: pg.Pool, logger: Logger): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await runMigrations(pool, { dir: MIGRATIONS_DIR, logger });
      return;
    } catch (error) {
      const isConnectionProblem = (error as { name?: string }).name !== 'MigrationError';
      if (!isConnectionProblem || attempt >= CONNECT_ATTEMPTS) throw error;
      logger.warn('Database not reachable yet, retrying', { attempt });
      await sleep(attempt * 2000);
    }
  }
}

async function main(): Promise<void> {
  let config: AppConfig;
  let warnings: string[];
  try {
    ({ config, warnings } = loadConfig());
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }

  const logger = createLogger({ level: config.logLevel });
  for (const warning of warnings) logger.warn(warning);

  const pool = createPool(config, logger);
  const store = new MemoryRateLimitStore({ maxKeys: config.rateLimit.maxKeys });

  if (config.runMigrations) {
    try {
      await migrateWithRetry(pool, logger);
    } catch (error) {
      logger.error('Migrations failed, refusing to start', { err: error });
      await pool.end().catch(() => undefined);
      process.exit(1);
    }
  } else {
    logger.info('RUN_MIGRATIONS is off, skipping migrations');
  }

  const app = createApp({ config, logger, pool, rateLimitStore: store });
  const server: Server = app.listen(config.port, () => {
    logger.info('Server listening', { port: config.port, env: config.nodeEnv });
  });
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Shutting down', { signal });

    const force = setTimeout(() => {
      logger.error('Shutdown timed out, closing remaining connections');
      server.closeAllConnections();
    }, config.shutdownTimeoutMs);
    force.unref();

    server.close(() => {
      store.close();
      pool
        .end()
        .catch((error: unknown) => logger.error('Pool close failed', { err: error }))
        .finally(() => {
          clearTimeout(force);
          logger.info('Shutdown complete');
          process.exit(0);
        });
    });
    server.closeIdleConnections();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', { err: reason });
  });
  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception', { err: error });
    process.exit(1);
  });
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Fatal startup error: ${error instanceof Error ? error.message : 'unknown'}\n`,
  );
  process.exit(1);
});
