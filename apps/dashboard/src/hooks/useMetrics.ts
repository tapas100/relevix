/**
 * useMetrics — returns synthetic time-series metrics derived from insight signals.
 *
 * Today: generates deterministic mock data seeded from the insight composite
 * scores so graphs are non-trivial and correlated with actual insight severity.
 *
 * Tomorrow: replace the body with a real /v1/metrics fetch — the hook contract
 * (return type, parameters) stays identical.
 */
import { useMemo } from 'react';
import type { RankedInsight } from '@relevix/types';
import type { ServiceMetrics, MetricPoint } from '../types/metrics';

const POINTS = 20;           // 20 points over 60 minutes → 3-minute granularity
const STEP_MS = 3 * 60_000;

/** Deterministic pseudo-random from a seed (no crypto needed here). */
function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    return (s >>> 0) / 0xffffffff;
  };
}

export function useMetrics(insights: RankedInsight[], service?: string): ServiceMetrics {
  return useMemo<ServiceMetrics>(() => {
    const now   = Date.now();
    // Use composite score of top insight as the "noise seed" so graphs
    // look more severe when insights are higher-scoring
    const topComposite = insights[0]?.components.composite ?? 0.3;
    const rand = seededRandom(Math.round(topComposite * 1e6));

    const latency:   MetricPoint[] = [];
    const errorRate: MetricPoint[] = [];

    for (let i = POINTS - 1; i >= 0; i--) {
      const t = new Date(now - i * STEP_MS).toISOString();

      // Latency: baseline 80ms, spikes proportional to composite score
      const latencySpike = topComposite * 400;
      const latencyNoise = (rand() - 0.5) * 40;
      latency.push({ t, v: Math.max(10, 80 + latencySpike + latencyNoise) });

      // Error rate: baseline near 0, elevates with composite
      const errBase  = topComposite * 8;
      const errNoise = rand() * 2;
      errorRate.push({ t, v: Math.max(0, errBase + errNoise) });
    }

    return { service: service ?? 'all', latency, errorRate };
  }, [insights, service]);
}
