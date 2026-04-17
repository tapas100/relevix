import { type Logger as PinoLogger, type LoggerOptions } from 'pino';
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
export declare function createLogger(context: LogContext & {
    service: string;
}, overrides?: LoggerOptions): Logger;
/**
 * Binds additional context to an existing logger (e.g. per-request traceId).
 *
 *   const reqLog = bindContext(log, { traceId, tenantId });
 */
export declare function bindContext(logger: Logger, ctx: LogContext): Logger;
export declare const defaultLogger: Logger;
//# sourceMappingURL=index.d.ts.map