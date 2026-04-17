# Relevix — Production Hardening Guide

> Senior SRE reference document. Last updated: 2026-04-17.

---

## Architecture Overview

```
Internet
   │
   ▼
[CDN / WAF / DDoS protection]
   │  (Cloudflare / AWS Shield)
   │
   ▼
[Load Balancer]  ─── TLS termination, health-check routing
   │               (ALB / NGINX / Caddy)
   ├──────────────────────────────────┐
   ▼                                  ▼
[API Gateway :3001]          [Dashboard :5173 (static CDN)]
   │  Fastify 4, JWT auth
   │  Rate limiting, CORS, Helmet
   │  Circuit breaker → Rule Engine
   │  Cache layer (Redis)
   ├── GET  /health         → readiness + liveness probes
   ├── GET  /metrics        → Prometheus scrape (internal only)
   ├── POST /v1/ingest      → Ingestion Service (Go)
   ├── GET  /v1/insights    → Rule Engine (Go) + Redis cache
   ├── GET  /v1/root-cause  → Rule Engine (Go) + Redis cache
   ├── GET  /v1/explain     → Root Cause + OpenAI narrator
   ├── POST /v1/search/insights → Elasticsearch
   └── GET  /v1/logs        → Ingestion Service

[Rule Engine :8080]     [Ingestion :4000]     [Signal Processor :4001]
  Go, precompute          Go, Kafka              Go, Kafka
  Redis cache             consumer               window aggregation

[Redis :6379]   [Postgres :5432]   [Kafka]   [Elasticsearch]

─── Observability Sidecar Stack ──────────────────────────────────────
[Prometheus :9090]  scrapes all /metrics endpoints every 15s
[Alertmanager :9093]  routes alerts → PagerDuty (page) / Slack (warn)
[Grafana Tempo :3200]  receives OTLP traces, queried by Grafana
[Grafana Loki :3100]  receives logs via Promtail, queried by Grafana
[Grafana :3030]  unified dashboards (metrics + traces + logs)
```

---

## 1. Observability

### 1.1 Structured Logging (Pino)

All services emit **newline-delimited JSON** to stdout.

Every log line includes: `level`, `time` (@timestamp ISO-8601), `service`,
`env`, `trace_id`, `span_id`, `requestId`, `tenantId`.

**PII redaction** is applied at the Pino layer before any transport:

| Field | Redacted by |
|---|---|
| `Authorization` header | Pino `redact` config |
| `x-forwarded-for` / `x-real-ip` | Pino `redact` config |
| `email`, `userId`, `password`, `apiKey` | Pino `redact` config |
| `cardNumber`, `cvv` | Pino `redact` config |
| JWT bearer token value | Promtail `replace` stage (belt-and-suspenders) |
| IPv4 addresses in log body | Promtail `replace` stage |

```
GDPR Article 4(1): IP addresses are personal data.
GDPR Article 25:  Data protection by design requires redaction at source.
```

### 1.2 Metrics (Prometheus + Grafana)

Exposed at `GET /metrics` on every service (internal network only).

| Metric | Type | Labels |
|---|---|---|
| `http_request_duration_seconds` | Histogram | method, route, status_code |
| `http_requests_total` | Counter | method, route, status_code |
| `http_errors_total` | Counter | method, route, status_code |
| `circuit_breaker_state` | Gauge | name — 0=CLOSED, 1=HALF_OPEN, 2=OPEN |
| `cache_hits_total` | Counter | namespace |
| `cache_misses_total` | Counter | namespace |
| `openai_requests_total` | Counter | outcome (success/fallback/error/timeout) |
| `openai_tokens_used_total` | Counter | — |

Pre-aggregated recording rules in `infra/prometheus/rules/recording_rules.yml`
produce P50/P99 latency, error rate, cache hit rate, and OpenAI token rate at
30s granularity — cheap to query in dashboards.

### 1.3 Distributed Tracing (Tempo / OTLP)

