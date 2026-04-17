/**
 * Redis client factory.
 *
 * Creates a single IORedis client per process with:
 * - Lazy connect (connect on first command, not on construction)
 * - Automatic reconnect with exponential back-off
 * - 5 s connect timeout to fail fast on misconfiguration
 *
 * Usage:
 *   const redis = createRedisClient(config.REDIS_URL);
 *   await redis.ping(); // warm up
 *   app.addHook('onClose', async () => { await redis.quit(); });
 */
import IORedis, { type RedisOptions } from 'ioredis';

export type { IORedis };

const BASE_OPTS: RedisOptions = {
  lazyConnect: true,
  // Retry up to 6 times with exponential back-off: 50ms, 100ms, 200ms…
  retryStrategy: (times: number): number | null => {
    if (times > 6) return null; // give up — bubble error to caller
    return Math.min(50 * 2 ** (times - 1), 2000);
  },
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  connectTimeout: 5_000, // ms
  // Disable auto-subscribe on reconnect (we don't use pub/sub)
  autoResubscribe: false,
  autoResendUnfulfilledCommands: true,
};

/**
 * Creates an IORedis client from a Redis URL string.
 * Supports both `redis://` and `rediss://` (TLS) schemes.
 */
export function createRedisClient(url: string): IORedis {
  return new IORedis(url, BASE_OPTS);
}
