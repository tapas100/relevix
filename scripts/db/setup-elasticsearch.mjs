#!/usr/bin/env node
/**
 * scripts/db/setup-elasticsearch.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Creates the Elasticsearch ILM policy, index template, and write alias for
 * every tenant that exists in the DATABASE_URL PostgreSQL database.
 *
 * Also runs against a hard-coded list of demo tenants so it works when
 * Postgres is not yet seeded (bootstrap order safety).
 *
 * Usage:
 *   node scripts/db/setup-elasticsearch.mjs
 *   ES_URL=http://localhost:9200 node scripts/db/setup-elasticsearch.mjs
 *   ES_URL=http://user:pass@es:9200 node scripts/db/setup-elasticsearch.mjs --tenant tenant-demo
 *
 * Requirements: Node.js ≥ 18 (built-in fetch), Elasticsearch ≥ 8.x
 */

import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    url:    { type: 'string', default: process.env.ES_URL    || 'http://localhost:9200' },
    tenant: { type: 'string', default: process.env.ES_TENANT || '' },
    force:  { type: 'boolean', default: false }, // re-create even if exists
  },
});

const ES_BASE   = args.url.replace(/\/$/, '');
const ES_HEADERS = { 'Content-Type': 'application/json' };

// Default demo tenants — always set up regardless of Postgres state
const BOOTSTRAP_TENANTS = ['tenant-demo', 'tenant-acme', 'tenant-staging'];