- Every inbound request generates or propagates a **W3C `traceparent`** header.
- `trace_id` and `span_id` are injected into every Pino log line → logs and
  traces are correlated automatically in Grafana (click a log line → open trace).
- Downstream calls to rule-engine carry `traceparent` so the full request chain
  is visible in a single trace.
- Configure `OTEL_ENABLED=true` + `OTEL_EXPORTER_OTLP_ENDPOINT` for full SDK
  tracing with automatic spans (HTTP, Redis, Postgres).

### 1.4 SLOs and Alerting

| SLO | Target | Alert |
|---|---|---|
| P99 HTTP latency | < 500 ms | `HighP99Latency` (page) |
| P50 HTTP latency | < 100 ms | `ElevatedP50Latency` (warn) |
| 5xx error rate | < 5% | `HighErrorRate` (page) |
| Circuit breaker open | 0 minutes | `CircuitBreakerOpen` (page) |
| Cache hit rate (insights) | > 50% | `LowCacheHitRate` (warn) |
| OpenAI fallback rate | < 30% | `HighOpenAiFallbackRate` (warn) |
| OpenAI tokens/min | < 10 000 | `OpenAiTokenBudgetSpike` (warn) |

---

## 2. Failure Recovery

### 2.1 Circuit Breaker (Rule Engine)

```
CLOSED  ──(5 consecutive failures)──▶  OPEN
OPEN    ──(30 s timeout)────────────▶  HALF_OPEN
HALF_OPEN ──(2 consecutive successes)▶ CLOSED
HALF_OPEN ──(any failure)────────────▶ OPEN
```

Configuration (env vars):

```
CB_FAILURE_THRESHOLD=5      # open after N consecutive failures
CB_RESET_TIMEOUT_MS=30000   # probe after 30 s in OPEN
CB_SUCCESS_THRESHOLD=2      # close after N consecutive successes in HALF_OPEN
```

When the circuit is OPEN, `GET /v1/insights` and `/v1/root-cause` return a
**cached stale value** (Redis TTL) rather than a 503, degrading gracefully.

### 2.2 Retry with Jitter (Rule Engine HTTP client)

```
attempt 0 → failure → wait ~20ms → attempt 1 → failure → wait ~40ms → attempt 2
```

Retries only on transient errors (network / timeout). Non-retryable errors
(4xx, schema mismatch) propagate immediately to prevent amplification.

### 2.3 Redis Failure Mode

The `CacheService.get()` catches all Redis errors and returns `null` (cache
miss). Services fall through to live evaluation — degraded performance but no
downtime.

Redis client retries up to 6 times with exponential back-off (50ms → 2s) before
giving up on a command.

### 2.4 Graceful Shutdown

On `SIGTERM` (Kubernetes `preStop` hook / PM2 scale down):

1. Fastify stops accepting new connections.
2. In-flight requests are drained (Fastify `close()` waits for all handlers).
3. Redis connection is closed cleanly.
4. Process exits 0.

Kubernetes `terminationGracePeriodSeconds: 30` — enough for most request budgets.

### 2.5 Health Probes

```
GET /health/live   → liveness  (process is running, not deadlocked)
GET /health/ready  → readiness (Redis connected, downstream reachable)
```

Kubernetes:
```yaml
livenessProbe:
  httpGet: { path: /health/live, port: 3001 }
  initialDelaySeconds: 5
  periodSeconds: 10

readinessProbe:
  httpGet: { path: /health/ready, port: 3001 }
  initialDelaySeconds: 3
  periodSeconds: 5
  failureThreshold: 3
```

---

## 3. Scaling Strategy

### 3.1 API Gateway (Node.js, stateless)

| Signal | Action |
|---|---|
| CPU > 70% (5 min avg) | Scale out +1 replica |
| `http_request_duration_p99 > 300ms` | Scale out +1 replica |
| `http_requests_total rate < 5 rps per pod` | Scale in -1 replica |

Minimum 2 replicas (HA). Maximum 10 (cost cap).

The gateway is fully stateless — Redis holds all shared state. Horizontal
scaling is safe with no coordination required.

