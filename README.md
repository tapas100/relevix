# Relevix — Distributed Relevance & Rule Engine Platform

Production-grade monorepo for a distributed system built with **Node.js (TypeScript)** and **Go**.

---

## Folder Structure

```
relevix/
├── apps/
│   └── api-gateway/            # Node.js (Fastify) — public REST entrypoint
│       ├── src/
│       │   ├── main.ts         # Bootstrap + graceful shutdown
│       │   ├── app.ts          # Fastify factory (testable)
│       │   └── routes/         # health, rules, ingest
│       ├── Containerfile
│       ├── package.json
│       └── tsconfig.json
│
├── services/
│   ├── rule-engine/            # Go — high-performance rule evaluator
│   │   ├── cmd/server/main.go
│   │   ├── internal/
│   │   │   ├── config/         # Env-based config loader
│   │   │   ├── domain/         # Rule, Condition, EvaluationRequest types
│   │   │   ├── engine/         # Pure evaluation logic + tests
│   │   │   ├── handler/        # HTTP handlers
│   │   │   ├── logger/         # zerolog factory
│   │   │   └── middleware/     # request logging, trace context
│   │   ├── Containerfile
│   │   └── go.mod
│   │
│   └── ingestion/              # Go — high-throughput event ingestion → Kafka
│       ├── cmd/server/main.go
│       ├── internal/
│       │   ├── config/
│       │   ├── domain/         # IngestEvent, BatchRequest
│       │   ├── handler/
│       │   └── logger/
│       ├── Containerfile
│       └── go.mod
│
├── libs/                       # Shared TypeScript packages (workspace:*)
│   ├── types/                  # @relevix/types  — domain contracts
│   ├── config/                 # @relevix/config — Zod-validated env config
│   ├── logger/                 # @relevix/logger — pino structured logger
│   └── errors/                 # @relevix/errors — typed error hierarchy
│
├── podman-compose.yml          # Production stack (Podman)
├── podman-compose.dev.yml      # Dev infra only (Postgres, Redis, Kafka)
├── turbo.json                  # Turborepo task pipeline
├── pnpm-workspace.yaml         # PNPM workspaces
├── tsconfig.base.json          # Shared TS compiler options
├── eslint.config.mjs           # ESLint v9 flat config
├── .env.example                # Environment variable template
└── Makefile                    # Developer convenience commands
```

---

## Architecture Decisions

### 1. Monorepo with Turborepo + PNPM

**Why:** Turborepo provides intelligent caching and parallelism for
`build → typecheck → test` pipelines. PNPM workspaces link local packages
with `workspace:*` — no publishing to npm required during development.
Each package builds independently; Turbo tracks the dependency graph.

### 2. Node.js for API Gateway

**Why Fastify over Express:**
- Fastify is 2–3× faster than Express for JSON throughput.
- Built-in schema validation, plugin architecture, native TypeScript support.
- `@fastify/jwt`, `@fastify/rate-limit`, `@fastify/helmet` are production-ready plugins.

The gateway acts as a **facade** — it authenticates, rate-limits, and
proxies requests to internal Go services. It does not contain business logic.

### 3. Go for Rule Engine & Ingestion

**Why Go:**
- The rule evaluator is a hot path — thousands of evaluations per second.
- Go's goroutine model handles high-concurrency ingestion natively.
- Statically compiled binaries fit into `FROM scratch` Docker images (~10 MB).
- `zerolog` produces zero-allocation structured JSON logs.

Each Go service follows the **standard project layout**:
`cmd/` (entrypoints) + `internal/` (private packages, cannot be imported externally).

### 4. Shared Types Library (`@relevix/types`)

TypeScript types in `libs/types` are the **source of truth** for the API contract.
Go domain types in `internal/domain/*.go` **mirror** these types manually.

> For stricter contract enforcement, generate Go types from a shared
> Protobuf or JSON Schema source (future: `buf` + `protoc-gen-go`).

### 5. Environment-Based Configuration

