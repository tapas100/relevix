export declare const ErrorCode: {
    readonly INTERNAL_ERROR: "INTERNAL_ERROR";
    readonly VALIDATION_ERROR: "VALIDATION_ERROR";
    readonly NOT_FOUND: "NOT_FOUND";
    readonly CONFLICT: "CONFLICT";
    readonly UNAUTHORIZED: "UNAUTHORIZED";
    readonly FORBIDDEN: "FORBIDDEN";
    readonly RATE_LIMITED: "RATE_LIMITED";
    readonly SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE";
    readonly BAD_GATEWAY: "BAD_GATEWAY";
    readonly TIMEOUT: "TIMEOUT";
    readonly RULE_NOT_FOUND: "RULE_NOT_FOUND";
    readonly RULE_INVALID_CONDITION: "RULE_INVALID_CONDITION";
    readonly RULE_CYCLE_DETECTED: "RULE_CYCLE_DETECTED";
    readonly RULE_EVALUATION_FAILED: "RULE_EVALUATION_FAILED";
    readonly INGEST_SCHEMA_INVALID: "INGEST_SCHEMA_INVALID";
    readonly INGEST_BATCH_TOO_LARGE: "INGEST_BATCH_TOO_LARGE";
    readonly INGEST_QUEUE_FULL: "INGEST_QUEUE_FULL";
    readonly TOKEN_EXPIRED: "TOKEN_EXPIRED";
    readonly TOKEN_INVALID: "TOKEN_INVALID";
    readonly TENANT_SUSPENDED: "TENANT_SUSPENDED";
    readonly INSIGHTS_UNAVAILABLE: "INSIGHTS_UNAVAILABLE";
    readonly ROOT_CAUSE_FAILED: "ROOT_CAUSE_FAILED";
    readonly INVALID_QUERY: "INVALID_QUERY";
};
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
export declare const ERROR_HTTP_STATUS: Record<ErrorCode, number>;
export declare class RelevixError extends Error {
    readonly code: ErrorCode;
    readonly httpStatus: number;
    readonly details: unknown | undefined;
    readonly traceId: string | undefined;
    constructor(opts: {
        code: ErrorCode;
        message: string;
        details?: unknown | undefined;
        traceId?: string | undefined;
        cause?: Error | undefined;
    });
    toJSON(): Record<string, unknown>;
}
export declare class NotFoundError extends RelevixError {
    constructor(resource: string, id: string, traceId?: string | undefined);
}
export declare class ValidationError extends RelevixError {
    constructor(details: unknown, traceId?: string | undefined);
}
export declare class UnauthorizedError extends RelevixError {
    constructor(message?: string, traceId?: string | undefined);
}
export declare class ForbiddenError extends RelevixError {
    constructor(message?: string, traceId?: string | undefined);
}
export declare class RateLimitError extends RelevixError {
    constructor(traceId?: string | undefined);
}
export declare class InternalError extends RelevixError {
    constructor(cause?: Error | undefined, traceId?: string | undefined);
}
export declare class InsightsUnavailableError extends RelevixError {
    constructor(reason?: string, traceId?: string | undefined);
}
export declare class InvalidQueryError extends RelevixError {
    constructor(details: unknown, traceId?: string | undefined);
}
export declare function isRelevixError(err: unknown): err is RelevixError;
//# sourceMappingURL=index.d.ts.map