```yaml
# Kubernetes HPA
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: api-gateway
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-gateway
  minReplicas: 2
  maxReplicas: 10
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
    - type: Pods
      pods:
        metric:
          name: http_request_duration_p99
        target:
          type: AverageValue
          averageValue: "0.3"
```

### 3.2 Rule Engine (Go, precomputed)

Precomputed results are stored in Redis — the engine itself is a **read-heavy,
CPU-light** service. Scale by:

1. Increasing `PRECOMPUTE_WORKERS` to parallelise recomputation.
2. Adding replicas — each replica reads from the same Redis precompute cache.
3. The `PRECOMPUTE_LOCK_TTL` prevents redundant work when replicas compete.

### 3.3 Ingestion Service (Go, Kafka consumer group)

Kafka consumer groups automatically distribute partitions across replicas.
Scale by adding replicas up to the Kafka partition count (default: 16).

To increase throughput:
- Increase `WORKER_COUNT` (in-process parallelism).
- Increase `BATCH_SIZE` + `BATCH_FLUSH_INTERVAL` (batching efficiency).
- Add Kafka partitions + replicas together.

### 3.4 Redis

Single primary is sufficient for dev. In production use:
- **Redis Sentinel** (HA without cluster complexity) for < 50 GB working set.
- **Redis Cluster** for > 50 GB or > 100k ops/s.

IORedis client supports both transparently via the `REDIS_URL` scheme:
- `redis://` → standalone
- `redis-sentinel://` → Sentinel
- `redis-cluster://` → Cluster

### 3.5 Elasticsearch

Index sharding strategy:
- `relevix-insights-{tenantId}` — one index per tenant (isolation).
- Primary shards: 2 per index (default). Increase for tenants > 10M docs.
- Replicas: 1 in prod (fault tolerance + read scaling).

Use ILM (Index Lifecycle Management) to roll over and delete old indices:
- Hot phase: SSD, 1 replica, < 30 days.
- Warm phase: HDD, 0 replicas, 30–90 days.
- Delete: > 90 days.

---

## 4. Cost Optimisation

### 4.1 OpenAI Token Budget

| Control | Location | Effect |
|---|---|---|
| `OPENAI_MAX_TOKENS=150` | env | Hard cap per completion |
| `AI_NARRATOR_TIMEOUT_MS=3000` | env | Abort slow calls; use fallback |
| `AI_NARRATOR_ENABLED=false` | env | Disable entirely (100% fallback) |
| `INTELLIGENCE_RATE_LIMIT_MAX=30` | env | Max 30 AI-eligible req/min/IP |
| Redis cache on `/v1/explain` | `INTELLIGENCE_CACHE_TTL_SECONDS` | Deduplicates identical inputs |

Token spend per call: ~350 tokens (200 prompt + 150 completion) = ~$0.000105 at
gpt-4o-mini pricing. At 30 req/min → $0.19/hour max.

Monitor `openai_tokens_used_total` and alert on `OpenAiTokenBudgetSpike`.

### 4.2 Compute Right-Sizing

| Service | Recommended (prod) | Notes |
|---|---|---|
| api-gateway | 0.25 vCPU / 256 MB × 2 pods | Event-loop, low CPU |
| rule-engine | 0.5 vCPU / 512 MB × 2 pods | Precompute is bursty |
| ingestion | 0.25 vCPU / 256 MB × N pods | Scale with Kafka lag |
| signal-processor | 0.5 vCPU / 512 MB × 2 pods | Window aggregation |
| Redis | 1 vCPU / 2 GB | Cache working set |
| Postgres | 2 vCPU / 4 GB | Rules + tenant data |

### 4.3 Cache TTL Strategy

| Cache | TTL | Rationale |
|---|---|---|
| Insights / root-cause | 25 s | Slightly less than precompute tick (30s) |
| Explain (AI narrative) | 25 s | Same — tied to insight freshness |
| Search results | 10 s | Searches are cheaper; fresher is better |

