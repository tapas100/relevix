// ─── Primitives ──────────────────────────────────────────────────────────────

export type UUID = string;
export type ISODateString = string; // ISO-8601
export type SemVer = string;       // e.g. "1.2.3"
export type Nullable<T> = T | null;
export type Optional<T> = T | undefined;

// ─── Pagination ───────────────────────────────────────────────────────────────

export interface PaginationQuery {
  page: number;      // 1-based
  pageSize: number;  // max 100
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  hasNextPage: boolean;
}

// ─── API envelope ─────────────────────────────────────────────────────────────

export interface ApiSuccess<T> {
  ok: true;
  data: T;
  meta?: Record<string, unknown>;
}

export interface ApiError {
  ok: false;
  error: {
    code: string;      // machine-readable, e.g. "RULE_NOT_FOUND"
    message: string;   // human-readable
    details?: unknown; // validation errors, etc.
    traceId?: string;  // correlate with logs/traces
  };
}

export type ApiResponse<T> = ApiSuccess<T> | ApiError;

// ─── Audit / base entity ──────────────────────────────────────────────────────

export interface BaseEntity {
  id: UUID;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  deletedAt: Nullable<ISODateString>; // soft-delete
}

// ─── Tenant (multi-tenancy support) ──────────────────────────────────────────

export interface Tenant extends BaseEntity {
  slug: string;
  name: string;
  plan: 'free' | 'starter' | 'pro' | 'enterprise';
  isActive: boolean;
}

// ─── Rule Engine types ────────────────────────────────────────────────────────

export type RuleOperator =
  | 'eq' | 'neq'
  | 'gt' | 'gte' | 'lt' | 'lte'
  | 'in' | 'not_in'
  | 'contains' | 'starts_with' | 'ends_with'
  | 'regex';

export type RuleAction = 'allow' | 'deny' | 'flag' | 'enrich' | 'transform';

export interface RuleCondition {
  field: string;           // dot-path, e.g. "user.country"
  operator: RuleOperator;
  value: unknown;          // compared against field value
  negate?: boolean;
}

export interface Rule extends BaseEntity {
  tenantId: UUID;
  name: string;
  description: Optional<string>;
  version: number;
  priority: number;        // lower = higher priority
  conditions: RuleCondition[];
  conditionLogic: 'ALL' | 'ANY'; // AND / OR
  action: RuleAction;
  actionPayload?: Record<string, unknown>;
  isActive: boolean;
  tags: string[];
}

export interface RuleEvaluationRequest {
  tenantId: UUID;
  context: Record<string, unknown>; // the data being evaluated
  tags?: string[];                   // optional tag filter
  traceId?: string;
}

export interface RuleEvaluationResult {
  ruleId: UUID;
  ruleName: string;
  matched: boolean;
  action: RuleAction;
  actionPayload?: Record<string, unknown>;
  evaluatedAt: ISODateString;
}

export interface RuleEvaluationResponse {
  traceId: string;
  results: RuleEvaluationResult[];
  matchedCount: number;
  evaluationTimeMs: number;
}

// ─── Ingestion types ──────────────────────────────────────────────────────────

export type EventSchema = 'relevix/event/v1';

export interface IngestEvent {
  schema: EventSchema;
  id: UUID;
  tenantId: UUID;
  source: string;              // origin service / SDK name
  type: string;                // e.g. "user.signup", "order.placed"
  payload: Record<string, unknown>;
  occurredAt: ISODateString;
  receivedAt?: ISODateString;  // set by ingestion service
  traceId?: string;
}

export interface IngestBatchRequest {
  events: IngestEvent[];
}

export interface IngestBatchResponse {
  accepted: number;
  rejected: number;
  rejections: Array<{ index: number; reason: string }>;
}

// ─── Intelligence / Insights ──────────────────────────────────────────────────

export type Severity = 'page' | 'critical' | 'warning' | 'info';

/** Four-factor scoring breakdown produced by the Go scorer. */
export interface ScoreComponents {
  severity: number;   // 0–1 normalised severity weight
  confidence: number; // 0–1 rule-match confidence
  recency: number;    // 0–1 exponential time decay
  impact: number;     // 0–1 blast-radius estimate
  composite: number;  // final weighted combination
}

/** A single evaluated rule match, enriched by the scorer. */
export interface Insight {
  id: string;
  ruleId: string;
  ruleName: string;
  severity: Severity;
  priority: number;
  confidence: number;
  firedAt: ISODateString;
  dedupKey?: string;
  signal?: Record<string, unknown>;
}

/** Insight enriched with rank position and component scores. */
export interface RankedInsight {
  rank: number;
  insight: Insight;
  components: ScoreComponents;
}

/** Query params for the insights endpoint. */
export interface InsightsQueryParams {
  service?: string;
  limit?: number; // 1–50, default 10
}

/** Response body data for GET /v1/insights. */
export interface InsightsData {
  tenantId: string;
  service?: string;
  insights: RankedInsight[];
  total: number;
  fromCache: boolean;
  computedAt: ISODateString;
  cacheAgeMs?: number;
}

/** Structured root cause with recommendations. */
export interface RootCause {
  ruleId: string;
  severity: Severity;
  confidence: number;
  explanation: string;
  affectedComponents: string[];
  recommendations: string[];
  timeline: {
    detectedAt: ISODateString;
    estimatedStartAt?: ISODateString;
  };
}

/** Response body data for GET /v1/root-cause. */
export interface RootCauseData {
  tenantId: string;
  service?: string;
  rootCause: RootCause | null;
  supporting: RankedInsight[];
  fromCache: boolean;
  computedAt: ISODateString;
  cacheAgeMs?: number;
}

