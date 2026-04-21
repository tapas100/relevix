#!/usr/bin/env node
/**
 * scripts/db/seed-insights.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Seeds realistic insights directly into Postgres.
 *
 * This bypasses the Go rule-engine + signal-processor so you can test the
 * full API gateway intelligence flows (GET /v1/insights, /v1/root-cause,
 * /v1/explain) without running Go services.
 *
 * Usage:  node scripts/db/seed-insights.mjs
 *         DATABASE_URL=postgres://... node scripts/db/seed-insights.mjs
 */

import postgres from 'postgres';

const DB_URL = process.env.DATABASE_URL ?? 'postgres://relevix:devpassword@localhost:5432/relevix_dev';
const sql    = postgres(DB_URL, { max: 2, transform: postgres.camel });

const TENANT_ID = 'a0000000-0000-0000-0000-000000000001';

// ── Rule UUIDs (match 002_seed_rules.sql) ─────────────────────────────────────
const RULES = {
  latencySpike:     'b0000000-0000-0000-0000-000000000001',
  errorRateCrit:    'b0000000-0000-0000-0000-000000000002',
  throughputDrop:   'b0000000-0000-0000-0000-000000000003',
  cascadingFailure: 'b0000000-0000-0000-0000-000000000004',
  baselineRegress:  'b0000000-0000-0000-0000-000000000005',
};

// ── Sample insights ───────────────────────────────────────────────────────────

const now   = new Date();
const minsAgo = (n) => new Date(Date.now() - n * 60 * 1000);

const INSIGHTS = [
  // ── CRITICAL: error rate spike on payment-service ─────────────────────────
  {
    tenant_id:           TENANT_ID,
    rule_id:             RULES.errorRateCrit,
    severity:            'critical',
    status:              'open',
    priority:            5,
    confidence:          0.92,
    composite_score:     0.87,
    severity_score:      0.80,
    recency_score:       1.00,
    impact_score:        0.75,
    service:             'payment-service',
    environment:         'production',
    affected_components: ['payment-service', 'checkout-service'],
    explanation:
      'Error rate for payment-service spiked to 18% (SLO threshold: 5%). ' +
      'Root cause: PostgreSQL connection pool exhausted under load. ' +
      'Recommendation: Increase PG_POOL_SIZE from 10 → 25 and add circuit breaker on payment client. ' +
      'Estimated impact: ~420 failed checkouts over the last 10 minutes.',
    signal: {
      kind: 'error_rate', value: 0.18, z_score: 4.2,
      throughput: 42.5, anomaly: 'critical', sample_count: 254,
      baseline_mean: 0.003, baseline_std: 0.001,
    },
    metadata:    { alert_channel: '#slo-alerts', escalation_policy: 'prod-oncall', incident_severity: 'P1' },
    dedup_key:   `${TENANT_ID}/payment-service/error_rate`,
    trace_id:    'aabbccdd11223344aabbccdd11223344',
    fired_at:    minsAgo(3),
  },

  // ── CRITICAL: cascading failure (3 services affected) ─────────────────────
  {
    tenant_id:           TENANT_ID,
    rule_id:             RULES.cascadingFailure,
    severity:            'critical',
    status:              'open',
    priority:            3,
    confidence:          0.78,
    composite_score:     0.82,
    severity_score:      0.80,
    recency_score:       0.90,
    impact_score:        0.85,
    service:             'checkout-service',
    environment:         'production',
    affected_components: ['payment-service', 'checkout-service', 'order-service'],
    explanation:
      'Cascading failure detected: 3 services showing simultaneous anomalies. ' +
      'payment-service error rate critical → checkout-service timeout rate rising → order-service queue depth growing. ' +
      'Classic upstream dependency failure propagation pattern. ' +
      'Immediate action: trip circuit breaker on payment client in checkout-service.',
    signal: {
      kind: 'error_rate', value: 0.24, z_score: 5.1,
      anomaly: 'critical', affected_services_count: 3, sample_count: 189,
    },
    metadata:    { oncall_policy: 'executive-escalation', auto_war_room: true, incident_severity: 'P0' },
    dedup_key:   `${TENANT_ID}/cascading`,
    trace_id:    'bbccddee22334455bbccddee22334455',
    fired_at:    minsAgo(8),
  },

  // ── WARNING: P95 latency spike on checkout-service ────────────────────────
  {
    tenant_id:           TENANT_ID,
    rule_id:             RULES.latencySpike,
    severity:            'warning',
    status:              'open',
    priority:            10,
    confidence:          0.83,
    composite_score:     0.71,
    severity_score:      0.60,
    recency_score:       0.85,
    impact_score:        0.65,
    service:             'checkout-service',
    environment:         'production',
    affected_components: ['checkout-service'],
    explanation:
      'P95 latency for checkout-service reached 1240ms — 3.4σ above the 30-day baseline of 320ms. ' +
      'Likely caused by synchronous calls to the degraded payment-service with no timeout. ' +
      'Recommendation: Set payment client timeout to 500ms and add fallback to async queue.',
    signal: {
      kind: 'latency_p95', value: 1240, z_score: 3.4,
      anomaly: 'warning', sample_count: 312,
      baseline_mean: 320, baseline_std: 28,
      p50: 680, p95: 1240, p99: 1890,
    },
    metadata:    { channel: '#slo-alerts', slo_budget_burn: true, runbook: 'https://wiki.internal/runbooks/latency-spike' },
    dedup_key:   `${TENANT_ID}/checkout-service/latency_p95`,
    trace_id:    'ccddee3344556677ccddee3344556677',
    fired_at:    minsAgo(5),
  },

  // ── WARNING: throughput drop on search-service ────────────────────────────
  {
    tenant_id:           TENANT_ID,
    rule_id:             RULES.throughputDrop,
    severity:            'warning',
    status:              'acknowledged',
    priority:            8,
    confidence:          0.71,
    composite_score:     0.58,
    severity_score:      0.55,
    recency_score:       0.70,
    impact_score:        0.50,
    service:             'search-service',
    environment:         'production',
    affected_components: ['search-service'],
    explanation:
      'Throughput for search-service dropped 52% below the rolling baseline (24 rps → 11.5 rps). ' +
      'Pattern consistent with Elasticsearch connection pool saturation or index refresh storm. ' +
      'No errors detected — requests are slow, not failing.',
    signal: {
      kind: 'throughput', value: 11.5, z_score: 2.8,
      anomaly: 'warning', sample_count: 87,
      baseline_mean: 24.0, baseline_std: 3.2,
      percent_change: -52,
    },
    metadata:    { channel: '#infra-alerts', possible_causes: ['elasticsearch_pool_saturation', 'index_refresh_storm'] },
    dedup_key:   `${TENANT_ID}/search-service/throughput`,
    trace_id:    null,
    fired_at:    minsAgo(22),
  },

  // ── INFO: baseline regression on recommendation-svc ──────────────────────
  {
    tenant_id:           TENANT_ID,
    rule_id:             RULES.baselineRegress,
    severity:            'info',
    status:              'open',
    priority:            20,
    confidence:          0.55,
    composite_score:     0.41,
    severity_score:      0.25,
    recency_score:       0.55,
    impact_score:        0.35,
    service:             'recommendation-svc',
    environment:         'production',
    affected_components: ['recommendation-svc'],
    explanation:
      'Gradual latency regression detected on recommendation-svc over the last 4 hours. ' +
      'Mean latency increased from 90ms → 145ms (+61%) without a corresponding error rate change. ' +
      'Pattern suggests memory leak or N+1 query issue introduced in the last deployment. ' +
      'Recommend: profile the service with pprof and review recent DB query plans.',
    signal: {
      kind: 'latency_mean', value: 145, z_score: 1.8,
      anomaly: 'info', sample_count: 1420,
      baseline_mean: 90, baseline_std: 12,
      rate_of_change: 1.2,
    },
    metadata:    { annotation: 'sustained_latency_regression', suggest_profiling: true },
    dedup_key:   `${TENANT_ID}/recommendation-svc/regression/latency_mean`,
    trace_id:    null,
    fired_at:    minsAgo(240),
  },
];

