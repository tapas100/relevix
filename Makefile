# ─────────────────────────────────────────────────────────────────────────────
# Makefile — Developer convenience targets for Relevix
# Wraps pnpm/turbo commands and Go toolchain.
#
# Container runtime: Podman (rootless, daemonless)
#   Install: https://podman.io/docs/installation
#   Compose:  podman compose  (built-in, Podman >= 4.7)
#             — or — pip install podman-compose
# ─────────────────────────────────────────────────────────────────────────────

.PHONY: install build dev test lint typecheck clean \
        go-test go-lint go-build \
        podman-up podman-down podman-dev podman-build podman-logs \
        podman-build-api podman-build-rule-engine podman-build-ingestion

# ── Node / TypeScript ─────────────────────────────────────────────────────────

install:
	pnpm install

build:
	pnpm turbo run build

dev:
	pnpm turbo run dev --parallel

test:
	pnpm turbo run test

lint:
	pnpm turbo run lint

typecheck:
	pnpm turbo run typecheck

clean:
	pnpm turbo run clean

# ── Go ────────────────────────────────────────────────────────────────────────

go-test:
	cd services/rule-engine      && CGO_ENABLED=0 go test ./... -race -cover
	cd services/ingestion        && CGO_ENABLED=0 go test ./... -race -cover
	cd services/signal-processor && CGO_ENABLED=0 go test ./... -race -cover

go-lint:
	cd services/rule-engine      && golangci-lint run ./...
	cd services/ingestion        && golangci-lint run ./...
	cd services/signal-processor && golangci-lint run ./...

go-build:
	cd services/rule-engine      && go build -o bin/rule-engine      ./cmd/server
	cd services/ingestion        && go build -o bin/ingestion        ./cmd/server
	cd services/signal-processor && go build -o bin/signal-processor ./cmd/server

# ── Podman — Compose ─────────────────────────────────────────────────────────

podman-up:
	podman compose -f podman-compose.yml up -d

podman-down:
	podman compose -f podman-compose.yml down

podman-dev:
	podman compose -f podman-compose.dev.yml up

podman-logs:
	podman compose -f podman-compose.yml logs -f

podman-build:
	podman compose -f podman-compose.yml build

# ── Podman — Individual image builds ─────────────────────────────────────────
# Podman auto-detects Containerfile before Dockerfile.
# Pass --no-cache to force a full rebuild.

podman-build-api:
	podman build -f apps/api-gateway/Containerfile \
	             -t localhost/relevix/api-gateway:latest .

podman-build-rule-engine:
	podman build -f services/rule-engine/Containerfile \
	             -t localhost/relevix/rule-engine:latest .

podman-build-ingestion:
	podman build -f services/ingestion/Containerfile \
	             -t localhost/relevix/ingestion:latest .

# ── Podman — Rootless setup helper ───────────────────────────────────────────
# Run once after installing Podman to initialise the rootless socket.
podman-init:
	systemctl --user enable --now podman.socket
	@echo "Podman rootless socket enabled."
