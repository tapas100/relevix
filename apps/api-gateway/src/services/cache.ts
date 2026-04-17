/**
 * CacheService — thin Redis wrapper with typed get/set and key builders.
 *
 * Design decisions:
 * - All values are JSON-serialised (compact, portable).
 * - TTL is required on every `set` — no implicit infinite TTL.
 * - `get` returns `null` on miss or Redis errors (fail-open: callers fall back
 *   to live evaluation rather than returning an error to the user).
 * - Key convention: `{namespace}:{tenantId}[:{discriminator}]`
 *   e.g. `insights:tenant-abc:checkout`
 */
import type IORedis from 'ioredis';
import { getMetrics } from '../plugins/metrics.js';

export class CacheService {
  constructor(
    private readonly redis: IORedis,
    /** Default TTL in seconds (used when callers omit the ttl param). */
    private readonly defaultTtl: number,
  ) {}

  /**
   * Returns the parsed cached value, or null on miss/error.
   * Never throws — cache misses are not errors.
   */
  async get<T>(key: string): Promise<{ value: T; setAt: number } | null> {
    const namespace = key.split(':')[0] ?? 'unknown';
    try {
      const raw = await this.redis.get(key);
      if (raw === null) {
        getMetrics().cacheMissesTotal.labels(namespace).inc();
        return null;
      }
      getMetrics().cacheHitsTotal.labels(namespace).inc();
      return JSON.parse(raw) as { value: T; setAt: number };
    } catch {
      getMetrics().cacheMissesTotal.labels(namespace).inc();
      return null;
    }
  }

  /** Serialises value to JSON and stores it with the given TTL (seconds). */
  async set<T>(key: string, value: T, ttl?: number): Promise<void> {
    const payload = JSON.stringify({ value, setAt: Date.now() });
    await this.redis.set(key, payload, 'EX', ttl ?? this.defaultTtl);
  }

  /** Deletes a single cache key. */
  async invalidate(key: string): Promise<void> {
    await this.redis.del(key);
  }

  /**
   * Deletes all keys matching a glob pattern (SCAN-based, no KEYS).
   * Use sparingly — O(N) over the keyspace.
   */
  async invalidatePattern(pattern: string): Promise<void> {
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = next;
      if (keys.length > 0) {
        await this.redis.del(...keys);
      }
    } while (cursor !== '0');
  }

  /** Pings Redis. Returns true if healthy. */
  async ping(): Promise<boolean> {
    try {
      const reply = await this.redis.ping();
      return reply === 'PONG';
    } catch {
      return false;
    }
  }
}

// ─── Key builders ─────────────────────────────────────────────────────────────
// All keys follow the pattern: namespace:tenantId[:service]
// The service suffix is omitted when fetching all services for a tenant.

export function insightsCacheKey(tenantId: string, service?: string): string {
  return service ? `insights:${tenantId}:${service}` : `insights:${tenantId}:__all__`;
}

export function rootCauseCacheKey(tenantId: string, service?: string): string {
  return service ? `root-cause:${tenantId}:${service}` : `root-cause:${tenantId}:__all__`;
}

export function explainCacheKey(tenantId: string, service?: string): string {
  return service ? `explain:${tenantId}:${service}` : `explain:${tenantId}:__all__`;
}
