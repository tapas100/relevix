/**
 * POST /v1/search/insights
 *
 * Full-text and semantic search over a tenant's indexed insights.
 *
 * Pipeline:
 *   1. Validate request body (Fastify JSON Schema).
 *   2. Check Redis cache (key: search:{tenantId}:{sha256(body)}, TTL 10s).
 *   3. On miss: call InsightSearchService.search() → ES query → ranked hits.
 *   4. Cache result, return InsightSearchResponse.
 *
 * Response time budget:
 *   Cache hit  : ~5ms
 *   Cache miss : ~80ms (ES timeout hard-capped at ELASTICSEARCH_TIMEOUT_MS)
 *
 * Search modes (req.mode):
 *   "keyword"  — BM25 function_score with composite boosting (default)
 *   "semantic" — kNN over embedding vector (requires embedding pipeline)
 *   "hybrid"   — RRF of keyword + kNN
 *
 * The route accepts POST (not GET) because:
 *   - The request body may include a future `embedding` float array.
 *   - Complex filter objects are cleaner in JSON than query strings.
 *   - Avoids URL-length limits on large queries.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { ApiSuccess, InsightSearchRequest, InsightSearchResponse } from '@relevix/types';
import type { CacheService } from '../services/cache.js';
import type { InsightSearchService } from '../search/insight-search-service.js';
import { authenticate, getTenantId } from '../middleware/auth.js';

// ─── Plugin options ───────────────────────────────────────────────────────────

export interface SearchRouteOptions {
  cache: CacheService;
  searchService: InsightSearchService;
  searchCacheTtl: number;
  rateLimit: number;
}

// ─── Request body schema ──────────────────────────────────────────────────────

const bodySchema = {
  type: 'object',
  required: ['q'],
  properties: {
    q:           { type: 'string', minLength: 1, maxLength: 512 },
    service:     { type: 'string', minLength: 1, maxLength: 128 },
    minSeverity: { type: 'string', enum: ['page', 'critical', 'warning', 'info'] },
    since:       { type: 'string', format: 'date-time' },
    limit:       { type: 'integer', minimum: 1, maximum: 50, default: 10 },
    from:        { type: 'integer', minimum: 0, default: 0 },
    mode:        { type: 'string', enum: ['keyword', 'semantic', 'hybrid'], default: 'keyword' },
  },
  additionalProperties: false,
} as const;

// ─── Cache key ────────────────────────────────────────────────────────────────

/**
 * Deterministic cache key for a search request.
 * Uses a stable JSON serialisation of the request body so that two
 * requests with the same filters hit the same cache entry.
 */
function searchCacheKey(tenantId: string, req: InsightSearchRequest): string {
  // Sort keys for stability
  const stable = JSON.stringify(
    Object.fromEntries(
      Object.entries(req)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
  );
  // Simple djb2 hash — no crypto needed, not security-sensitive
  let hash = 5381;
  for (let i = 0; i < stable.length; i++) {
    hash = ((hash << 5) + hash) ^ stable.charCodeAt(i);
  }
  return `search:${tenantId}:${String(hash >>> 0)}`;
}

// ─── Route ────────────────────────────────────────────────────────────────────

export async function searchRoutes(
  app: FastifyInstance,
  opts: SearchRouteOptions,
): Promise<void> {
  const { cache, searchService, searchCacheTtl, rateLimit } = opts;

  app.post<{ Body: InsightSearchRequest }>(
    '/',
    {
      schema: { body: bodySchema },
      config: { rateLimit: { max: rateLimit, timeWindow: '1 minute' } },
      preHandler: [authenticate],
    },
    async (req: FastifyRequest<{ Body: InsightSearchRequest }>, reply: FastifyReply) => {
      const start    = Date.now();
      const tenantId = getTenantId(req);
      const body     = req.body;

      const cacheKey = searchCacheKey(tenantId, body);

      // ── Cache hit ─────────────────────────────────────────────────────────
      const cached = await cache.get<InsightSearchResponse>(cacheKey);
      if (cached !== null) {
        const cacheAgeMs = Date.now() - cached.setAt;
        req.log.debug({ tenantId, q: body.q, cacheAgeMs }, 'search cache hit');
        const response: ApiSuccess<InsightSearchResponse> = {
          ok:   true,
          data: { ...cached.value, fromCache: true },
        };
        return reply.status(200).send(response);
      }

      // ── Ensure the tenant's index exists (lazy provisioning) ─────────────
      // Fire-and-forget — if the index doesn't exist ES will 404 on search;
      // ensureIndex is idempotent and fast on subsequent calls.
      searchService.ensureIndex(tenantId).catch((err: unknown) => {
        req.log.warn({ err, tenantId }, 'search index ensure failed');
      });

      // ── Live search ───────────────────────────────────────────────────────
      const result = await searchService.search(tenantId, body);

      req.log.info(
        {
          tenantId,
          q:        body.q,
          mode:     body.mode ?? 'keyword',
          total:    result.total,
          took:     result.took,
          latencyMs: Date.now() - start,
        },
        'search complete',
      );

      // Cache best-effort
      cache.set(cacheKey, result, searchCacheTtl).catch((err: unknown) => {
        req.log.warn({ err, cacheKey }, 'search cache write failed');
      });

      const response: ApiSuccess<InsightSearchResponse> = { ok: true, data: result };
      return reply.status(200).send(response);
    },
  );
}
