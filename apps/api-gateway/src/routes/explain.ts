/**
 * GET /v1/explain?service=checkout
 *
 * Returns an AI-generated (or deterministic-fallback) narrative for the current
 * root cause, scoped to the authenticated tenant.
 *
 * Pipeline:
 *   1. Resolve RootCauseData using the same cache-first logic as /v1/root-cause.
 *   2. Pass the structured data to AiNarrator.narrate() — never raw logs.
 *   3. Cache the resulting ExplainData in Redis (same TTL as insights).
 *   4. Return { ok: true, data: ExplainData }.
 *
 * The AiNarrator always returns a result — either AI-generated (source:"ai") or
 * deterministic fallback (source:"fallback").  The route never returns 500 due
 * to AI failure.
 *
 * Caching:
 *   Key : explain:{tenantId}:{service|__all__}
 *   TTL : INTELLIGENCE_CACHE_TTL_SECONDS
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type {
  ApiSuccess,
  ExplainData,
  RankedInsight,
  RootCause,
  InsightsData,
} from '@relevix/types';
import type { CacheService } from '../services/cache.js';
import { insightsCacheKey, explainCacheKey } from '../services/cache.js';
import type { RuleEngineClient } from '../services/rule-engine-client.js';
import { normaliseInsights } from '../services/rule-engine-client.js';
import type { AiNarrator } from '../services/ai-narrator.js';
import { authenticate, getTenantId } from '../middleware/auth.js';
import type { Severity } from '@relevix/types';

// ─── Plugin options ───────────────────────────────────────────────────────────

export interface ExplainRouteOptions {
  cache: CacheService;
  ruleEngineClient: RuleEngineClient;
  narrator: AiNarrator;
  rateLimit: number;
}

// ─── Query schema ─────────────────────────────────────────────────────────────

const querySchema = {
  type: 'object',
  properties: {
    service: { type: 'string', minLength: 1, maxLength: 128 },
  },
  additionalProperties: false,
} as const;

interface ExplainQuery {
  service?: string;
}

// ─── Cache key helper ─────────────────────────────────────────────────────────
// Exported from cache.ts; imported above alongside insightsCacheKey.

// ─── Route ────────────────────────────────────────────────────────────────────

export async function explainRoutes(
  app: FastifyInstance,
  opts: ExplainRouteOptions,
): Promise<void> {
  const { cache, ruleEngineClient, narrator, rateLimit } = opts;

  app.get<{ Querystring: ExplainQuery }>(
    '/',
    {
      schema: { querystring: querySchema },
      config: { rateLimit: { max: rateLimit, timeWindow: '1 minute' } },
      preHandler: [authenticate],
    },
    async (req: FastifyRequest<{ Querystring: ExplainQuery }>, reply: FastifyReply) => {
      const start     = Date.now();
      const tenantId  = getTenantId(req);
      const { service } = req.query;

      const cacheKey = explainCacheKey(tenantId, service);

      // ── Fast path: cached narrative ───────────────────────────────────────
      const cached = await cache.get<ExplainData>(cacheKey);
      if (cached !== null) {
        const cacheAgeMs = Date.now() - cached.setAt;
        req.log.debug({ tenantId, service, cacheAgeMs }, 'explain cache hit');

        const body: ApiSuccess<ExplainData> = {
          ok: true,
          data: { ...cached.value, fromCache: true, cacheAgeMs },
        };
        return reply.status(200).send(body);
      }

      // ── Resolve insights (re-use insights cache if warm) ──────────────────
      let allInsights: RankedInsight[];
      const insKey    = insightsCacheKey(tenantId, service);
      const cachedIns = await cache.get<InsightsData>(insKey);

      if (cachedIns !== null) {
        allInsights = cachedIns.value.insights;
      } else {
        const raw = await ruleEngineClient.fetchInsights(tenantId, req.id);
        allInsights = normaliseInsights(raw.insights);
        if (service) {
          allInsights = allInsights.filter(
            (r) =>
              r.insight.ruleId.toLowerCase().includes(service.toLowerCase()) ||
              (r.insight.signal?.['service'] as string | undefined)
                ?.toLowerCase() === service.toLowerCase(),
          );
        }
      }

      // ── Build RootCauseData (same logic as /v1/root-cause) ───────────────
      const computedAt   = new Date().toISOString();
      const topInsight   = allInsights[0] ?? null;
      const rootCause: RootCause | null = topInsight
        ? buildRootCause(topInsight, service)
        : null;

      const rootCauseData = {
        tenantId,
        ...(service !== undefined && { service }),
        rootCause,
        supporting: allInsights.slice(1, 4),
        fromCache:  false,
        computedAt,
      };

      // ── AI narration (with deterministic fallback) ────────────────────────
      const narrative = await narrator.narrate(rootCauseData);

      req.log.info(
        {
          tenantId,
          service,
          narrativeSource: narrative.source,
          latencyMs: Date.now() - start,
        },
        'explain narrative generated',
      );

      const data: ExplainData = {
        tenantId,
        ...(service !== undefined && { service }),
        narrative,
        rootCause,
        fromCache:  false,
        computedAt,
      };

      // Write to cache best-effort
      cache.set(cacheKey, data).catch((err: unknown) => {
        req.log.warn({ err, cacheKey }, 'explain cache write failed');
      });

      const body: ApiSuccess<ExplainData> = { ok: true, data };
      return reply.status(200).send(body);
    },
  );
}

// ─── Inline root-cause builder (mirrors root-cause.ts) ───────────────────────
// Duplicated here so the explain route is self-contained and the logic is not
// coupled to the root-cause route's internal helpers.

function buildRootCause(top: RankedInsight, service?: string): RootCause {
  const { insight, components } = top;
  const detectedAt       = insight.firedAt;
  const estimatedStartAt = subtractMinutes(detectedAt, severityOffset(insight.severity));

  return {
    ruleId:             insight.ruleId,
    severity:           insight.severity,
    confidence:         insight.confidence,
    explanation:        buildExplanation(insight.ruleId, insight.severity, components.composite),
    affectedComponents: service ? [service] : deriveComponents(insight.ruleId),
    recommendations:    buildRecommendations(insight.ruleId, insight.severity),
    timeline: {
      detectedAt,
      ...(estimatedStartAt !== undefined && { estimatedStartAt }),
    },
  };
}

function buildExplanation(ruleId: string, severity: Severity, score: number): string {
  const pct  = Math.round(score * 100);
  const base = RULE_EXPLANATIONS[ruleId] ?? `Rule "${ruleId}" triggered`;
  return `${base}. Root cause identified with ${String(pct)}% confidence (severity: ${severity}).`;
}

function buildRecommendations(ruleId: string, severity: Severity): string[] {
  const specific = RULE_RECOMMENDATIONS[ruleId] ?? [];
  const generic  = SEVERITY_RECOMMENDATIONS[severity] ?? [];
  return [...new Set([...specific, ...generic])].slice(0, 5);
}

function deriveComponents(ruleId: string): string[] {
  const map: Record<string, string[]> = {
    'latency-p95-spike':           ['api-layer', 'database'],
    'error-rate-critical':         ['application', 'dependencies'],
    'throughput-drop':             ['ingress', 'load-balancer'],
    'cascading-failure-detection': ['multiple-services'],
    'baseline-regression':         ['recent-deployment'],
  };
  return map[ruleId] ?? ['unknown'];
}

function subtractMinutes(iso: string, minutes: number): string | undefined {
  try {
    return new Date(Date.parse(iso) - minutes * 60_000).toISOString();
  } catch {
    return undefined;
  }
}

function severityOffset(severity: Severity): number {
  return { page: 2, critical: 5, warning: 10, info: 20 }[severity];
}

const RULE_EXPLANATIONS: Record<string, string> = {
  'latency-p95-spike':           'P95 latency exceeded threshold by more than 3 standard deviations',
  'error-rate-critical':         'Error rate crossed the critical threshold (>5%)',
  'throughput-drop':             'Request throughput dropped by more than 40% from baseline',
  'cascading-failure-detection': 'Correlated failures detected across multiple services simultaneously',
  'baseline-regression':         'Performance has regressed between 1.5× and 2.5× above baseline',
};

const RULE_RECOMMENDATIONS: Record<string, string[]> = {
  'latency-p95-spike': [
    'Check for slow database queries or N+1 patterns',
    'Inspect upstream service latency (dependency tracing)',
    'Consider horizontal scaling if CPU/memory is saturated',
  ],
  'error-rate-critical': [
    'Review recent deployments and consider rollback',
    'Check error budget and SLO compliance dashboard',
    'Inspect circuit breaker state on downstream services',
  ],
  'throughput-drop': [
    'Verify load balancer health and sticky session settings',
    'Check for upstream traffic shaping or rate limiting',
    'Confirm auto-scaling policies are responding',
  ],
  'cascading-failure-detection': [
    'Isolate the first service to fail (check timeline)',
    'Enable circuit breakers to prevent cascade propagation',
    'Increase timeouts temporarily to absorb backpressure',
  ],
  'baseline-regression': [
    'Compare current build against the last known-good deployment',
    'Profile CPU and memory for regressions in hot paths',
    'Review configuration changes in the last 24 hours',
  ],
};

const SEVERITY_RECOMMENDATIONS: Record<Severity, string[]> = {
  page:     ['Page the on-call engineer immediately', 'Initiate incident runbook'],
  critical: ['Alert the on-call team', 'Prepare rollback procedure'],
  warning:  ['Monitor closely for escalation', 'Schedule investigation within 1 hour'],
  info:     ['Log for trend analysis', 'Review in next sprint retro'],
};
