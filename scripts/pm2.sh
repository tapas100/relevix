#!/usr/bin/env bash
# scripts/pm2.sh — Relevix PM2 helper
#
# Wraps common PM2 commands so they always resolve to the root ecosystem file.
# Designed to be called via pnpm scripts:
#   pnpm pm2:dev
#   pnpm pm2:start
#   pnpm pm2:stop   etc.
#
# Usage: bash scripts/pm2.sh <command> [app-name]
#   dev        start all apps in dev/watch mode (tsx watch + vite + go run)
#   start      start all apps (production mode — build first with pnpm build)
#   stop       stop all apps (or a single app if name provided)
#   restart    restart all apps (or a single app)
#   reload     zero-downtime reload (Node apps only)
#   delete     remove all apps from PM2 daemon
#   logs       tail logs for all apps (Ctrl-C to exit)
#   status     show process table
#   save       persist process list for startup
#   startup    configure PM2 to start on OS boot
#   monit      open interactive monitor
#   infra:up   start Redis + Postgres via Podman
#   infra:down stop Redis + Postgres containers

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ECOSYSTEM="${REPO_ROOT}/ecosystem.config.cjs"
CMD="${1:-status}"
APP="${2:-}"                   # optional app name filter

# ── Colour helpers ────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; RESET='\033[0m'
info()  { echo -e "${CYAN}[relevix]${RESET} $*"; }
ok()    { echo -e "${GREEN}[relevix]${RESET} $*"; }
warn()  { echo -e "${YELLOW}[relevix]${RESET} $*"; }

# ── Ensure PM2 is available ───────────────────────────────────────────────────
if ! command -v pm2 &>/dev/null; then
  warn "PM2 not found. Installing globally…"
  npm install -g pm2
fi

# ── Commands ──────────────────────────────────────────────────────────────────
case "$CMD" in

  build:go)
    # CGO_ENABLED=1 + linkmode=external forces clang as the final linker,
    # which emits LC_UUID in the Mach-O header (required by macOS 26 dyld).
    # After linking, codesign --force --sign - applies an ad-hoc signature
    # so macOS Gatekeeper accepts the binary (CGO builds invalidate the
    # default Go ad-hoc signature, causing "invalid signature" kills).
    info "Compiling Go service binaries with external linker + ad-hoc codesign…"
    for svc in rule-engine ingestion signal-processor; do
      info "  building ${svc}…"
      ( cd "${REPO_ROOT}/services/${svc}" && \
        mkdir -p bin && \
        CGO_ENABLED=1 go build -ldflags="-linkmode=external" -o bin/server ./cmd/server )
      codesign --force --sign - "${REPO_ROOT}/services/${svc}/bin/server"
      ok "  ${svc} → services/${svc}/bin/server ✓ (signed)"
    done
    ok "All Go binaries built and signed."
    ;;

  dev)
    info "Starting all services in dev mode…"
    pm2 start "$ECOSYSTEM" --env development ${APP:+--only "$APP"}
    pm2 ls
    ok "All services started. Run 'pnpm pm2:logs' to tail output."
    ;;

  start)
    info "Starting all services in production mode…"
    pm2 start "$ECOSYSTEM" --env production ${APP:+--only "$APP"}
    pm2 ls
    ok "Done."
    ;;

  stop)
    info "Stopping services…"
    if [[ -n "$APP" ]]; then
      pm2 stop "$APP"
    else
      pm2 stop "$ECOSYSTEM"
    fi
    ok "Stopped."
    ;;

  restart)
    info "Restarting services…"
    if [[ -n "$APP" ]]; then
      pm2 restart "$APP"
    else
      pm2 restart "$ECOSYSTEM"
    fi
    ok "Restarted."
    ;;

  reload)
    info "Zero-downtime reload (Node apps only)…"
    if [[ -n "$APP" ]]; then
      pm2 reload "$APP"
    else
      pm2 reload "$ECOSYSTEM"
    fi
    ok "Reloaded."
    ;;

  delete)
    warn "Removing all Relevix apps from PM2 daemon…"
    pm2 delete "$ECOSYSTEM" 2>/dev/null || true
    ok "Deleted."
    ;;

  logs)
    info "Tailing logs (Ctrl-C to exit)…"
    if [[ -n "$APP" ]]; then
      pm2 logs "$APP" --lines 100
    else
      pm2 logs --lines 50
    fi
    ;;

  status)
    pm2 ls
    ;;

  save)
    info "Saving current process list for auto-restart on reboot…"
    pm2 save
    ok "Saved. Run 'pnpm pm2:startup' to configure OS-level startup."
    ;;

  startup)
    info "Configuring PM2 startup hook for this OS…"
    pm2 startup
    ok "Follow the printed command to enable the startup hook."
    ;;

  monit)
    pm2 monit
    ;;

  infra:up)
    info "Starting Redis + Postgres via Podman…"
    podman run -d --name relevix-redis \
      --replace -p 6379:6379 \
      redis:7-alpine
    podman run -d --name relevix-postgres \
      --replace -p 5432:5432 \
      -e POSTGRES_USER=relevix \
      -e POSTGRES_PASSWORD=devpassword \
      -e POSTGRES_DB=relevix_dev \
      postgres:16-alpine
    ok "Infra containers started."
    podman ps --filter "name=relevix" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
    ;;

  infra:down)
    info "Stopping infra containers…"
    podman stop relevix-redis relevix-postgres 2>/dev/null || true
    ok "Containers stopped."
    ;;

  *)
    echo "Unknown command: $CMD"
    echo "Usage: pnpm pm2:<dev|start|stop|restart|reload|delete|logs|status|save|startup|monit|infra:up|infra:down>"
    exit 1
    ;;

esac