async function main() {
  console.log('\n🌱  Seeding insights into Postgres…\n');

  for (const insight of INSIGHTS) {
    try {
      const [row] = await sql`
        INSERT INTO insights (
          tenant_id, rule_id, severity, status, priority,
          confidence, composite_score, severity_score, recency_score, impact_score,
          service, environment, affected_components, explanation,
          signal, metadata, dedup_key, trace_id, fired_at
        ) VALUES (
          ${insight.tenant_id},
          ${insight.rule_id},
          ${insight.severity},
          ${insight.status},
          ${insight.priority},
          ${insight.confidence},
          ${insight.composite_score},
          ${insight.severity_score},
          ${insight.recency_score},
          ${insight.impact_score},
          ${insight.service},
          ${insight.environment},
          ${insight.affected_components},
          ${insight.explanation},
          ${sql.json(insight.signal)},
          ${sql.json(insight.metadata)},
          ${insight.dedup_key},
          ${insight.trace_id},
          ${insight.fired_at}
        )
        ON CONFLICT DO NOTHING
        RETURNING id, service, severity, composite_score
      `;
      if (row) {
        console.log(`  ✅  [${insight.severity.padEnd(8)}] ${insight.service.padEnd(25)} composite=${insight.composite_score.toFixed(2)}  id=${row.id}`);
      } else {
        console.log(`  ⏭️   [${insight.severity.padEnd(8)}] ${insight.service.padEnd(25)} already exists — skipped`);
      }
    } catch (e) {
      console.error(`  ❌  ${insight.service}: ${e.message}`);
    }
  }

  // Verify final state
  const counts = await sql`
    SELECT severity, status, COUNT(*) AS n
    FROM insights
    WHERE tenant_id = ${TENANT_ID}
    GROUP BY severity, status
    ORDER BY severity
  `;

  console.log('\n📊  Insights table state:');
  console.log('  severity   status         count');
  console.log('  ' + '─'.repeat(42));
  for (const r of counts) {
    console.log(`  ${String(r.severity).padEnd(10)} ${String(r.status).padEnd(14)} ${r.n}`);
  }

  await sql.end();
  console.log('\n✅  Done. Run node scripts/test-all-flows.mjs to test insights API.\n');
}

main().catch(e => { console.error(e); process.exit(1); });
