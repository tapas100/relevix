/**
 * InsightSearchService — Elasticsearch client for insight search.
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │  Index per tenant  : relevix-insights-{tenantId}-000001             │
 * │  Write via alias   : relevix-insights-{tenantId}                    │
 * │  Timeout SLA       : 80ms (hard ES timeout; Redis cache covers hot) │
 * │  Search modes      : keyword (BM25) · semantic (kNN) · hybrid (RRF) │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * Ranking strategy
 * ────────────────
 * Keyword mode uses a `function_score` query that multiplies the BM25 text
 * score by a weighted combination of four numeric signals already stored on
 * the document:
 *
 *   final_score = BM25(q, searchText | ruleName)
 *               × (0.35·composite + 0.25·confidence + 0.20·recency + 0.20·impact)
 *
 * This ensures that among documents equally matching the query text, the one
 * with the highest operational severity/confidence surfaces first — exactly
 * mirroring the Go scorer's composite logic.
 *
 * Severity order boost (page=4, critical=3, warning=2, info=1) is applied as
 * an additive `weight` filter boost so page-severity documents always beat
 * equivalent lower-severity ones.
 *
 * Semantic mode (future)
 * ──────────────────────
 * Uses ES kNN (`knn` top-level key) against the `embedding` dense_vector.
 * Requires the embedding pipeline to populate `InsightDocument.embedding`.
 * Enabled by flipping `index: false → true` on the mapping and setting
 * `EMBEDDING_PIPELINE_ENABLED=true` in config.
 *
 * Hybrid mode
 * ───────────
 * Uses Elasticsearch's Reciprocal Rank Fusion (RRF) combiner to merge the
 * keyword ranked list and the kNN ranked list into a single result set.
 * No score normalisation needed — RRF handles it natively.
 */

import type {
  InsightDocument,
  InsightSearchRequest,
  InsightSearchResponse,
  InsightSearchHit,
  Severity,
  RankedInsight,
} from '@relevix/types';
import {
  INSIGHT_INDEX_SETTINGS,
  INSIGHT_INDEX_MAPPING,
  tenantIndexAlias,
  tenantIndexName,
  ILM_POLICY_NAME,
} from './insight-index-mapping.js';

// ─── Config ───────────────────────────────────────────────────────────────────

export interface SearchServiceConfig {
  elasticsearchUrl: string;
  apiKey?: string | undefined;
  indexPrefix: string;
  timeoutMs: number;
}

// ─── Severity helpers ─────────────────────────────────────────────────────────

const SEVERITY_WEIGHT: Record<Severity, number> = {
  page: 4, critical: 3, warning: 2, info: 1,
};

const SEVERITY_ORDER: Severity[] = ['page', 'critical', 'warning', 'info'];

/** Returns all severities >= the given minimum (inclusive). */
function severitiesAtOrAbove(min: Severity): Severity[] {
  const idx = SEVERITY_ORDER.indexOf(min);
  return SEVERITY_ORDER.slice(0, idx + 1);
}

// ─── Document builder ─────────────────────────────────────────────────────────

/**
 * Converts a RankedInsight (from the rule-engine) into an InsightDocument
 * ready to be indexed into Elasticsearch.
 *
 * The `searchText` catch-all field is constructed here, once, at index time —
 * not at query time — so search stays cheap.
 */
