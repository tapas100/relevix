-- ─────────────────────────────────────────────────────────────────────────────
-- 001_schema.sql  —  Relevix PostgreSQL schema  (idempotent)
--
-- Run:  psql "$DATABASE_URL" -f scripts/db/001_schema.sql
-- ─────────────────────────────────────────────────────────────────────────────

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";   -- for ILIKE trigram indexes on name/description
CREATE EXTENSION IF NOT EXISTS "btree_gin";  -- composite GIN on array columns

-- ─── ENUM types ──────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE rule_severity AS ENUM ('info', 'warning', 'critical', 'page');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE rule_action AS ENUM (
    'alert', 'suppress', 'escalate', 'enrich', 'page', 'create_incident'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE rule_condition_logic AS ENUM ('ALL', 'ANY', 'MIN_N');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE insight_status AS ENUM ('open', 'acknowledged', 'resolved', 'suppressed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE signal_kind AS ENUM (
    'latency_p95', 'latency_p99', 'latency_mean',
    'error_rate', 'throughput',
    'cpu_usage', 'memory_usage',
    'saturation', 'availability'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ─── tenants ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tenants (
  id           UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  slug         TEXT        NOT NULL UNIQUE,   -- URL-safe identifier used as tenant_id
  name         TEXT        NOT NULL,
  plan         TEXT        NOT NULL DEFAULT 'free',  -- free | pro | enterprise
  settings     JSONB       NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tenants_slug ON tenants (slug);


-- ─── rules ───────────────────────────────────────────────────────────────────
-- Canonical source-of-truth for all rule-engine rules.
-- The Go rule-engine polls this table (PRECOMPUTE_TICK_INTERVAL) to hot-reload.

CREATE TABLE IF NOT EXISTS rules (
  id               UUID                 PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id        UUID                 NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,

  -- Identity
  slug             TEXT                 NOT NULL,   -- human-readable stable ID (e.g. "latency-p95-spike")
  name             TEXT                 NOT NULL,
  description      TEXT,
  version          INT                  NOT NULL DEFAULT 1,

  -- Evaluation
  priority         INT                  NOT NULL DEFAULT 100,  -- lower = evaluated first
  severity         rule_severity        NOT NULL DEFAULT 'warning',
  condition_logic  rule_condition_logic NOT NULL DEFAULT 'ALL',
  min_match        INT,                             -- only used when condition_logic = MIN_N
  conditions       JSONB                NOT NULL DEFAULT '[]',
  action           rule_action          NOT NULL DEFAULT 'alert',
  action_payload   JSONB                NOT NULL DEFAULT '{}',

  -- Deduplication
  dedup_key        TEXT,                            -- Go-template expression
  dedup_window     INTERVAL,
  dedup_max_fire   INT,

  -- Confidence scoring
  confidence_base  FLOAT                NOT NULL DEFAULT 0.7,
  confidence_mods  JSONB                NOT NULL DEFAULT '[]',

  -- Lifecycle
  is_active        BOOLEAN              NOT NULL DEFAULT TRUE,
  tags             TEXT[]               NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ          NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ          NOT NULL DEFAULT NOW(),

  UNIQUE (tenant_id, slug, version)
);

CREATE INDEX IF NOT EXISTS idx_rules_tenant_active   ON rules (tenant_id, is_active);
CREATE INDEX IF NOT EXISTS idx_rules_priority        ON rules (tenant_id, priority) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_rules_tags            ON rules USING GIN (tags);
CREATE INDEX IF NOT EXISTS idx_rules_name_trgm       ON rules USING GIN (name gin_trgm_ops);


-- ─── insights ────────────────────────────────────────────────────────────────
-- Every time the rule-engine fires a rule an insight row is written here.
-- The api-gateway also maintains a mirror in Elasticsearch for full-text search.

CREATE TABLE IF NOT EXISTS insights (
  id                   UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id            UUID          NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  rule_id              UUID          NOT NULL REFERENCES rules (id) ON DELETE SET NULL,

  -- Classification
  severity             rule_severity NOT NULL,
  status               insight_status NOT NULL DEFAULT 'open',
  priority             INT           NOT NULL DEFAULT 100,

  -- Scores (0–1 floats)
  confidence           FLOAT         NOT NULL DEFAULT 0.0,
  composite_score      FLOAT         NOT NULL DEFAULT 0.0,
  severity_score       FLOAT         NOT NULL DEFAULT 0.0,
  recency_score        FLOAT         NOT NULL DEFAULT 0.0,
  impact_score         FLOAT         NOT NULL DEFAULT 0.0,

  -- Context
  service              TEXT          NOT NULL,
  environment          TEXT          NOT NULL DEFAULT 'production',
  affected_components  TEXT[]        NOT NULL DEFAULT '{}',
  explanation          TEXT,                   -- AI-generated or deterministic fallback
  signal               JSONB         NOT NULL DEFAULT '{}',  -- raw Signal snapshot
  metadata             JSONB         NOT NULL DEFAULT '{}',  -- arbitrary context

  -- Deduplication
  dedup_key            TEXT,                   -- same key = same logical incident
  dedup_count          INT           NOT NULL DEFAULT 1,

  -- Tracing
  trace_id             TEXT,

  -- Timestamps
  fired_at             TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  resolved_at          TIMESTAMPTZ,
  acknowledged_by      TEXT,
  acknowledged_at      TIMESTAMPTZ,
  created_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_insights_tenant_status    ON insights (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_insights_tenant_severity  ON insights (tenant_id, severity);
CREATE INDEX IF NOT EXISTS idx_insights_service          ON insights (tenant_id, service);
CREATE INDEX IF NOT EXISTS idx_insights_fired_at         ON insights (tenant_id, fired_at DESC);
CREATE INDEX IF NOT EXISTS idx_insights_dedup_key        ON insights (tenant_id, dedup_key, fired_at DESC)
  WHERE dedup_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_insights_components       ON insights USING GIN (affected_components);


-- ─── signals ─────────────────────────────────────────────────────────────────
-- Pre-aggregated window snapshots from signal-processor.
-- Retained for 90 days (partition-prune by month in production).

CREATE TABLE IF NOT EXISTS signals (
  id               UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id        UUID        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  service          TEXT        NOT NULL,
  environment      TEXT        NOT NULL DEFAULT 'production',
  kind             signal_kind NOT NULL,

  -- Aggregated values
  value            FLOAT       NOT NULL,
  z_score          FLOAT       NOT NULL DEFAULT 0.0,
  p50              FLOAT,
  p95              FLOAT,
  p99              FLOAT,
  sample_count     INT         NOT NULL DEFAULT 0,

  -- Baseline
  baseline_mean    FLOAT,
  baseline_std     FLOAT,
  baseline_samples INT,

  -- Window
  window_start     TIMESTAMPTZ NOT NULL,
  window_end       TIMESTAMPTZ NOT NULL,
  window_size      INTERVAL    NOT NULL DEFAULT '60 seconds',

  emitted_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_signals_tenant_service  ON signals (tenant_id, service, kind, window_end DESC);
CREATE INDEX IF NOT EXISTS idx_signals_window          ON signals (tenant_id, window_end DESC);


-- ─── raw_logs ────────────────────────────────────────────────────────────────
-- Normalized logs from the ingestion service.
-- Partitioned by month in production (TimescaleDB / pg_partman recommended).
-- For local dev / small scale: plain table with BRIN index on timestamp.

CREATE TABLE IF NOT EXISTS raw_logs (
  id           UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id    UUID        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  trace_id     TEXT,
  service      TEXT        NOT NULL,
  environment  TEXT        NOT NULL DEFAULT 'production',
  level        TEXT        NOT NULL DEFAULT 'info',
  message      TEXT        NOT NULL,
  fields       JSONB       NOT NULL DEFAULT '{}',
  tags         TEXT[]      NOT NULL DEFAULT '{}',
  timestamp    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  received_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- BRIN is tiny and works well for append-only time-ordered data
CREATE INDEX IF NOT EXISTS idx_raw_logs_tenant_ts   ON raw_logs USING BRIN (tenant_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_raw_logs_service     ON raw_logs (tenant_id, service, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_raw_logs_level       ON raw_logs (tenant_id, level, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_raw_logs_trace       ON raw_logs (trace_id) WHERE trace_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_raw_logs_tags        ON raw_logs USING GIN (tags);
CREATE INDEX IF NOT EXISTS idx_raw_logs_fields      ON raw_logs USING GIN (fields jsonb_path_ops);


-- ─── audit_log ───────────────────────────────────────────────────────────────
-- Immutable append-only record of all user/system actions (SOC 2 requirement).

CREATE TABLE IF NOT EXISTS audit_log (
  id           BIGSERIAL   PRIMARY KEY,
  tenant_id    UUID        REFERENCES tenants (id) ON DELETE SET NULL,
  actor        TEXT        NOT NULL,   -- user email or service name
  action       TEXT        NOT NULL,   -- e.g. "rule.created", "insight.acknowledged"
  resource     TEXT,                   -- e.g. "rule:uuid", "insight:uuid"
  payload      JSONB       NOT NULL DEFAULT '{}',
  ip           TEXT,
  trace_id     TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_tenant_ts ON audit_log (tenant_id, created_at DESC);


-- ─── updated_at auto-trigger ──────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DO $$ BEGIN
  CREATE TRIGGER trg_tenants_updated_at  BEFORE UPDATE ON tenants  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TRIGGER trg_rules_updated_at    BEFORE UPDATE ON rules    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TRIGGER trg_insights_updated_at BEFORE UPDATE ON insights FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ─── schema_migrations bookkeeping ───────────────────────────────────────────
-- Simple single-table migration ledger (no external tooling needed).

CREATE TABLE IF NOT EXISTS schema_migrations (
  version     TEXT        PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO schema_migrations (version) VALUES ('001_schema')
ON CONFLICT (version) DO NOTHING;
