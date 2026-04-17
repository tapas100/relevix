package main

import (
	"context"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/redis/go-redis/v9"
	"github.com/tapas100/relevix/services/rule-engine/internal/config"
	"github.com/tapas100/relevix/services/rule-engine/internal/engine"
	"github.com/tapas100/relevix/services/rule-engine/internal/handler"
	"github.com/tapas100/relevix/services/rule-engine/internal/logger"
	ratemw "github.com/tapas100/relevix/services/rule-engine/internal/middleware"
	"github.com/tapas100/relevix/services/rule-engine/internal/precompute"
	"github.com/tapas100/relevix/services/rule-engine/internal/scorer"
)

func main() {
	cfg := config.MustLoad()
	log := logger.New(cfg.LogLevel, cfg.ServiceName)

	// ── Redis client ─────────────────────────────────────────────────────────
	redisOpts, err := redis.ParseURL(cfg.RedisURL)
	if err != nil {
		log.Fatal().Err(err).Str("redis_url", cfg.RedisURL).Msg("invalid REDIS_URL")
	}
	rdb := redis.NewClient(redisOpts)
	{
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := rdb.Ping(ctx).Err(); err != nil {
			log.Fatal().Err(err).Msg("redis ping failed")
		}
	}
	log.Info().Str("redis_url", cfg.RedisURL).Msg("redis connected")

	// ── Precompute subsystem ──────────────────────────────────────────────────
	tickInterval := time.Duration(cfg.PrecomputeTickInterval) * time.Second
	lockTTL := time.Duration(cfg.PrecomputeLockTTL) * time.Second
	resultsTTL := tickInterval * time.Duration(cfg.RedisResultsTTLFactor)

	pcStore := precompute.NewStore(rdb, resultsTTL, lockTTL)

	infraEngine := engine.NewInfraEngine(nil)
	sc := scorer.NewDefault()
	pcMetrics := precompute.NewMetrics()

	// Static fetcher/rule-source are the dev/test implementations.
	// Replace with real Kafka/Postgres implementations as they become available.
	fetcher := &precompute.StaticFetcher{}
	ruleSrc := &precompute.StaticRuleSource{}
	impactSrc := &precompute.StaticImpactSource{}

	workerCfg := precompute.WorkerConfig{
		WorkerID:     "rule-engine",
		Store:        pcStore,
		Fetcher:      fetcher,
		Rules:        ruleSrc,
		Impact:       impactSrc,
		InfraEngine:  infraEngine,
		Scorer:       sc,
		TickInterval: tickInterval,
		Log:          log,
	}

	schedulerCfg := precompute.DefaultSchedulerConfig(log)
	schedulerCfg.TickInterval = tickInterval
	schedulerCfg.MaxConcurrency = cfg.PrecomputeWorkers

	scheduler := precompute.NewScheduler(schedulerCfg, workerCfg, pcStore)

	queryHandler := precompute.NewQueryHandler(precompute.QueryHandlerConfig{
		Store:       pcStore,
		Fetcher:     fetcher,
		Rules:       ruleSrc,
		Impact:      impactSrc,
		InfraEngine: infraEngine,
		Scorer:      sc,
		Metrics:     pcMetrics,
		Log:         log,
	})

	// Start the scheduler background loop.
	bgCtx, bgCancel := context.WithCancel(context.Background())
	defer bgCancel()
	scheduler.Start(bgCtx)

	r := chi.NewRouter()

	// ── Global middleware stack ──────────────────────────────────────────────
	r.Use(middleware.RealIP)
	r.Use(middleware.RequestID)
	r.Use(ratemw.RequestLogger(log))
	r.Use(middleware.Recoverer)
	r.Use(ratemw.TraceContext)

	// ── Routes ───────────────────────────────────────────────────────────────
	r.Get("/health", handler.Health(cfg))
	r.Get("/metrics", promhttp.Handler().ServeHTTP)
	r.Route("/v1/rules", func(r chi.Router) {
		r.Post("/evaluate", handler.Evaluate(log))
	})
	r.Route("/v1/insights", func(r chi.Router) {
		r.Get("/", queryHandler.ServeHTTP)
	})

	srv := &http.Server{
		Addr:         cfg.Addr(),
		Handler:      r,
		ReadTimeout:  5 * time.Second,
		WriteTimeout: 10 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	// ── Graceful shutdown ────────────────────────────────────────────────────
	go func() {
		log.Info().Str("addr", srv.Addr).Msg("rule-engine started")
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatal().Err(err).Msg("server error")
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	log.Info().Msg("shutting down gracefully…")
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	if err := srv.Shutdown(ctx); err != nil {
		log.Error().Err(err).Msg("shutdown error")
		os.Exit(1)
	}
	log.Info().Msg("bye")
}
