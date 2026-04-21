/**
 * GET /v1/insights?service=checkout&limit=10
 *
 * Returns ranked infrastructure insights for the authenticated tenant,
 * optionally filtered by service name.
 *
 * Response time budget:
 *   Cache hit  : ~5ms  (Redis GET + JSON parse + serialise)
 *   Cache miss : ~180ms (Redis miss + Go rule-engine ~150ms + cache write)
 *
 * Caching strategy:
 *   Key : insights:{tenantId}:{service|__all__}
 *   TTL : INTELLIGENCE_CACHE_TTL_SECONDS (default 25s)
 *
 * Rate limiting:
 *   INTELLIGENCE_RATE_LIMIT_MAX requests per minute per tenant (default 30).
 *   Applied in addition to the global rate limit registered in buildApp.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { ApiSuccess } from '@relevix/types';
import type { InsightsData, RankedInsight } from '@relevix/types';
import { InvalidQueryError } from '@relevix/errors';
import type { CacheService } from '../services/cache.js';
import { insightsCacheKey } from '../services/cache.js';
import type { RuleEngineClient } from '../services/rule-engine-client.js';
import { normaliseInsights } from '../services/rule-engine-client.js';
import { authenticate, getTenantId } from '../middleware/auth.js';
import { InsightRepository } from '../services/insight-repository.js';

// ─── Plugin options ───────────────────────────────────────────────────────────

export interface InsightsRouteOptions {
  cache: CacheService;
  ruleEngineClient: RuleEngineClient;
  /** Max requests per minute for this route group. */
  rateLimit: number;
}

// ─── Query schema (Fastify validates against JSON Schema) ─────────────────────

const querySchema = {
  type: 'object',
  properties: {
    service: { type: 'string', minLength: 1, maxLength: 128 },
    limit:   { type: 'integer', minimum: 1, maximum: 50, default: 10 },
  },
  additionalProperties: false,
} as const;

interface InsightsQuery {
  service?: string;
  limit: number;
}

// ─── Route ────────────────────────────────────────────────────────────────────

export async function insightsRoutes(
  app: FastifyInstance,
  opts: InsightsRouteOptions,
): Promise<void> {
  const { cache, ruleEngineClient, rateLimit } = opts;

  app.get<{ Querystring: InsightsQuery }>(
    '/',
    {
      schema: { querystring: querySchema },
      config: { rateLimit: { max: rateLimit, timeWindow: '1 minute' } },
      preHandler: [authenticate],
    },
    async (req: FastifyRequest<{ Querystring: InsightsQuery }>, reply: FastifyReply) => {
      const start = Date.now();
      const tenantId = getTenantId(req);
      const { service, limit } = req.query;

      if (limit < 1 || limit > 50) {
        throw new InvalidQueryError({ limit: 'must be between 1 and 50' }, req.id);
      }

      const cacheKey = insightsCacheKey(tenantId, service);

      // ── Fast path: cache hit ────────────────────────────────────────────────
      const cached = await cache.get<InsightsData>(cacheKey);
      if (cached !== null) {
        const cacheAgeMs = Date.now() - cached.setAt;
        req.log.debug({ tenantId, service, cacheAgeMs }, 'insights cache hit');

        const body: ApiSuccess<InsightsData> = {
          ok: true,
          data: {
            ...cached.value,
            insights: cached.value.insights.slice(0, limit),
            fromCache: true,
            cacheAgeMs,
          },
        };
        return reply.status(200).send(body);
      }

      // ── Slow path: live fetch from rule-engine, fallback to Postgres ────────
      let insights: RankedInsight[] = [];
      let fromCache = false;
      let computedAt = new Date().toISOString();

      try {
        const raw = await ruleEngineClient.fetchInsights(tenantId, req.id);
        insights = normaliseInsights(raw.insights);
        fromCache   = raw.from_cache;
        computedAt  = raw.computed_at;
      } catch {
        // Rule-engine unavailable — read directly from Postgres insights table
        req.log.warn({ tenantId }, 'rule-engine unavailable — falling back to Postgres insights');
        const repo = new InsightRepository();
        const { rows } = await repo.list(tenantId, { service, limit, sinceHours: 48 });
        insights = rows.map((row, i): RankedInsight => ({
          rank: i + 1,
          insight: {
            id:         row.id,
            ruleId:     row.ruleId,
            ruleName:   row.ruleId,
            severity:   row.severity as RankedInsight['insight']['severity'],
            priority:   row.priority,
            confidence: row.confidence,
            firedAt:    row.firedAt.toISOString(),
            ...(row.dedupKey !== null && { dedupKey: row.dedupKey }),
            signal:     row.signal,
          } as RankedInsight['insight'],
          components: {
            severity:   row.severityScore,
            confidence: row.confidence,
            recency:    row.recencyScore,
            impact:     row.impactScore,
            composite:  row.compositeScore,
          },
        }));
        fromCache  = false;
        computedAt = new Date().toISOString();
      }

      // Filter by service if requested (match against ruleId prefix or signal.service)
      if (service) {
        insights = insights.filter(
          (r) =>
            r.insight.ruleId.toLowerCase().includes(service.toLowerCase()) ||
            (r.insight.signal?.['service'] as string | undefined)
              ?.toLowerCase() === service.toLowerCase(),
        );
        // Re-rank after filter
        insights = insights.map((r, i) => ({ ...r, rank: i + 1 }));
      }

      const data: InsightsData = {
        tenantId,
        ...(service !== undefined && { service }),
        insights: insights.slice(0, limit),
        total: insights.length,
        fromCache,
        computedAt,
      };

      // Write to cache (best-effort — don't fail the request on cache error)
      cache.set(cacheKey, data).catch((err: unknown) => {
        req.log.warn({ err, cacheKey }, 'cache write failed');
      });

      req.log.info(
        { tenantId, service, total: insights.length, latencyMs: Date.now() - start },
        'insights fetched',
      );

      const body: ApiSuccess<InsightsData> = { ok: true, data };
      return reply.status(200).send(body);
    },
  );
}
