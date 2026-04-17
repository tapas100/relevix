/**
 * RuleEngineClient — HTTP client for the Go rule-engine's intelligence API.
 *
 * Endpoints consumed:
 *   GET {baseUrl}/v1/insights?tenant={tenantId}
 *     → Returns precomputed ranked insights from Redis cache (p50 ~2ms).
 *       Falls back to live evaluation on cache miss (p95 ~80ms).
 *
 * Timeout budget:
 *   150ms — leaves headroom for the gateway to cache + serialise within 200ms.
 *
 * Error handling:
 *   - Network / timeout errors → thrown as InsightsUnavailableError
 *   - Non-2xx from rule-engine → thrown with upstream error details
 */
import { InsightsUnavailableError } from '@relevix/errors';
import type { RankedInsight, ISODateString } from '@relevix/types';
import { CircuitBreaker, CircuitOpenError } from './circuit-breaker.js';
import { newTraceparent } from '../plugins/otel.js';
import { recordCircuitState } from '../plugins/metrics.js';

const TIMEOUT_MS = 150;

/** How many times to retry a transient failure before giving up. */
const MAX_RETRIES = 2;
/** Base delay for exponential back-off between retries (ms). */
const RETRY_BASE_MS = 20;

/** Wire format returned by the Go rule-engine query handler. */
export interface RuleEngineInsightsResponse {
  ok: boolean;
  from_cache: boolean;
  computed_at: ISODateString;
  insights: RawRankedInsight[];
}

/** Go scorer.RankedInsight serialised to JSON (snake_case Go tags). */
export interface RawRankedInsight {
  rank: number;
  insight: {
    id: string;
    rule_id: string;
    rule_name?: string;
    severity: string;
    priority?: number;
    confidence: number;
    fired_at: ISODateString;
    dedup_key?: string;
    signal?: Record<string, unknown>;
  };
  components: {
    severity: number;
    confidence: number;
    recency: number;
    impact: number;
    composite?: number;
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class RuleEngineClient {
  private readonly cb: CircuitBreaker;

  constructor(private readonly baseUrl: string) {
    this.cb = new CircuitBreaker('rule-engine', {
      failureThreshold: 5,
      successThreshold: 2,
      resetTimeoutMs:   30_000,
      onStateChange: (name, _from, to) => {
        recordCircuitState(name, to);
      },
    });
    // Initialise gauge to CLOSED on startup
    recordCircuitState('rule-engine', 'CLOSED');
  }

  /** Current circuit state — exposed on the health endpoint. */
  get circuitState() { return this.cb.currentState; }

  /**
   * Fetches ranked insights for a tenant from the Go rule-engine.
   * Returns the raw response so callers can use `from_cache` + `computed_at`.
   *
   * Failure model:
   *   - Transient network errors: retried up to MAX_RETRIES with exponential back-off.
   *   - Circuit OPEN: throws CircuitOpenError immediately (no HTTP call).
   *   - All errors are wrapped as InsightsUnavailableError for callers.
   */
  async fetchInsights(tenantId: string, traceId?: string): Promise<RuleEngineInsightsResponse> {
    try {
      return await this.cb.call(() => this.fetchWithRetry(tenantId, traceId));
    } catch (err) {
      if (err instanceof CircuitOpenError) {
        throw new InsightsUnavailableError(
          'Rule engine is temporarily unavailable (circuit open).',
          traceId,
        );
      }
      throw err;
    }
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private async fetchWithRetry(
    tenantId: string,
    traceId?: string,
    attempt = 0,
  ): Promise<RuleEngineInsightsResponse> {
    try {
      return await this.doFetch(tenantId, traceId);
    } catch (err) {
      const isRetryable =
        !(err instanceof InsightsUnavailableError) ||
        err.message.includes('timed out') ||
        err.message.includes('unreachable');

      if (isRetryable && attempt < MAX_RETRIES) {
        // Exponential back-off with ±20% jitter: 20ms, 40ms
        const delay = RETRY_BASE_MS * 2 ** attempt * (0.8 + Math.random() * 0.4);
        await sleep(delay);
        return this.fetchWithRetry(tenantId, traceId, attempt + 1);
      }
      throw err;
    }
  }

  private async doFetch(tenantId: string, traceId?: string): Promise<RuleEngineInsightsResponse> {
    const url = `${this.baseUrl}/v1/insights?tenant=${encodeURIComponent(tenantId)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); }, TIMEOUT_MS);

    // Propagate W3C trace context downstream so rule-engine spans can be
    // correlated with the gateway span in Tempo/Jaeger.
    const traceparent = newTraceparent(traceId);

    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          'Accept':       'application/json',
          'X-Request-Id': traceId ?? '',
          'traceparent':  traceparent,
        },
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new InsightsUnavailableError(
          `Rule engine returned ${String(res.status)}: ${text.slice(0, 200)}`,
          traceId,
        );
      }

      return (await res.json()) as RuleEngineInsightsResponse;
    } catch (err) {
      if (err instanceof InsightsUnavailableError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      throw new InsightsUnavailableError(
        msg.includes('abort') ? 'Rule engine request timed out.' : `Rule engine unreachable: ${msg}`,
        traceId,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

// ─── Normaliser ───────────────────────────────────────────────────────────────
// Converts raw Go wire format → canonical TypeScript types.

export function normaliseInsights(raw: RawRankedInsight[]): RankedInsight[] {
  return raw.map((r) => ({
    rank: r.rank,
    insight: {
      id: r.insight.id,
      ruleId: r.insight.rule_id,
      ruleName: r.insight.rule_name ?? r.insight.rule_id,
      severity: r.insight.severity as RankedInsight['insight']['severity'],
      priority: r.insight.priority ?? 0,
      confidence: r.insight.confidence,
      firedAt: r.insight.fired_at,
      ...(r.insight.dedup_key !== undefined && { dedupKey: r.insight.dedup_key }),
      ...(r.insight.signal !== undefined && { signal: r.insight.signal }),
    },
    components: {
      severity: r.components.severity,
      confidence: r.components.confidence,
      recency: r.components.recency,
      impact: r.components.impact,
      composite: r.components.composite ?? (
        r.components.severity * r.components.confidence *
        r.components.recency * r.components.impact
      ),
    },
  }));
}
