#!/usr/bin/env node
/**
 * Relevix Data Seeder
 * ───────────────────────────────────────────────────────────────────────────
 * Generates realistic e-commerce / SaaS infrastructure telemetry and pumps
 * it into Relevix via POST /v1/ingest/batch.
 *
 * Simulates 10 microservices across 3 environments with:
 *   - Normal traffic patterns (baseline)
 *   - Injected anomalies: latency spikes, error bursts, OOM events
 *   - ~2.5 lakh (250 000) events in the default "large" run
 *
 * Usage:
 *   node scripts/seed.mjs                   # 250 000 events, all services
 *   node scripts/seed.mjs --count 10000     # quick smoke test
 *   node scripts/seed.mjs --tenant acme     # specific tenant
 *   node scripts/seed.mjs --anomaly high    # inject more anomalies
 *
 * Dependencies: none (pure Node.js, uses only fetch which is built-in ≥ v18)
 */

import { parseArgs } from 'node:util';

// ─── CLI args ─────────────────────────────────────────────────────────────────

const { values: args } = parseArgs({
  options: {
    count:    { type: 'string',  default: '250000' },
    tenant:   { type: 'string',  default: 'tenant-demo' },
    url:      { type: 'string',  default: 'http://localhost:3001' },
    token:    { type: 'string',  default: '' },
    batch:    { type: 'string',  default: '500' },
    anomaly:  { type: 'string',  default: 'medium' }, // low | medium | high
    services: { type: 'string',  default: '' },       // comma-separated, default=all
    dryRun:   { type: 'boolean', default: false },
    quiet:    { type: 'boolean', default: false },
  },
});

const TOTAL     = parseInt(args.count,  10);
const BATCH_SZ  = parseInt(args.batch,  10);
const TENANT_ID = args.tenant;
const BASE_URL  = args.url;
const TOKEN     = args.token;
const DRY_RUN   = args.dryRun;
const QUIET     = args.quiet;

// Anomaly injection rates by tier
const ANOMALY_RATE = { low: 0.02, medium: 0.08, high: 0.20 }[args.anomaly] ?? 0.08;

// ─── Service catalogue ────────────────────────────────────────────────────────
// Mirrors a typical e-commerce / SaaS microservice topology.

const ALL_SERVICES = [
  { name: 'api-gateway',       env: 'production',  baseLatency: 45,   errorRate: 0.002 },
  { name: 'checkout-service',  env: 'production',  baseLatency: 120,  errorRate: 0.005 },
  { name: 'inventory-service', env: 'production',  baseLatency: 30,   errorRate: 0.001 },
  { name: 'payment-service',   env: 'production',  baseLatency: 280,  errorRate: 0.003 },
  { name: 'search-service',    env: 'production',  baseLatency: 65,   errorRate: 0.002 },
  { name: 'recommendation-svc',env: 'production',  baseLatency: 90,   errorRate: 0.004 },
  { name: 'user-service',      env: 'production',  baseLatency: 25,   errorRate: 0.001 },
  { name: 'notification-svc',  env: 'production',  baseLatency: 55,   errorRate: 0.006 },
  { name: 'order-service',     env: 'staging',     baseLatency: 150,  errorRate: 0.010 },
  { name: 'analytics-service', env: 'staging',     baseLatency: 500,  errorRate: 0.008 },
];

const SERVICES = args.services
  ? ALL_SERVICES.filter(s => args.services.split(',').includes(s.name))
  : ALL_SERVICES;

// ─── Anomaly patterns ─────────────────────────────────────────────────────────

const ANOMALY_TYPES = [
  {
    name: 'latency_spike',
    probability: 0.40,
    // Inject a rolling spike window: latency jumps 5-20x for 30-120 events
    apply: (svc, fields) => ({
      ...fields,
      latency_ms:  fields.latency_ms * (5 + Math.random() * 15),
      latency_p95: fields.latency_p95 * (4 + Math.random() * 10),
      latency_p99: fields.latency_p99 * (6 + Math.random() * 20),
      z_score:     3.5 + Math.random() * 4,
      anomaly:     'latency_spike',
      severity:    Math.random() > 0.5 ? 'critical' : 'warning',
    }),
  },
  {
    name: 'error_burst',
    probability: 0.25,
    apply: (svc, fields) => ({
      ...fields,
      error_rate:  0.15 + Math.random() * 0.40,
      http_5xx:    Math.floor(100 + Math.random() * 500),
      anomaly:     'error_burst',
      severity:    'critical',
      level:       'error',
    }),
  },
  {
    name: 'memory_pressure',
    probability: 0.15,
    apply: (svc, fields) => ({
      ...fields,
      memory_usage_pct: 85 + Math.random() * 14,
      gc_pause_ms:      200 + Math.random() * 800,
      anomaly:          'memory_pressure',
      severity:         'warning',
    }),
  },
  {
    name: 'cpu_saturation',
    probability: 0.10,
    apply: (svc, fields) => ({
      ...fields,
      cpu_usage_pct: 88 + Math.random() * 11,
      throttled_pct: 20 + Math.random() * 60,
      anomaly:       'cpu_saturation',
      severity:      'warning',
    }),
  },
  {
    name: 'dependency_timeout',
    probability: 0.10,
    apply: (svc, fields) => ({
      ...fields,
      downstream_timeout_rate: 0.10 + Math.random() * 0.30,
      circuit_open:            Math.random() > 0.6,
      anomaly:                 'dependency_timeout',
      severity:                'critical',
    }),
  },
];

