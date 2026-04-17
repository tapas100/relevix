/**
 * Prometheus metrics plugin for the API Gateway.
 *
 * Exposes the following metrics at GET /metrics:
 *
 *   http_request_duration_seconds  — histogram of response latency, labelled by
 *                                    method, route, status_code
 *   http_requests_total            — counter of all requests
 *   http_errors_total              — counter of 4xx/5xx responses
 *   circuit_breaker_state          — gauge: 0=CLOSED, 1=HALF_OPEN, 2=OPEN
 *   cache_hits_total               — counter of Redis cache hits
 *   cache_misses_total             — counter of Redis cache misses
 *   openai_requests_total          — counter labelled by outcome (success/fallback/error)
 *   openai_tokens_used_total       — counter of tokens consumed
 *
 * Prom-client is initialised with a DEFAULT_REGISTRY — the /metrics route
 * simply calls `register.metrics()`.  All collectors must call
 * `getMetricsRegistry()` to avoid duplicate registration across hot reloads.
 */

import { Registry, Counter, Histogram, Gauge } from 'prom-client';
import type { CircuitState } from '../services/circuit-breaker.js';

// ─── Singleton registry ───────────────────────────────────────────────────────
// We use our own registry (not prom-client's default global) so that test
// instances don't bleed state between each other.

let _registry: Registry | null = null;

export function getMetricsRegistry(): Registry {
  if (!_registry) _registry = new Registry();
  return _registry;
}

// ─── Metric declarations ──────────────────────────────────────────────────────

let _metrics: ReturnType<typeof createMetrics> | null = null;

function createMetrics(registry: Registry) {
  const httpDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request latency in seconds',
    labelNames: ['method', 'route', 'status_code'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [registry],
  });

  const httpRequestsTotal = new Counter({
    name: 'http_requests_total',
    help: 'Total HTTP requests',
    labelNames: ['method', 'route', 'status_code'] as const,
    registers: [registry],
  });

  const httpErrorsTotal = new Counter({
    name: 'http_errors_total',
    help: 'Total HTTP 4xx/5xx responses',
    labelNames: ['method', 'route', 'status_code'] as const,
    registers: [registry],
  });

  const circuitBreakerState = new Gauge({
    name: 'circuit_breaker_state',
    help: 'Circuit breaker state: 0=CLOSED 1=HALF_OPEN 2=OPEN',
    labelNames: ['name'] as const,
    registers: [registry],
  });

  const cacheHitsTotal = new Counter({
    name: 'cache_hits_total',
    help: 'Redis cache hits',
    labelNames: ['namespace'] as const,
    registers: [registry],
  });

  const cacheMissesTotal = new Counter({
    name: 'cache_misses_total',
    help: 'Redis cache misses',
    labelNames: ['namespace'] as const,
    registers: [registry],
  });

  const openaiRequestsTotal = new Counter({
    name: 'openai_requests_total',
    help: 'OpenAI API calls by outcome',
    labelNames: ['outcome'] as const, // success | fallback | error | timeout
    registers: [registry],
  });

  const openaiTokensTotal = new Counter({
    name: 'openai_tokens_used_total',
    help: 'OpenAI completion tokens consumed',
    registers: [registry],
  });

  return {
    httpDuration,
    httpRequestsTotal,
    httpErrorsTotal,
    circuitBreakerState,
    cacheHitsTotal,
    cacheMissesTotal,
    openaiRequestsTotal,
    openaiTokensTotal,
  };
}

export function getMetrics() {
  if (!_metrics) _metrics = createMetrics(getMetricsRegistry());
  return _metrics;
}

// ─── Circuit-breaker state helper ────────────────────────────────────────────

const STATE_VALUE: Record<CircuitState, number> = {
  CLOSED:    0,
  HALF_OPEN: 1,
  OPEN:      2,
};

export function recordCircuitState(name: string, state: CircuitState): void {
  getMetrics().circuitBreakerState.labels(name).set(STATE_VALUE[state]);
}
