/**
 * Elasticsearch index mapping for the `relevix-insights-{tenantId}` index.
 *
 * Design decisions
 * ────────────────
 * 1. One index per tenant (via alias + write-index pattern).
 *    • Tenant isolation at the index level — no cross-tenant leakage possible.
 *    • Allows per-tenant shard sizing and independent ILM policies.
 *
 * 2. Two text fields per searchable string:
 *    • `.keyword` sub-field for exact/term filters and aggregations (not_analyzed).
 *    • Root field with `english` analyser for BM25 full-text.
 *
 * 3. `searchText` is the single catch-all full-text field.
 *    Populated as: `${ruleName} ${explanation} ${affectedComponents.join(' ')}`.
 *    All multi-match queries target only `searchText` and `ruleName` — keeps
 *    the query DSL simple and the index lean.
 *
 * 4. `embedding` is a `dense_vector` with 1536 dims (text-embedding-3-small).
 *    `index: false` while the embedding pipeline is not yet wired — the field
 *    is stored but not indexed, so no wasted segment memory.
 *    Flip to `index: true, similarity: "cosine"` to activate kNN search.
 *
 * 5. Numeric score fields (`composite`, `confidence`, `recency`, `impact`) are
 *    `float` — used as multiplicative boosters in `function_score` queries.
 *
 * 6. `dynamic: "strict"` — reject any document with unmapped fields to prevent
 *    accidental field explosion (a common ES footgun).
 *
 * 7. ILM / rollover: index name pattern is `relevix-insights-{tenantId}-000001`.
 *    A write alias `relevix-insights-{tenantId}` points to the active index.
 *    Rollover at 10 GB or 30 days keeps shards healthy.
 */

export const INSIGHT_INDEX_SETTINGS = {
  number_of_shards:   1,    // single-tenant index — 1 shard is plenty up to ~50 GB
  number_of_replicas: 1,
  // Refresh every 5s (default 1s) — insights are near-real-time, not real-time.
  // Reduces indexing overhead at the cost of ≤5s search lag.
  refresh_interval: '5s',
  analysis: {
    analyzer: {
      /**
       * Used for `searchText` and `explanation`.
       * Applies English stemming + stopword removal so "latency spiked" matches
       * "latency spike" and "spikes".
       */
      insight_text: {
        type:      'custom',
        tokenizer: 'standard',
        filter:    ['lowercase', 'english_stop', 'english_stemmer'],
      },
    },
    filter: {
      english_stop:    { type: 'stop',   language: 'english' },
      english_stemmer: { type: 'stemmer', language: 'english' },
    },
  },
} as const;

export const INSIGHT_INDEX_MAPPING = {
  dynamic: 'strict',
  properties: {
    // ── Identity ──────────────────────────────────────────────────────────
    docId:     { type: 'keyword' },
    tenantId:  { type: 'keyword' },
    insightId: { type: 'keyword' },
    ruleId:    {
      type:   'keyword',
      // Copy to a text field so `ruleId` is also full-text searchable
      fields: { text: { type: 'text', analyzer: 'standard' } },
    },
    ruleName: {
      type:     'text',
      analyzer: 'insight_text',
      fields:   { keyword: { type: 'keyword', ignore_above: 256 } },
    },

    // ── Classification ────────────────────────────────────────────────────
    severity: {
      type: 'keyword',
      // Numeric mapping for range queries / script scoring
      // page=4, critical=3, warning=2, info=1
    },
    priority: { type: 'integer' },

    // ── Scores ────────────────────────────────────────────────────────────
    confidence:    { type: 'float' },
    composite:     { type: 'float' },
    severityScore: { type: 'float' },
    recency:       { type: 'float' },
    impact:        { type: 'float' },

    // ── Temporal ──────────────────────────────────────────────────────────
    firedAt:   { type: 'date' },
    indexedAt: { type: 'date' },

    // ── Service context ───────────────────────────────────────────────────
    service:            { type: 'keyword' },
    affectedComponents: { type: 'keyword' },   // array of keyword values

    // ── Full-text search surface ──────────────────────────────────────────
    explanation: {
      type:     'text',
      analyzer: 'insight_text',
      // store: true so highlighting works without _source fetching
      store: true,
    },
    /**
     * Catch-all field. Populated as:
     *   `${ruleName} ${explanation} ${affectedComponents.join(' ')}`
     *
     * All free-text searches run against this single field.
     * The `insight_text` analyser applies English stemming.
     */
    searchText: {
      type:             'text',
      analyzer:         'insight_text',
      // term_vector enables faster highlighting
      term_vector:      'with_positions_offsets',
    },

    /**
     * Future-ready: 1536-dim OpenAI text-embedding-3-small vector.
     * Set `index: false` now — flip to `{ index: true, similarity: "cosine" }`
     * once the embedding pipeline is live.
     */
    embedding: {
      type:       'dense_vector',
      dims:       1536,
      index:      false,          // ← change to true to activate kNN
      similarity: 'cosine',
    },

    // ── Raw signal (stored, not indexed) ─────────────────────────────────
    signal: {
      type:    'object',
      enabled: false,   // stored in _source only; not indexed or searchable
    },
  },
} as const;

/** ILM policy name — must be created separately via ES ILM API. */
export const ILM_POLICY_NAME = 'relevix-insights-policy';

/**
 * Returns the write-alias name for a tenant.
 * This is also the name used in all search queries.
 */
export function tenantIndexAlias(prefix: string, tenantId: string): string {
  return `${prefix}-${tenantId}`;
}

/**
 * Returns the concrete index name used on first creation.
 * Subsequent rollover indices are: -000002, -000003, etc.
 */
export function tenantIndexName(prefix: string, tenantId: string): string {
  return `${prefix}-${tenantId}-000001`;
}
