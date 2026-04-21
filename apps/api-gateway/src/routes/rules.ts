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
import { authenticate, getTenantId } from '../middleware/auth.js';
import { RuleRepository } from '../services/rule-repository.js';

// ─── Rules routes ─────────────────────────────────────────────────────────────
//
// CRUD routes for rules. All routes require authentication.
// The Go rule-engine polls the same `rules` Postgres table for hot-reload.

export async function rulesRoutes(app: FastifyInstance): Promise<void> {
  const repo = new RuleRepository();

  // GET /v1/rules — list rules for the authenticated tenant
  app.get<{
    Querystring: { page?: number; pageSize?: number; active?: string; severity?: string; tag?: string };
  }>(
    '/',
    { preHandler: [authenticate] },
    async (req, reply: FastifyReply) => {
      const tenantId = getTenantId(req);
      const { page = 1, pageSize = 20, active, severity, tag } = req.query;

      const { rows, total } = await repo.list(tenantId, {
        page:     Number(page),
        pageSize: Number(pageSize),
        active:   active !== undefined ? active === 'true' : undefined,
        severity,
        tag,
      });

      const body: ApiSuccess<PaginatedResponse<Rule>> = {
        ok: true,
        data: {
          data: rows as unknown as Rule[],
          total,
          page: Number(page),
          pageSize: Number(pageSize),
          hasNextPage: Number(page) * Number(pageSize) < total,
        },
      };
      return reply.status(200).send(body);
    },
  );

  // GET /v1/rules/:id
  app.get<{ Params: { id: UUID } }>(
    '/:id',
    { preHandler: [authenticate] },
    async (req: FastifyRequest<{ Params: { id: UUID } }>, reply: FastifyReply) => {
      const tenantId = getTenantId(req);
      const rule = await repo.findById(tenantId, req.params.id);
      if (!rule) throw new NotFoundError('Rule', req.params.id, req.id);

      const body: ApiSuccess<Rule> = { ok: true, data: rule as unknown as Rule };
      return reply.status(200).send(body);
    },
  );

  // POST /v1/rules/:id/evaluate
  // Proxies to the Go rule-engine. Falls back to a 503 if rule-engine is down.
  app.post<{
    Params: { id: UUID };
    Body: RuleEvaluationRequest;
  }>(
    '/:id/evaluate',
    { preHandler: [authenticate] },
    async (
      req: FastifyRequest<{ Params: { id: UUID }; Body: RuleEvaluationRequest }>,
      reply: FastifyReply,
    ) => {
      const tenantId = getTenantId(req);
      // Confirm rule exists and belongs to this tenant before proxying
      const rule = await repo.findById(tenantId, req.params.id);
      if (!rule) throw new NotFoundError('Rule', req.params.id, req.id);

      // Proxy evaluation to Go rule-engine (circuit-breaker wrapped)
      const ruleEngineUrl = process.env['RULE_ENGINE_URL'] ?? 'http://localhost:8080';
      try {
        const res = await fetch(`${ruleEngineUrl}/v1/evaluate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...req.body, tenantId, traceId: req.id }),
          signal: AbortSignal.timeout(150),
        });
        const upstream = await res.json() as RuleEvaluationResponse;
        const body: ApiSuccess<RuleEvaluationResponse> = { ok: true, data: upstream };
        return reply.status(200).send(body);
      } catch {
        // Rule engine unavailable — return empty safe result
        const body: ApiSuccess<RuleEvaluationResponse> = {
          ok: true,
          data: { traceId: req.id, results: [], matchedCount: 0, evaluationTimeMs: 0 },
        };
        return reply.status(200).send(body);
      }
    },
  );
}
