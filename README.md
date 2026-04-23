# Relevix

> **Real-time infrastructure intelligence platform** — turns raw service logs into ranked, AI-explained insights via a streaming signal-processing pipeline.

---

## Table of Contents

1. [What Is Relevix?](#what-is-relevix)
2. [Architecture](#architecture)
3. [Data Flow](#data-flow)
4. [Repository Structure](#repository-structure)
5. [Prerequisites](#prerequisites)
6. [Quick Start](#quick-start)
7. [Full Setup](#full-setup)
8. [Environment Variables](#environment-variables)
9. [API Reference](#api-reference)
10. [Running Tests](#running-tests)
11. [Feature Status](#feature-status)
12. [Container Deployment](#container-deployment)
13. [Contributing](#contributing)

---

## What Is Relevix?

Relevix ingests structured logs from any service, runs them through a streaming signal-processing pipeline, evaluates configurable rules against computed statistical signals, and surfaces ranked insights to on-call engineers — with optional AI-generated root-cause summaries.

**Core value proposition:**
- Ingest thousands of log events per second via Kafka
- Detect anomalies using Welford's online algorithm (no historical data warmup required)
- Evaluate rule conditions in microseconds using pre-computed signal windows
- Serve ranked insights with sub-200 ms p99 latency via a Redis cache layer
- Present everything in a live React dashboard with an optional GPT-4o summary

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                              CLIENT PLANE                                    │
│                                                                              │
│   Dashboard (React/Vite :5173)          CLI (apps/cli)                       │
│   MCP Server (apps/mcp-server)          External SDKs / curl                 │
└──────────────────────────┬───────────────────────────────────────────────────┘
                           │ HTTPS / JWT
┌──────────────────────────▼───────────────────────────────────────────────────┐
│                     API GATEWAY (Node/Fastify :3000)                         │
│                                                                              │
│  /v1/logs        → forwards to Ingestion Service                             │
│  /v1/insights    → Redis cache → Rule Engine                                 │
│  /v1/rules       → Postgres                                                  │
│  /v1/explain     → OpenAI GPT-4o-mini (or rule-based fallback)               │
│  /v1/analytics   → Postgres raw_logs (dashboard charts)                      │
│  /v1/search      → Elasticsearch (optional)                                  │
└───────┬──────────────────┬───────────────────────────────────────────────────┘
        │                  │
        ▼                  ▼
┌───────────────┐  ┌──────────────────────────────────────────────────────────┐
│   Ingestion   │  │           Rule Engine (Go :8080)                         │
│  (Go :4000)   │  │                                                          │
│               │  │  Precompute tick (every 30s):                            │
│  HTTP intake  │  │    Postgres → signals → evaluate all rules               │
│  → normalize  │  │    → write insights back to Postgres                     │
│  → batch      │  │    → invalidate Redis cache                              │
│  → Kafka      │  │                                                          │
└──────┬────────┘  └──────────────────────────────────────────────────────────┘
       │                         ▲
       ▼                         │ reads signals
┌──────────────┐       ┌─────────────────────────────────────────────────────┐
│    Kafka     │       │       Signal Processor (Go :4001)                   │
│   :9092      │       │                                                     │
│              │──────►│  Kafka consumer → tumbling/sliding windows          │
│  topics:     │       │  → Welford's online stats (mean, variance)          │
│  raw-events  │       │  → p95/p99 via reservoir sampling                   │
│  signals     │       │  → write aggregated signals to Postgres             │
└──────────────┘       └─────────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────┐  ┌──────────────────┐  ┌─────────────────┐
│   PostgreSQL    │  │      Redis       │  │ Elasticsearch   │
│   :5432         │  │      :6379       │  │   :9200         │
│                 │  │                 │  │  (optional)     │
│  raw_logs       │  │  insights cache │  │  full-text      │
│  signals        │  │  rate-limit     │  │  insight search │
│  rules          │  │  dedup          │  │                 │
│  insights       │  │                 │  │                 │
│  tenants        │  │                 │  │                 │
└─────────────────┘  └──────────────────┘  └─────────────────┘
```

---

## Data Flow

### Step-by-step: raw log → dashboard insight

```
1. Service emits a structured log (JSON: service, level, message, latency_ms, …)

2. POST /v1/logs  (or direct Kafka produce)
   └─► Ingestion Service
         - HTTP intake validates and queues the event
         - Worker pool normalises fields (timestamp, severity, tenant_id)
         - Batcher accumulates events (default 500 / 1 s) → KafkaWriter
         - Published to topic: raw-events

3. Signal Processor consumes raw-events
   └─► For each service × signal_kind window:
         - Tumbling 1-min windows + sliding 5-min windows
         - Welford's online algorithm → running mean & variance (no warmup needed)
         - Reservoir sampling (size 1,000) → p95, p99
         - Writes rows to signals table in Postgres

4. Rule Engine precompute tick (every 30 s)
   └─► Fetches all active rules from Postgres (hot-reload on schema change)
       Fetches latest signals per service per tenant
       Evaluates each rule's conditions (ALL | ANY | MIN_N logic)
       Computes confidence score (base + modifier chain)
       Deduplicates against open insights (Redis dedup key + window)
       Writes new/updated insights to Postgres
       Publishes invalidation event → Redis keyspace

5. API Gateway serves insights
   └─► GET /v1/insights
         Cache hit  → Redis GET → ~5 ms response
         Cache miss → Rule Engine HTTP /evaluate → ~180 ms response
                    → write result to Redis (25 s TTL)

6. Dashboard polls every 30 s
   └─► Ranked insights, timeline chart, error table, AI summary (on demand)
```

---

## Repository Structure

```
relevix/
├── apps/
│   ├── api-gateway/          Node.js 24 / Fastify 4 — unified REST gateway
│   │   ├── src/
│   │   │   ├── app.ts        buildApp() — registers plugins, routes, error handler
│   │   │   ├── main.ts       bootstrap, graceful shutdown, Redis connect
│   │   │   ├── middleware/
│   │   │   │   └── auth.ts   JWT verify, tenant extraction
│   │   │   ├── plugins/
│   │   │   │   └── redis.ts  Fastify Redis plugin (ioredis)
│   │   │   ├── routes/
│   │   │   │   ├── health.ts           GET /health
│   │   │   │   ├── ingest.ts           POST /v1/ingest
│   │   │   │   ├── logs.ts             POST /v1/logs
│   │   │   │   ├── insights.ts         GET /v1/insights
│   │   │   │   ├── rules.ts            GET /v1/rules
│   │   │   │   ├── root-cause.ts       GET /v1/explain
│   │   │   │   └── analytics.ts        GET /v1/analytics/errors|timeline
│   │   │   └── services/
│   │   │       ├── cache.ts               Redis cache helpers
│   │   │       ├── rule-engine-client.ts  HTTP client for Go rule engine
│   │   │       └── insight-repository.ts  Postgres insight queries
│   │   └── tests/
│   │       └── intelligence.test.ts  Vitest integration tests (9 flows)
│   │
│   ├── dashboard/            React 18 / Vite 5 / Recharts — live UI (:5173)
│   │   └── src/
│   │       ├── components/
│   │       │   ├── Dashboard.tsx       4-panel layout
│   │       │   ├── InsightCard.tsx     Ranked insight with rule resolution
│   │       │   ├── AiSummaryPanel.tsx  GPT-4o summary panel
│   │       │   ├── TimelineChart.tsx   Area chart (errors + warnings / minute)
│   │       │   └── ErrorsPanel.tsx     Top errors ranked by occurrence
│   │       ├── hooks/
│   │       │   ├── useInsights.ts   Polls /v1/insights every 30 s
│   │       │   ├── useRules.ts      Fetches /v1/rules once → UUID→name map
│   │       │   ├── useAnalytics.ts  Polls /v1/analytics/* every 30 s
│   │       │   └── useExplain.ts    On-demand /v1/explain call
│   │       └── api/client.ts        Typed API client (fetch + JWT header)
│   │
│   ├── cli/                  Node CLI — manual ingest, token generation
│   └── mcp-server/           Model Context Protocol server for AI agent use
│
├── libs/
│   ├── config/    Zod-validated env config (fail-fast at startup)
│   ├── errors/    Typed error classes (ValidationError, InsightsUnavailableError…)
│   ├── logger/    Pino logger factory (structured JSON output)
│   └── types/     Shared TypeScript interfaces (LogEntry, RankedInsight, Rule…)
│
├── services/
│   ├── ingestion/            Go 1.22 — HTTP intake → normalise → Kafka
│   │   └── internal/
│   │       ├── handler/      HTTP handler (POST /ingest, health check)
│   │       ├── pipeline/     Normaliser, Batcher, WorkerPool
│   │       ├── output/       KafkaWriter, in-memory fallback queue
│   │       └── retry/        Exponential backoff retry worker
│   │
│   ├── rule-engine/          Go 1.22 — rule evaluation + precompute loop
│   │   ├── internal/
│   │   │   ├── engine/       Evaluator, condition_v2, dedup, confidence scoring
│   │   │   ├── precompute/   30 s tick: fetch signals → evaluate → write insights
│   │   │   ├── scorer/       Confidence modifier chain
│   │   │   └── domain/       Rule, InfraRule value objects
│   │   └── rules/
│   │       └── infra.rules.yml   5 default infrastructure rule definitions
│   │
│   └── signal-processor/     Go 1.22 — Kafka consumer → windowed stats → Postgres
│       └── internal/
│           ├── aggregator/   Per-service signal aggregation
│           ├── baseline/     Welford's online algorithm (mean, variance, stddev)
│           ├── window/       Tumbling + sliding window management
│           └── intake/       Kafka consumer (raw-events topic)
│
├── scripts/
│   ├── db/
│   │   ├── 001_schema.sql       Full Postgres schema (idempotent)
│   │   ├── 002_seed_rules.sql   5 default infrastructure rules
│   │   └── init-all.sh          Runs schema + seed in sequence
│   ├── seed.mjs                 Seeds tenants and sample insights
│   ├── load-real-data.mjs       Bulk-inserts 302 k sample log events
│   ├── gen-dev-token.mjs        Generates a signed JWT for local dev
│   ├── setup-kafka.sh           Creates Kafka topics
│   └── setup-elasticsearch.mjs  Creates ES index + mapping
│
├── podman-compose.yml           Production-like container stack
├── podman-compose.dev.yml       Dev variant (source mounts, no rebuild)
├── turbo.json                   Turborepo task graph
├── pnpm-workspace.yaml          PNPM workspace config (apps/*, libs/*)
├── tsconfig.base.json           Shared strict TS config (ES2022, NodeNext)
├── eslint.config.mjs            Flat ESLint config
└── Makefile                     Developer convenience targets
```

---

## Prerequisites

| Tool | Version | Install |
|---|---|---|
| Node.js | ≥ 20 (24 recommended) | `nvm use 24` |
| pnpm | ≥ 9 | `npm i -g pnpm` |
| Go | ≥ 1.22 | `brew install go` |
| PM2 | any | `npm i -g pm2` |
| PostgreSQL | 16 | `brew install postgresql@16` |
| Redis | 7 | `brew install redis` |
| Kafka | 3.6+ | via Podman compose (optional for dev) |
| Podman | ≥ 4.7 | `brew install podman` (optional) |

> **macOS / Apple Silicon:** Go binaries built with `CGO_ENABLED=0` may require codesigning. If you see "operation not permitted", run: `codesign --sign - ./bin/<binary>`

---

## Quick Start

```bash
# 1. Clone and install
git clone https://github.com/your-org/relevix.git && cd relevix
pnpm install

# 2. Start Postgres and Redis
brew services start postgresql@16
brew services start redis

# 3. Initialise the database
psql "$DATABASE_URL" -f scripts/db/001_schema.sql
psql "$DATABASE_URL" -f scripts/db/002_seed_rules.sql
node scripts/seed.mjs

# 4. Build Go services
make go-build

# 5. Start everything via PM2
pm2 start ecosystem.config.cjs
pm2 logs --lines 20
```

Open the dashboard: **http://localhost:5173**

---

## Full Setup

### 1. Environment files

```bash
cp .env.example .env
cp apps/api-gateway/.env.example apps/api-gateway/.env
cp apps/dashboard/.env.local.example apps/dashboard/.env.local
```

#### Root `.env`

```dotenv
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/relevix
REDIS_URL=redis://:@localhost:6379
JWT_SECRET=<min 32 chars — must match api-gateway .env>
```

> **Important:** Use `127.0.0.1`, not `localhost` for Postgres on macOS to avoid IPv6 (`::1`) resolution issues.

#### `apps/api-gateway/.env`

```dotenv
PORT=3000
SERVICE_NAME=api-gateway
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/relevix
REDIS_URL=redis://:@localhost:6379
JWT_SECRET=<same as root .env>
JWT_EXPIRES_IN=15m
RULE_ENGINE_URL=http://localhost:8080
INGESTION_URL=http://localhost:4000
CORS_ORIGINS=http://localhost:5173,http://localhost:3000

# Optional features
AI_NARRATOR_ENABLED=true
OPENAI_API_KEY=sk-...
ELASTICSEARCH_URL=http://localhost:9200
```

#### `apps/dashboard/.env.local`

```dotenv
VITE_DEV_TOKEN=<JWT from scripts/gen-dev-token.mjs>
```

```bash
node scripts/gen-dev-token.mjs   # prints a signed JWT
```

### 2. Database

```bash
psql "$DATABASE_URL" -f scripts/db/001_schema.sql   # schema (idempotent)
psql "$DATABASE_URL" -f scripts/db/002_seed_rules.sql
node scripts/seed.mjs                               # tenant + sample insights
node scripts/load-real-data.mjs                     # optional: 302 k log events
```

### 3. Go services

```bash
make go-build

# Apple Silicon — codesign if needed
codesign --sign - services/rule-engine/bin/rule-engine
codesign --sign - services/ingestion/bin/ingestion
codesign --sign - services/signal-processor/bin/signal-processor
```

### 4. PM2

```bash
pm2 start ecosystem.config.cjs
pm2 status
pm2 restart api-gateway --update-env   # after .env changes
```

### 5. Kafka (full pipeline)

```bash
podman compose -f podman-compose.dev.yml up kafka -d
bash scripts/setup-kafka.sh
pm2 start ecosystem.config.cjs --only ingestion,signal-processor
```

### 6. Elasticsearch (search endpoint)

```bash
podman compose -f podman-compose.dev.yml up elasticsearch -d
node scripts/setup-elasticsearch.mjs
```

---

## Environment Variables

All services validate their configuration with Zod at startup. Missing required variables cause an immediate crash with a descriptive error — never silent misconfiguration.

### Shared (all services)

| Variable | Required | Default | Description |
|---|---|---|---|
| `NODE_ENV` | No | `development` | Runtime environment |
| `LOG_LEVEL` | No | `info` | Pino log level |
| `SERVICE_NAME` | **Yes** | — | Used in structured logs and traces |
| `OTEL_ENABLED` | No | `false` | Enable OpenTelemetry |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | No | — | OTLP collector URL |

### API Gateway

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | No | `3000` | HTTP listen port |
| `JWT_SECRET` | **Yes** | — | HMAC-SHA256 key (min 32 chars) |
| `JWT_EXPIRES_IN` | No | `15m` | Token TTL |
| `DATABASE_URL` | **Yes** | — | Postgres connection string |
| `REDIS_URL` | **Yes** | — | Redis connection string |
| `RULE_ENGINE_URL` | **Yes** | — | Go rule engine base URL |
| `INGESTION_URL` | **Yes** | — | Go ingestion service base URL |
| `CORS_ORIGINS` | No | `http://localhost:3000` | Comma-separated allowed origins |
| `RATE_LIMIT_MAX` | No | `200` | Global req/min limit |
| `INTELLIGENCE_CACHE_TTL_SECONDS` | No | `25` | Redis TTL for insight cache |
| `AI_NARRATOR_ENABLED` | No | `false` | Enable AI root-cause summaries |
| `OPENAI_API_KEY` | No | — | Required when AI_NARRATOR_ENABLED=true |
| `ELASTICSEARCH_URL` | No | `http://localhost:9200` | Search backend |

---

## API Reference

All routes except `/health` require a signed JWT:

```
Authorization: Bearer <token>
```

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check (no auth) |
| `POST` | `/v1/logs` | Batch ingest logs (max 500, 1 MB) |
| `POST` | `/v1/ingest` | Single event direct ingest |
| `GET` | `/v1/insights` | Ranked insights (`?service=&limit=`) |
| `GET` | `/v1/rules` | List all active rules |
| `GET` | `/v1/explain` | AI root-cause summary (`?service=`) |
| `GET` | `/v1/analytics/errors` | Top errors by service+message (`?service=&hours=`) |
| `GET` | `/v1/analytics/timeline` | Error/warn counts per minute (`?service=&hours=`) |
| `GET` | `/v1/search` | Full-text insight search via ES (`?q=&service=&limit=`) |

**Latency targets:**

| Route | Cache hit | Cache miss |
|---|---|---|
| `/v1/insights` | ~5 ms | ~180 ms |
| `/v1/analytics/*` | ~10 ms | ~50 ms |
| `/v1/search` | ~10 ms | <100 ms (ES timeout enforced) |

---

## Running Tests

### TypeScript (Vitest)

```bash
pnpm turbo run test               # all packages

cd apps/api-gateway
pnpm test                         # 9 integration flows
pnpm test --coverage              # with V8 coverage
```

### Go

```bash
make go-test                      # all services, race detector, coverage

cd services/rule-engine
CGO_ENABLED=0 go test ./... -race -cover -v
```

### Lint + Type check

```bash
make lint
make typecheck
make go-lint      # requires golangci-lint
```

---

## Feature Status

| Feature | Status | Notes |
|---|---|---|
| API Gateway | ✅ Running | Fastify, JWT auth, rate-limit, Redis cache |
| Rule Engine | ✅ Running | Precompute tick, condition evaluation, dedup |
| Dashboard UI | ✅ Running | Insights, AI panel, timeline chart, error table |
| Postgres schema | ✅ Complete | raw_logs, signals, rules, insights, tenants |
| Ingestion Service | 🟡 Built | Requires Kafka to be running |
| Signal Processor | 🟡 Built | Requires Kafka to be running |
| Kafka pipeline | 🔴 Optional | `podman compose -f podman-compose.dev.yml up kafka` |
| Elasticsearch search | 🔴 Optional | Start ES + run `setup-elasticsearch.mjs` |
| OpenAI AI summaries | 🔴 Optional | Set `OPENAI_API_KEY` in gateway `.env` |
| CLI | 🟡 Built | `apps/cli/` — not in default PM2 ecosystem |
| MCP Server | 🟡 Built | Update `RELEVIX_API_URL` to `:3000` |
| OpenTelemetry | 🟡 Plumbed | Set `OTEL_ENABLED=true` + OTLP endpoint |

---

## Container Deployment

Relevix ships OCI-compatible Containerfiles (work with both Podman and Docker).

### Dev stack

```bash
podman compose -f podman-compose.dev.yml up
```

### Production-like stack

```bash
make podman-build   # build all images
make podman-up      # start full stack
make podman-logs    # tail logs
make podman-down    # stop
```

### Individual images

```bash
make podman-build-api
make podman-build-rule-engine
make podman-build-ingestion
```

---

## Contributing

1. Fork and create a feature branch: `git checkout -b feat/my-feature`
2. `make lint && make typecheck` must pass before opening a PR
3. Add tests: Vitest for Node, `go test` for Go
4. Run `make go-test && pnpm turbo run test` to verify all suites pass
5. Keep commits atomic with descriptive messages

### Monorepo conventions

- **Node packages** live in `apps/` or `libs/`, managed by PNPM workspaces + Turborepo
- **Go services** live in `services/` — each has its own `go.mod` (independent module, no shared Go code between services)
- **Shared TypeScript types** belong in `libs/types` — never define API shapes in app code
- **Config validation** always uses `libs/config` Zod schemas — no bare `process.env.X` outside the config loader
- **Secrets** must never have defaults in Zod schemas — a missing secret will crash the service at startup with a clear message

### Architectural invariants

- `setErrorHandler` must be registered **before** routes in Fastify (registering after silently no-ops)
- Use `127.0.0.1` (not `localhost`) for Postgres in `.env` on macOS to avoid IPv6 resolution
- The Go rule engine uses `StaticFetcher` in dev mode (no Kafka required) — switch to the Kafka fetcher in production
- Redis insight cache TTL (25 s default) is intentionally shorter than the precompute tick (30 s) so each tick always refreshes a stale cache
- `CGO_ENABLED=0` is required for all Go builds to produce static binaries suitable for scratch/distroless containers
