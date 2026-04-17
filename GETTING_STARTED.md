# Relevix — Getting Started

Complete guide to boot the platform and feed it real data.

---

## Prerequisites

```bash
node  >= 20      # check: node --version
pnpm  >= 9       # check: pnpm --version   (npm i -g pnpm)
go    >= 1.22    # check: go version
podman >= 4      # check: podman --version
pm2   >= 6       # check: pm2 --version    (npm i -g pm2)
```

---

## Step 1 — Install dependencies

```bash
git clone https://github.com/tapas100/relevix.git
cd relevix
pnpm install
```

---

## Step 2 — Start infra containers (Redis + Postgres)

```bash
# Create the shared Podman network (once only)
podman network create relevix 2>/dev/null || true

# Redis
podman run -d \
  --name relevix-redis \
  --network relevix \
  -p 6379:6379 \
  redis:7-alpine

# Postgres
podman run -d \
  --name relevix-postgres \
  --network relevix \
  -p 5432:5432 \
  -e POSTGRES_USER=relevix \
  -e POSTGRES_PASSWORD=devpassword \
  -e POSTGRES_DB=relevix_dev \
  postgres:16-alpine

# Verify
podman ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
```

---

## Step 3 — Build Go services

> **macOS arm64 (Apple Silicon) requirement** — macOS 26 Tahoe enforces code
> signatures on all binaries. You must build with the external C linker and
> re-sign the output.

```bash
pnpm pm2:build:go
```

This runs `CGO_ENABLED=1 go build -ldflags="-linkmode=external"` + `codesign`
for each Go service. See `scripts/pm2.sh` for the exact commands.

---

## Step 4 — Configure environment

```bash
# Copy the example env file
cp apps/api-gateway/.env.example apps/api-gateway/.env
```

Open `apps/api-gateway/.env` and set at minimum:

```bash
PORT=3001
HOST=0.0.0.0
SERVICE_NAME=api-gateway
JWT_SECRET=<any-64-char-random-string>   # openssl rand -hex 32
REDIS_URL=redis://localhost:6379
DATABASE_URL=postgresql://relevix:devpassword@localhost:5432/relevix_dev
RULE_ENGINE_URL=http://localhost:8080
INGESTION_URL=http://localhost:4000
```

Optional (for AI narration):
```bash
OPENAI_API_KEY=sk-...
AI_NARRATOR_ENABLED=true
```

---

## Step 5 — Start all services with PM2

```bash
pnpm pm2:start

# Check everything is running
pnpm pm2:status
```

Expected output — all 6 should show `online`:

```
┌──────────────────┬────┬──────────┬──────┬───────────┐
│ name             │ id │ status   │ cpu  │ memory    │
├──────────────────┼────┼──────────┼──────┼───────────┤
│ api-gateway      │ 0  │ online   │ 0%   │ 80mb      │
│ dashboard        │ 1  │ online   │ 0%   │ 120mb     │
│ rule-engine      │ 2  │ online   │ 0%   │ 30mb      │
│ ingestion        │ 3  │ online   │ 0%   │ 25mb      │
│ signal-processor │ 4  │ online   │ 0%   │ 25mb      │
│ mcp-server       │ 5  │ online   │ 0%   │ 60mb      │
└──────────────────┴────┴──────────┴──────┴───────────┘
```

Smoke-test the gateway:
```bash
curl http://localhost:3001/health
# → {"status":"ok","checks":{"redis":{"status":"ok"},...}}
```

---

## Step 6 — Start the observability stack (optional but recommended)

```bash
pnpm obs:up

# Grafana: http://localhost:3030   (admin / relevix-dev)
# Prometheus: http://localhost:9090
```

---

## Step 7 — Feed data

### Option A — Quick smoke test (5 000 events, 30 seconds)

```bash
pnpm seed:quick
```

### Option B — Large realistic dataset (2.5 lakh / 250 000 events)

```bash
pnpm seed:large
```

Progress bar shows live throughput (~8 000 events/sec on a modern machine):
```
  [████████████░░░░░░░░] 60%  150,000 / 250,000  errors:0  anomalies:19,843
```

### Option C — Custom seed

```bash
node scripts/seed.mjs \
  --count   500000 \         # how many events (5 lakh)
  --tenant  my-company \     # tenant ID (any string)
  --anomaly high \           # low | medium | high anomaly injection
  --batch   500 \            # events per HTTP batch
  --url     http://localhost:3001
```

### Option D — Real production data from open datasets

The seed script generates synthetic e-commerce telemetry. For real-world
infrastructure log datasets you can use:

| Dataset | Events | Format | Source |
|---|---|---|---|
| **Loghub** — 16 real system log datasets | ~10M lines each | raw text → map to `message` + `fields` | https://github.com/logpai/loghub |
| **OpenTelemetry demo** (Astronomy Shop) | continuous | OTLP | https://opentelemetry.io/docs/demo |
| **Elastic SIEM sample data** | 100 000+ | JSON | Built into Kibana dev tools |
| **Google Cluster Traces** | 25B events | CSV | https://github.com/google/cluster-data |
| **Alibaba 2018 cluster** | 4 000 machines | CSV | https://github.com/alibaba/clusterdata |
| **Azure VM traces** | millions | CSV | https://github.com/Azure/AzurePublicDataset |

To ingest Loghub data:
```bash
# Download a dataset (e.g. HDFS — 11M lines)
wget https://zenodo.org/record/8196385/files/HDFS_v1.zip

# Use the transform helper (see scripts/loghub-transform.mjs)
node scripts/loghub-transform.mjs \
  --input HDFS_v1/HDFS.log \
  --tenant my-tenant \
  --service hdfs-namenode \
  | node scripts/seed.mjs --count 500000
```

---

## Step 8 — View results

After seeding, open:

| URL | What you see |
|---|---|
| http://localhost:5173 | React dashboard — ranked insights, graphs |
| http://localhost:3001/v1/insights?tenant=tenant-demo | Raw JSON insights API |
| http://localhost:3001/v1/root-cause?tenant=tenant-demo | Root cause analysis |
| http://localhost:3001/v1/explain?tenant=tenant-demo | AI narrative (if OpenAI key set) |
| http://localhost:9090 | Prometheus — query metrics |
| http://localhost:3030 | Grafana — dashboards |

Or use the CLI:
```bash
pnpm cli -- insights --limit 10
pnpm cli -- analyze
pnpm cli -- compare checkout-service payment-service
pnpm cli -- search "latency spike"
```

---

## Common commands

```bash
pnpm pm2:status          # service status
pnpm pm2:logs            # tail all logs
pnpm pm2:restart         # restart all services
pnpm pm2:stop            # stop all services
pnpm obs:up              # start Prometheus + Grafana + Tempo + Loki
pnpm obs:down            # stop observability stack
pnpm seed:quick          # inject 5 000 events quickly
pnpm seed:large          # inject 250 000 events
```

---

## Troubleshooting

### Gateway not starting
```bash
pm2 logs api-gateway --lines 50
# Most common: JWT_SECRET missing or < 32 chars, REDIS_URL unreachable
```

### Go binary crashes immediately (macOS)
```bash
# Re-sign the binary
codesign --force --sign - services/rule-engine/bin/server
```

### Redis connection refused
```bash
podman start relevix-redis
```

### Port already in use
```bash
lsof -i :3001   # find what's using the port
# Change PORT in apps/api-gateway/.env
```
