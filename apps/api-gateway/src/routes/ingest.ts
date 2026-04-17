import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { IngestBatchRequest, IngestBatchResponse, ApiSuccess } from '@relevix/types';

// ─── Ingest routes ────────────────────────────────────────────────────────────
//
// The gateway validates the batch envelope and proxies to the Go
// ingestion service, which writes to Kafka for async processing.

export async function ingestRoutes(app: FastifyInstance): Promise<void> {
  // POST /v1/ingest/batch
  app.post('/batch', async (req: FastifyRequest<{ Body: IngestBatchRequest }>, reply: FastifyReply) => {
    // TODO: inject IngestionClient
    const body: ApiSuccess<IngestBatchResponse> = {
      ok: true,
      data: {
        accepted: req.body.events.length,
        rejected: 0,
        rejections: [],
      },
    };
    return reply.status(202).send(body);
  });
}