**Strategy:**
- All config comes from environment variables (12-factor app).
- TypeScript: `@relevix/config` uses **Zod** schemas to validate `process.env` at startup.
- Go: `internal/config/config.go` reads env vars and panics on missing required values.
- Fail-fast — bad config crashes the process before it accepts traffic.
- `.env.example` documents every variable; `.env` is `.gitignore`d.
- Secrets (JWT_SECRET, DB passwords) have **no defaults** — they must be explicitly set.

### 6. Logging Standard

All services emit **newline-delimited JSON** to stdout.

| Field         | Description                              |
|---------------|------------------------------------------|
| `@timestamp`  | ISO-8601 time (compatible with ELK/Loki) |
| `level`       | trace/debug/info/warn/error/fatal        |
| `service`     | Service name (e.g. `api-gateway`)        |
| `msg`         | Human-readable message                   |
| `traceId`     | Distributed trace correlator             |
| `tenantId`    | For multi-tenant context filtering       |

- **Node.js:** `pino` with `pino-pretty` in development.
- **Go:** `zerolog` with zero-allocation JSON output.
- In production, ship logs to **Grafana Loki**, **Datadog**, or **CloudWatch** via a log forwarder (Fluent Bit / Vector).

### 7. Error Handling Standard

#### TypeScript

```
RelevixError (base)
├── NotFoundError       → 404
├── ValidationError     → 422
├── UnauthorizedError   → 401
├── ForbiddenError      → 403
├── RateLimitError      → 429
└── InternalError       → 500
```

- All errors carry a `code` (machine-readable), `message` (human), `details`, `traceId`.
- Fastify's `setErrorHandler` normalises every error to the `ApiError` envelope.
- `isRelevixError()` type guard prevents leaking raw errors.

#### Go

- Errors are **wrapped** with `fmt.Errorf("context: %w", err)` for stack-safe unwrapping.
- Handlers return structured JSON matching the same `ApiError` envelope.
- HTTP status codes are derived from error type, not magic numbers.

### 8. Podman Instead of Docker

**Why Podman:**
- **Rootless by default** — containers run as your host UID; no daemon with root privileges.
- **Daemonless** — no background `dockerd`; each `podman` command is a direct fork-exec.
- **OCI-native** — identical image format; all `FROM`, `RUN`, `COPY` instructions unchanged.
- **Drop-in compose** — `podman compose` (built-in ≥ v4.7) reads the same YAML syntax.
- **`Containerfile`** — Podman's canonical build file name; auto-detected before `Dockerfile`.

| Concern | Approach |
|---|---|
| Healthcheck in scratch images | Binary self-check `CMD ["/rule-engine", "-healthcheck"]` — no shell needed |
| Node healthcheck | `curl -sf` (installed in runner stage) — replaces `wget` |
| Secrets in production | `podman secret create jwt_secret <(echo -n "value")` |
| Auto-restart in production | `podman generate systemd` → systemd unit files (replaces `restart: unless-stopped`) |
| Ports below 1024 | `sudo sysctl net.ipv4.ip_unprivileged_port_start=80` if needed for rootless |

---

## Getting Started

```bash
# 1. Install Node dependencies
pnpm install

# 2. Start local infrastructure (Postgres, Redis, Kafka) — rootless Podman
make podman-dev

# 3. Copy and fill environment variables
cp .env.example .env

# 4. Run all services in dev mode (hot reload)
make dev

# 5. Run Go services separately
cd services/rule-engine && go run ./cmd/server
cd services/ingestion   && go run ./cmd/server
```

### Run tests

```bash
# TypeScript
pnpm test

# Go (with race detector)
make go-test
```

### Production build

```bash
# Build all TS packages + apps
make build

# Build OCI images with Podman and start the full stack
make podman-build
make podman-up

# View logs
make podman-logs
```

---

## Scaling Strategy

| Concern         | Approach                                                          |
|-----------------|-------------------------------------------------------------------|
| Stateless       | All services are stateless — scale horizontally behind a LB       |
| Rate limiting   | Redis-backed sliding window (api-gateway)                         |
| Async ingestion | Events published to Kafka; consumers process independently        |
| Rule hot-path   | Rule engine caches active rules in Redis (TTL-based invalidation) |
| Multi-tenancy   | Every record has `tenantId`; row-level security in Postgres       |
| Observability   | OpenTelemetry traces → Jaeger/Tempo; metrics → Prometheus         |
