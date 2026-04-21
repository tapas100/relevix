/**
 * services/rule-repository.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Postgres-backed repository for reading rules.
 *
 * All queries are tenant-scoped — no cross-tenant data leakage is possible
 * because every query binds `tenantId` as the first WHERE clause.
 *
 * The Go rule-engine also reads from this same table (poll-based hot-reload)
 * so changes made here are picked up within one PRECOMPUTE_TICK_INTERVAL.
 */
import type postgres from 'postgres';
import { getDb } from './db.js';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface RuleRow {
  id: string;
  tenantId: string;
  slug: string;
  name: string;
  description: string | null;
  version: number;
  priority: number;
  severity: string;
  conditionLogic: string;
  minMatch: number | null;
  conditions: unknown[];
  action: string;
  actionPayload: Record<string, unknown>;
  dedupKey: string | null;
  dedupWindow: string | null;
  dedupMaxFire: number | null;
  confidenceBase: number;
  confidenceMods: unknown[];
  isActive: boolean;
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface RuleListOptions {
  page?:     number;
  pageSize?: number;
  active?:   boolean | undefined;
  severity?: string | undefined;
  tag?:      string | undefined;
}

// ─── Repository ───────────────────────────────────────────────────────────────

export class RuleRepository {
  constructor(private readonly sql: postgres.Sql = getDb()) {}

  /** List rules for a tenant with optional filters + pagination. */
  async list(tenantId: string, opts: RuleListOptions = {}): Promise<{ rows: RuleRow[]; total: number }> {
    const {
      page     = 1,
      pageSize = 20,
      active,
      severity,
      tag,
    } = opts;

    const offset = (page - 1) * pageSize;

    // Build the WHERE clauses dynamically.
    // postgres.js handles array parameters safely — no SQL injection possible.
    const rows = await this.sql<RuleRow[]>`
      SELECT
        id, tenant_id, slug, name, description, version, priority,
        severity, condition_logic, min_match, conditions,
        action, action_payload,
        dedup_key, dedup_window::text, dedup_max_fire,
        confidence_base, confidence_mods,
        is_active, tags, created_at, updated_at
      FROM rules
      WHERE tenant_id = ${tenantId}
        ${active !== undefined ? this.sql`AND is_active = ${active}` : this.sql``}
        ${severity ? this.sql`AND severity = ${severity}` : this.sql``}
        ${tag ? this.sql`AND ${tag} = ANY(tags)` : this.sql``}
      ORDER BY priority ASC, slug ASC
      LIMIT ${pageSize} OFFSET ${offset}
    `;

    const [{ count }] = await this.sql<[{ count: string }]>`
      SELECT COUNT(*)::text AS count
      FROM rules
      WHERE tenant_id = ${tenantId}
        ${active !== undefined ? this.sql`AND is_active = ${active}` : this.sql``}
        ${severity ? this.sql`AND severity = ${severity}` : this.sql``}
        ${tag ? this.sql`AND ${tag} = ANY(tags)` : this.sql``}
    `;

    return { rows, total: parseInt(count, 10) };
  }

  /** Get a single rule by ID, scoped to the tenant. */
  async findById(tenantId: string, ruleId: string): Promise<RuleRow | null> {
    const rows = await this.sql<RuleRow[]>`
      SELECT
        id, tenant_id, slug, name, description, version, priority,
        severity, condition_logic, min_match, conditions,
        action, action_payload,
        dedup_key, dedup_window::text, dedup_max_fire,
        confidence_base, confidence_mods,
        is_active, tags, created_at, updated_at
      FROM rules
      WHERE tenant_id = ${tenantId} AND id = ${ruleId}
      LIMIT 1
    `;
    return rows[0] ?? null;
  }
}
