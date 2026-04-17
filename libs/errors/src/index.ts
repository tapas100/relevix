// ─── Error Codes ─────────────────────────────────────────────────────────────
//
// Machine-readable error codes. Format: DOMAIN_REASON (all caps, underscores).
// These are shared across services and exposed in API responses.
//
export const ErrorCode = {
  // Generic
  INTERNAL_ERROR:         'INTERNAL_ERROR',
  VALIDATION_ERROR:       'VALIDATION_ERROR',
  NOT_FOUND:              'NOT_FOUND',
  CONFLICT:               'CONFLICT',
  UNAUTHORIZED:           'UNAUTHORIZED',
  FORBIDDEN:              'FORBIDDEN',
  RATE_LIMITED:           'RATE_LIMITED',
  SERVICE_UNAVAILABLE:    'SERVICE_UNAVAILABLE',
  BAD_GATEWAY:            'BAD_GATEWAY',
  TIMEOUT:                'TIMEOUT',

  // Rule Engine
  RULE_NOT_FOUND:         'RULE_NOT_FOUND',
  RULE_INVALID_CONDITION: 'RULE_INVALID_CONDITION',
  RULE_CYCLE_DETECTED:    'RULE_CYCLE_DETECTED',
  RULE_EVALUATION_FAILED: 'RULE_EVALUATION_FAILED',

  // Ingestion
  INGEST_SCHEMA_INVALID:  'INGEST_SCHEMA_INVALID',
  INGEST_BATCH_TOO_LARGE: 'INGEST_BATCH_TOO_LARGE',
  INGEST_QUEUE_FULL:      'INGEST_QUEUE_FULL',

  // Auth
  TOKEN_EXPIRED:          'TOKEN_EXPIRED',
  TOKEN_INVALID:          'TOKEN_INVALID',
  TENANT_SUSPENDED:       'TENANT_SUSPENDED',

  // Intelligence
  INSIGHTS_UNAVAILABLE:   'INSIGHTS_UNAVAILABLE',
  ROOT_CAUSE_FAILED:      'ROOT_CAUSE_FAILED',
  INVALID_QUERY:          'INVALID_QUERY',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

// ─── HTTP status map ──────────────────────────────────────────────────────────

export const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
  INTERNAL_ERROR:         500,
  VALIDATION_ERROR:       422,
  NOT_FOUND:              404,
  CONFLICT:               409,
  UNAUTHORIZED:           401,
  FORBIDDEN:              403,
  RATE_LIMITED:           429,
  SERVICE_UNAVAILABLE:    503,
  BAD_GATEWAY:            502,
  TIMEOUT:                504,
  RULE_NOT_FOUND:         404,
  RULE_INVALID_CONDITION: 422,
  RULE_CYCLE_DETECTED:    422,
  RULE_EVALUATION_FAILED: 500,
  INGEST_SCHEMA_INVALID:  422,
  INGEST_BATCH_TOO_LARGE: 413,
  INGEST_QUEUE_FULL:      503,
  TOKEN_EXPIRED:          401,
  TOKEN_INVALID:          401,
  TENANT_SUSPENDED:       403,
  INSIGHTS_UNAVAILABLE:   503,
  ROOT_CAUSE_FAILED:      500,
  INVALID_QUERY:          400,
};

// ─── Base domain error ────────────────────────────────────────────────────────

export class RelevixError extends Error {
  public readonly code: ErrorCode;
  public readonly httpStatus: number;
  public readonly details: unknown | undefined;
  public readonly traceId: string | undefined;

  constructor(opts: {
    code: ErrorCode;
    message: string;
    details?: unknown | undefined;
    traceId?: string | undefined;
    cause?: Error | undefined;
  }) {
    super(opts.message, { cause: opts.cause });
    this.name = 'RelevixError';
    this.code = opts.code;
    this.httpStatus = ERROR_HTTP_STATUS[opts.code] ?? 500;
    this.details = opts.details;
    this.traceId = opts.traceId;

    // Maintains proper prototype chain in transpiled ES5
    Object.setPrototypeOf(this, new.target.prototype);
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      httpStatus: this.httpStatus,
      details: this.details,
      traceId: this.traceId,
    };
  }
}

// ─── Typed sub-classes ────────────────────────────────────────────────────────

export class NotFoundError extends RelevixError {
  constructor(resource: string, id: string, traceId?: string | undefined) {
    super({
      code: ErrorCode.NOT_FOUND,
      message: `${resource} with id '${id}' was not found.`,
      ...(traceId !== undefined && { traceId }),
    });
    this.name = 'NotFoundError';
  }
}

export class ValidationError extends RelevixError {
  constructor(details: unknown, traceId?: string | undefined) {
    super({
      code: ErrorCode.VALIDATION_ERROR,
      message: 'Request validation failed.',
      details,
      ...(traceId !== undefined && { traceId }),
    });
    this.name = 'ValidationError';
  }
}

export class UnauthorizedError extends RelevixError {
  constructor(message = 'Authentication required.', traceId?: string | undefined) {
    super({ code: ErrorCode.UNAUTHORIZED, message, ...(traceId !== undefined && { traceId }) });
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends RelevixError {
  constructor(message = 'You do not have permission to perform this action.', traceId?: string | undefined) {
    super({ code: ErrorCode.FORBIDDEN, message, ...(traceId !== undefined && { traceId }) });
    this.name = 'ForbiddenError';
  }
}

export class RateLimitError extends RelevixError {
  constructor(traceId?: string | undefined) {
    super({ code: ErrorCode.RATE_LIMITED, message: 'Too many requests. Slow down.', ...(traceId !== undefined && { traceId }) });
    this.name = 'RateLimitError';
  }
}

export class InternalError extends RelevixError {
  constructor(cause?: Error | undefined, traceId?: string | undefined) {
    super({
      code: ErrorCode.INTERNAL_ERROR,
      message: 'An unexpected internal error occurred.',
      ...(cause !== undefined && { cause }),
      ...(traceId !== undefined && { traceId }),
    });
    this.name = 'InternalError';
  }
}

export class InsightsUnavailableError extends RelevixError {
  constructor(reason?: string, traceId?: string | undefined) {
    super({
      code: ErrorCode.INSIGHTS_UNAVAILABLE,
      message: reason ?? 'Insights are temporarily unavailable. Please try again shortly.',
      ...(traceId !== undefined && { traceId }),
    });
    this.name = 'InsightsUnavailableError';
  }
}

export class InvalidQueryError extends RelevixError {
  constructor(details: unknown, traceId?: string | undefined) {
    super({
      code: ErrorCode.INVALID_QUERY,
      message: 'Invalid query parameters.',
      details,
      ...(traceId !== undefined && { traceId }),
    });
    this.name = 'InvalidQueryError';
  }
}

// ─── Type guard ───────────────────────────────────────────────────────────────

export function isRelevixError(err: unknown): err is RelevixError {
  return err instanceof RelevixError;
}
