/**
 * useInsights — polls GET /v1/insights every 25 s (matching the cache TTL).
 *
 * Returns { data, loading, error } — the classic async resource tuple.
 * On refocus the browser tab triggers an immediate refresh.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import type { InsightsData } from '@relevix/types';
import { api } from '../api/client';

const POLL_MS = 25_000;

interface UseInsightsResult {
  data:    InsightsData | null;
  loading: boolean;
  error:   string | null;
  refresh: () => void;
}

export function useInsights(service?: string, limit = 3): UseInsightsResult {
  const [data,    setData]    = useState<InsightsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetch = useCallback(async () => {
    try {
      setError(null);
      const res = await api.getInsights({
        ...(service !== undefined && { service }),
        limit,
      });
      setData(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load insights');
    } finally {
      setLoading(false);
    }
  }, [service, limit]);

  useEffect(() => {
    setLoading(true);
    void fetch();

    timerRef.current = setInterval(() => { void fetch(); }, POLL_MS);

    const onFocus = () => { void fetch(); };
    window.addEventListener('focus', onFocus);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      window.removeEventListener('focus', onFocus);
    };
  }, [fetch]);

  return { data, loading, error, refresh: fetch };
}
