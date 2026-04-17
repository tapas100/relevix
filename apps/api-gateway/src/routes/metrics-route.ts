/**
 * GET /metrics — Prometheus scrape endpoint.
 *
 * Security: this route must be behind network-level access control (firewall /
 * k8s NetworkPolicy) in production — it must NOT be publicly reachable.
 * The route itself does not require a JWT so the Prometheus scraper can
 * authenticate via mTLS or a service-mesh sidecar instead.
 *
 * Usage (prometheus.yml):
 *   scrape_configs:
 *     - job_name: api-gateway
 *       static_configs:
 *         - targets: ['api-gateway:3001']
 *       metrics_path: /metrics
 */
import type { FastifyInstance } from 'fastify';
import { getMetricsRegistry } from '../plugins/metrics.js';

export async function metricsRoute(app: FastifyInstance): Promise<void> {
  app.get('/metrics', {
    // Exclude from rate limiter — scraper is internal
    config: { rateLimit: { max: 1000, timeWindow: 60_000 } },
    schema: {
      hide: true, // don't expose in OpenAPI docs
      response: {
        200: { type: 'string' },
      },
    },
  }, async (_req, reply) => {
    const registry = getMetricsRegistry();
    const body = await registry.metrics();
    return reply
      .header('Content-Type', registry.contentType)
      .send(body);
  });
}
