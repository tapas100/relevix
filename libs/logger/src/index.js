"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.defaultLogger = void 0;
exports.createLogger = createLogger;
exports.bindContext = bindContext;
const pino_1 = __importDefault(require("pino"));
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
function createLogger(context, overrides) {
    const isDev = process.env['NODE_ENV'] !== 'production';
    const level = process.env['LOG_LEVEL'] ?? (isDev ? 'debug' : 'info');
    const transport = isDev
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
    return (0, pino_1.default)({
        level,
        base: {
            service: context.service,
            env: process.env['NODE_ENV'] ?? 'development',
        },
        // Rename pino's 'time' to '@timestamp' for ELK/OpenSearch compatibility
        timestamp: pino_1.default.stdTimeFunctions.isoTime,
        formatters: {
            level: (label) => ({ level: label }),
        },
        serializers: {
            err: pino_1.default.stdSerializers.err,
            req: pino_1.default.stdSerializers.req,
            res: pino_1.default.stdSerializers.res,
        },
        transport,
        ...overrides,
    }, process.stdout);
}
// ─── Child logger helper ──────────────────────────────────────────────────────
/**
 * Binds additional context to an existing logger (e.g. per-request traceId).
 *
 *   const reqLog = bindContext(log, { traceId, tenantId });
 */
function bindContext(logger, ctx) {
    return logger.child(ctx);
}
// ─── Default singleton (override per service) ─────────────────────────────────
exports.defaultLogger = createLogger({ service: 'relevix' });
//# sourceMappingURL=index.js.map