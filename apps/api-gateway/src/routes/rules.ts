import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type {
  Rule,
  RuleEvaluationRequest,
  RuleEvaluationResponse,
  ApiSuccess,
  PaginatedResponse,
  UUID,
} from '@relevix/types';
import { NotFoundError } from '@relevix/errors';

// ─── Rules routes ─────────────────────────────────────────────────────────────
//
// The gateway proxies rule evaluation to the Go rule-engine service.
// CRUD operations hit Postgres directly via a service layer (omitted here).

export async function rulesRoutes(app: FastifyInstance): Promise<void> {
  // GET /v1/rules — list rules for the authenticated tenant
  app.get('/', async (req: FastifyRequest, reply: FastifyReply) => {
    // TODO: inject RuleService; this is a structural placeholder
    const body: ApiSuccess<PaginatedResponse<Rule>> = {
      ok: true,
      data: { data: [], total: 0, page: 1, pageSize: 20, hasNextPage: false },
    };
    return reply.status(200).send(body);
  });

  // GET /v1/rules/:id
  app.get('/:id', async (req: FastifyRequest<{ Params: { id: UUID } }>, reply: FastifyReply) => {
    const { id } = req.params;
    // Stub — replace with real lookup
    throw new NotFoundError('Rule', id, req.id);
  });

  // POST /v1/rules/:id/evaluate
  app.post(
    '/:id/evaluate',
    async (
      req: FastifyRequest<{
        Params: { id: UUID };
        Body: RuleEvaluationRequest;
      }>,
      reply: FastifyReply,
    ) => {
      // Proxy to rule-engine gRPC/HTTP service
      // TODO: inject RuleEngineClient
      const stub: ApiSuccess<RuleEvaluationResponse> = {
        ok: true,
        data: {
          traceId: req.id,
          results: [],
          matchedCount: 0,
          evaluationTimeMs: 0,
        },
      };
      return reply.status(200).send(stub);
    },
  );
}
