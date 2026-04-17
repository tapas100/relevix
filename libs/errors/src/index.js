"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InvalidQueryError = exports.InsightsUnavailableError = exports.InternalError = exports.RateLimitError = exports.ForbiddenError = exports.UnauthorizedError = exports.ValidationError = exports.NotFoundError = exports.RelevixError = exports.ERROR_HTTP_STATUS = exports.ErrorCode = void 0;
exports.isRelevixError = isRelevixError;
// ─── Error Codes ─────────────────────────────────────────────────────────────
//
// Machine-readable error codes. Format: DOMAIN_REASON (all caps, underscores).
// These are shared across services and exposed in API responses.
//
exports.ErrorCode = {
    // Generic
    INTERNAL_ERROR: 'INTERNAL_ERROR',
    VALIDATION_ERROR: 'VALIDATION_ERROR',
    NOT_FOUND: 'NOT_FOUND',
    CONFLICT: 'CONFLICT',
    UNAUTHORIZED: 'UNAUTHORIZED',
    FORBIDDEN: 'FORBIDDEN',
    RATE_LIMITED: 'RATE_LIMITED',
    SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
    BAD_GATEWAY: 'BAD_GATEWAY',
    TIMEOUT: 'TIMEOUT',
    // Rule Engine
    RULE_NOT_FOUND: 'RULE_NOT_FOUND',
    RULE_INVALID_CONDITION: 'RULE_INVALID_CONDITION',
    RULE_CYCLE_DETECTED: 'RULE_CYCLE_DETECTED',
    RULE_EVALUATION_FAILED: 'RULE_EVALUATION_FAILED',
    // Ingestion
    INGEST_SCHEMA_INVALID: 'INGEST_SCHEMA_INVALID',
    INGEST_BATCH_TOO_LARGE: 'INGEST_BATCH_TOO_LARGE',
    INGEST_QUEUE_FULL: 'INGEST_QUEUE_FULL',
    // Auth
    TOKEN_EXPIRED: 'TOKEN_EXPIRED',
    TOKEN_INVALID: 'TOKEN_INVALID',
    TENANT_SUSPENDED: 'TENANT_SUSPENDED',
    // Intelligence
    INSIGHTS_UNAVAILABLE: 'INSIGHTS_UNAVAILABLE',
    ROOT_CAUSE_FAILED: 'ROOT_CAUSE_FAILED',
    INVALID_QUERY: 'INVALID_QUERY',
};
// ─── HTTP status map ──────────────────────────────────────────────────────────
exports.ERROR_HTTP_STATUS = {
    INTERNAL_ERROR: 500,
    VALIDATION_ERROR: 422,
    NOT_FOUND: 404,
    CONFLICT: 409,
    UNAUTHORIZED: 401,
    FORBIDDEN: 403,
    RATE_LIMITED: 429,
    SERVICE_UNAVAILABLE: 503,
    BAD_GATEWAY: 502,
    TIMEOUT: 504,
    RULE_NOT_FOUND: 404,
    RULE_INVALID_CONDITION: 422,
    RULE_CYCLE_DETECTED: 422,
    RULE_EVALUATION_FAILED: 500,
    INGEST_SCHEMA_INVALID: 422,
    INGEST_BATCH_TOO_LARGE: 413,
    INGEST_QUEUE_FULL: 503,
    TOKEN_EXPIRED: 401,
    TOKEN_INVALID: 401,
    TENANT_SUSPENDED: 403,
    INSIGHTS_UNAVAILABLE: 503,
    ROOT_CAUSE_FAILED: 500,
    INVALID_QUERY: 400,
};
// ─── Base domain error ────────────────────────────────────────────────────────
class RelevixError extends Error {
    code;
    httpStatus;
    details;
    traceId;
    constructor(opts) {
        super(opts.message, { cause: opts.cause });
        this.name = 'RelevixError';
        this.code = opts.code;
        this.httpStatus = exports.ERROR_HTTP_STATUS[opts.code] ?? 500;
        this.details = opts.details;
        this.traceId = opts.traceId;
        // Maintains proper prototype chain in transpiled ES5
        Object.setPrototypeOf(this, new.target.prototype);
    }
    toJSON() {
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
exports.RelevixError = RelevixError;
// ─── Typed sub-classes ────────────────────────────────────────────────────────
class NotFoundError extends RelevixError {
    constructor(resource, id, traceId) {
        super({
            code: exports.ErrorCode.NOT_FOUND,
            message: `${resource} with id '${id}' was not found.`,
            ...(traceId !== undefined && { traceId }),
        });
        this.name = 'NotFoundError';
    }
}
exports.NotFoundError = NotFoundError;
class ValidationError extends RelevixError {
    constructor(details, traceId) {
        super({
            code: exports.ErrorCode.VALIDATION_ERROR,
            message: 'Request validation failed.',
            details,
            ...(traceId !== undefined && { traceId }),
        });
        this.name = 'ValidationError';
    }
}
exports.ValidationError = ValidationError;
class UnauthorizedError extends RelevixError {
    constructor(message = 'Authentication required.', traceId) {
        super({ code: exports.ErrorCode.UNAUTHORIZED, message, ...(traceId !== undefined && { traceId }) });
        this.name = 'UnauthorizedError';
    }
}
exports.UnauthorizedError = UnauthorizedError;
class ForbiddenError extends RelevixError {
    constructor(message = 'You do not have permission to perform this action.', traceId) {
        super({ code: exports.ErrorCode.FORBIDDEN, message, ...(traceId !== undefined && { traceId }) });
        this.name = 'ForbiddenError';
    }
}
exports.ForbiddenError = ForbiddenError;
class RateLimitError extends RelevixError {
    constructor(traceId) {
        super({ code: exports.ErrorCode.RATE_LIMITED, message: 'Too many requests. Slow down.', ...(traceId !== undefined && { traceId }) });
        this.name = 'RateLimitError';
    }
}
exports.RateLimitError = RateLimitError;
class InternalError extends RelevixError {
    constructor(cause, traceId) {
        super({
            code: exports.ErrorCode.INTERNAL_ERROR,
            message: 'An unexpected internal error occurred.',
            ...(cause !== undefined && { cause }),
            ...(traceId !== undefined && { traceId }),
        });
        this.name = 'InternalError';
    }
}
exports.InternalError = InternalError;
class InsightsUnavailableError extends RelevixError {
    constructor(reason, traceId) {
        super({
            code: exports.ErrorCode.INSIGHTS_UNAVAILABLE,
            message: reason ?? 'Insights are temporarily unavailable. Please try again shortly.',
            ...(traceId !== undefined && { traceId }),
        });
        this.name = 'InsightsUnavailableError';
    }
}
exports.InsightsUnavailableError = InsightsUnavailableError;
class InvalidQueryError extends RelevixError {
    constructor(details, traceId) {
        super({
            code: exports.ErrorCode.INVALID_QUERY,
            message: 'Invalid query parameters.',
            details,
            ...(traceId !== undefined && { traceId }),
        });
        this.name = 'InvalidQueryError';
    }
}
exports.InvalidQueryError = InvalidQueryError;
// ─── Type guard ───────────────────────────────────────────────────────────────
function isRelevixError(err) {
    return err instanceof RelevixError;
}
//# sourceMappingURL=index.js.map