/** A single structured log entry for POST /v1/logs. */
export interface LogEntry {
  id?: UUID;
  service: string;
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  message: string;
  timestamp?: ISODateString;
  traceId?: string;
  spanId?: string;
  metadata?: Record<string, unknown>;
}

export interface LogIngestionRequest {
  entries: LogEntry[];
}

export interface LogIngestionResponse {
  accepted: number;
  rejected: number;
  rejections: Array<{ index: number; reason: string }>;
}

// ─── Search ───────────────────────────────────────────────────────────────────

/**
 * The Elasticsearch document shape for a single indexed insight.
 *
 * Naming convention: camelCase (serialised as-is into ES).
 * All tenant data is namespace-isolated via the `tenantId` field
 * and a per-tenant index alias (see InsightSearchService).
 */
export interface InsightDocument {
  // ── Identity ────────────────────────────────────────────────────────────
  /** Composite document ID: "{tenantId}#{insightId}" — ensures idempotent indexing. */
  docId:     string;
  tenantId:  string;
  insightId: string;
  ruleId:    string;
  /** Human-readable rule name — full-text searchable. */
  ruleName:  string;

  // ── Classification ──────────────────────────────────────────────────────
  severity:  Severity;
  priority:  number;       // integer 1–100; lower = higher priority

  // ── Scores (stored as floats for function_score / script queries) ───────
  confidence:  number;     // 0–1
  composite:   number;     // 0–1 final scorer composite
  severityScore: number;   // 0–1 normalised severity weight
  recency:     number;     // 0–1 exponential time decay at index time
  impact:      number;     // 0–1 blast-radius estimate

  // ── Temporal ────────────────────────────────────────────────────────────
  firedAt:    ISODateString;
  indexedAt:  ISODateString;  // set by the indexer

  // ── Service context ─────────────────────────────────────────────────────
  /** The service this insight concerns, if determinable from signal. */
  service?: string;
  affectedComponents: string[];

  // ── Full-text / semantic fields ─────────────────────────────────────────
  /**
   * Pre-rendered explanation string (from root-cause builder).
   * Indexed with the `english` analyser for keyword search.
   * Future: dense_vector embedding stored alongside this for kNN.
   */
  explanation: string;

  /**
   * Concatenated search surface: ruleName + explanation + affectedComponents.
   * A single catch-all field to keep multi-match queries simple.
   */
  searchText: string;

  /**
   * Future-ready: 1536-dim embedding of `searchText` (OpenAI text-embedding-3-small).
   * Stored as a `dense_vector` field; not populated until the embedding pipeline
   * is wired. Set to null until then — the mapping marks it as `index: false`
   * when null to avoid wasted storage.
   */
  embedding?: number[] | null;

  // ── Raw signal passthrough (not indexed, stored only) ───────────────────
  signal?: Record<string, unknown>;
}

/** Query params for POST /v1/search/insights. */
export interface InsightSearchRequest {
  /** Free-text query string. Supports Elasticsearch simple_query_string syntax. */
  q: string;
  /** Filter to a single service. */
  service?: string;
  /** Minimum severity to include (page > critical > warning > info). */
  minSeverity?: Severity;
  /** Only return insights fired after this timestamp. */
  since?: ISODateString;
  /** Maximum number of results (1–50, default 10). */
  limit?: number;
  /** Offset for pagination (default 0). */
  from?: number;
  /**
   * Search mode:
   *  "keyword"  — BM25 full-text over searchText + ruleName (default)
   *  "semantic" — kNN over the embedding vector (requires embedding pipeline)
   *  "hybrid"   — RRF combination of keyword + semantic
   */
  mode?: 'keyword' | 'semantic' | 'hybrid';
}

/** A single hit returned from search. */
export interface InsightSearchHit {
  score:    number;
  document: InsightDocument;
  /** Highlighted fragments of the matching searchText / explanation. */
  highlights?: Record<string, string[]>;
}

/** Response body for POST /v1/search/insights. */
export interface InsightSearchResponse {
  total:   number;
  hits:    InsightSearchHit[];
  took:    number;   // ES-reported query time in ms
  fromCache: boolean;
}

// ─── AI Narrator ──────────────────────────────────────────────────────────────

/**
 * Structured narrative produced by the AI augmentation layer.
 * All three fields are always present — either AI-generated or
 * deterministically built by the fallback path.
 */
export interface AiNarrative {
  /** 1–2 sentence technical explanation of what happened and why. */
  explanation: string;
  /** ≤ 25-word plain-English summary suitable for a status page or Slack alert. */
  summary: string;
  /** Top 3 prioritised next-step actions. */
  actions: string[];
  /** Whether the text was produced by the AI model or the deterministic fallback. */
  source: 'ai' | 'fallback';
  /** ISO-8601 timestamp when this narrative was generated. */
  generatedAt: ISODateString;
}

/** Response body for GET /v1/explain. */
export interface ExplainData {
  tenantId: string;
  service?: string;
  narrative: AiNarrative;
  /** The structured root-cause that was narrated (for client reference). */
  rootCause: RootCause | null;
  fromCache: boolean;
  computedAt: ISODateString;
  cacheAgeMs?: number;
}

// ─── Health check ─────────────────────────────────────────────────────────────

export type HealthStatus = 'ok' | 'degraded' | 'down';

export interface HealthCheckResponse {
  status: HealthStatus;
  version: SemVer;
  uptime: number;     // seconds
  checks: Record<string, { status: HealthStatus; latencyMs?: number }>;
}
