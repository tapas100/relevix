#!/usr/bin/env bash
# scripts/db/setup-kafka.sh
# ─────────────────────────────────────────────────────────────────────────────
# Creates all Kafka topics required by the Relevix platform.
#
# Usage:
#   ./scripts/db/setup-kafka.sh
#   KAFKA_BROKERS=localhost:9092 ./scripts/db/setup-kafka.sh
#
# Requirements:
#   - kafka-topics command on $PATH  OR
#   - kafka container accessible via `podman exec`
#
# The script is fully idempotent: running it on a cluster that already has
# the topics is a no-op (uses --if-not-exists).
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

BROKERS="${KAFKA_BROKERS:-localhost:9092}"
CONTAINER="${KAFKA_CONTAINER:-relevix-kafka-1}"   # set in podman-compose.yml

# ── Resolve kafka-topics binary ───────────────────────────────────────────────
#
# 1. Use system kafka-topics if available.
# 2. Fall back to running inside the kafka container via podman exec.

if command -v kafka-topics &>/dev/null; then
  KT="kafka-topics --bootstrap-server ${BROKERS}"
elif podman container exists "${CONTAINER}" 2>/dev/null; then
  KT="podman exec -it ${CONTAINER} kafka-topics --bootstrap-server localhost:9092"
else
  echo "❌  kafka-topics not found in PATH and container '${CONTAINER}' is not running."
  echo "    Start the stack first:  podman compose -f podman-compose.yml up -d kafka"
  exit 1
fi

echo ""
echo "🚀  Creating Kafka topics on ${BROKERS}"
echo ""

# ─── Topic definitions ────────────────────────────────────────────────────────
# Format: "topic-name:partitions:replication-factor:retention-ms"
#   retention-ms: -1 = infinite (compact topics), else millis
#
# Partition count:
#   - 12 for high-throughput topics (12 allows up to 12 consumer instances)
#   - 4  for lower-volume internal topics
#   - 1  for single-writer topics

declare -a TOPICS=(
  # ── Ingestion pipeline ──────────────────────────────────────
  # Raw logs from HTTP clients and external producers
  "relevix.logs.raw:12:1:86400000"            # 24 h retention

  # Normalised + enriched logs from ingestion service
  "relevix.logs.normalized:12:1:172800000"    # 48 h retention

  # Dead-letter queue: malformed or unprocessable events
  "relevix.logs.dlq:2:1:604800000"            # 7 d retention

  # ── Signal processor ────────────────────────────────────────
  # Window snapshots (aggregated metrics per service/window)
  "relevix.signals:8:1:86400000"              # 24 h retention

  # Baseline updates from the baseline tracker
  "relevix.baselines:4:1:604800000"           # 7 d retention

  # ── Rule engine ─────────────────────────────────────────────
  # Fired insights from the rule engine
  "relevix.insights:8:1:604800000"            # 7 d retention

  # Rule hot-reload notifications (rule-engine consumers)
  "relevix.rules.changes:1:1:604800000"       # 7 d retention

  # ── API / audit ─────────────────────────────────────────────
  # Audit trail for all user/system actions
  "relevix.audit:4:1:2592000000"              # 30 d retention

  # Internal system events (health checks, restarts, scale events)
  "relevix.system.events:2:1:86400000"        # 24 h retention
)

# ─── Create topics ────────────────────────────────────────────────────────────

CREATED=0
SKIPPED=0
FAILED=0

for entry in "${TOPICS[@]}"; do
  IFS=':' read -r topic partitions replicas retention_ms <<< "${entry}"

  echo -n "  📦  ${topic} (p=${partitions}, r=${replicas}, retention=${retention_ms}ms) ... "

  if ${KT} --describe --topic "${topic}" &>/dev/null; then
    echo "already exists — skipped"
    (( SKIPPED++ )) || true
    continue
  fi

  if ${KT} \
      --create \
      --topic "${topic}" \
      --partitions "${partitions}" \
      --replication-factor "${replicas}" \
      --config "retention.ms=${retention_ms}" \
      --if-not-exists \
      2>&1; then
    echo "✅  created"
    (( CREATED++ )) || true
  else
    echo "❌  FAILED"
    (( FAILED++ )) || true
  fi
done

# ─── Summary ─────────────────────────────────────────────────────────────────

echo ""
echo "─────────────────────────────────────────────────"
echo "  Created : ${CREATED}"
echo "  Skipped : ${SKIPPED}"
echo "  Failed  : ${FAILED}"
echo "─────────────────────────────────────────────────"
echo ""

if (( FAILED > 0 )); then
  echo "⚠️   Some topics failed to create. Check the output above."
  exit 1
fi

echo "🎉  Kafka topic setup complete"
