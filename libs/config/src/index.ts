import { z } from 'zod';

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

export const BaseConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  SERVICE_NAME: z.string().min(1),
  SERVICE_VERSION: z.string().default('0.0.0'),

  // OpenTelemetry
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  OTEL_ENABLED: z
    .string()
    .transform((v: string) => v === 'true')
    .default('false'),
});

export type BaseConfig = z.infer<typeof BaseConfigSchema>;

// ─── API Gateway schema ───────────────────────────────────────────────────────

export const ApiGatewayConfigSchema = BaseConfigSchema.extend({
  PORT: z.coerce.number().int().min(1024).max(65535).default(3000),
  HOST: z.string().default('0.0.0.0'),

  // Auth
  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.string().default('15m'),

  // Downstream service URLs
  RULE_ENGINE_URL: z.string().url(),
  INGESTION_URL: z.string().url(),

  // Redis (rate limiting, session cache)
  REDIS_URL: z.string().url(),

  // Postgres
  DATABASE_URL: z.string().url(),

  // CORS
  CORS_ORIGINS: z
    .string()
    .transform((v: string) => v.split(',').map((s: string) => s.trim()))
    .default('http://localhost:3000'),

  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().default(200),

  // Intelligence API
  // How long to cache insights / root-cause results in Redis.
  // Should be slightly less than the Go precompute tick interval (default 30s)
  // so the cache is always fresher than one tick behind.
  INTELLIGENCE_CACHE_TTL_SECONDS: z.coerce.number().int().min(5).default(25),
  // Tighter per-minute rate limit for intelligence endpoints (they hit Redis + Go).
  INTELLIGENCE_RATE_LIMIT_MAX: z.coerce.number().int().default(30),

  // Search (Elasticsearch)
  ELASTICSEARCH_URL: z.string().url().default('http://localhost:9200'),
  ELASTICSEARCH_API_KEY: z.string().min(1).optional().or(z.literal('').transform(() => undefined)),
  // Index alias prefix — actual index is "{prefix}-{tenantId}".
  ELASTICSEARCH_INDEX_PREFIX: z.string().default('relevix-insights'),
  // Hard timeout (ms) passed to ES as ?timeout= — enforces the <100ms SLA.
  ELASTICSEARCH_TIMEOUT_MS: z.coerce.number().int().default(80),
  // Search results TTL in Redis (shorter than insight TTL — searches are cheap).
  SEARCH_CACHE_TTL_SECONDS: z.coerce.number().int().default(10),

  // AI Narrator — optional; if unset the narrator always uses the fallback path.
  OPENAI_API_KEY: z.string().min(1).optional().or(z.literal('').transform(() => undefined)),
  // Model to use. gpt-4o-mini is the default: cheap, fast, sufficient for summaries.
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),
  // Hard upper-bound on completion tokens to keep costs predictable.
  OPENAI_MAX_TOKENS: z.coerce.number().int().min(50).max(300).default(150),
  // Wall-clock budget (ms) before the AI call is aborted and fallback is used.
  AI_NARRATOR_TIMEOUT_MS: z.coerce.number().int().default(3_000),
  // Set to "false" to disable AI narration entirely (always use fallback).
  AI_NARRATOR_ENABLED: z
    .string()
    .transform((v: string) => v !== 'false')
    .default('true'),

  // ── Circuit breaker (rule-engine) ─────────────────────────────────────────
  // Number of consecutive failures before the circuit opens.
  CB_FAILURE_THRESHOLD: z.coerce.number().int().min(1).default(5),
  // How long (ms) the circuit stays OPEN before a probe is attempted.
  CB_RESET_TIMEOUT_MS: z.coerce.number().int().default(30_000),
  // Consecutive successes needed in HALF_OPEN before closing.
  CB_SUCCESS_THRESHOLD: z.coerce.number().int().min(1).default(2),

  // ── Metrics ───────────────────────────────────────────────────────────────
  // Set to "false" to disable the /metrics Prometheus endpoint.
  METRICS_ENABLED: z
    .string()
    .transform((v: string) => v !== 'false')
    .default('true'),
});

export type ApiGatewayConfig = z.infer<typeof ApiGatewayConfigSchema>;

// ─── Ingestion worker schema ──────────────────────────────────────────────────

export const IngestionConfigSchema = BaseConfigSchema.extend({
  PORT: z.coerce.number().int().default(4000),
  KAFKA_BROKERS: z
    .string()
    .transform((v: string) => v.split(',').map((s: string) => s.trim())),
  KAFKA_CLIENT_ID: z.string().default('relevix-ingestion'),
  KAFKA_GROUP_ID: z.string().default('relevix-ingestion-group'),
  KAFKA_TOPIC_EVENTS: z.string().default('relevix.events'),
  BATCH_SIZE_MAX: z.coerce.number().default(500),
  DATABASE_URL: z.string().url(),
});

export type IngestionConfig = z.infer<typeof IngestionConfigSchema>;

// ─── Loader ───────────────────────────────────────────────────────────────────

/**
 * Validates process.env against the provided Zod schema.
 * Throws a descriptive error at startup if validation fails.
 *
 * Usage (in each service's main.ts):
 *   import { loadConfig, ApiGatewayConfigSchema } from '@relevix/config';
 *   const config = loadConfig(ApiGatewayConfigSchema);
 */
export function loadConfig<T extends z.ZodTypeAny>(schema: T): z.infer<T> {
  const result = schema.safeParse(process.env);

  if (!result.success) {
    const formatted = result.error.issues
      .map((issue: z.ZodIssue) => `  [${issue.path.join('.')}] ${issue.message}`)
      .join('\n');
    throw new Error(`❌ Invalid environment configuration:\n${formatted}`);
  }

  return result.data as z.infer<T>;
}
