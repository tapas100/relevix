/**
 * Typed API client.
 *
 * All requests attach the JWT stored in localStorage under "relevix_token".
 * Every response is unwrapped from the { ok, data } envelope.
 *
 * Usage:
 *   const { insights } = await api.getInsights({ service: 'checkout', limit: 3 });
 */
import type {
  InsightsData,
  RootCauseData,
  ExplainData,
  ApiSuccess,
  ApiError,
} from '@relevix/types';

const BASE = '/v1';

function authHeader(): HeadersInit {
  const token = localStorage.getItem('relevix_token') ?? '';
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...authHeader(),
      ...(init.headers ?? {}),
    },
  });

  const body = (await res.json()) as ApiSuccess<T> | ApiError;

  if (!body.ok) {
    throw new Error((body as ApiError).error.message);
  }

  return (body as ApiSuccess<T>).data;
}

// ─── Endpoints ────────────────────────────────────────────────────────────────

export const api = {
  getInsights(params: { service?: string; limit?: number } = {}): Promise<InsightsData> {
    const qs = new URLSearchParams();
    if (params.service) qs.set('service', params.service);
    if (params.limit)   qs.set('limit',   String(params.limit));
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return request<InsightsData>(`/insights${suffix}`);
  },

  getRootCause(params: { service?: string } = {}): Promise<RootCauseData> {
    const qs = new URLSearchParams();
    if (params.service) qs.set('service', params.service);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return request<RootCauseData>(`/root-cause${suffix}`);
  },

  getExplain(params: { service?: string } = {}): Promise<ExplainData> {
    const qs = new URLSearchParams();
    if (params.service) qs.set('service', params.service);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return request<ExplainData>(`/explain${suffix}`);
  },
};