// ─── Field generators ─────────────────────────────────────────────────────────

const ENDPOINTS = [
  '/v1/products', '/v1/cart', '/v1/checkout', '/v1/orders',
  '/v1/search', '/v1/users/me', '/v1/inventory', '/v1/payments',
  '/v1/recommendations', '/health', '/metrics',
];

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];
const HTTP_CODES   = [200, 200, 200, 200, 200, 201, 204, 400, 404, 500, 502, 503];
const REGIONS      = ['us-east-1', 'us-west-2', 'eu-west-1', 'ap-southeast-1'];
const K8S_PODS     = Array.from({ length: 5 }, (_, i) => `pod-${Math.random().toString(36).slice(2, 8)}`);

function jitter(base, pct = 0.2) {
  return base * (1 + (Math.random() - 0.5) * 2 * pct);
}

function uuid() {
  return crypto.randomUUID();
}

function isoTs(offsetMs = 0) {
  return new Date(Date.now() - offsetMs).toISOString();
}

function randomFrom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Generates one RawLog that the ingestion service accepts.
 * The `fields` map is where all metric/signal data lives.
 */
function generateEvent(svc, i, totalCount) {
  const isAnomaly  = Math.random() < ANOMALY_RATE;
  const aType      = isAnomaly ? pickAnomalyType() : null;

  // Base metrics — realistic distributions
  const latency_ms  = Math.abs(jitter(svc.baseLatency));
  const latency_p95 = latency_ms * (1.4 + Math.random() * 0.6);
  const latency_p99 = latency_p95 * (1.2 + Math.random() * 0.5);
  const rps         = 50 + Math.random() * 500;
  const error_rate  = Math.random() < svc.errorRate * 5 ? svc.errorRate * (2 + Math.random() * 5) : svc.errorRate;
  const statusCode  = Math.random() < error_rate ? randomFrom([500, 502, 503]) : randomFrom([200, 200, 200, 201]);

  let fields = {
    // HTTP
    http_method:  randomFrom(HTTP_METHODS),
    http_path:    randomFrom(ENDPOINTS),
    http_status:  statusCode,
    latency_ms,
    latency_p50:  latency_ms * 0.7,
    latency_p95,
    latency_p99,
    z_score:      (latency_ms - svc.baseLatency) / (svc.baseLatency * 0.15),

    // Throughput
    requests_per_sec: rps,
    error_rate,
    http_5xx: Math.floor(rps * error_rate),
    http_4xx: Math.floor(rps * 0.01),

    // System
    cpu_usage_pct:    20 + Math.random() * 40,
    memory_usage_pct: 40 + Math.random() * 30,
    gc_pause_ms:      Math.random() * 50,

    // Infra
    region:      randomFrom(REGIONS),
    pod:         randomFrom(K8S_PODS),
    replica:     Math.floor(Math.random() * 5),
    environment: svc.env,

    // Derived signals — used by rule engine conditions
    throughput_drop_pct: Math.random() * 5,
    saturation:          (20 + Math.random() * 40) / 100,
    signal_kind:         'http_request',
  };

  // Apply anomaly transform if selected
  if (aType) {
    fields = aType.apply(svc, fields);
  }

  // Simulate a traffic wave: higher load every ~1000 events
  if (i % 1000 < 50) {
    fields.requests_per_sec *= 3;
    fields.latency_ms       *= 1.5;
  }

  const level = statusCode >= 500 ? 'error'
              : statusCode >= 400 ? 'warn'
              : Math.random() < 0.05 ? 'warn'
              : 'info';

  const message = statusCode >= 500
    ? `[ERROR] ${fields.http_method} ${fields.http_path} → ${statusCode} (${Math.round(latency_ms)}ms)`
    : `${fields.http_method} ${fields.http_path} ${statusCode} ${Math.round(latency_ms)}ms`;

  return {
    tenantId: TENANT_ID,
    message,
    level,
    service: svc.name,
    traceId: uuid(),
    timestamp: isoTs(Math.random() * 3_600_000), // spread over last 1h
    fields,
    tags: [
      svc.env,
      svc.name,
      ...(aType ? [aType.name] : []),
      ...(statusCode >= 500 ? ['error', '5xx'] : []),
    ],
  };
}