export function toInsightDocument(
  tenantId: string,
  ri: RankedInsight,
  explanation: string,
  affectedComponents: string[],
): InsightDocument {
  const { insight, components } = ri;
  const service =
    (insight.signal?.['service'] as string | undefined) ?? undefined;

  const searchText = [
    insight.ruleName,
    explanation,
    ...affectedComponents,
    service ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return {
    docId:             `${tenantId}#${insight.id}`,
    tenantId,
    insightId:         insight.id,
    ruleId:            insight.ruleId,
    ruleName:          insight.ruleName,
    severity:          insight.severity,
    priority:          insight.priority,
    confidence:        insight.confidence,
    composite:         components.composite,
    severityScore:     components.severity,
    recency:           components.recency,
    impact:            components.impact,
    firedAt:           insight.firedAt,
    indexedAt:         new Date().toISOString(),
    ...(service !== undefined && { service }),
    affectedComponents,
    explanation,
    searchText,
    embedding:         null,  // populated by embedding pipeline when enabled
    ...(insight.signal !== undefined && { signal: insight.signal }),
  };
}

// ─── ES wire types (minimal subset) ──────────────────────────────────────────

interface EsHit {
  _score: number;
  _source: InsightDocument;
  highlight?: Record<string, string[]>;
}

interface EsSearchResponse {
  took: number;
  hits: {
    total: { value: number; relation: 'eq' | 'gte' };
    hits:  EsHit[];
  };
}

interface EsBulkItem {
  index?: { result?: string; error?: { reason: string } };
}

interface EsBulkResponse {
  errors: boolean;
  items:  EsBulkItem[];
}

// ─── Query builders ───────────────────────────────────────────────────────────

/**
 * Keyword query — BM25 with function_score composite boosting.
 *
 * Query anatomy:
 *   bool
 *   ├── must  : simple_query_string over [searchText^2, ruleName^1]
 *   ├── filter: term(tenantId), [term(service)], [terms(severity)], [range(firedAt)]
 *   └── wrapped in function_score for numeric boosting
 *
 * The `^2` weight on `searchText` prioritises the rich concatenated field
 * over the raw `ruleName` alone.
 */
function buildKeywordQuery(req: InsightSearchRequest, tenantId: string): object {
  const filters: object[] = [
    { term: { tenantId } },
  ];

  if (req.service) {
    filters.push({ term: { service: req.service } });
  }

  if (req.minSeverity) {
    filters.push({ terms: { severity: severitiesAtOrAbove(req.minSeverity) } });
  }

  if (req.since) {
    filters.push({ range: { firedAt: { gte: req.since } } });
  }

  const textQuery = {
    simple_query_string: {
      query:            req.q,
      fields:           ['searchText^2', 'ruleName^1', 'ruleId.text^0.5'],
      default_operator: 'AND',
      // Supports +, -, |, *, "", ~ operators familiar to power users
      flags: 'AND|OR|NOT|PHRASE|PREFIX|FUZZY',
    },
  };

  return {
    function_score: {
      query: {
        bool: {
          must:   [textQuery],
          filter: filters,
        },
      },
      /**
       * Score functions
       * ───────────────
       * 1. Composite weight  (0–1 float) — the Go scorer's final score
       * 2. Confidence weight (0–1 float) — rule match confidence
       * 3. Recency weight    (0–1 float) — exponential time decay
       * 4. Impact weight     (0–1 float) — blast-radius
       * 5. Severity weight   (1–4 int)   — page insights always beat critical
       *
       * score_mode "sum" adds the individual function scores together.
       * boost_mode "multiply" multiplies the sum against the BM25 score.
       * This means BM25 relevance is required — a non-matching doc scores 0.
       */
      functions: [
        {
          filter: { match_all: {} },
          script_score: {
            script: {
              source: `
                double composite  = doc['composite'].value  * 0.35;
                double confidence = doc['confidence'].value * 0.25;
                double recency    = doc['recency'].value    * 0.20;
                double impact     = doc['impact'].value     * 0.20;
                return composite + confidence + recency + impact;
              `,
            },
          },
        },
        // Severity tier boost: page gets +4, critical +3, etc.
        ...Object.entries(SEVERITY_WEIGHT).map(([sev, weight]) => ({
          filter: { term: { severity: sev } },
          weight,
        })),
      ],
      score_mode: 'sum',
      boost_mode: 'multiply',
    },
  };
}

/**
 * Semantic query — kNN over the `embedding` dense_vector field.
 *
 * Prerequisites:
 *   - `embedding` field mapping must have `index: true`.
 *   - `InsightDocument.embedding` must be populated (1536-dim float array).
 *
 * `num_candidates` controls the HNSW graph traversal width.
 * Larger = more accurate but slower. 150 is a good default for <100ms SLA.
 */
function buildSemanticQuery(
  queryVector: number[],
  tenantId: string,
  req: InsightSearchRequest,
): object {
  const filters: object[] = [{ term: { tenantId } }];

  if (req.service)      filters.push({ term: { service: req.service } });
  if (req.minSeverity)  filters.push({ terms: { severity: severitiesAtOrAbove(req.minSeverity) } });
  if (req.since)        filters.push({ range: { firedAt: { gte: req.since } } });

  return {
    knn: {
      field:          'embedding',
      query_vector:   queryVector,
      k:              req.limit ?? 10,
      num_candidates: 150,
      filter:         filters,
    },
  };
}

/**
 * Hybrid query — Reciprocal Rank Fusion of keyword + kNN.
 *
 * RRF natively handles score-scale differences between BM25 and cosine
 * similarity. The `rank_constant` (default 60) controls how aggressively
 * top-ranked results are promoted — 60 is the ES-recommended starting point.
 */
function buildHybridQuery(
  req: InsightSearchRequest,
  tenantId: string,
  queryVector: number[],
): object {
  return {
    retriever: {
      rrf: {
        retrievers: [
          { standard: { query: buildKeywordQuery(req, tenantId) } },
          { knn:      buildSemanticQuery(queryVector, tenantId, req) },
        ],
        rank_constant: 60,
        rank_window_size: (req.limit ?? 10) * 2,
      },
    },
  };
}

// ─── Highlighting config ──────────────────────────────────────────────────────

const HIGHLIGHT_CONFIG = {
  pre_tags:  ['<mark>'],
  post_tags: ['</mark>'],
  fields: {
    searchText:  { number_of_fragments: 2, fragment_size: 150 },
    explanation: { number_of_fragments: 1, fragment_size: 200 },
    ruleName:    { number_of_fragments: 1, fragment_size: 100 },
  },
};

// ─── InsightSearchService ─────────────────────────────────────────────────────

export class InsightSearchService {
  private readonly baseUrl: string;
  private readonly authHeader: Record<string, string>;
  private readonly indexPrefix: string;
  private readonly timeoutMs: number;

  constructor(config: SearchServiceConfig) {
    this.baseUrl     = config.elasticsearchUrl.replace(/\/$/, '');
    this.authHeader  = config.apiKey
      ? { Authorization: `ApiKey ${config.apiKey}` }
      : {};
    this.indexPrefix = config.indexPrefix;
    this.timeoutMs   = config.timeoutMs;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Full-text / semantic search over a tenant's insight index.
   *
   * Performance path:
   *   1. Build query DSL (no I/O, <1ms).
   *   2. Single ES `_search` call with `?timeout=80ms` hard deadline.
   *   3. Map hits to InsightSearchHit[].
   *
   * The caller (route handler) wraps this in Redis cache (10s TTL) so
   * repeated identical queries are served from memory in <5ms.
   */
  async search(
    tenantId: string,
    req: InsightSearchRequest,
    // Future: queryVector is passed in when embedding pipeline is live
    queryVector?: number[],
  ): Promise<InsightSearchResponse> {
    const limit = req.limit ?? 10;
    const from  = req.from  ?? 0;
    const mode  = req.mode  ?? 'keyword';

    let body: object;

    if (mode === 'semantic' && queryVector) {
      body = buildSemanticQuery(queryVector, tenantId, req);
    } else if (mode === 'hybrid' && queryVector) {
      body = buildHybridQuery(req, tenantId, queryVector);
    } else {
      // Default: keyword
      body = {
        query:     buildKeywordQuery(req, tenantId),
        highlight: HIGHLIGHT_CONFIG,
        from,
        size:      limit,
        // Only return fields we need — reduces network payload
        _source:   true,
        // Sort: ES score first, then composite desc as tiebreaker
        sort: [
          { _score:    { order: 'desc' } },
          { composite: { order: 'desc' } },
          { firedAt:   { order: 'desc' } },
        ],
      };
    }

    const alias = tenantIndexAlias(this.indexPrefix, tenantId);
    const esRes = await this.esRequest<EsSearchResponse>(
      'POST',
      `/${alias}/_search?timeout=${String(this.timeoutMs)}ms`,
      body,
    );

    const hits: InsightSearchHit[] = esRes.hits.hits.map((h) => ({
      score:    h._score,
      document: h._source,
      ...(h.highlight !== undefined && { highlights: h.highlight }),
    }));

    return {
      total:     esRes.hits.total.value,
      hits,
      took:      esRes.took,
      fromCache: false,
    };
  }

  /**
   * Indexes or re-indexes a batch of insight documents.
   *
   * Uses bulk API with `index` action (idempotent via `docId`).
   * Errors on individual documents are logged but do not fail the batch —
   * the next precompute tick will re-index.
   */
  async bulkIndex(documents: InsightDocument[]): Promise<{ indexed: number; failed: number }> {
    if (documents.length === 0) return { indexed: 0, failed: 0 };

    const lines: string[] = [];
    for (const doc of documents) {
      const alias = tenantIndexAlias(this.indexPrefix, doc.tenantId);
      lines.push(JSON.stringify({ index: { _index: alias, _id: doc.docId } }));
      lines.push(JSON.stringify(doc));
    }

    const res = await this.esRequest<EsBulkResponse>(
      'POST',
      '/_bulk',
      lines.join('\n') + '\n',
      'application/x-ndjson',
    );

    let failed = 0;
    for (const item of res.items) {
      if (item.index?.error) failed++;
    }

    return { indexed: documents.length - failed, failed };
  }

  /**
   * Ensures the tenant's index + alias exists.
   * Called lazily on first search or proactively during tenant provisioning.
   * Safe to call multiple times — is idempotent.
   */
  async ensureIndex(tenantId: string): Promise<void> {
    const indexName = tenantIndexName(this.indexPrefix, tenantId);
    const alias     = tenantIndexAlias(this.indexPrefix, tenantId);

    // Check if index already exists
    const exists = await this.esHead(`/${indexName}`);
    if (exists) return;

    // Create index with mapping + alias
    await this.esRequest('PUT', `/${indexName}`, {
      settings: {
        ...INSIGHT_INDEX_SETTINGS,
        lifecycle: { name: ILM_POLICY_NAME, rollover_alias: alias },
      },
      mappings: INSIGHT_INDEX_MAPPING,
      aliases: {
        [alias]: { is_write_index: true },
      },
    });
  }

  // ── Private HTTP helpers ────────────────────────────────────────────────────

  private async esRequest<T>(
    method: string,
    path: string,
    body?: object | string,
    contentType = 'application/json',
  ): Promise<T> {
    const controller = new AbortController();
    // Give ES 20ms extra beyond the query timeout for network overhead
    const timer = setTimeout(() => controller.abort(), this.timeoutMs + 20);

    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          'Content-Type': contentType,
          Accept:         'application/json',
          ...this.authHeader,
        },
        body:   body !== undefined
          ? (typeof body === 'string' ? body : JSON.stringify(body))
          : null,
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Elasticsearch ${method} ${path} → HTTP ${String(res.status)}: ${text}`);
      }

      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  private async esHead(path: string): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs + 20);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: 'HEAD',
        headers: { ...this.authHeader },
        signal: controller.signal,
      });
      return res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createInsightSearchService(cfg: {
  ELASTICSEARCH_URL: string;
  ELASTICSEARCH_API_KEY?: string | undefined;
  ELASTICSEARCH_INDEX_PREFIX: string;
  ELASTICSEARCH_TIMEOUT_MS: number;
}): InsightSearchService {
  return new InsightSearchService({
    elasticsearchUrl: cfg.ELASTICSEARCH_URL,
    ...(cfg.ELASTICSEARCH_API_KEY !== undefined && { apiKey: cfg.ELASTICSEARCH_API_KEY }),
    indexPrefix:      cfg.ELASTICSEARCH_INDEX_PREFIX,
    timeoutMs:        cfg.ELASTICSEARCH_TIMEOUT_MS,
  });
}
