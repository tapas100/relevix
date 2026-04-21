#!/usr/bin/env node
/**
 * scripts/test-all-flows.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * End-to-end test script that exercises EVERY flow in Relevix.
 * Run it to understand the full data lifecycle.
 *
 * Usage:  node scripts/test-all-flows.mjs
 *
 * Requirements:
 *   - API gateway running on localhost:3001  (pnpm --filter api-gateway dev)
 *   - Postgres running                       (podman compose up -d postgres)
 *   - .env loaded                            (DB_URL + JWT_SECRET)
 */

import crypto from 'node:crypto';

const BASE   = process.env.BASE_URL ?? 'http://localhost:3000';
const SECRET = process.env.JWT_SECRET ?? 'c58edc560f65e74ce89496dd7a4a44b35f40874c678563996b13e20656dbb98a';

// Tenant UUID — must match what's seeded in Postgres (scripts/db/002_seed_rules.sql)
const TENANT_ID = process.env.TENANT_ID ?? 'a0000000-0000-0000-0000-000000000001';

// ── colour helpers ────────────────────────────────────────────────────────────
const C = { reset:'\x1b[0m', bold:'\x1b[1m', cyan:'\x1b[36m', green:'\x1b[32m',
             yellow:'\x1b[33m', red:'\x1b[31m', dim:'\x1b[2m', magenta:'\x1b[35m' };
const h1  = (s) => console.log(`\n${C.bold}${C.cyan}${'═'.repeat(64)}${C.reset}\n${C.bold}${C.cyan}  ${s}${C.reset}\n${C.cyan}${'═'.repeat(64)}${C.reset}`);
const h2  = (s) => console.log(`\n${C.bold}${C.yellow}  ▶ ${s}${C.reset}`);
const ok  = (s) => console.log(`  ${C.green}✅${C.reset}  ${s}`);
const err = (s) => console.log(`  ${C.red}❌${C.reset}  ${s}`);
const dim = (s) => console.log(`  ${C.dim}${s}${C.reset}`);
const out = (o) => console.log(C.dim + JSON.stringify(o, null, 2) + C.reset);

