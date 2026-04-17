/**
 * Local metric types for the dashboard graphs.
 *
 * The backend does not yet expose a /v1/metrics endpoint.
 * These types describe the shape returned by useMetrics(), which today
 * derives mock data from the Insight signals. When a real metrics
 * endpoint is wired, only useMetrics.ts needs to change.
 */

export interface MetricPoint {
  /** ISO-8601 timestamp for the x-axis. */
  t: string;
  /** Numeric value for the y-axis. */
  v: number;
}

export interface ServiceMetrics {
  service: string;
  /** p95 latency in milliseconds over the last 60 minutes. */
  latency: MetricPoint[];
  /** Error rate 0–100 (%) over the last 60 minutes. */
  errorRate: MetricPoint[];
}