const INDEX_PREFIX = 'relevix-insights';
const ILM_POLICY   = 'relevix-insights-policy';
const TEMPLATE_NAME = 'relevix-insights-template';

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function esReq(method, path, body) {
  const res = await fetch(`${ES_BASE}${path}`, {
    method,
    headers: ES_HEADERS,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body: json };
}

function log(emoji, msg) { console.log(`${emoji}  ${msg}`); }
function ok(msg)   { log('✅', msg); }
function skip(msg) { log('⏭️ ', msg); }
function warn(msg) { log('⚠️ ', msg); }
function fail(msg) { log('❌', msg); process.exitCode = 1; }

// ─── 1. ILM policy ───────────────────────────────────────────────────────────
// Rollover at 10 GB or 30 days; delete after 90 days.

async function ensureIlmPolicy() {
  const check = await esReq('GET', `/_ilm/policy/${ILM_POLICY}`);
  if (check.ok && !args.force) {
    skip(`ILM policy "${ILM_POLICY}" already exists`);
    return;
  }

  const { ok: success, body } = await esReq('PUT', `/_ilm/policy/${ILM_POLICY}`, {
    policy: {
      phases: {
        hot: {
          min_age: '0ms',
          actions: {
            rollover: { max_primary_shard_size: '10gb', max_age: '30d' },
            set_priority: { priority: 100 },
          },
        },
        warm: {
          min_age: '30d',
          actions: {
            shrink: { number_of_shards: 1 },
            forcemerge: { max_num_segments: 1 },
            set_priority: { priority: 50 },
          },
        },
        delete: {
          min_age: '90d',
          actions: { delete: {} },
        },
      },
    },
  });

  success ? ok(`ILM policy "${ILM_POLICY}" created`) : fail(`ILM policy failed: ${JSON.stringify(body)}`);
}

// ─── 2. Index template ────────────────────────────────────────────────────────
// Applies settings + mapping to any index matching relevix-insights-*

async function ensureTemplate() {
  const check = await esReq('HEAD', `/_index_template/${TEMPLATE_NAME}`);
  if (check.ok && !args.force) {
    skip(`Index template "${TEMPLATE_NAME}" already exists`);
    return;
  }

  const { ok: success, body } = await esReq('PUT', `/_index_template/${TEMPLATE_NAME}`, {
    index_patterns: [`${INDEX_PREFIX}-*`],
    priority: 200,
    template: {
      settings: {
        number_of_shards:   1,
        number_of_replicas: 1,
        refresh_interval:   '5s',
        'index.lifecycle.name':         ILM_POLICY,
        'index.lifecycle.rollover_alias': INDEX_PREFIX,  // overridden per-alias below
        analysis: {
          analyzer: {
            insight_text: {
              type:      'custom',
              tokenizer: 'standard',
              filter:    ['lowercase', 'english_stop', 'english_stemmer'],
            },
          },
          filter: {
            english_stop:    { type: 'stop',    language: 'english' },
            english_stemmer: { type: 'stemmer', language: 'english' },
          },
        },
      },
      mappings: {
        dynamic: 'strict',
        properties: {
          // Identity
          docId:     { type: 'keyword' },
          tenantId:  { type: 'keyword' },
          insightId: { type: 'keyword' },
          ruleId:    { type: 'keyword', fields: { text: { type: 'text', analyzer: 'standard' } } },
          ruleName:  { type: 'text', analyzer: 'insight_text', fields: { keyword: { type: 'keyword', ignore_above: 256 } } },

          // Classification
          severity:      { type: 'keyword' },
          priority:      { type: 'integer' },

          // Scores
          confidence:    { type: 'float' },
          composite:     { type: 'float' },
          severityScore: { type: 'float' },
          recency:       { type: 'float' },
          impact:        { type: 'float' },

          // Temporal
          firedAt:   { type: 'date' },
          indexedAt: { type: 'date' },

          // Service context
          service:            { type: 'keyword' },
          affectedComponents: { type: 'keyword' },

          // Full-text
          explanation: { type: 'text', analyzer: 'insight_text', store: true },
          searchText:  { type: 'text', analyzer: 'insight_text', term_vector: 'with_positions_offsets' },

          // Vector (inactive — flip index:true to enable kNN)
          embedding: { type: 'dense_vector', dims: 1536, index: false, similarity: 'cosine' },

          // Raw signal (stored only, not indexed)
          signal: { type: 'object', enabled: false },
        },
      },
    },
  });

  success ? ok(`Index template "${TEMPLATE_NAME}" created`) : fail(`Template failed: ${JSON.stringify(body)}`);
}

// ─── 3. Per-tenant write index + alias ───────────────────────────────────────

async function ensureTenantIndex(tenantId) {
  const alias    = `${INDEX_PREFIX}-${tenantId}`;
  const concrete = `${INDEX_PREFIX}-${tenantId}-000001`;

  // Check if alias already exists
  const check = await esReq('HEAD', `/_alias/${alias}`);
  if (check.ok && !args.force) {
    skip(`Alias "${alias}" already exists`);
    return;
  }

  // Create the concrete index with the write-alias baked in
  const { ok: success, status, body } = await esReq('PUT', `/${concrete}`, {
    aliases: {
      [alias]: { is_write_index: true },
    },
    settings: {
      'index.lifecycle.name':           ILM_POLICY,
      'index.lifecycle.rollover_alias': alias,
    },
  });

  if (success) {
    ok(`Tenant index "${concrete}" + alias "${alias}" created`);
  } else if (status === 400 && body?.error?.type === 'resource_already_exists_exception') {
    skip(`Index "${concrete}" already exists — adding alias only`);
    // PUT alias just in case it was missing
    await esReq('PUT', `/${concrete}/_alias/${alias}`, { is_write_index: true });
  } else {
    fail(`Tenant index failed for "${tenantId}": ${JSON.stringify(body)}`);
  }
}

// ─── 4. Seed a sample insight document ───────────────────────────────────────
// One document per demo tenant so dashboards aren't empty on first boot.

async function seedSampleInsight(tenantId) {
  const alias = `${INDEX_PREFIX}-${tenantId}`;
  const docId = `seed-sample-${tenantId}-001`;

  // Idempotency: check if document already exists
  const check = await esReq('HEAD', `/${alias}/_doc/${docId}`);
  if (check.ok) {
    skip(`Sample insight for "${tenantId}" already exists`);
    return;
  }

  const now = new Date().toISOString();
  const { ok: success, body } = await esReq('PUT', `/${alias}/_doc/${docId}`, {
    docId,
    tenantId,
    insightId: docId,
    ruleId:    'b0000000-0000-0000-0000-000000000002',
    ruleName:  'Error Rate Critical Threshold',
    severity:  'critical',
    priority:  5,
    confidence:    0.92,
    composite:     0.87,
    severityScore: 0.80,
    recency:       1.00,
    impact:        0.75,
    service:  'checkout-service',
    affectedComponents: ['checkout-service', 'payment-service'],
    explanation: 'Error rate for checkout-service spiked to 18% — 3.6× the weekly baseline. '
               + 'Root cause: payment-service returning HTTP 503 due to database connection pool exhaustion. '
               + 'Recommend: increase PG_POOL_SIZE from 10 to 25 and add circuit breaker on payment client.',
    searchText: 'Error Rate Critical Threshold checkout-service payment-service error rate spike',
    firedAt:   now,
    indexedAt: now,
    signal: {
      kind:         'error_rate',
      value:        0.18,
      z_score:      4.2,
      throughput:   42.5,
      anomaly:      'critical',
      sample_count: 254,
    },
  });

  success ? ok(`Sample insight seeded for tenant "${tenantId}"`) : warn(`Sample insight skipped: ${JSON.stringify(body)}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🔍  Elasticsearch setup — ${ES_BASE}\n`);

  // Check ES is reachable
  const ping = await esReq('GET', '/');
  if (!ping.ok) {
    fail(`Cannot reach Elasticsearch at ${ES_BASE}. Start it first.`);
    process.exit(1);
  }
  log('🔗', `Connected to Elasticsearch ${ping.body.version?.number ?? '(unknown version)'}`);

  await ensureIlmPolicy();
  await ensureTemplate();

  const tenants = args.tenant
    ? [args.tenant]
    : BOOTSTRAP_TENANTS;

  for (const t of tenants) {
    await ensureTenantIndex(t);
    await seedSampleInsight(t);
  }

  console.log('\n🎉  Elasticsearch setup complete\n');
}

main().catch(err => { console.error(err); process.exit(1); });
