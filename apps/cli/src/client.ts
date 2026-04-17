/**
 * client.ts — Typed HTTP client for the Relevix API Gateway.
 *
 * Used by all CLI commands. Reads apiUrl + token from the conf store.
 * All methods throw on non-2xx or when the { ok: false } envelope is returned.
 */
import type {
  InsightsData,
  RootCauseData,
  ExplainData,
  InsightSearchRequest,
  InsightSearchResponse,
  HealthCheckResponse,
  ApiSuccess,
  ApiError,
} from '@relevix/types';
import { apiUrl, requireToken } from './config.js';

// ─── Core fetch wrapper ───────────────────────────────────────────────────────

async function request<T>(
  path: string,
  init: RequestInit = {},
  overrideToken?: string,
): Promise<T> {
  const token = overrideToken ?? requireToken();
  const base  = apiUrl();

  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  });

  const body = (await res.json()) as ApiSuccess<T> | ApiError;

  if (!res.ok || !body.ok) {
    const msg = body.ok === false ? (body as ApiError).error.message : `HTTP ${String(res.status)}`;
    throw new Error(msg);
  }

  return (body as ApiSuccess<T>).data;
}

function qs(params: Record<string, string | number | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

// ─── API methods ──────────────────────────────────────────────────────────────

export const api = {

  health(): Promise<HealthCheckResponse> {
    return request<HealthCheckResponse>('/health', { method: 'GET' });
  },

  insights(params: { service?: string; limit?: number } = {}): Promise<InsightsData> {
    return request<InsightsData>(`/v1/insights${qs(params)}`);
  },

  rootCause(params: { service?: string } = {}): Promise<RootCauseData> {
    return request<RootCauseData>(`/v1/root-cause${qs(params)}`);
  },

  explain(params: { service?: string } = {}): Promise<ExplainData> {
    return request<ExplainData>(`/v1/explain${qs(params)}`);
  },

  search(body: InsightSearchRequest): Promise<InsightSearchResponse> {
    return request<InsightSearchResponse>('/v1/search/insights', {
      method: 'POST',
      body:   JSON.stringify(body),
    });
  },
};
