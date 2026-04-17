-- ─────────────────────────────────────────────────────────────────────────────
-- 002_seed_rules.sql  —  Seed tenant + rules from infra.rules.yml
--
-- Run AFTER 001_schema.sql.
-- Run:  psql "$DATABASE_URL" -f scripts/db/002_seed_rules.sql
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Demo tenant ───────────────────────────────────────────────────────────────

INSERT INTO tenants (id, slug, name, plan, settings)
VALUES (
  'a0000000-0000-0000-0000-000000000001',
  'tenant-demo',
  'Demo Organisation',
  'enterprise',
  '{"timezone":"UTC","retention_days":90,"alert_channels":["#slo-alerts","#infra-alerts"]}'
)
ON CONFLICT (slug) DO UPDATE SET
  name     = EXCLUDED.name,
  plan     = EXCLUDED.plan,
  settings = EXCLUDED.settings,
  updated_at = NOW();


-- ── Rules (mirrored from services/rule-engine/rules/infra.rules.yml) ─────────
-- These are the system-wide infra rules owned by the demo tenant.
-- Production deployments would have per-tenant rule sets loaded via the API.

-- 1. P95 Latency Spike
INSERT INTO rules (
  id, tenant_id, slug, name, description, version, priority,
  severity, condition_logic, conditions, action, action_payload,
  dedup_key, dedup_window, dedup_max_fire,
  confidence_base, confidence_mods,
  is_active, tags
)
VALUES (
  'b0000000-0000-0000-0000-000000000001',
  'a0000000-0000-0000-0000-000000000001',
  'latency-p95-spike',
  'P95 Latency Spike',
  'Fires when p95 latency exceeds the rolling baseline by more than 3 standard deviations.',
  3, 10,
  'warning', 'ALL',
  '[
    {"field":"signal.kind",         "op":"eq",          "value":"latency_p95",  "weight":0.0},
    {"field":"signal.value",        "op":"gte",         "value":200,            "weight":0.3},
    {"field":"signal.z_score",      "op":"stddev_above","value":3.0,            "weight":0.5},
    {"field":"signal.sample_count", "op":"gte",         "value":30,             "weight":0.2}
  ]',
  'alert',
  '{"channel":"#slo-alerts","runbook":"https://wiki.internal/runbooks/latency-spike","slo_budget_burn":true}',
  '{{ .meta.tenant_id }}/{{ .meta.service }}/latency_p95',
  '5 minutes', 1,
  0.70,
  '[
    {"when":{"field":"signal.z_score",      "op":"gte","value":4.0},    "adjust":0.15},
    {"when":{"field":"meta.environment",    "op":"eq", "value":"production"}, "adjust":0.10},
    {"when":{"field":"signal.sample_count", "op":"lt", "value":100},    "adjust":-0.10}
  ]',
  true, ARRAY['latency','slo','api']
)
ON CONFLICT (tenant_id, slug, version) DO UPDATE SET
  name             = EXCLUDED.name,
  description      = EXCLUDED.description,
  priority         = EXCLUDED.priority,
  severity         = EXCLUDED.severity,
  conditions       = EXCLUDED.conditions,
  action           = EXCLUDED.action,
  action_payload   = EXCLUDED.action_payload,
  dedup_key        = EXCLUDED.dedup_key,
  dedup_window     = EXCLUDED.dedup_window,
  dedup_max_fire   = EXCLUDED.dedup_max_fire,
  confidence_base  = EXCLUDED.confidence_base,
  confidence_mods  = EXCLUDED.confidence_mods,
  is_active        = EXCLUDED.is_active,
  tags             = EXCLUDED.tags,
  updated_at       = NOW();


-- 2. Error Rate Critical Threshold
INSERT INTO rules (
  id, tenant_id, slug, name, description, version, priority,
  severity, condition_logic, conditions, action, action_payload,
  dedup_key, dedup_window, dedup_max_fire,
  confidence_base, confidence_mods,
  is_active, tags
)
VALUES (
  'b0000000-0000-0000-0000-000000000002',
  'a0000000-0000-0000-0000-000000000001',
  'error-rate-critical',
  'Error Rate Critical Threshold',
  'Fires when the error rate crosses 5% for a production service with meaningful traffic.',
  2, 5,
  'critical', 'ALL',
  '[
    {"field":"signal.kind",        "op":"eq",  "value":"error_rate",             "weight":0.0},
    {"field":"signal.value",       "op":"gte", "value":0.05,                     "weight":0.4},
    {"field":"signal.throughput",  "op":"gte", "value":1.0,                      "weight":0.2},
    {"field":"meta.environment",   "op":"eq",  "value":"production",             "weight":0.0},
    {"field":"signal.anomaly",     "op":"in",  "value":["warning","critical"],   "weight":0.4}
  ]',
  'escalate',
  '{"escalation_policy":"prod-oncall","incident_severity":"P1","runbook":"https://wiki.internal/runbooks/error-rate"}',
  '{{ .meta.tenant_id }}/{{ .meta.service }}/error_rate',
  '10 minutes', 2,
  0.80,
  '[
    {"when":{"field":"signal.value",        "op":"gte","value":0.20}, "adjust":0.15},
    {"when":{"field":"signal.z_score",      "op":"gte","value":4.0},  "adjust":0.10},
    {"when":{"field":"signal.sample_count", "op":"lt", "value":50},   "adjust":-0.20}
  ]',
  true, ARRAY['errors','slo','production']
)
ON CONFLICT (tenant_id, slug, version) DO UPDATE SET
  name             = EXCLUDED.name,
  priority         = EXCLUDED.priority,
  severity         = EXCLUDED.severity,
  conditions       = EXCLUDED.conditions,
  action           = EXCLUDED.action,
  action_payload   = EXCLUDED.action_payload,
  confidence_base  = EXCLUDED.confidence_base,
  confidence_mods  = EXCLUDED.confidence_mods,
  updated_at       = NOW();


