"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.IngestionConfigSchema = exports.ApiGatewayConfigSchema = exports.BaseConfigSchema = void 0;
exports.loadConfig = loadConfig;
const zod_1 = require("zod");
// ─── Strategy ─────────────────────────────────────────────────────────────────
//
// All configuration is sourced strictly from environment variables.
// No config files are read at runtime — only .env files loaded by the
// process manager (Docker, systemd, dotenvx, etc.) before startup.
//
// Each service defines its own Zod schema and calls `loadConfig(schema)`.
// Validation fails loudly at startup — fail-fast over silent misconfiguration.
//
// Secrets (JWT_SECRET, DB passwords) must NEVER have defaults.
// Non-sensitive values (ports, log level) may have safe defaults.
// ─── Shared base schema (all services extend this) ────────────────────────────
exports.BaseConfigSchema = zod_1.z.object({
    NODE_ENV: zod_1.z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: zod_1.z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
    SERVICE_NAME: zod_1.z.string().min(1),
    SERVICE_VERSION: zod_1.z.string().default('0.0.0'),
    // OpenTelemetry
    OTEL_EXPORTER_OTLP_ENDPOINT: zod_1.z.string().url().optional(),
    OTEL_ENABLED: zod_1.z
        .string()
        .transform((v) => v === 'true')
        .default('false'),
});
// ─── API Gateway schema ───────────────────────────────────────────────────────
exports.ApiGatewayConfigSchema = exports.BaseConfigSchema.extend({
    PORT: zod_1.z.coerce.number().int().min(1024).max(65535).default(3000),
    HOST: zod_1.z.string().default('0.0.0.0'),
    // Auth
    JWT_SECRET: zod_1.z.string().min(32),
    JWT_EXPIRES_IN: zod_1.z.string().default('15m'),
    // Downstream service URLs
    RULE_ENGINE_URL: zod_1.z.string().url(),
    INGESTION_URL: zod_1.z.string().url(),
    // Redis (rate limiting, session cache)
    REDIS_URL: zod_1.z.string().url(),
    // Postgres
    DATABASE_URL: zod_1.z.string().url(),
    // CORS
    CORS_ORIGINS: zod_1.z
        .string()
        .transform((v) => v.split(',').map((s) => s.trim()))
        .default('http://localhost:3000'),
    RATE_LIMIT_WINDOW_MS: zod_1.z.coerce.number().default(60_000),
    RATE_LIMIT_MAX: zod_1.z.coerce.number().default(200),
    // Intelligence API
    // How long to cache insights / root-cause results in Redis.
    // Should be slightly less than the Go precompute tick interval (default 30s)
    // so the cache is always fresher than one tick behind.
    INTELLIGENCE_CACHE_TTL_SECONDS: zod_1.z.coerce.number().int().min(5).default(25),
    // Tighter per-minute rate limit for intelligence endpoints (they hit Redis + Go).
    INTELLIGENCE_RATE_LIMIT_MAX: zod_1.z.coerce.number().int().default(30),
    // Search (Elasticsearch)
    ELASTICSEARCH_URL: zod_1.z.string().url().default('http://localhost:9200'),
    ELASTICSEARCH_API_KEY: zod_1.z.string().min(1).optional(),
    // Index alias prefix — actual index is "{prefix}-{tenantId}".
    ELASTICSEARCH_INDEX_PREFIX: zod_1.z.string().default('relevix-insights'),
    // Hard timeout (ms) passed to ES as ?timeout= — enforces the <100ms SLA.
    ELASTICSEARCH_TIMEOUT_MS: zod_1.z.coerce.number().int().default(80),
    // Search results TTL in Redis (shorter than insight TTL — searches are cheap).
    SEARCH_CACHE_TTL_SECONDS: zod_1.z.coerce.number().int().default(10),
    // AI Narrator — optional; if unset the narrator always uses the fallback path.
    OPENAI_API_KEY: zod_1.z.string().min(1).optional(),
    // Model to use. gpt-4o-mini is the default: cheap, fast, sufficient for summaries.
    OPENAI_MODEL: zod_1.z.string().default('gpt-4o-mini'),
    // Hard upper-bound on completion tokens to keep costs predictable.
    OPENAI_MAX_TOKENS: zod_1.z.coerce.number().int().min(50).max(300).default(150),
    // Wall-clock budget (ms) before the AI call is aborted and fallback is used.
    AI_NARRATOR_TIMEOUT_MS: zod_1.z.coerce.number().int().default(3_000),
    // Set to "false" to disable AI narration entirely (always use fallback).
    AI_NARRATOR_ENABLED: zod_1.z
        .string()
        .transform((v) => v !== 'false')
        .default('true'),
});
// ─── Ingestion worker schema ──────────────────────────────────────────────────
exports.IngestionConfigSchema = exports.BaseConfigSchema.extend({
    PORT: zod_1.z.coerce.number().int().default(4000),
    KAFKA_BROKERS: zod_1.z
        .string()
        .transform((v) => v.split(',').map((s) => s.trim())),
    KAFKA_CLIENT_ID: zod_1.z.string().default('relevix-ingestion'),
    KAFKA_GROUP_ID: zod_1.z.string().default('relevix-ingestion-group'),
    KAFKA_TOPIC_EVENTS: zod_1.z.string().default('relevix.events'),
    BATCH_SIZE_MAX: zod_1.z.coerce.number().default(500),
    DATABASE_URL: zod_1.z.string().url(),
});
// ─── Loader ───────────────────────────────────────────────────────────────────
/**
 * Validates process.env against the provided Zod schema.
 * Throws a descriptive error at startup if validation fails.
 *
 * Usage (in each service's main.ts):
 *   import { loadConfig, ApiGatewayConfigSchema } from '@relevix/config';
 *   const config = loadConfig(ApiGatewayConfigSchema);
 */
function loadConfig(schema) {
    const result = schema.safeParse(process.env);
    if (!result.success) {
        const formatted = result.error.issues
            .map((issue) => `  [${issue.path.join('.')}] ${issue.message}`)
            .join('\n');
        throw new Error(`❌ Invalid environment configuration:\n${formatted}`);
    }
    return result.data;
}
//# sourceMappingURL=index.js.map