Increasing TTLs reduces rule-engine load and OpenAI spend at the cost of staleness.

### 4.4 Elasticsearch Cost

- Use `_source: false` on fields not needed at query time.
- Enable `best_compression` codec on warm indices.
- Use Snapshot Lifecycle Management to archive to S3 Glacier for cold storage.

---

## 5. Security

### 5.1 Network Segmentation

```
Public zone:   :443 (LB/CDN) → :3001 (gateway) only
Internal zone: gateway ←→ rule-engine, ingestion, Redis, Postgres
Metrics zone:  Prometheus → :3001/metrics, :8080/metrics (no public access)
```

`/metrics` must be behind a network policy that only allows the Prometheus
scraper. Never expose it on the public load balancer.

### 5.2 Authentication & Authorisation

- All `/v1/*` routes require a valid JWT (`Authorization: Bearer <token>`).
- Tokens carry `tenantId` — all data queries are scoped to the tenant.
- Service-to-service calls use short-lived machine tokens (separate `iss` claim).
- `JWT_EXPIRES_IN=15m` — short expiry limits the blast radius of a leaked token.
- Implement a **token rotation endpoint** (`POST /v1/auth/refresh`) backed by
  a Redis allowlist of valid refresh tokens.

### 5.3 Input Validation

- Fastify JSON schema validation on all routes (422 on mismatch).
- Zod validation on config at startup (fail-fast).
- Elasticsearch query uses parameterised `multi_match` — no query injection.
- OpenAI prompt only includes pre-validated structured fields — no raw user input.

### 5.4 Secret Management

| Secret | Storage |
|---|---|
| `JWT_SECRET` | Vault / AWS Secrets Manager / k8s Secret |
| `OPENAI_API_KEY` | Vault / AWS Secrets Manager |
| `ELASTICSEARCH_API_KEY` | Vault / AWS Secrets Manager |
| DB passwords | Vault dynamic credentials |
| Grafana admin password | k8s Secret |

**Never commit secrets to git.** Use `SOPS` or `sealed-secrets` for k8s.

### 5.5 Dependency Supply Chain

```bash
# Audit weekly (add to CI)
pnpm audit --audit-level=high
go list -json -m all | nancy sleuth
```

Pin base images to digest hashes in Containerfiles:
```dockerfile
FROM node:20-alpine@sha256:<digest>
```

### 5.6 CORS Policy

`CORS_ORIGINS` must be an explicit allowlist — never `*` in production.

```
CORS_ORIGINS=https://app.example.com,https://admin.example.com
```

---

## 6. Runbooks

### Circuit breaker open
1. Check `GET /health/ready` on all gateway pods.
2. Check rule-engine logs: `podman logs relevix-rule-engine | grep ERROR`
3. Check Prometheus: `circuit_breaker_state{name="rule-engine"}` should be 0 (CLOSED).
4. Force reset: restart the rule-engine pod; circuit resets to CLOSED on gateway restart.

### High P99 latency
1. Check `job:http_request_duration_p99:5m` per route in Grafana.
2. If `/v1/insights` is slow: check Redis `cache_hit_rate` — cold cache causes rule-engine calls.
3. If rule-engine is slow: check `precompute` lock contention in logs.
4. Scale out gateway if CPU-bound.

### OpenAI cost spike
1. Check `openai_tokens_used_total` rate in Grafana.
2. Check `openai_requests_total{outcome="success"}` vs `{outcome="fallback"}`.
3. If legitimate: increase `INTELLIGENCE_CACHE_TTL_SECONDS`.
4. If runaway: set `AI_NARRATOR_ENABLED=false` and redeploy (zero-downtime).

---

## Quick Start (local)

```bash
# 1. Start infra containers
pnpm podman:up

# 2. Start observability stack
pnpm obs:up

# 3. Start all services
pnpm pm2:start

# 4. Open dashboards
open http://localhost:9090  # Prometheus
open http://localhost:3030  # Grafana (admin / relevix-dev)
open http://localhost:3001/metrics  # raw Prometheus metrics
```
