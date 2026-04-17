/**
 * PM2 Ecosystem — Relevix
 * ─────────────────────────────────────────────────────────────────────────────
 * Manages all Node.js / TypeScript processes for local dev and production.
 * Go services (rule-engine, ingestion, signal-processor) are compiled to
 * binaries and also managed here — PM2 treats them as plain shell processes.
 *
 * Usage
 * ──────
 *   pnpm pm2:dev      start all apps in dev/watch mode
 *   pnpm pm2:start    start all apps in production mode (requires build first)
 *   pnpm pm2:stop     stop all apps
 *   pnpm pm2:restart  restart all apps
 *   pnpm pm2:delete   remove all apps from PM2 daemon
 *   pnpm pm2:logs     tail all logs
 *   pnpm pm2:status   show process list
 *   pnpm pm2:save     persist current process list (survives reboots)
 *   pnpm pm2:monit    open interactive monitor
 *
 * Prerequisites
 * ─────────────
 *   npm i -g pm2          install PM2 globally
 *   pnpm install          install Node dependencies
 *   Go toolchain          for Go service binaries (go >= 1.22)
 *   Podman / Docker       for infra containers (Redis, Postgres, Kafka)
 *
 * Infra containers (NOT managed by PM2 — start separately):
 *   podman run -d --name relevix-redis    -p 6379:6379 redis:7-alpine
 *   podman run -d --name relevix-postgres -p 5432:5432 \
 *     -e POSTGRES_USER=relevix -e POSTGRES_PASSWORD=devpassword \
 *     -e POSTGRES_DB=relevix_dev postgres:16-alpine
 */

'use strict';

// ─── Paths ────────────────────────────────────────────────────────────────────

const ROOT = __dirname;

// ─── Shared env loaded by every process ──────────────────────────────────────
// Node processes load their own .env via --env-file; Go processes share a
// flat env object here so PM2 injects the vars before exec.

const infraEnv = {
  REDIS_URL:    'redis://localhost:6379',
  DATABASE_URL: 'postgresql://relevix:devpassword@localhost:5432/relevix_dev',
};

// ─── Go service helpers ───────────────────────────────────────────────────────

function goApp({ name, cwd, env = {} }) {
  return {
    name,
    cwd,
    // Run the pre-compiled binary at bin/server.
    // "go run" is intentionally avoided — on macOS arm64 (Apple Silicon) the
    // temp binaries produced by "go run" lack the LC_UUID Mach-O load command
    // and are rejected by dyld on macOS 26 (Tahoe), causing an immediate abort.
    //
    // Always build with the external C linker so clang emits LC_UUID:
    //   CGO_ENABLED=1 go build -ldflags="-linkmode=external" -o bin/server ./cmd/server
    //
    // Use:  pnpm pm2:build:go   (rebuilds all three Go services correctly)
    script:      './bin/server',
    interpreter: 'none',
    env: { ...infraEnv, ...env },
    watch:        false,
    autorestart:  true,
    max_restarts: 10,
    restart_delay: 2000,
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    merge_logs: true,
    out_file:   `/tmp/pm2-${name}-out.log`,
    error_file: `/tmp/pm2-${name}-err.log`,
  };
}

// ─── App definitions ──────────────────────────────────────────────────────────

