import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { ApiSuccess } from '@relevix/types';
import { authenticate, getTenantId } from '../middleware/auth.js';
import { getDb } from '../services/db.js';

// ─── Wire types ───────────────────────────────────────────────────────────────

interface RawLogEvent {
  message:    string;
  level?:     string;
  service?:   string;
  traceId?:   string;
  timestamp?: string;
  fields?:    Record<string, unknown>;
  tags?:      string[];
}

interface LogBatchRequest  { events: RawLogEvent[]; }
interface LogBatchResponse { accepted: number; rejected: number; rejections: Array<{ index: number; reason: string }>; }

// ─── Ingest routes ────────────────────────────────────────────────────────────
//
// POST /v1/ingest/batch accepts up to 500 log events per request.
//
// Data flow:
//   1. JWT auth → tenantId extracted from token payload
//   2. Fastify validates JSON schema (minItems, maxLength, etc.)
//   3. Valid events → INSERT INTO raw_logs (Postgres)
//   4. Return { accepted, rejected, rejections[] }
//
// In production the Go ingestion service consumes from Kafka and writes
// raw_logs. This direct Postgres path is the local-dev / test path.

export async function ingestRoutes(app: FastifyInstance): Promise<void> {
  const batchSchema = {
    body: {
      type: 'object',
      required: ['events'],
      properties: {
        events: {
          type: 'array',
          minItems: 1,
          maxItems: 500,
          items: {
            type: 'object',
            required: ['message'],
            properties: {
              message:   { type: 'string', minLength: 1, maxLength: 4096 },
              level:     { type: 'string' },
              service:   { type: 'string' },
              traceId:   { type: 'string' },
              timestamp: { type: 'string' },
              fields:    { type: 'object' },
              tags:      { type: 'array', items: { type: 'string' } },
            },
            additionalProperties: true,
          },
        },
      },
    },
  };

  app.post<{ Body: LogBatchRequest }>(
    '/batch',
    { schema: batchSchema, preHandler: [authenticate] },
    async (req: FastifyRequest<{ Body: LogBatchRequest }>, reply: FastifyReply) => {
      const tenantId = getTenantId(req);
      const sql      = getDb();
      const events   = req.body.events;
      const accepted: string[] = [];
      const rejections: Array<{ index: number; reason: string }> = [];

      const insertRows = events.flatMap((ev: RawLogEvent, i: number) => {
        if (!ev.message?.trim()) {
          rejections.push({ index: i, reason: 'message is empty' });
          return [];
        }
        return [{
          tenant_id:   tenantId,
          trace_id:    ev.traceId   ?? null,
          service:     ev.service   ?? 'unknown',
          environment: (ev.fields?.['env'] as string | undefined) ?? process.env['NODE_ENV'] ?? 'development',
          level:       ev.level     ?? 'info',
          message:     ev.message,
          fields:      sql.json((ev.fields ?? {}) as Parameters<typeof sql.json>[0]),
          tags:        ev.tags ?? [],
          timestamp:   ev.timestamp ? new Date(ev.timestamp) : new Date(),
          received_at: new Date(),
        }];
      });

      if (insertRows.length > 0) {
        try {
          const inserted = await sql`INSERT INTO raw_logs ${sql(insertRows)} RETURNING id`;
          inserted.forEach((r) => accepted.push(r['id'] as string));
          req.log.info({ tenantId, accepted: accepted.length, rejected: rejections.length }, 'batch ingested');
        } catch (err) {
          req.log.error({ err }, 'batch insert failed');
          return reply.status(502).send({ ok: false, error: { code: 'INGEST_FAILED', message: 'Failed to persist events.' } });
        }
      }

      const body: ApiSuccess<LogBatchResponse> = {
        ok: true,
        data: { accepted: accepted.length, rejected: rejections.length, rejections },
      };
      return reply.status(202).send(body);
    },
  );
}
