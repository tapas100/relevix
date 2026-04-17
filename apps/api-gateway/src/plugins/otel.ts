/**
 * OpenTelemetry plugin — trace context propagation for the API Gateway.
 *
 * When OTEL_ENABLED=true the plugin:
 *  1. Reads W3C traceparent / tracestate headers from every inbound request.
 *  2. Injects trace_id + span_id into every Pino log line (structlog correlation).
 *  3. Forwards traceparent downstream to rule-engine and ingestion service.
 *
 * The heavy SDK (@opentelemetry/sdk-node) is initialised ONCE in main.ts —
 * this plugin only handles per-request context propagation and log binding.
 *
 * Architecture note:
 *  - Traces are exported via OTLP/HTTP to OTEL_EXPORTER_OTLP_ENDPOINT
 *    (e.g. a local Tempo or Jaeger collector, or an OTLP cloud endpoint).
 *  - Sampling rate is controlled via OTEL_TRACES_SAMPLER + OTEL_TRACES_SAMPLER_ARG
 *    env vars — the SDK respects these without code changes.
 *
 * When OTEL_ENABLED=false (default) the plugin is a no-op: no SDK loaded,
 * no overhead, no external calls.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';

// W3C Trace Context header names
const TRACEPARENT = 'traceparent';
const TRACESTATE  = 'tracestate';

/**
 * Parses a W3C traceparent header.
 * Format: `00-{traceId:32hex}-{spanId:16hex}-{flags:2hex}`
 */
function parseTraceparent(header: string): { traceId: string; spanId: string } | null {
  const parts = header.split('-');
  if (parts.length !== 4 || parts[0] !== '00') return null;
  const [, traceId, spanId] = parts;
  if (!traceId || !spanId) return null;
  if (traceId.length !== 32 || spanId.length !== 16) return null;
  return { traceId, spanId };
}

/**
 * Generates a new W3C-compliant traceparent header for outbound requests.
 * If an inbound traceId exists it is propagated (same trace, new span).
 */
export function newTraceparent(traceId?: string): string {
  const tid = traceId ?? crypto.randomUUID().replace(/-/g, '');
  const sid = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  return `00-${tid}-${sid}-01`; // sampled=01
}

async function otelPlugin(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', async (request: FastifyRequest, _reply: FastifyReply) => {
    const raw = request.headers[TRACEPARENT];
    const header = Array.isArray(raw) ? raw[0] : raw;

    let traceId: string | undefined;
    let spanId:  string | undefined;

    if (header) {
      const parsed = parseTraceparent(header);
      if (parsed) {
        traceId = parsed.traceId;
        spanId  = parsed.spanId;
      }
    }

    // Generate a new trace if none was provided
    if (!traceId) {
      traceId = crypto.randomUUID().replace(/-/g, '');
    }

    // Bind trace context to the request logger — every log line for this
    // request will include trace_id and span_id for log↔trace correlation.
    (request as FastifyRequest & { log: ReturnType<typeof request.log.child> }).log =
      request.log.child({
        trace_id: traceId,
        span_id:  spanId ?? request.id,
      });

    // Attach to request so downstream route handlers can forward to services
    (request as FastifyRequest & { traceId: string; tracestate?: string }).traceId = traceId;

    const ts = request.headers[TRACESTATE];
    if (ts) {
      (request as FastifyRequest & { tracestate: string }).tracestate = Array.isArray(ts) ? ts[0] ?? '' : ts;
    }
  });

  // Emit trace_id in every response for client-side log correlation
  app.addHook('onSend', async (request: FastifyRequest, reply: FastifyReply) => {
    const r = request as FastifyRequest & { traceId?: string };
    if (r.traceId) {
      void reply.header('x-trace-id', r.traceId);
    }
  });
}

export const otelTracePlugin = fp(otelPlugin, {
  name: 'otel-trace',
  fastify: '4.x',
});
