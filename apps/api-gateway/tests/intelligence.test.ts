/**
 * Tests for the intelligence API routes.
 *
 * Strategy:
 * - Build a real Fastify instance with a mock Redis (ioredis-mock) and a
 *   stub RuleEngineClient so tests run fully in-process with no network I/O.
 * - Assert on HTTP status, envelope shape, caching behaviour, and auth.
 *
 * Run:  pnpm --filter @relevix/api-gateway test
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';

import { insightsRoutes } from '../src/routes/insights.js';
import { rootCauseRoutes } from '../src/routes/root-cause.js';
import { logsRoutes } from '../src/routes/logs.js';
import { CacheService } from '../src/services/cache.js';
import type { RuleEngineClient, RuleEngineInsightsResponse } from '../src/services/rule-engine-client.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const JWT_SECRET = 'super-secret-test-key-at-least-32-chars!!';
const TENANT_ID  = 'tenant-test-abc';

const MOCK_RAW_RESPONSE: RuleEngineInsightsResponse = {
  ok: true,
  from_cache: false,
  computed_at: '2026-04-17T10:00:00.000Z',
  insights: [
    {
      rank: 1,
      insight: {
        id: 'ins-1',
        rule_id: 'latency-p95-spike',
        rule_name: 'Latency P95 Spike',
        severity: 'critical',
        priority: 1,
        confidence: 0.91,
        fired_at: '2026-04-17T09:59:00.000Z',
      },
      components: { severity: 0.8, confidence: 0.91, recency: 0.95, impact: 0.7, composite: 0.49 },
    },
    {
      rank: 2,
      insight: {
        id: 'ins-2',
        rule_id: 'error-rate-critical',
        rule_name: 'Error Rate Critical',
        severity: 'page',
        priority: 0,
        confidence: 0.85,
        fired_at: '2026-04-17T09:58:00.000Z',
        signal: { service: 'checkout' },
      },
      components: { severity: 1.0, confidence: 0.85, recency: 0.9, impact: 0.8, composite: 0.61 },
    },
  ],
};

// ─── In-memory Redis mock ──────────────────────────────────────────────────────

class MemRedis {
  private store = new Map<string, { value: string; expiresAt: number }>();

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) { this.store.delete(key); return null; }
    return entry.value;
  }

  async set(key: string, value: string, _ex: 'EX', ttl: number): Promise<'OK'> {
    this.store.set(key, { value, expiresAt: Date.now() + ttl * 1000 });
    return 'OK';
  }

  async del(...keys: string[]): Promise<number> {
    let n = 0;
    for (const k of keys) { if (this.store.delete(k)) n++; }
    return n;
  }

  async scan(_cursor: string, _match: string, _pattern: string, _count: string, _n: number): Promise<[string, string[]]> {
    return ['0', []];
  }

  async ping(): Promise<'PONG'> { return 'PONG'; }

  clear(): void { this.store.clear(); }
}

// ─── Stub RuleEngineClient ────────────────────────────────────────────────────

function makeStubClient(response: RuleEngineInsightsResponse): RuleEngineClient {
  return {
    fetchInsights: vi.fn().mockResolvedValue(response),
  } as unknown as RuleEngineClient;
}

// ─── App builder ──────────────────────────────────────────────────────────────

async function buildTestApp(
  mem: MemRedis,
  client: RuleEngineClient,
  cacheTtl = 25,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  await app.register(rateLimit, { max: 1000, timeWindow: 60_000 });
  await app.register(jwt, { secret: JWT_SECRET });

  // Cast MemRedis to IORedis for the CacheService constructor.
  // MemRedis implements the small surface we use (get/set/del/scan/ping).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const makeCache = (): CacheService => new CacheService(mem as any, cacheTtl);

  await app.register(insightsRoutes, {
    prefix: '/v1/insights',
    cache: makeCache(),
    ruleEngineClient: client,
    rateLimit: 100,
  });

  await app.register(rootCauseRoutes, {
    prefix: '/v1/root-cause',
    cache: makeCache(),
    ruleEngineClient: client,
    rateLimit: 100,
  });

  await app.register(logsRoutes, {
    prefix: '/v1/logs',
    ingestionUrl: 'http://ingestion-stub:4000',
    rateLimit: 100,
  });

  return app;
}

/** Signs a test JWT for TENANT_ID. */
async function signToken(app: FastifyInstance): Promise<string> {
  return app.jwt.sign({ tenantId: TENANT_ID });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /v1/insights', () => {
  let app: FastifyInstance;
  let mem: MemRedis;
  let client: RuleEngineClient;
  let token: string;

  beforeAll(async () => {
    mem = new MemRedis();
    client = makeStubClient(MOCK_RAW_RESPONSE);
    app = await buildTestApp(mem, client);
    token = await signToken(app);
  });

  afterAll(async () => { await app.close(); });

  it('returns 401 without auth token', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/insights' });
    expect(res.statusCode).toBe(401);
    const body = res.json<{ ok: boolean; error: { code: string } }>();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('returns 200 with ranked insights', async () => {
    mem.clear();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/insights',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ ok: boolean; data: { insights: unknown[]; tenantId: string; fromCache: boolean } }>();
    expect(body.ok).toBe(true);
    expect(body.data.tenantId).toBe(TENANT_ID);
    expect(body.data.insights).toHaveLength(2);
    expect(body.data.fromCache).toBe(false);
  });

  it('respects limit query param', async () => {
    mem.clear();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/insights?limit=1',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { insights: unknown[] } }>();
    expect(body.data.insights).toHaveLength(1);
  });

  it('filters by service', async () => {
    mem.clear();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/insights?service=checkout',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { insights: unknown[]; service: string } }>();
    // Only ins-2 has signal.service === 'checkout'
    expect(body.data.insights).toHaveLength(1);
    expect(body.data.service).toBe('checkout');
  });

  it('serves from cache on second request', async () => {
    mem.clear();
    const fetchInsights = vi.spyOn(client, 'fetchInsights');

    // First request — cache miss
    await app.inject({
      method: 'GET',
      url: '/v1/insights',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(fetchInsights).toHaveBeenCalledTimes(1);

    // Small wait so cache.set completes (it's fire-and-forget)
    await new Promise((r) => setTimeout(r, 10));

    // Second request — cache hit
    const res2 = await app.inject({
      method: 'GET',
      url: '/v1/insights',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(fetchInsights).toHaveBeenCalledTimes(1); // no second call
    const body2 = res2.json<{ data: { fromCache: boolean } }>();
    expect(body2.data.fromCache).toBe(true);
  });

  it('returns 400 for invalid limit', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/insights?limit=999',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /v1/root-cause', () => {
  let app: FastifyInstance;
  let mem: MemRedis;
  let token: string;

  beforeAll(async () => {
    mem = new MemRedis();
    const client = makeStubClient(MOCK_RAW_RESPONSE);
    app = await buildTestApp(mem, client);
    token = await signToken(app);
  });

  afterAll(async () => { await app.close(); });

  it('returns 401 without auth token', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/root-cause' });
    expect(res.statusCode).toBe(401);
  });

  it('returns root cause from top insight', async () => {
    mem.clear();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/root-cause',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      ok: boolean;
      data: {
        rootCause: {
          ruleId: string;
          severity: string;
          recommendations: string[];
          affectedComponents: string[];
          timeline: { detectedAt: string };
        } | null;
        supporting: unknown[];
      };
    }>();
    expect(body.ok).toBe(true);
    expect(body.data.rootCause).not.toBeNull();
    expect(body.data.rootCause?.ruleId).toBe('latency-p95-spike');
    expect(body.data.rootCause?.severity).toBe('critical');
    expect(body.data.rootCause?.recommendations.length).toBeGreaterThan(0);
    expect(body.data.rootCause?.affectedComponents.length).toBeGreaterThan(0);
    expect(body.data.rootCause?.timeline.detectedAt).toBe('2026-04-17T09:59:00.000Z');
    expect(body.data.supporting).toHaveLength(1); // ins-2
  });

  it('returns null rootCause when no insights', async () => {
    mem.clear();
    const emptyClient = makeStubClient({ ...MOCK_RAW_RESPONSE, insights: [] });
    const emptyApp = await buildTestApp(new MemRedis(), emptyClient);
    const emptyToken = await signToken(emptyApp);

    const res = await emptyApp.inject({
      method: 'GET',
      url: '/v1/root-cause',
      headers: { authorization: `Bearer ${emptyToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { rootCause: null } }>();
    expect(body.data.rootCause).toBeNull();
    await emptyApp.close();
  });

  it('serves from cache on second call', async () => {
    mem.clear();
    const client = makeStubClient(MOCK_RAW_RESPONSE);
    const appC = await buildTestApp(mem, client);
    const tokenC = await signToken(appC);

    await appC.inject({ method: 'GET', url: '/v1/root-cause', headers: { authorization: `Bearer ${tokenC}` } });
    await new Promise((r) => setTimeout(r, 10));

    const res2 = await appC.inject({ method: 'GET', url: '/v1/root-cause', headers: { authorization: `Bearer ${tokenC}` } });
    const body2 = res2.json<{ data: { fromCache: boolean } }>();
    expect(body2.data.fromCache).toBe(true);
    await appC.close();
  });
});

describe('POST /v1/logs', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = await buildTestApp(new MemRedis(), makeStubClient(MOCK_RAW_RESPONSE));
    token = await signToken(app);
  });

  afterAll(async () => { await app.close(); });

  it('returns 401 without auth token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/logs',
      payload: { entries: [{ service: 'checkout', level: 'info', message: 'hello' }] },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 422 for missing required fields', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/logs',
      headers: { authorization: `Bearer ${token}` },
      payload: { entries: [{ level: 'info', message: 'missing service' }] },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json<{ ok: boolean; error: { code: string } }>();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 422 for empty entries array', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/logs',
      headers: { authorization: `Bearer ${token}` },
      payload: { entries: [] },
    });
    expect(res.statusCode).toBe(422);
  });

  it('returns 503 when ingestion is unreachable', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/logs',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        entries: [{ service: 'checkout', level: 'error', message: 'payment failed' }],
      },
    });
    // The stub ingestion URL (http://ingestion-stub:4000) is unreachable in tests
    expect(res.statusCode).toBe(503);
    const body = res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('INSIGHTS_UNAVAILABLE');
  });
});

describe('Response envelope shape', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = await buildTestApp(new MemRedis(), makeStubClient(MOCK_RAW_RESPONSE));
    token = await signToken(app);
  });

  afterAll(async () => { await app.close(); });

  it('success envelope has ok:true and data', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/insights',
      headers: { authorization: `Bearer ${token}` },
    });
    const body = res.json<Record<string, unknown>>();
    expect(body).toHaveProperty('ok', true);
    expect(body).toHaveProperty('data');
    expect(body).not.toHaveProperty('error');
  });

  it('error envelope has ok:false, error.code, error.message', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/insights' });
    const body = res.json<{ ok: boolean; error: { code: string; message: string } }>();
    expect(body.ok).toBe(false);
    expect(typeof body.error.code).toBe('string');
    expect(typeof body.error.message).toBe('string');
  });
});
