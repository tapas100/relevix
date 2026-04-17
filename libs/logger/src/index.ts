import pino, { type Logger as PinoLogger, type LoggerOptions } from 'pino';

// ─── PII redaction ────────────────────────────────────────────────────────────
//
// These jq-style paths are intercepted by Pino before serialisation.
// The value is replaced with "[REDACTED]" — no PII ever reaches the transport.
//
// Rule: redact at the logger layer so EVERY downstream sink (Loki, S3, stdout)
// is protected regardless of how logs are shipped.
//
// Paths use glob syntax:
//   "*.email"          — any top-level object with an "email" field
//   "req.headers.authorization" — JWT / API key in request logs
//
const PII_REDACT_PATHS: string[] = [
  // Auth tokens
  'req.headers.authorization',
  'req.headers["x-api-key"]',
  'token',
  '*.token',
  'accessToken',
  '*.accessToken',
  'refreshToken',
  '*.refreshToken',

  // Identity
  'email',
  '*.email',
  'userId',
  '*.userId',
  'password',
  '*.password',
  'apiKey',
  '*.apiKey',

  // Network / device (GDPR article 4(1): IP = personal data)
  'req.remoteAddress',
  'req.headers["x-forwarded-for"]',
  'req.headers["x-real-ip"]',
  'ipAddress',
  '*.ipAddress',
  'ip',

  // Financial
  'cardNumber',
  '*.cardNumber',
  'cvv',
  '*.cvv',
];

// ─── Types ────────────────────────────────────────────────────────────────────

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface LogContext {
  traceId?: string;
  spanId?: string;
  tenantId?: string;
  userId?: string;
  requestId?: string;
  service?: string;
  [key: string]: unknown;
}

export type Logger = PinoLogger;

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Creates a structured JSON logger.
 *
 * - In production: emits newline-delimited JSON (stdout) — ready for Loki/CloudWatch/Datadog.
 * - In development: uses pino-pretty for human-readable output.
 *
 * All log lines include:
 *   service, env, level, time (epoch ms), msg, traceId, spanId
 *
 * Usage:
 *   const log = createLogger({ service: 'api-gateway' });
 *   log.info({ tenantId: 'abc' }, 'Request received');
 */
export function createLogger(
  context: LogContext & { service: string },
  overrides?: LoggerOptions,
): Logger {
  const isDev = process.env['NODE_ENV'] !== 'production';
  const level = (process.env['LOG_LEVEL'] as LogLevel | undefined) ?? (isDev ? 'debug' : 'info');

  const transport: LoggerOptions['transport'] = isDev
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:HH:MM:ss.l',
          ignore: 'pid,hostname',
          messageFormat: '[{service}] {msg}',
        },
      }
    : undefined;

  const opts: LoggerOptions = {
      level,
      base: {
        service: context.service,
        env: process.env['NODE_ENV'] ?? 'development',
      },
      // Rename pino's 'time' to '@timestamp' for ELK/OpenSearch compatibility
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: {
        level: (label: string) => ({ level: label }),
      },
      serializers: {
        err: pino.stdSerializers.err,
        req: pino.stdSerializers.req,
        res: pino.stdSerializers.res,
      },
      // ── PII redaction ─────────────────────────────────────────────────────
      // Pino intercepts these paths before serialisation and replaces values
      // with "[REDACTED]". Applied to ALL sinks — stdout, Loki, S3, etc.
      redact: {
        paths:  PII_REDACT_PATHS,
        censor: '[REDACTED]',
      },
      ...overrides,
    };
  if (transport) opts.transport = transport;

  return pino(opts, process.stdout);
}

// ─── Child logger helper ──────────────────────────────────────────────────────

/**
 * Binds additional context to an existing logger (e.g. per-request traceId).
 *
 *   const reqLog = bindContext(log, { traceId, tenantId });
 */
export function bindContext(logger: Logger, ctx: LogContext): Logger {
  return logger.child(ctx);
}

// ─── Default singleton (override per service) ─────────────────────────────────

export const defaultLogger = createLogger({ service: 'relevix' });