-- 3. Throughput Drop
INSERT INTO rules (
  id, tenant_id, slug, name, description, version, priority,
  severity, condition_logic, conditions, action, action_payload,
  dedup_key, dedup_window, dedup_max_fire,
  confidence_base, confidence_mods,
  is_active, tags
)
VALUES (
  'b0000000-0000-0000-0000-000000000003',
  'a0000000-0000-0000-0000-000000000001',
  'throughput-drop',
  'Throughput Drop — Possible Traffic Loss',
  'Fires when throughput falls more than 40% below the rolling baseline.',
  1, 8,
  'warning', 'ALL',
  '[
    {"field":"signal.kind",         "op":"eq",            "value":"throughput", "weight":0.0},
    {"field":"signal.value",        "op":"percent_change","value":-40,          "weight":0.6},
    {"field":"baseline.mean",       "op":"gte",           "value":5.0,          "weight":0.2},
    {"field":"signal.sample_count", "op":"gte",           "value":20,           "weight":0.2}
  ]',
  'alert',
  '{"channel":"#infra-alerts","possible_causes":["load_balancer_misconfiguration","upstream_routing_failure","crash_loop_backoff"]}',
  '{{ .meta.tenant_id }}/{{ .meta.service }}/throughput',
  '10 minutes', 1,
  0.65,
  '[
    {"when":{"field":"signal.value",     "op":"percent_change","value":-70},          "adjust":0.20},
    {"when":{"field":"meta.environment", "op":"neq",           "value":"production"}, "adjust":-0.15}
  ]',
  true, ARRAY['throughput','availability','traffic']
)
ON CONFLICT (tenant_id, slug, version) DO NOTHING;


-- 4. Cascading Failure
INSERT INTO rules (
  id, tenant_id, slug, name, description, version, priority,
  severity, condition_logic, min_match, conditions, action, action_payload,
  dedup_key, dedup_window, dedup_max_fire,
  confidence_base, confidence_mods,
  is_active, tags
)
VALUES (
  'b0000000-0000-0000-0000-000000000004',
  'a0000000-0000-0000-0000-000000000001',
  'cascading-failure-detection',
  'Cascading Failure — Correlated Degradation',
  'Fires when three or more distinct signals are anomalous simultaneously for the same tenant.',
  2, 3,
  'critical', 'MIN_N', 3,
  '[
    {"field":"signal.kind",                    "op":"eq", "value":"error_rate", "weight":0.25},
    {"field":"signal.anomaly",                 "op":"eq", "value":"critical",   "weight":0.25},
    {"field":"context.affected_services_count","op":"gte","value":2,            "weight":0.25},
    {"field":"signal.z_score",                 "op":"gte","value":3.0,          "weight":0.25}
  ]',
  'create_incident',
  '{"severity":"P0","oncall_policy":"executive-escalation","auto_war_room":true}',
  '{{ .meta.tenant_id }}/cascading',
  '15 minutes', 1,
  0.55,
  '[
    {"when":{"field":"context.affected_services_count","op":"gte","value":5},         "adjust":0.30},
    {"when":{"field":"meta.environment",               "op":"eq", "value":"production"},"adjust":0.15}
  ]',
  true, ARRAY['cascading','systemic','incident']
)
ON CONFLICT (tenant_id, slug, version) DO NOTHING;


-- 5. Baseline Regression
INSERT INTO rules (
  id, tenant_id, slug, name, description, version, priority,
  severity, condition_logic, conditions, action, action_payload,
  dedup_key, dedup_window, dedup_max_fire,
  confidence_base, confidence_mods,
  is_active, tags
)
VALUES (
  'b0000000-0000-0000-0000-000000000005',
  'a0000000-0000-0000-0000-000000000001',
  'baseline-regression',
  'Baseline Regression — Gradual Latency Creep',
  'Detects slow latency regressions that never cross a hard threshold.',
  1, 20,
  'info', 'ALL',
  '[
    {"field":"signal.kind",         "op":"in",            "value":["latency_p95","latency_mean"],"weight":0.0},
    {"field":"signal.z_score",      "op":"between",       "value":[1.5,2.5],                     "weight":0.4},
    {"field":"signal.value",        "op":"rate_of_change","value":0.5,                           "weight":0.4},
    {"field":"signal.sample_count", "op":"gte",           "value":60,                            "weight":0.2}
  ]',
  'enrich',
  '{"annotation":"sustained_latency_regression","suggest_profiling":true,"dashboard_link":"https://grafana.internal/d/latency-trend"}',
  '{{ .meta.tenant_id }}/{{ .meta.service }}/regression/{{ .signal.kind }}',
  '30 minutes', 1,
  0.50,
  '[
    {"when":{"field":"meta.environment","op":"eq", "value":"production"},"adjust":0.15},
    {"when":{"field":"signal.z_score",  "op":"gte","value":2.0},        "adjust":0.10}
  ]',
  true, ARRAY['regression','trend','sre']
)
ON CONFLICT (tenant_id, slug, version) DO NOTHING;


-- ── Record migration ──────────────────────────────────────────────────────────
INSERT INTO schema_migrations (version) VALUES ('002_seed_rules')
ON CONFLICT (version) DO NOTHING;

-- ── Summary ───────────────────────────────────────────────────────────────────
SELECT
  'Tenants' AS entity, COUNT(*)::TEXT AS count FROM tenants
UNION ALL
SELECT 'Rules', COUNT(*)::TEXT FROM rules
UNION ALL
SELECT 'Active rules', COUNT(*)::TEXT FROM rules WHERE is_active;