function pickAnomalyType() {
  const r = Math.random();
  let cum = 0;
  for (const a of ANOMALY_TYPES) {
    cum += a.probability;
    if (r < cum) return a;
  }
  return ANOMALY_TYPES[0];
}

// ─── HTTP helper ─────────────────────────────────────────────────────────────

async function postBatch(logs) {
  if (DRY_RUN) return { accepted: logs.length, rejected: 0 };

  const headers = {
    'Content-Type': 'application/json',
    'Accept':       'application/json',
  };
  if (TOKEN) headers['Authorization'] = `Bearer ${TOKEN}`;

  const res = await fetch(`${BASE_URL}/v1/ingest/batch`, {
    method:  'POST',
    headers,
    body:    JSON.stringify({ logs }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  return res.json();
}

// ─── Progress bar ─────────────────────────────────────────────────────────────

function progress(sent, total, errors, anomalies) {
  if (QUIET) return;
  const pct   = Math.round((sent / total) * 100);
  const bar   = '█'.repeat(Math.floor(pct / 5)) + '░'.repeat(20 - Math.floor(pct / 5));
  const label = `${sent.toLocaleString()} / ${total.toLocaleString()}`;
  process.stdout.write(
    `\r  [${bar}] ${pct}%  ${label}  errors:${errors}  anomalies:${anomalies}  `
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n  Relevix Data Seeder');
  console.log('  ─────────────────────────────────────────────────────');
  console.log(`  Target  : ${BASE_URL}`);
  console.log(`  Tenant  : ${TENANT_ID}`);
  console.log(`  Events  : ${TOTAL.toLocaleString()}`);
  console.log(`  Batch   : ${BATCH_SZ}`);
  console.log(`  Anomaly : ${args.anomaly} (${(ANOMALY_RATE * 100).toFixed(0)}% injection rate)`);
  console.log(`  Services: ${SERVICES.map(s => s.name).join(', ')}`);
  if (DRY_RUN) console.log('  DRY RUN : no HTTP calls will be made\n');
  console.log();

  let sent       = 0;
  let errorCount = 0;
  let anomalies  = 0;
  const t0       = Date.now();

  while (sent < TOTAL) {
    const batch = [];
    const svc   = SERVICES[Math.floor((sent / TOTAL) * SERVICES.length) % SERVICES.length];

    for (let i = 0; i < BATCH_SZ && sent + batch.length < TOTAL; i++) {
      const evt = generateEvent(svc, sent + i, TOTAL);
      if (evt.fields.anomaly) anomalies++;
      batch.push(evt);
    }

    try {
      await postBatch(batch);
    } catch (err) {
      errorCount++;
      if (!QUIET) console.error(`\n  [!] Batch failed: ${err.message}`);
      // Back off briefly on error
      await new Promise(r => setTimeout(r, 500));
    }

    sent += batch.length;
    progress(sent, TOTAL, errorCount, anomalies);
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const ratePs  = Math.round(TOTAL / parseFloat(elapsed));

  console.log('\n');
  console.log('  ─────────────────────────────────────────────────────');
  console.log(`  ✓  Sent      : ${sent.toLocaleString()} events`);
  console.log(`  ✓  Anomalies : ${anomalies.toLocaleString()} (${((anomalies/sent)*100).toFixed(1)}%)`);
  console.log(`  ✓  Errors    : ${errorCount}`);
  console.log(`  ✓  Duration  : ${elapsed}s  (~${ratePs.toLocaleString()} events/s)`);
  console.log(`  ✓  Tenant    : ${TENANT_ID}`);
  console.log('\n  Next steps:');
  console.log(`    curl http://localhost:3001/v1/insights?tenant=${TENANT_ID}`);
  console.log(`    open http://localhost:5173   # dashboard`);
  console.log();
}

main().catch(err => {
  console.error('\n  Fatal:', err.message);
  process.exit(1);
});
