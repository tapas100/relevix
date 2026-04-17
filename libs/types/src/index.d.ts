export type UUID = string;
export type ISODateString = string;
export type SemVer = string;
export type Nullable<T> = T | null;
export type Optional<T> = T | undefined;
export interface PaginationQuery {
    page: number;
    pageSize: number;
}
export interface PaginatedResponse<T> {
    data: T[];
    total: number;
    page: number;
    pageSize: number;
    hasNextPage: boolean;
}
export interface ApiSuccess<T> {
    ok: true;
    data: T;
    meta?: Record<string, unknown>;
}
export interface ApiError {
    ok: false;
    error: {
        code: string;
        message: string;
        details?: unknown;
        traceId?: string;
    };
}
export type ApiResponse<T> = ApiSuccess<T> | ApiError;
export interface BaseEntity {
    id: UUID;
    createdAt: ISODateString;
    updatedAt: ISODateString;
    deletedAt: Nullable<ISODateString>;
}
export interface Tenant extends BaseEntity {
    slug: string;
    name: string;
    plan: 'free' | 'starter' | 'pro' | 'enterprise';
    isActive: boolean;
}
export type RuleOperator = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'not_in' | 'contains' | 'starts_with' | 'ends_with' | 'regex';
export type RuleAction = 'allow' | 'deny' | 'flag' | 'enrich' | 'transform';
export interface RuleCondition {
    field: string;
    operator: RuleOperator;
    value: unknown;
    negate?: boolean;
}
export interface Rule extends BaseEntity {
    tenantId: UUID;
    name: string;
    description: Optional<string>;
    version: number;
    priority: number;
    conditions: RuleCondition[];
    conditionLogic: 'ALL' | 'ANY';
    action: RuleAction;
    actionPayload?: Record<string, unknown>;
    isActive: boolean;
    tags: string[];
}
export interface RuleEvaluationRequest {
    tenantId: UUID;
    context: Record<string, unknown>;
    tags?: string[];
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
export type EventSchema = 'relevix/event/v1';
export interface IngestEvent {
    schema: EventSchema;
    id: UUID;
    tenantId: UUID;
    source: string;
    type: string;
    payload: Record<string, unknown>;
    occurredAt: ISODateString;
    receivedAt?: ISODateString;
    traceId?: string;
}
export interface IngestBatchRequest {
    events: IngestEvent[];
}
export interface IngestBatchResponse {
    accepted: number;
    rejected: number;
    rejections: Array<{
        index: number;
        reason: string;
    }>;
}
export type Severity = 'page' | 'critical' | 'warning' | 'info';
/** Four-factor scoring breakdown produced by the Go scorer. */
export interface ScoreComponents {
    severity: number;
    confidence: number;
    recency: number;
    impact: number;
    composite: number;
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
    limit?: number;
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
    rejections: Array<{
        index: number;
        reason: string;
    }>;
}
/**
 * The Elasticsearch document shape for a single indexed insight.
 *
 * Naming convention: camelCase (serialised as-is into ES).
 * All tenant data is namespace-isolated via the `tenantId` field
 * and a per-tenant index alias (see InsightSearchService).
 */
export interface InsightDocument {
    /** Composite document ID: "{tenantId}#{insightId}" — ensures idempotent indexing. */
    docId: string;
    tenantId: string;
    insightId: string;
    ruleId: string;
    /** Human-readable rule name — full-text searchable. */
    ruleName: string;
    severity: Severity;
    priority: number;
    confidence: number;
    composite: number;
    severityScore: number;
    recency: number;
    impact: number;
    firedAt: ISODateString;
    indexedAt: ISODateString;
    /** The service this insight concerns, if determinable from signal. */
    service?: string;
    affectedComponents: string[];
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
    score: number;
    document: InsightDocument;
    /** Highlighted fragments of the matching searchText / explanation. */
    highlights?: Record<string, string[]>;
}
/** Response body for POST /v1/search/insights. */
export interface InsightSearchResponse {
    total: number;
    hits: InsightSearchHit[];
    took: number;
    fromCache: boolean;
}
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
export type HealthStatus = 'ok' | 'degraded' | 'down';
export interface HealthCheckResponse {
    status: HealthStatus;
    version: SemVer;
    uptime: number;
    checks: Record<string, {
        status: HealthStatus;
        latencyMs?: number;
    }>;
}
//# sourceMappingURL=index.d.ts.map