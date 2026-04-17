/**
 * JWT authentication middleware.
 *
 * Usage — add as a preHandler on any route or route-group that requires auth:
 *
 *   import { authenticate } from '../middleware/auth.js';
 *
 *   app.get('/protected', { preHandler: [authenticate] }, handler);
 *
 * On success: `request.user` is populated with the decoded JWT payload.
 * On failure: throws UnauthorizedError → global error handler sends 401.
 *
 * The `@fastify/jwt` plugin must be registered on the Fastify instance before
 * these routes are loaded (it is registered in `buildApp`).
 */
import type { FastifyRequest, FastifyReply } from 'fastify';
import { UnauthorizedError } from '@relevix/errors';

// ─── JWT payload shape ────────────────────────────────────────────────────────
// Augment the @fastify/jwt module so `request.user` is typed throughout.

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: JwtPayload; // used when signing tokens
    user: JwtPayload;    // populated on `request.jwtVerify()`
  }
}

export interface JwtPayload {
  /** The tenant this token belongs to. Required. */
  tenantId: string;
  /** Optional user identifier (absent for service-to-service tokens). */
  userId?: string;
  /** JWT subject (same as userId for user tokens). */
  sub?: string;
  /** Issued-at (epoch seconds, added by @fastify/jwt). */
  iat?: number;
  /** Expiry (epoch seconds, added by @fastify/jwt). */
  exp?: number;
}

/**
 * Verify the Bearer token in the Authorization header.
 * Throws UnauthorizedError with a specific message on any auth failure.
 */
export async function authenticate(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  try {
    await request.jwtVerify();
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'JWT verification failed.';
    // Map @fastify/jwt error messages to machine-readable descriptions.
    const isExpired = msg.toLowerCase().includes('expired');
    throw new UnauthorizedError(
      isExpired ? 'Token has expired. Please re-authenticate.' : 'Invalid or missing authentication token.',
      request.id,
    );
  }
}

/**
 * Extract the tenantId from the verified JWT payload.
 * Must be called after `authenticate` runs (i.e. in the handler, not a preHandler).
 */
export function getTenantId(request: FastifyRequest): string {
  return request.user.tenantId;
}
