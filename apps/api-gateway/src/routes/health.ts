import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { HealthCheckResponse } from '@relevix/types';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  const startTime = Date.now();

  app.get('/', async (_req: FastifyRequest, reply: FastifyReply) => {
    const body: HealthCheckResponse = {
      status: 'ok',
      version: (process.env as NodeJS.ProcessEnv)['SERVICE_VERSION'] ?? '0.0.0',
      uptime: Math.floor((Date.now() - startTime) / 1000),
      checks: {
        self: { status: 'ok' },
      },
    };
    return reply.status(200).send(body);
  });
}