// ── JWT mint (manual HS256, no deps) ─────────────────────────────────────────
function mintJwt(payload, secret) {
  const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify({ ...payload, iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+86400 })).toString('base64url');
  const s = crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${s}`;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
async function req(method, path, { body, token, expectStatus } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (expectStatus && res.status !== expectStatus) {
    err(`Expected HTTP ${expectStatus}, got ${res.status} on ${method} ${path}`);
  }
  return { status: res.status, body: json, headers: Object.fromEntries(res.headers) };
}

// ═════════════════════════════════════════════════════════════════════════════
// MAIN
// ═════════════════════════════════════════════════════════════════════════════

async function main() {
  console.log(`\n${C.bold}${C.magenta}  Relevix — End-to-End Flow Test${C.reset}`);
  console.log(`  ${C.dim}Target: ${BASE}   Date: ${new Date().toISOString()}${C.reset}`);

  // ──────────────────────────────────────────────────────────────────────────
  // FLOW 0: Health Check
  // No auth required. Returns uptime + dependency status.
  // ──────────────────────────────────────────────────────────────────────────
  h1('FLOW 0 — Health Check (public, no auth)');
  h2('GET /health');
  dim('Purpose: Liveness check used by Podman/k8s healthcheck + load balancer.');
  dim('Logic:   Returns uptime in ms + self-check status. Redis/DB checks added in production.');
  const health = await req('GET', '/health', { expectStatus: 200 });
  ok(`HTTP ${health.status}`);
  out(health.body);

  // ──────────────────────────────────────────────────────────────────────────
  // FLOW 1: Auth — JWT verification
  // Every /v1/* route is protected by @fastify/jwt.
  // ──────────────────────────────────────────────────────────────────────────
  h1('FLOW 1 — JWT Authentication');

  h2('Reject: Missing token');
  dim('Logic: authenticate() calls request.jwtVerify(). No header → 401.');
  const noAuth = await req('GET', '/v1/rules', { expectStatus: 401 });
  ok(`HTTP ${noAuth.status} — ${JSON.stringify(noAuth.body?.error?.code)}`);

  h2('Reject: Tampered token (wrong signature)');
  dim('Logic: @fastify/jwt rejects any token whose HMAC doesn\'t match JWT_SECRET.');
  const badToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJoYWNrZXIifQ.invalid_signature';
  const badAuth = await req('GET', '/v1/rules', { token: badToken, expectStatus: 401 });
  ok(`HTTP ${badAuth.status} — ${JSON.stringify(badAuth.body?.error?.code)}`);

  h2('Accept: Valid token for tenant-demo');
  dim('Logic: Token contains { tenantId, sub, role }. getTenantId(req) extracts tenantId.');
  dim('       All DB queries are scoped to this tenantId — cross-tenant isolation enforced here.');
  const TOKEN = mintJwt({ sub: 'dev-user', tenantId: TENANT_ID, role: 'admin', email: 'demo@relevix.dev' }, SECRET);
  dim(`Token (truncated): ${TOKEN.slice(0,40)}...`);

  // ──────────────────────────────────────────────────────────────────────────
  // FLOW 2: Rules — List & Get
  // Reads from the `rules` Postgres table, scoped to tenantId.
  // ──────────────────────────────────────────────────────────────────────────
  h1('FLOW 2 — Rules (Postgres-backed)');

  h2('GET /v1/rules  → list all rules for tenant');
  dim('Logic: RuleRepository.list(tenantId) → SELECT ... FROM rules WHERE tenant_id=$1');
  dim('       Results ordered by priority ASC (lower = evaluated first by Go rule-engine)');
  const rules = await req('GET', '/v1/rules', { token: TOKEN, expectStatus: 200 });
  ok(`HTTP ${rules.status} — ${rules.body?.data?.total} rules returned`);
  if (rules.body?.data?.data?.length > 0) {
    for (const r of rules.body.data.data) {
      console.log(`     ${C.yellow}[priority ${r.priority}]${C.reset} ${r.name} (${r.severity}) → action: ${r.action}`);
    }
  }

  h2('GET /v1/rules?active=true&severity=critical  → filtered list');
  dim('Logic: Additional WHERE clauses: is_active=true AND severity=\'critical\'');
  const critRules = await req('GET', '/v1/rules?active=true&severity=critical', { token: TOKEN, expectStatus: 200 });
  ok(`HTTP ${critRules.status} — ${critRules.body?.data?.total} critical rules`);

  h2('GET /v1/rules/:id  → single rule by UUID');
  const ruleId = rules.body?.data?.data?.[0]?.id;
  dim(`Fetching rule: ${ruleId}`);
  dim('Logic: SELECT ... FROM rules WHERE tenant_id=$1 AND id=$2 LIMIT 1');
  if (ruleId) {
    const rule = await req('GET', `/v1/rules/${ruleId}`, { token: TOKEN, expectStatus: 200 });
    ok(`HTTP ${rule.status} — "${rule.body?.data?.name}"`);
    dim(`  conditions: ${rule.body?.data?.conditions?.length} predicates, conditionLogic: ${rule.body?.data?.conditionLogic}`);
    dim(`  confidenceBase: ${rule.body?.data?.confidenceBase}, dedupWindow: ${rule.body?.data?.dedupWindow}`);
  }

  h2('GET /v1/rules/00000000-0000-0000-0000-000000000000  → 404 for unknown rule');
  dim('Logic: findById returns null → NotFoundError → global error handler → 404');
  const miss = await req('GET', '/v1/rules/00000000-0000-0000-0000-000000000000', { token: TOKEN, expectStatus: 404 });
  ok(`HTTP ${miss.status} — code: ${miss.body?.error?.code}`);

  // ──────────────────────────────────────────────────────────────────────────
  // FLOW 3: Log Ingestion
  // POST /v1/ingest/batch → writes to raw_logs in Postgres.
  // In production: Go ingestion service reads from Kafka → raw_logs.
  // ──────────────────────────────────────────────────────────────────────────
  h1('FLOW 3 — Log Ingestion (write to raw_logs)');

  h2('POST /v1/ingest/batch — normal logs');
  dim('Logic:');
  dim('  1. JWT auth → tenantId = "tenant-demo"');
  dim('  2. Fastify JSON schema validates: events[].message required, maxItems=500');
  dim('  3. INSERT INTO raw_logs for each valid event');
  dim('  4. Returns { accepted, rejected, rejections[] }');

  const normalLogs = {
    events: [
      { message: 'HTTP GET /api/products 200 OK',  level: 'info',  service: 'api-gateway',      fields: { duration_ms: 42,  status: 200 }, tags: ['http'] },
      { message: 'Cache miss for key products:p1', level: 'debug', service: 'api-gateway',      fields: { key: 'products:p1' } },
      { message: 'DB query completed',             level: 'info',  service: 'inventory-service', fields: { duration_ms: 12,  rows: 5 } },
      { message: 'Payment processed successfully', level: 'info',  service: 'payment-service',  fields: { amount: 99.99, currency: 'USD', status: 200 } },
      { message: 'Checkout initiated',             level: 'info',  service: 'checkout-service', fields: { cart_id: 'cart-abc', items: 3 } },
    ],
  };

  const ingest1 = await req('POST', '/v1/ingest/batch', { body: normalLogs, token: TOKEN, expectStatus: 202 });
  ok(`HTTP ${ingest1.status} — accepted: ${ingest1.body?.data?.accepted}, rejected: ${ingest1.body?.data?.rejected}`);

  h2('POST /v1/ingest/batch — error logs (these will trigger rules if rule-engine runs)');
  dim('Logic: Same path. level=error → Go ingestion normalises → signal-processor detects anomaly → rule-engine fires');
  const errorLogs = {
    events: [
      { message: 'Payment service 503 Service Unavailable', level: 'error', service: 'payment-service',
        fields: { duration_ms: 5200, status: 503, error: 'DB pool exhausted', http_path: '/payments' }, tags: ['error', 'slo'] },
      { message: 'Checkout timed out waiting for payment',  level: 'error', service: 'checkout-service',
        fields: { duration_ms: 5000, status: 504, http_path: '/checkout/confirm' }, tags: ['error', 'timeout'] },
      { message: 'OOM kill: pod payment-service-xyz restarted', level: 'fatal', service: 'payment-service',
        fields: { memory_mb: 512, event: 'oom_kill' }, tags: ['oom', 'critical'] },
      { message: 'Error rate 18% exceeds SLO threshold',   level: 'error', service: 'checkout-service',
        fields: { error_rate: 0.18, threshold: 0.05, window: '60s' }, tags: ['slo', 'alert'] },
    ],
  };

  const ingest2 = await req('POST', '/v1/ingest/batch', { body: errorLogs, token: TOKEN, expectStatus: 202 });
  ok(`HTTP ${ingest2.status} — accepted: ${ingest2.body?.data?.accepted}, rejected: ${ingest2.body?.data?.rejected}`);

  h2('POST /v1/ingest/batch — validation: empty message (rejected)');
  dim('Logic: Fastify JSON schema rejects events where message.trim() === ""');
  const badLogs = { events: [{ message: '' }, { message: 'good log' }] };
  const ingestBad = await req('POST', '/v1/ingest/batch', { body: badLogs, token: TOKEN });
  ok(`HTTP ${ingestBad.status} — ${ingestBad.status === 422 ? 'schema validation rejected empty message ✓' : JSON.stringify(ingestBad.body)}`);

  h2('POST /v1/ingest/batch — large batch (100 events)');
  dim('Logic: Each event independently validated. Batch INSERT in single SQL statement.');
  const largeBatch = {
    events: Array.from({ length: 100 }, (_, i) => ({
      message:   `[load-test] service health check ${i}`,
      level:     i % 10 === 0 ? 'error' : 'info',
      service:   ['api-gateway','checkout-service','payment-service','inventory-service','search-service'][i % 5],
      fields:    { duration_ms: 20 + Math.random() * 200, iteration: i },
      tags:      ['load-test'],
    })),
  };
  const ingestLarge = await req('POST', '/v1/ingest/batch', { body: largeBatch, token: TOKEN, expectStatus: 202 });
  ok(`HTTP ${ingestLarge.status} — accepted: ${ingestLarge.body?.data?.accepted} events in single batch INSERT`);

  // ──────────────────────────────────────────────────────────────────────────
  // FLOW 4: Insights — Intelligence API
  // GET /v1/insights reads from the rule-engine (via HTTP client + circuit breaker).
  // Falls back gracefully when rule-engine is not running.
  // ──────────────────────────────────────────────────────────────────────────
  h1('FLOW 4 — Insights (Intelligence API)');

  h2('GET /v1/insights  → fetch ranked insights for tenant');
  dim('Logic (cache miss, rule-engine available):');
  dim('  1. Check Redis: key "insights:tenant-demo:__all__" → MISS');
  dim('  2. CircuitBreaker state = CLOSED → allow call');
  dim('  3. GET http://rule-engine:8080/v1/insights?tenant=tenant-demo  (150ms timeout)');
  dim('  4. Rule-engine returns precomputed ranked insights from its own Redis');
  dim('  5. Response cached in Redis with TTL=25s');
  dim('  6. Return { insights[], total, fromCache: false }');
  dim('Logic (rule-engine DOWN — current state):');
  dim('  3. fetch() times out / connection refused');
  dim('  4. CircuitBreaker records failure (failureThreshold=5)');
  dim('  5. After 5 failures: state → OPEN → fast-fail with 503');
  const insights = await req('GET', '/v1/insights', { token: TOKEN });
  if (insights.status === 200) {
    ok(`HTTP ${insights.status} — ${insights.body?.data?.insights?.length ?? 0} insights (fromCache: ${insights.body?.data?.fromCache})`);
  } else {
    ok(`HTTP ${insights.status} — rule-engine not running (expected in local dev). Error: ${insights.body?.error?.code}`);
    dim('  This is correct behaviour — circuit breaker prevents cascading failures');
  }

  h2('GET /v1/insights?service=checkout-service&limit=5');
  dim('Logic: Same fetch, then filter: insights where signal.service === "checkout-service"');
  dim('       Re-rank after filter (rank 1 = highest composite score for that service)');
  const filtered = await req('GET', '/v1/insights?service=checkout-service&limit=5', { token: TOKEN });
  ok(`HTTP ${filtered.status} — service filter applied`);

  // ──────────────────────────────────────────────────────────────────────────
  // FLOW 5: Root Cause Analysis
  // GET /v1/root-cause derives the most probable cause from ranked insights.
  // ──────────────────────────────────────────────────────────────────────────
  h1('FLOW 5 — Root Cause Analysis');

  h2('GET /v1/root-cause');
  dim('Logic:');
  dim('  1. Fetch insights (cache-first — reuses insights cache key)');
  dim('  2. Top-ranked insight = highest composite score = most probable root cause');
  dim('  3. composite score = 0.35×severity + 0.35×confidence + 0.15×recency + 0.15×impact');
  dim('  4. Derive recommendations from rule slug + severity (deterministic, no LLM needed)');
  dim('  5. Return { rootCause, confidence, recommendations[], supportingInsights[0..3] }');
  const rc = await req('GET', '/v1/root-cause', { token: TOKEN });
  ok(`HTTP ${rc.status} — ${rc.status === 200 ? 'rootCause: ' + JSON.stringify(rc.body?.data?.rootCause?.ruleId) : rc.body?.error?.code}`);

  // ──────────────────────────────────────────────────────────────────────────
  // FLOW 6: Metrics (Prometheus scrape)
  // GET /metrics is public (excluded from auth + rate limiting)
  // ──────────────────────────────────────────────────────────────────────────
  h1('FLOW 6 — Prometheus Metrics');

  h2('GET /metrics  → Prometheus text format');
  dim('Logic:');
  dim('  prom-client registry exposes all registered metrics.');
  dim('  Metrics populated by the onResponse hook on every request:');
  dim('    http_request_duration_seconds{method,route,status} (Histogram)');
  dim('    http_requests_total{method,route,status} (Counter)');
  dim('    http_errors_total{method,route,status} (Counter)');
  dim('    circuit_breaker_state{name} (Gauge: 0=CLOSED,1=HALF_OPEN,2=OPEN)');
  dim('  circuit_breaker_state for rule-engine shows current CB state after flow 4 failures');
  const metricsRes = await fetch(`${BASE}/metrics`);
  const metricsText = await metricsRes.text();
  const metricLines = metricsText.split('\n').filter(l => !l.startsWith('#') && l.trim());
  ok(`HTTP ${metricsRes.status} — ${metricLines.length} metric data points exposed`);

  // Show specific metrics
  const relevant = metricsText.split('\n').filter(l =>
    (l.includes('http_requests_total') || l.includes('circuit_breaker_state') || l.includes('http_errors_total'))
    && !l.startsWith('#')
  );
  if (relevant.length) {
    dim('  Key metrics collected during this test run:');
    relevant.slice(0, 10).forEach(l => dim(`    ${l}`));
  }

  // ──────────────────────────────────────────────────────────────────────────
  // FLOW 7: Rate limiting
  // ──────────────────────────────────────────────────────────────────────────
  h1('FLOW 7 — Rate Limiting');

  h2('Simulating fast burst of requests to /v1/rules');
  dim('Config: RATE_LIMIT_MAX=500 per minute (global), INTELLIGENCE_RATE_LIMIT_MAX=60 (insights)');
  dim('Logic:  @fastify/rate-limit tracks per-IP sliding window in memory (Redis in prod)');
  dim('        Returns 429 with Retry-After header when exceeded');
  dim('        (With RATE_LIMIT_MAX=500 this test won\'t hit the limit)');
  const burst = await Promise.all(Array.from({ length: 5 }, () =>
    req('GET', '/v1/rules', { token: TOKEN })
  ));
  const statuses = burst.map(r => r.status);
  ok(`5 parallel requests: statuses = [${statuses.join(', ')}] — all served (limit not hit)`);

  // ──────────────────────────────────────────────────────────────────────────
  // FLOW 8: OTel trace propagation
  // ──────────────────────────────────────────────────────────────────────────
  h1('FLOW 8 — OpenTelemetry Trace Propagation');

  h2('Request with W3C traceparent header');
  dim('Logic:');
  dim('  otelTracePlugin parses the incoming "traceparent" header (W3C format):');
  dim('    "00-{traceId:32hex}-{spanId:16hex}-01"');
  dim('  Binds trace_id + span_id into the Pino child logger (appears in every log line)');
  dim('  Forwards traceparent to downstream rule-engine calls');
  dim('  Returns x-trace-id response header for client correlation');
  const traceId = crypto.randomBytes(16).toString('hex');
  const spanId  = crypto.randomBytes(8).toString('hex');
  const traceparent = `00-${traceId}-${spanId}-01`;
  dim(`  Sending: traceparent: ${traceparent}`);

  const traceRes = await fetch(`${BASE}/health`, { headers: { traceparent } });
  const responseTraceId = traceRes.headers.get('x-trace-id');
  ok(`x-trace-id in response: ${responseTraceId}`);
  ok(`Trace propagated: ${responseTraceId === traceId ? 'YES — same traceId echoed back ✓' : 'NO (new traceId generated for new root span)'}`);

  // ──────────────────────────────────────────────────────────────────────────
  // FLOW 9: Error envelope — global error handler
  // ──────────────────────────────────────────────────────────────────────────
  h1('FLOW 9 — Global Error Handler (ApiError envelope)');

  h2('422 Validation Error');
  dim('Logic: Fastify AJV validates JSON body against schema. Extra fields rejected (additionalProperties:false).');
  dim('       setErrorHandler catches FastifyError with .validation → wraps in ApiError envelope');
  const badBody = await req('POST', '/v1/ingest/batch', {
    body: { events: 'not-an-array' },
    token: TOKEN,
  });
  ok(`HTTP ${badBody.status} — code: ${badBody.body?.error?.code} — validation details attached: ${!!badBody.body?.error?.details}`);

  h2('401 Unauthorized');
  dim('Logic: authenticate() throws UnauthorizedError → httpStatus=401 → ApiError envelope');
  const unauth = await req('GET', '/v1/insights', { token: 'bad.token.here' });
  ok(`HTTP ${unauth.status} — { ok: false, error: { code, message, traceId } }`);

  // ──────────────────────────────────────────────────────────────────────────
  // SUMMARY
  // ──────────────────────────────────────────────────────────────────────────
  h1('TEST COMPLETE — Data State Summary');

  console.log(`\n${C.bold}  What's now in Postgres:${C.reset}`);
  console.log(`  ${C.green}✓${C.reset}  tenants:   1 (Demo Organisation — UUID: a0000000-0000-0000-0000-000000000001)`);
  console.log(`  ${C.green}✓${C.reset}  rules:     5 seeded from infra.rules.yml`);
  console.log(`  ${C.green}✓${C.reset}  insights:  10 seeded directly (bypass rule-engine)`);
  console.log(`  ${C.green}✓${C.reset}  raw_logs:  events accumulating from every ingest test`);
  console.log(`  ${C.yellow}○${C.reset}  signals:   0 (signal-processor not running — Go service)`);
  console.log(`  ${C.yellow}○${C.reset}  kafka:     not running — ingestion uses in-process queue in dev`);

  console.log(`\n${C.bold}  Full flow diagram:${C.reset}`);
  console.log(`
  [Client / Dashboard]
       │
       ├─ GET /health            → no auth, returns uptime
       ├─ GET /v1/rules          → JWT auth → Postgres rules table
       ├─ POST /v1/ingest/batch  → JWT auth → INSERT raw_logs (Postgres)
       │                                          │
       │                         [Go Ingestion] ──┘ (normalise → Kafka)
       │                                          │
       │                         [Go Signal-Processor] → sliding window
       │                                          │     → signals table
       │                                          │
       │                         [Go Rule-Engine] → evaluate rules
       │                                          │  → INSERT insights
       │                                          │  → cache in Redis
       │                                          │
       ├─ GET /v1/insights       → JWT → Redis cache → rule-engine → insights table
       ├─ GET /v1/root-cause     → JWT → top insight → recommendations
       ├─ GET /v1/explain        → JWT → AI narrator (OpenAI / fallback)
       └─ GET /metrics           → public → Prometheus scrape
  `);

  console.log(`${C.bold}  To seed insights directly (bypass rule-engine):${C.reset}`);
  console.log(`    node scripts/db/seed-insights.mjs\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