module.exports = {
  apps: [

    // ── 1. API Gateway (Node / TypeScript) ──────────────────────────────────
    {
      name:        'api-gateway',
      cwd:         `${ROOT}/apps/api-gateway`,
      script:      'pnpm',
      args:        'exec tsx watch --env-file=.env src/main.ts',
      interpreter: 'none',
      watch:       false,           // tsx handles its own watch
      autorestart: true,
      max_restarts: 10,
      restart_delay: 2000,
      // Environment is loaded from .env via --env-file; add overrides here if needed.
      env: {
        NODE_ENV: 'development',
      },
      env_production: {
        NODE_ENV: 'production',
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      out_file:   '/tmp/pm2-api-gateway-out.log',
      error_file: '/tmp/pm2-api-gateway-err.log',
    },

    // ── 2. Dashboard (Vite dev server) ───────────────────────────────────────
    {
      name:        'dashboard',
      cwd:         `${ROOT}/apps/dashboard`,
      script:      'pnpm',
      args:        'exec vite',
      interpreter: 'none',
      watch:       false,           // Vite handles HMR
      autorestart: true,
      max_restarts: 10,
      restart_delay: 2000,
      env: {
        NODE_ENV: 'development',
      },
      env_production: {
        // In production, serve the pre-built dist with `vite preview`
        NODE_ENV: 'production',
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      out_file:   '/tmp/pm2-dashboard-out.log',
      error_file: '/tmp/pm2-dashboard-err.log',
    },

    // ── 3. Rule Engine (Go) ───────────────────────────────────────────────────
    goApp({
      name: 'rule-engine',
      cwd:  `${ROOT}/services/rule-engine`,
      env: {
        SERVICE_NAME:    'rule-engine',
        SERVICE_VERSION: '0.0.1',
        LOG_LEVEL:       'info',
        HOST:            '0.0.0.0',
        PORT:            '8080',
        PRECOMPUTE_TICK_INTERVAL: '30',
        PRECOMPUTE_LOCK_TTL:      '24',
        PRECOMPUTE_WORKERS:       '0',
      },
    }),

    // ── 4. Ingestion Service (Go) ─────────────────────────────────────────────
    goApp({
      name: 'ingestion',
      cwd:  `${ROOT}/services/ingestion`,
      env: {
        SERVICE_NAME:         'ingestion',
        SERVICE_VERSION:      '0.0.1',
        LOG_LEVEL:            'info',
        HOST:                 '0.0.0.0',
        PORT:                 '4000',
        KAFKA_BROKERS:        'localhost:9092',
        KAFKA_CLIENT_ID:      'relevix-ingestion',
        KAFKA_GROUP_ID:       'relevix-ingestion-group',
        KAFKA_TOPIC_EVENTS:   'relevix.events',
        INTAKE_BUFFER_SIZE:   '10000',
        WORKER_COUNT:         '4',
        BATCH_SIZE:           '500',
        BATCH_FLUSH_INTERVAL: '1s',
        OUTPUT_BUFFER_SIZE:   '1000',
      },
    }),

    // ── 5. Signal Processor (Go) ──────────────────────────────────────────────
    goApp({
      name: 'signal-processor',
      cwd:  `${ROOT}/services/signal-processor`,
      env: {
        SERVICE_NAME:    'signal-processor',
        SERVICE_VERSION: '0.0.1',
        LOG_LEVEL:       'info',
        HOST:            '0.0.0.0',
        PORT:            '4001',
        KAFKA_BROKERS:   'localhost:9092',
      },
    }),

    // ── 6. MCP Server (Node / TypeScript) ────────────────────────────────────
    // Exposes Relevix insight tools over the Model Context Protocol (stdio
    // transport) so AI agents (Cursor, GitHub Copilot, Claude Desktop, etc.)
    // can query the platform directly.
    // The MCP server reads RELEVIX_API_URL and RELEVIX_TOKEN from the env;
    // set those in apps/mcp-server/.env or pass them here.
    {
      name:        'mcp-server',
      cwd:         `${ROOT}/apps/mcp-server`,
      script:      'node',
      args:        'dist/apps/mcp-server/src/index.js',
      interpreter: 'none',
      watch:       false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 2000,
      env: {
        NODE_ENV:         'development',
        RELEVIX_API_URL:  'http://localhost:3001',
        RELEVIX_TIMEOUT:  '10000',
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      out_file:   '/tmp/pm2-mcp-server-out.log',
      error_file: '/tmp/pm2-mcp-server-err.log',
    },

  ],
};
