/**
 * POST /v1/logs
 *
 * Accepts a batch of structured log entries and forwards them to the
 * ingestion service (which writes to Kafka for async processing).
 *
 * This is the "optional ingestion" endpoint — useful for:
 *   - SDKs that want a single gateway endpoint for all telemetry
 *   - Debug / manual log submission
 *   - Services that can't reach Kafka directly
 *
 * Constraints:
 *   - Max 500 entries per batch (matches ingestion service limit)
 *   - Max payload 1 MB
 *   - Rate limited: INTELLIGENCE_RATE_LIMIT_MAX req/min (same bucket as insights)
 *
 * Response:
 *   202 Accepted — entries are queued, processing is async.
 *   The response includes accepted/rejected counts and rejection details.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { ApiSuccess, LogEntry, LogIngestionRequest, LogIngestionResponse } from '@relevix/types';
import { ValidationError, InsightsUnavailableError } from '@relevix/errors';
import { authenticate, getTenantId } from '../middleware/auth.js';

export interface LogsRouteOptions {
  /** Base URL of the ingestion service, e.g. http://ingestion:4000 */
  ingestionUrl: string;
  rateLimit: number;
}

const MAX_ENTRIES = 500;
const TIMEOUT_MS = 5_000;

const bodySchema = {
  type: 'object',
  required: ['entries'],
  properties: {
    entries: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_ENTRIES,
      items: {
        type: 'object',
        required: ['service', 'level', 'message'],
        properties: {
          id:        { type: 'string' },
          service:   { type: 'string', minLength: 1, maxLength: 128 },
          level:     { type: 'string', enum: ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] },
          message:   { type: 'string', minLength: 1, maxLength: 4096 },
          timestamp: { type: 'string' },
          traceId:   { type: 'string' },
          spanId:    { type: 'string' },
          metadata:  { type: 'object' },
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
} as const;

export async function logsRoutes(
  app: FastifyInstance,
  opts: LogsRouteOptions,
): Promise<void> {
  const { ingestionUrl, rateLimit } = opts;

  app.post<{ Body: LogIngestionRequest }>(
    '/',
    {
      schema: { body: bodySchema },
      config: { rateLimit: { max: rateLimit, timeWindow: '1 minute' } },
      preHandler: [authenticate],
      // Increase body limit to 1 MB for this route only
      bodyLimit: 1_048_576,
    },
    async (
      req: FastifyRequest<{ Body: LogIngestionRequest }>,
      reply: FastifyReply,
    ) => {
      const tenantId = getTenantId(req);
      const { entries } = req.body;

      if (entries.length === 0) {
        throw new ValidationError({ entries: 'must contain at least one entry' }, req.id);
      }

      // Stamp receivedAt and tenantId on each entry before forwarding.
      const receivedAt = new Date().toISOString();
      const enrichedEntries = entries.map((e: LogEntry) => ({
        ...e,
        tenantId,
        receivedAt,
        ...(e.id === undefined && { id: crypto.randomUUID() }),
      }));

      // Forward to ingestion service.
      const controller = new AbortController();
      const timer = setTimeout(() => { controller.abort(); }, TIMEOUT_MS);

      let result: LogIngestionResponse;
      try {
        const res = await fetch(`${ingestionUrl}/v1/ingest/batch`, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            'X-Request-Id': req.id,
            'X-Tenant-Id': tenantId,
          },
          body: JSON.stringify({ events: enrichedEntries }),
        });

        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new InsightsUnavailableError(
            `Ingestion service returned ${String(res.status)}: ${text.slice(0, 200)}`,
            req.id,
          );
        }

        const json = (await res.json()) as { data?: LogIngestionResponse };
        result = json.data ?? {
          accepted: enrichedEntries.length,
          rejected: 0,
          rejections: [],
        };
      } catch (err) {
        if (err instanceof InsightsUnavailableError) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        throw new InsightsUnavailableError(
          msg.includes('abort') ? 'Ingestion service timed out.' : `Ingestion service unreachable: ${msg}`,
          req.id,
        );
      } finally {
        clearTimeout(timer);
      }

      req.log.info(
        { tenantId, accepted: result.accepted, rejected: result.rejected },
        'log batch forwarded to ingestion',
      );

      const body: ApiSuccess<LogIngestionResponse> = { ok: true, data: result };
      return reply.status(202).send(body);
    },
  );
}
