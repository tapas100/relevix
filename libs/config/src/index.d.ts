import { z } from 'zod';
export declare const BaseConfigSchema: z.ZodObject<{
    NODE_ENV: z.ZodDefault<z.ZodEnum<["development", "test", "production"]>>;
    LOG_LEVEL: z.ZodDefault<z.ZodEnum<["trace", "debug", "info", "warn", "error", "fatal"]>>;
    SERVICE_NAME: z.ZodString;
    SERVICE_VERSION: z.ZodDefault<z.ZodString>;
    OTEL_EXPORTER_OTLP_ENDPOINT: z.ZodOptional<z.ZodString>;
    OTEL_ENABLED: z.ZodDefault<z.ZodEffects<z.ZodString, boolean, string>>;
}, "strip", z.ZodTypeAny, {
    NODE_ENV: "development" | "test" | "production";
    LOG_LEVEL: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
    SERVICE_NAME: string;
    SERVICE_VERSION: string;
    OTEL_ENABLED: boolean;
    OTEL_EXPORTER_OTLP_ENDPOINT?: string | undefined;
}, {
    SERVICE_NAME: string;
    NODE_ENV?: "development" | "test" | "production" | undefined;
    LOG_LEVEL?: "trace" | "debug" | "info" | "warn" | "error" | "fatal" | undefined;
    SERVICE_VERSION?: string | undefined;
    OTEL_EXPORTER_OTLP_ENDPOINT?: string | undefined;
    OTEL_ENABLED?: string | undefined;
}>;
export type BaseConfig = z.infer<typeof BaseConfigSchema>;
export declare const ApiGatewayConfigSchema: z.ZodObject<{
    NODE_ENV: z.ZodDefault<z.ZodEnum<["development", "test", "production"]>>;
    LOG_LEVEL: z.ZodDefault<z.ZodEnum<["trace", "debug", "info", "warn", "error", "fatal"]>>;
    SERVICE_NAME: z.ZodString;
    SERVICE_VERSION: z.ZodDefault<z.ZodString>;
    OTEL_EXPORTER_OTLP_ENDPOINT: z.ZodOptional<z.ZodString>;
    OTEL_ENABLED: z.ZodDefault<z.ZodEffects<z.ZodString, boolean, string>>;
} & {
    PORT: z.ZodDefault<z.ZodNumber>;
    HOST: z.ZodDefault<z.ZodString>;
    JWT_SECRET: z.ZodString;
    JWT_EXPIRES_IN: z.ZodDefault<z.ZodString>;
    RULE_ENGINE_URL: z.ZodString;
    INGESTION_URL: z.ZodString;
    REDIS_URL: z.ZodString;
    DATABASE_URL: z.ZodString;
    CORS_ORIGINS: z.ZodDefault<z.ZodEffects<z.ZodString, string[], string>>;
    RATE_LIMIT_WINDOW_MS: z.ZodDefault<z.ZodNumber>;
    RATE_LIMIT_MAX: z.ZodDefault<z.ZodNumber>;
    INTELLIGENCE_CACHE_TTL_SECONDS: z.ZodDefault<z.ZodNumber>;
    INTELLIGENCE_RATE_LIMIT_MAX: z.ZodDefault<z.ZodNumber>;
    ELASTICSEARCH_URL: z.ZodDefault<z.ZodString>;
    ELASTICSEARCH_API_KEY: z.ZodOptional<z.ZodString>;
    ELASTICSEARCH_INDEX_PREFIX: z.ZodDefault<z.ZodString>;
    ELASTICSEARCH_TIMEOUT_MS: z.ZodDefault<z.ZodNumber>;
    SEARCH_CACHE_TTL_SECONDS: z.ZodDefault<z.ZodNumber>;
    OPENAI_API_KEY: z.ZodOptional<z.ZodString>;
    OPENAI_MODEL: z.ZodDefault<z.ZodString>;
    OPENAI_MAX_TOKENS: z.ZodDefault<z.ZodNumber>;
    AI_NARRATOR_TIMEOUT_MS: z.ZodDefault<z.ZodNumber>;
    AI_NARRATOR_ENABLED: z.ZodDefault<z.ZodEffects<z.ZodString, boolean, string>>;
}, "strip", z.ZodTypeAny, {
    NODE_ENV: "development" | "test" | "production";
    LOG_LEVEL: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
    SERVICE_NAME: string;
    SERVICE_VERSION: string;
    OTEL_ENABLED: boolean;
    PORT: number;
    HOST: string;
    JWT_SECRET: string;
    JWT_EXPIRES_IN: string;
    RULE_ENGINE_URL: string;
    INGESTION_URL: string;
    REDIS_URL: string;
    DATABASE_URL: string;
    CORS_ORIGINS: string[];
    RATE_LIMIT_WINDOW_MS: number;
    RATE_LIMIT_MAX: number;
    INTELLIGENCE_CACHE_TTL_SECONDS: number;
    INTELLIGENCE_RATE_LIMIT_MAX: number;
    ELASTICSEARCH_URL: string;
    ELASTICSEARCH_INDEX_PREFIX: string;
    ELASTICSEARCH_TIMEOUT_MS: number;
    SEARCH_CACHE_TTL_SECONDS: number;
    OPENAI_MODEL: string;
    OPENAI_MAX_TOKENS: number;
    AI_NARRATOR_TIMEOUT_MS: number;
    AI_NARRATOR_ENABLED: boolean;
    OTEL_EXPORTER_OTLP_ENDPOINT?: string | undefined;
    ELASTICSEARCH_API_KEY?: string | undefined;
    OPENAI_API_KEY?: string | undefined;
}, {
    SERVICE_NAME: string;
    JWT_SECRET: string;
    RULE_ENGINE_URL: string;
    INGESTION_URL: string;
    REDIS_URL: string;
    DATABASE_URL: string;
    NODE_ENV?: "development" | "test" | "production" | undefined;
    LOG_LEVEL?: "trace" | "debug" | "info" | "warn" | "error" | "fatal" | undefined;
    SERVICE_VERSION?: string | undefined;
    OTEL_EXPORTER_OTLP_ENDPOINT?: string | undefined;
    OTEL_ENABLED?: string | undefined;
    PORT?: number | undefined;
    HOST?: string | undefined;
    JWT_EXPIRES_IN?: string | undefined;
    CORS_ORIGINS?: string | undefined;
    RATE_LIMIT_WINDOW_MS?: number | undefined;
    RATE_LIMIT_MAX?: number | undefined;
    INTELLIGENCE_CACHE_TTL_SECONDS?: number | undefined;
    INTELLIGENCE_RATE_LIMIT_MAX?: number | undefined;
    ELASTICSEARCH_URL?: string | undefined;
    ELASTICSEARCH_API_KEY?: string | undefined;
    ELASTICSEARCH_INDEX_PREFIX?: string | undefined;
    ELASTICSEARCH_TIMEOUT_MS?: number | undefined;
    SEARCH_CACHE_TTL_SECONDS?: number | undefined;
    OPENAI_API_KEY?: string | undefined;
    OPENAI_MODEL?: string | undefined;
    OPENAI_MAX_TOKENS?: number | undefined;
    AI_NARRATOR_TIMEOUT_MS?: number | undefined;
    AI_NARRATOR_ENABLED?: string | undefined;
}>;
export type ApiGatewayConfig = z.infer<typeof ApiGatewayConfigSchema>;
export declare const IngestionConfigSchema: z.ZodObject<{
    NODE_ENV: z.ZodDefault<z.ZodEnum<["development", "test", "production"]>>;
    LOG_LEVEL: z.ZodDefault<z.ZodEnum<["trace", "debug", "info", "warn", "error", "fatal"]>>;
    SERVICE_NAME: z.ZodString;
    SERVICE_VERSION: z.ZodDefault<z.ZodString>;
    OTEL_EXPORTER_OTLP_ENDPOINT: z.ZodOptional<z.ZodString>;
    OTEL_ENABLED: z.ZodDefault<z.ZodEffects<z.ZodString, boolean, string>>;
} & {
    PORT: z.ZodDefault<z.ZodNumber>;
    KAFKA_BROKERS: z.ZodEffects<z.ZodString, string[], string>;
    KAFKA_CLIENT_ID: z.ZodDefault<z.ZodString>;
    KAFKA_GROUP_ID: z.ZodDefault<z.ZodString>;
    KAFKA_TOPIC_EVENTS: z.ZodDefault<z.ZodString>;
    BATCH_SIZE_MAX: z.ZodDefault<z.ZodNumber>;
    DATABASE_URL: z.ZodString;
}, "strip", z.ZodTypeAny, {
    NODE_ENV: "development" | "test" | "production";
    LOG_LEVEL: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
    SERVICE_NAME: string;
    SERVICE_VERSION: string;
    OTEL_ENABLED: boolean;
    PORT: number;
    DATABASE_URL: string;
    KAFKA_BROKERS: string[];
    KAFKA_CLIENT_ID: string;
    KAFKA_GROUP_ID: string;
    KAFKA_TOPIC_EVENTS: string;
    BATCH_SIZE_MAX: number;
    OTEL_EXPORTER_OTLP_ENDPOINT?: string | undefined;
}, {
    SERVICE_NAME: string;
    DATABASE_URL: string;
    KAFKA_BROKERS: string;
    NODE_ENV?: "development" | "test" | "production" | undefined;
    LOG_LEVEL?: "trace" | "debug" | "info" | "warn" | "error" | "fatal" | undefined;
    SERVICE_VERSION?: string | undefined;
    OTEL_EXPORTER_OTLP_ENDPOINT?: string | undefined;
    OTEL_ENABLED?: string | undefined;
    PORT?: number | undefined;
    KAFKA_CLIENT_ID?: string | undefined;
    KAFKA_GROUP_ID?: string | undefined;
    KAFKA_TOPIC_EVENTS?: string | undefined;
    BATCH_SIZE_MAX?: number | undefined;
}>;
export type IngestionConfig = z.infer<typeof IngestionConfigSchema>;
/**
 * Validates process.env against the provided Zod schema.
 * Throws a descriptive error at startup if validation fails.
 *
 * Usage (in each service's main.ts):
 *   import { loadConfig, ApiGatewayConfigSchema } from '@relevix/config';
 *   const config = loadConfig(ApiGatewayConfigSchema);
 */
export declare function loadConfig<T extends z.ZodTypeAny>(schema: T): z.infer<T>;
//# sourceMappingURL=index.d.ts.map