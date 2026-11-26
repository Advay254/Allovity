import type { LogLevel } from '../config/env.js';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
export const SECRET_KEY_PATTERN =
  /pass(word)?|secret|token|authorization|cookie|api[-_]?key|connection|database[-_]?url|credential/i;
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(:[^\s/@]*)?@/gi;

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
}

/** Removes credentials embedded in URLs from any string. */
export function scrubString(value: string): string {
  return value.replace(URL_CREDENTIALS, '$1[redacted]@');
}

function serializeError(error: Error): LogFields {
  return {
    name: error.name,
    message: scrubString(error.message),
    stack: error.stack ? scrubString(error.stack) : undefined,
    code: (error as { code?: unknown }).code,
  };
}

function sanitize(value: unknown, depth = 0): unknown {
  if (value instanceof Error) return serializeError(value);
  if (typeof value === 'string') return scrubString(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 4) return '[truncated]';
  if (Array.isArray(value)) return value.map((item) => sanitize(item, depth + 1));
  const output: LogFields = {};
  for (const [key, inner] of Object.entries(value)) {
    output[key] = SECRET_KEY_PATTERN.test(key) ? '[redacted]' : sanitize(inner, depth + 1);
  }
  return output;
}

export interface LoggerOptions {
  level: LogLevel;
  sink?: (line: string) => void;
  bindings?: LogFields;
}

export function createLogger(options: LoggerOptions): Logger {
  const threshold = LEVELS[options.level];
  const sink = options.sink ?? ((line: string) => process.stdout.write(`${line}\n`));
  const bindings = options.bindings ?? {};

  const write = (level: LogLevel, message: string, fields?: LogFields): void => {
    if (LEVELS[level] < threshold) return;
    const record = sanitize({
      level,
      time: new Date().toISOString(),
      msg: message,
      ...bindings,
      ...fields,
    });
    sink(JSON.stringify(record));
  };

  return {
    debug: (message, fields) => write('debug', message, fields),
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
    child: (extra) => createLogger({ ...options, bindings: { ...bindings, ...extra } }),
  };
}
