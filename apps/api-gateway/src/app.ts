import Fastify, {
  type FastifyInstance,
  type FastifyBaseLogger,
  type FastifyRequest,
  type FastifyReply,
  type FastifyError,
} from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { errorResponseBuilderContext } from '@fastify/rate-limit';
import jwt from '@fastify/jwt';
import type { ApiGatewayConfig } from '@relevix/config';
import type { Logger } from '@relevix/logger';
import { isRelevixError, InternalError } from '@relevix/errors';
import type { ApiError } from '@relevix/types';
import { healthRoutes } from './routes/health.js';
import { rulesRoutes } from './routes/rules.js';
import { ingestRoutes } from './routes/ingest.js';
import { insightsRoutes } from './routes/insights.js';
import { rootCauseRoutes } from './routes/root-cause.js';
import { logsRoutes } from './routes/logs.js';
import { explainRoutes } from './routes/explain.js';
import { searchRoutes } from './routes/search.js';
import { metricsRoute } from './routes/metrics-route.js';
import { CacheService } from './services/cache.js';
import { RuleEngineClient } from './services/rule-engine-client.js';
import { createAiNarrator } from './services/ai-narrator.js';
import { createInsightSearchService } from './search/insight-search-service.js';
import { otelTracePlugin } from './plugins/otel.js';
import { getMetrics } from './plugins/metrics.js';
import type IORedis from 'ioredis';

// ─── App factory ─────────────────────────────────────────────────────────────
//
// Using a factory function (not a singleton module) allows easy testing:
// each test spins up a fresh app instance.

export async function buildApp(
  config: ApiGatewayConfig,
  logger: FastifyBaseLogger,
  redis: IORedis,
): Promise<FastifyInstance> {
  const app = Fastify({
    // Pass our pino logger instance directly — the `logger` option accepts
    // a pre-built pino instance as well as a config object.
    logger,
    // Expose requestId in every log line
    genReqId: () => crypto.randomUUID(),
    requestIdHeader: 'x-request-id',
    requestIdLogLabel: 'requestId',
    trustProxy: true,
  });

  // ─── Security ──────────────────────────────────────────────────────────────
  await app.register(helmet, { global: true });

  await app.register(cors, {
    origin: config.CORS_ORIGINS,
    credentials: true,
  });

  // ─── Observability — must register early so all routes are instrumented ────
  await app.register(otelTracePlugin);

  // HTTP latency + throughput metrics — recorded on every response
  const m = getMetrics();
  app.addHook('onResponse', (request, reply, done) => {
    const route  = request.routeOptions?.url ?? request.url;
    const method = request.method;
    const status = String(reply.statusCode);
    const elapsed = reply.elapsedTime / 1_000; // ms → seconds

    m.httpDuration.labels(method, route, status).observe(elapsed);
    m.httpRequestsTotal.labels(method, route, status).inc();
    if (reply.statusCode >= 400) {
      m.httpErrorsTotal.labels(method, route, status).inc();
    }
    done();
  });

  // ─── Rate limiting ─────────────────────────────────────────────────────────
  await app.register(rateLimit, {
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW_MS,
    errorResponseBuilder: (_req: FastifyRequest, context: errorResponseBuilderContext) => ({
      ok: false,
      error: {
        code: 'RATE_LIMITED',
        message: `Rate limit exceeded. Retry after ${String(context.after)}.`,
      },
    }),
  });

  // ─── Auth ──────────────────────────────────────────────────────────────────
  await app.register(jwt, {
    secret: config.JWT_SECRET,
    sign: { expiresIn: config.JWT_EXPIRES_IN },
  });

  // ─── Shared service singletons ────────────────────────────────────────────
  const cache = new CacheService(redis, config.INTELLIGENCE_CACHE_TTL_SECONDS);
  const ruleEngineClient = new RuleEngineClient(config.RULE_ENGINE_URL);
  const intelligenceRateLimit = config.INTELLIGENCE_RATE_LIMIT_MAX;
  const narrator = createAiNarrator(config);
  const searchService = createInsightSearchService(config);

  // ─── Routes ────────────────────────────────────────────────────────────────
  await app.register(healthRoutes,    { prefix: '/health' });
  await app.register(metricsRoute);   // GET /metrics — Prometheus scrape
  await app.register(rulesRoutes,     { prefix: '/v1/rules' });
  await app.register(ingestRoutes,    { prefix: '/v1/ingest' });

  // Intelligence routes
  await app.register(insightsRoutes, {
    prefix: '/v1/insights',
    cache,
    ruleEngineClient,
    rateLimit: intelligenceRateLimit,
  });
  await app.register(rootCauseRoutes, {
    prefix: '/v1/root-cause',
    cache,
    ruleEngineClient,
    rateLimit: intelligenceRateLimit,
  });
  await app.register(explainRoutes, {
    prefix: '/v1/explain',
    cache,
    ruleEngineClient,
    narrator,
    rateLimit: intelligenceRateLimit,
  });
  await app.register(searchRoutes, {
    prefix: '/v1/search/insights',
    cache,
    searchService,
    searchCacheTtl: config.SEARCH_CACHE_TTL_SECONDS,
    rateLimit: intelligenceRateLimit,
  });
  await app.register(logsRoutes, {
    prefix: '/v1/logs',
    ingestionUrl: config.INGESTION_URL,
    rateLimit: intelligenceRateLimit,
  });

  // ─── Global error handler ──────────────────────────────────────────────────
  // Normalises all errors to the ApiError envelope before responding.
  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    const traceId = request.id;

    if (isRelevixError(error)) {
      const body: ApiError = {
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
          traceId,
        },
      };
      return reply.status(error.httpStatus).send(body);
    }

    // Fastify validation errors (schema mismatch)
    if (error.validation) {
      const body: ApiError = {
        ok: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed.',
          details: error.validation,
          traceId,
        },
      };
      return reply.status(422).send(body);
    }

    // Unknown/unhandled
    const internal = new InternalError(error, traceId);
    request.log.error({ err: error }, 'Unhandled error');
    return reply.status(500).send({
      ok: false,
      error: {
        code: internal.code,
        message: internal.message,
        traceId,
      },
    });
  });

  return app;
}
