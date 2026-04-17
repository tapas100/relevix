import { loadConfig, ApiGatewayConfigSchema } from '@relevix/config';
import { createLogger } from '@relevix/logger';
import { buildApp } from './app.js';
import { createRedisClient } from './plugins/redis.js';

// ─── Bootstrap ────────────────────────────────────────────────────────────────
//
// Fail-fast: config validation happens before any I/O.
// Unhandled rejections and uncaught exceptions are logged then exit(1).

const config = loadConfig(ApiGatewayConfigSchema);
const log = createLogger({ service: config.SERVICE_NAME });

process.on('unhandledRejection', (reason: unknown) => {
  log.fatal({ reason }, 'Unhandled promise rejection');
  process.exit(1);
});

process.on('uncaughtException', (err: Error) => {
  log.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

async function main(): Promise<void> {
  // ── Redis ────────────────────────────────────────────────────────────────
  const redis = createRedisClient(config.REDIS_URL);

  // Eagerly connect so the first request doesn't pay the TCP setup cost.
  await redis.connect();
  log.info('Redis connected');

  const app = await buildApp(config, log, redis);

  await app.listen({ port: config.PORT, host: config.HOST });

  log.info(
    { port: config.PORT, env: config.NODE_ENV, version: config.SERVICE_VERSION },
    '🚀 API Gateway started',
  );

  // ─── Graceful shutdown ──────────────────────────────────────────────────────
  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, 'Shutting down gracefully…');
    await app.close();
    await redis.quit();
    log.info('Server closed. Bye.');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT',  () => void shutdown('SIGINT'));
}

void main();
