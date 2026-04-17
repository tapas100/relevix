#!/usr/bin/env bash
# scripts/db/init-all.sh
# ─────────────────────────────────────────────────────────────────────────────
# Master database initialisation script.
#
# Runs in order:
#   1. Wait for Postgres, Redis, Kafka, Elasticsearch to be healthy
#   2. Run PostgreSQL migrations (001_schema → 002_seed_rules)
#   3. Create Kafka topics
#   4. Create Elasticsearch ILM policy, index template, and per-tenant aliases
#
# Usage:
#   ./scripts/db/init-all.sh               # uses .env values
#   ./scripts/db/init-all.sh --skip-wait   # skip health-check wait loop
#
# All required env vars can be set in .env at the project root.
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPTS_DIR="${REPO_ROOT}/scripts/db"

# ── Load .env if present ──────────────────────────────────────────────────────
if [[ -f "${REPO_ROOT}/.env" ]]; then
  set -o allexport
  # shellcheck source=/dev/null
  source "${REPO_ROOT}/.env"
  set +o allexport
  echo "ℹ️   Loaded .env from ${REPO_ROOT}/.env"
fi

# ── Defaults (can be overridden via env) ──────────────────────────────────────
DATABASE_URL="${DATABASE_URL:-postgres://relevix:relevix@localhost:5432/relevix_dev}"
KAFKA_BROKERS="${KAFKA_BROKERS:-localhost:9092}"
ES_URL="${ES_URL:-http://localhost:9200}"
REDIS_URL="${REDIS_URL:-redis://:@localhost:6379}"

SKIP_WAIT=false
for arg in "$@"; do [[ "${arg}" == "--skip-wait" ]] && SKIP_WAIT=true; done

# ── Colour helpers ────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()    { echo -e "${YELLOW}[init]${NC} $*"; }
success() { echo -e "${GREEN}[init]${NC} ✅  $*"; }
error()   { echo -e "${RED}[init]${NC} ❌  $*" >&2; }

# ── Wait helpers ──────────────────────────────────────────────────────────────

wait_for() {
  local name="$1"; local cmd="$2"; local retries=30; local delay=2
  info "Waiting for ${name}..."
  for i in $(seq 1 ${retries}); do
    if eval "${cmd}" &>/dev/null; then
      success "${name} is ready"
      return 0
    fi
    echo -n "  attempt ${i}/${retries} ..."
    sleep "${delay}"
  done
  error "${name} did not become ready after $((retries * delay))s"
  return 1
}

# ─────────────────────────────────────────────────────────────────────────────
#  STEP 0: Health checks
# ─────────────────────────────────────────────────────────────────────────────

if [[ "${SKIP_WAIT}" == "false" ]]; then
  echo ""
  info "Step 0: Waiting for infrastructure to be healthy"
  echo "─────────────────────────────────────────────────────────────────"

  # PostgreSQL
  PG_HOST=$(echo "${DATABASE_URL}" | grep -oP '(?<=@)[^:/]+')
  PG_PORT=$(echo "${DATABASE_URL}" | grep -oP '(?<=:)[0-9]+(?=/)' | tail -1)
  wait_for "PostgreSQL (${PG_HOST}:${PG_PORT})" \
    "pg_isready -h ${PG_HOST} -p ${PG_PORT:-5432} -q"

  # Kafka
  KF_HOST=$(echo "${KAFKA_BROKERS}" | cut -d: -f1)
  KF_PORT=$(echo "${KAFKA_BROKERS}" | cut -d: -f2)
  wait_for "Kafka (${KF_HOST}:${KF_PORT})" \
    "nc -z ${KF_HOST} ${KF_PORT:-9092}"

  # Elasticsearch
  ES_HOST=$(echo "${ES_URL}" | grep -oP '(?<=://)([^:/]+)')
  ES_PORT=$(echo "${ES_URL}" | grep -oP '(?<=:)[0-9]+$' || echo "9200")
  wait_for "Elasticsearch (${ES_HOST}:${ES_PORT})" \
    "curl -sf ${ES_URL}/_cluster/health?wait_for_status=yellow&timeout=5s"

  # Redis (optional — just nc check)
  REDIS_HOST=$(echo "${REDIS_URL}" | grep -oP '(?<=@)[^:/]+' || echo "localhost")
  REDIS_PORT=$(echo "${REDIS_URL}" | grep -oP '(?<=[^@]:)[0-9]+$' || echo "6379")
  wait_for "Redis (${REDIS_HOST}:${REDIS_PORT})" \
    "nc -z ${REDIS_HOST} ${REDIS_PORT:-6379}"
fi

# ─────────────────────────────────────────────────────────────────────────────
#  STEP 1: PostgreSQL migrations
# ─────────────────────────────────────────────────────────────────────────────

echo ""
info "Step 1: PostgreSQL migrations"
echo "─────────────────────────────────────────────────────────────────"

for migration in "${SCRIPTS_DIR}"/0*.sql; do
  version=$(basename "${migration}" .sql)
  echo -n "  Running ${version} ... "
  if psql "${DATABASE_URL}" \
       --single-transaction \
       --set ON_ERROR_STOP=1 \
       -f "${migration}" \
       --quiet; then
    success "${version} applied"
  else
    error "${version} failed — aborting"
    exit 1
  fi
done

success "All PostgreSQL migrations applied"

# ─────────────────────────────────────────────────────────────────────────────
#  STEP 2: Kafka topics
# ─────────────────────────────────────────────────────────────────────────────

echo ""
info "Step 2: Kafka topics"
echo "─────────────────────────────────────────────────────────────────"

KAFKA_BROKERS="${KAFKA_BROKERS}" bash "${SCRIPTS_DIR}/setup-kafka.sh"

# ─────────────────────────────────────────────────────────────────────────────
#  STEP 3: Elasticsearch
# ─────────────────────────────────────────────────────────────────────────────

echo ""
info "Step 3: Elasticsearch ILM + templates + tenant indices"
echo "─────────────────────────────────────────────────────────────────"

ES_URL="${ES_URL}" node "${SCRIPTS_DIR}/setup-elasticsearch.mjs"

# ─────────────────────────────────────────────────────────────────────────────
#  Done
# ─────────────────────────────────────────────────────────────────────────────

echo ""
echo "════════════════════════════════════════════════════════════════"
success "Database initialisation complete 🎉"
echo ""
echo "  Next steps:"
echo "    pnpm seed:quick          # ingest 10 000 synthetic events"
echo "    pnpm seed                # ingest 250 000 events (full dataset)"
echo "    pnpm dev                 # start api-gateway in watch mode"
echo "════════════════════════════════════════════════════════════════"
echo ""
