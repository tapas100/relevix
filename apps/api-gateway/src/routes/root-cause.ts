/**
 * GET /v1/root-cause?service=checkout
 *
 * Derives the most likely root cause from the current ranked insights for a
 * tenant, optionally scoped to a specific service.
 *
 * Algorithm:
 *   1. Fetch insights (cache-first, same source as GET /v1/insights).
 *   2. Take the top-ranked insight — highest composite score = most probable cause.
 *   3. Derive human-readable recommendations from the rule ID and severity.
 *   4. Return structured root-cause + up to 3 supporting insights.
 *
 * When no insights exist (quiet system) `rootCause` is null.
 *
 * Caching:
 *   Key : root-cause:{tenantId}:{service|__all__}
 *   TTL : same as INTELLIGENCE_CACHE_TTL_SECONDS
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { ApiSuccess, RankedInsight, RootCauseData, RootCause, Severity } from '@relevix/types';
import type { CacheService } from '../services/cache.js';
import { rootCauseCacheKey, insightsCacheKey } from '../services/cache.js';
import type { RuleEngineClient } from '../services/rule-engine-client.js';
import { normaliseInsights } from '../services/rule-engine-client.js';
import type { InsightsData } from '@relevix/types';
import { authenticate, getTenantId } from '../middleware/auth.js';

export interface RootCauseRouteOptions {
  cache: CacheService;
  ruleEngineClient: RuleEngineClient;
  rateLimit: number;
}

const querySchema = {
  type: 'object',
  properties: {
    service: { type: 'string', minLength: 1, maxLength: 128 },
  },
  additionalProperties: false,
} as const;

interface RootCauseQuery {
  service?: string;
}

export async function rootCauseRoutes(
  app: FastifyInstance,
  opts: RootCauseRouteOptions,
): Promise<void> {
  const { cache, ruleEngineClient, rateLimit } = opts;

  app.get<{ Querystring: RootCauseQuery }>(
    '/',
    {
      schema: { querystring: querySchema },
      config: { rateLimit: { max: rateLimit, timeWindow: '1 minute' } },
      preHandler: [authenticate],
    },
    async (req: FastifyRequest<{ Querystring: RootCauseQuery }>, reply: FastifyReply) => {
      const start = Date.now();
      const tenantId = getTenantId(req);
      const { service } = req.query;

      const cacheKey = rootCauseCacheKey(tenantId, service);

      // ── Cache hit ───────────────────────────────────────────────────────────
      const cached = await cache.get<RootCauseData>(cacheKey);
      if (cached !== null) {
        const cacheAgeMs = Date.now() - cached.setAt;
        req.log.debug({ tenantId, service, cacheAgeMs }, 'root-cause cache hit');
        const body: ApiSuccess<RootCauseData> = {
          ok: true,
          data: { ...cached.value, fromCache: true, cacheAgeMs },
        };
        return reply.status(200).send(body);
      }

      // ── Fetch insights (try insights cache first) ────────────────────────────
      let allInsights: RankedInsight[];
      const insKey = insightsCacheKey(tenantId, service);
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

      const computedAt = new Date().toISOString();
      const topInsight = allInsights[0] ?? null;

      const rootCause: RootCause | null = topInsight
        ? buildRootCause(topInsight, service)
        : null;

      const data: RootCauseData = {
        tenantId,
        ...(service !== undefined && { service }),
        rootCause,
        supporting: allInsights.slice(1, 4), // next 3 after the root cause
        fromCache: false,
        computedAt,
      };

      // Write to cache (best-effort)
      cache.set(cacheKey, data).catch((err: unknown) => {
        req.log.warn({ err, cacheKey }, 'root-cause cache write failed');
      });

      req.log.info(
        { tenantId, service, hasRootCause: rootCause !== null, latencyMs: Date.now() - start },
        'root-cause analysis complete',
      );

      const body: ApiSuccess<RootCauseData> = { ok: true, data };
      return reply.status(200).send(body);
    },
  );
}

// ─── Root cause builder ───────────────────────────────────────────────────────

/**
 * Derives a structured RootCause from the top-ranked insight.
 *
 * Recommendations are generated from the rule ID + severity combo, mirroring
 * the 5 rules defined in `rules/infra.rules.yml`:
 *   latency-p95-spike          → scale / check dependencies
 *   error-rate-critical        → check error budget / rollback
 *   throughput-drop            → check upstream / load balancer
 *   cascading-failure-detection → isolate failing services
 *   baseline-regression        → check recent deploys
 */
function buildRootCause(top: RankedInsight, service?: string): RootCause {
  const { insight, components } = top;
  const detectedAt = insight.firedAt;
  const estimatedStartAt = subtractMinutes(detectedAt, severityOffset(insight.severity));

  const affectedComponents = service
    ? [service]
    : deriveComponents(insight.ruleId);

  return {
    ruleId: insight.ruleId,
    severity: insight.severity,
    confidence: insight.confidence,
    explanation: buildExplanation(insight.ruleId, insight.severity, components.composite),
    affectedComponents,
    recommendations: buildRecommendations(insight.ruleId, insight.severity),
    timeline: {
      detectedAt,
      ...(estimatedStartAt !== undefined && { estimatedStartAt }),
    },
  };
}

function buildExplanation(ruleId: string, severity: Severity, score: number): string {
  const pct = Math.round(score * 100);
  const base = RULE_EXPLANATIONS[ruleId] ?? `Rule "${ruleId}" triggered`;
  return `${base}. Root cause identified with ${String(pct)}% confidence (severity: ${severity}).`;
}

function buildRecommendations(ruleId: string, severity: Severity): string[] {
  const specific = RULE_RECOMMENDATIONS[ruleId] ?? [];
  const generic = SEVERITY_RECOMMENDATIONS[severity] ?? [];
  // deduplicate, specific first
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
  // Estimate how many minutes before detection the issue started
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
