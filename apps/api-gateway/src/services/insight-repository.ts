/**
 * services/insight-repository.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Postgres-backed repository for reading and writing insights.
 *
 * The rule-engine writes insights to this table after evaluation.
 * The API gateway reads from it to serve GET /v1/insights and /v1/root-cause.
 *
 * When the Go rule-engine is NOT running (local dev), you can insert rows
 * directly via:  pnpm db:seed:insights
 */
import type postgres from 'postgres';
import { getDb } from './db.js';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface InsightRow {
  id: string;
  tenantId: string;
  ruleId: string;
  severity: string;
  status: string;
  priority: number;
  confidence: number;
  compositeScore: number;
  severityScore: number;
  recencyScore: number;
  impactScore: number;
  service: string;
  environment: string;
  affectedComponents: string[];
  explanation: string | null;
  signal: Record<string, unknown>;
  metadata: Record<string, unknown>;
  dedupKey: string | null;
  dedupCount: number;
  traceId: string | null;
  firedAt: Date;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface InsightListOptions {
  service?:    string | undefined;
  severity?:   string | undefined;
  status?:     string | undefined;
  limit?:      number | undefined;
  offset?:     number | undefined;
  sinceHours?: number | undefined;
}

// ─── Repository ───────────────────────────────────────────────────────────────

export class InsightRepository {
  constructor(private readonly sql: postgres.Sql = getDb()) {}

  /**
   * List insights for a tenant sorted by composite score descending.
   * This is the backing query for GET /v1/insights.
   */
  async list(tenantId: string, opts: InsightListOptions = {}): Promise<{ rows: InsightRow[]; total: number }> {
    const {
      service,
      severity,
      status    = 'open',
      limit     = 10,
      offset    = 0,
      sinceHours = 24,
    } = opts;

    const rows = await this.sql<InsightRow[]>`
      SELECT
        id, tenant_id, rule_id, severity, status, priority,
        confidence, composite_score, severity_score, recency_score, impact_score,
        service, environment, affected_components, explanation,
        signal, metadata, dedup_key, dedup_count, trace_id,
        fired_at, resolved_at, created_at, updated_at
      FROM insights
      WHERE tenant_id     = ${tenantId}
        AND status        = ${status}
        AND fired_at     >= NOW() - (${sinceHours} || ' hours')::INTERVAL
        ${service  ? this.sql`AND service  = ${service}`  : this.sql``}
        ${severity ? this.sql`AND severity = ${severity}` : this.sql``}
      ORDER BY composite_score DESC, fired_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;

    const [{ count }] = await this.sql<[{ count: string }]>`
      SELECT COUNT(*)::text AS count
      FROM insights
      WHERE tenant_id  = ${tenantId}
        AND status     = ${status}
        AND fired_at  >= NOW() - (${sinceHours} || ' hours')::INTERVAL
        ${service  ? this.sql`AND service  = ${service}`  : this.sql``}
        ${severity ? this.sql`AND severity = ${severity}` : this.sql``}
    `;

    return { rows, total: parseInt(count, 10) };
  }

  /** Insert a new insight (used by seed script and rule-engine adapter). */
  async insert(insight: Omit<InsightRow, 'id' | 'createdAt' | 'updatedAt' | 'dedupCount' | 'resolvedAt'>): Promise<InsightRow> {
    const [row] = await this.sql<InsightRow[]>`
      INSERT INTO insights (
        tenant_id, rule_id, severity, status, priority,
        confidence, composite_score, severity_score, recency_score, impact_score,
        service, environment, affected_components, explanation,
        signal, metadata, dedup_key, trace_id, fired_at
      ) VALUES (
        ${insight.tenantId},
        ${insight.ruleId},
        ${insight.severity},
        ${insight.status},
        ${insight.priority},
        ${insight.confidence},
        ${insight.compositeScore},
        ${insight.severityScore},
        ${insight.recencyScore},
        ${insight.impactScore},
        ${insight.service},
        ${insight.environment},
        ${insight.affectedComponents},
        ${insight.explanation ?? null},
        ${this.sql.json(insight.signal as Parameters<typeof this.sql.json>[0])},
        ${this.sql.json(insight.metadata as Parameters<typeof this.sql.json>[0])},
        ${insight.dedupKey ?? null},
        ${insight.traceId ?? null},
        ${insight.firedAt}
      )
      ON CONFLICT (tenant_id, dedup_key, fired_at)
      DO UPDATE SET
        dedup_count     = insights.dedup_count + 1,
        composite_score = EXCLUDED.composite_score,
        confidence      = EXCLUDED.confidence,
        explanation     = COALESCE(EXCLUDED.explanation, insights.explanation),
        updated_at      = NOW()
      RETURNING *
    `;
    return row!;
  }

  /** Update insight status (acknowledge / resolve). */
  async updateStatus(
    tenantId: string,
    insightId: string,
    status: 'acknowledged' | 'resolved',
    actor: string,
  ): Promise<InsightRow | null> {
    const rows = await this.sql<InsightRow[]>`
      UPDATE insights
      SET
        status          = ${status},
        resolved_at     = ${status === 'resolved' ? this.sql`NOW()` : this.sql`resolved_at`},
        acknowledged_by = ${status === 'acknowledged' ? actor : this.sql`acknowledged_by`},
        acknowledged_at = ${status === 'acknowledged' ? this.sql`NOW()` : this.sql`acknowledged_at`},
        updated_at      = NOW()
      WHERE tenant_id = ${tenantId} AND id = ${insightId}
      RETURNING *
    `;
    return rows[0] ?? null;
  }
}
