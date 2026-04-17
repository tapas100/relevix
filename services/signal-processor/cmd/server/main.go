package main

import (
	"context"
	"errors"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"
	chimw "github.com/go-chi/chi/v5/middleware"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/tapas100/relevix/services/signal-processor/internal/aggregator"
	"github.com/tapas100/relevix/services/signal-processor/internal/baseline"
	"github.com/tapas100/relevix/services/signal-processor/internal/config"
	"github.com/tapas100/relevix/services/signal-processor/internal/domain"
	"github.com/tapas100/relevix/services/signal-processor/internal/intake"
	"github.com/tapas100/relevix/services/signal-processor/internal/logger"
	"github.com/tapas100/relevix/services/signal-processor/internal/output"
	"github.com/tapas100/relevix/services/signal-processor/internal/query"
	"github.com/tapas100/relevix/services/signal-processor/internal/window"
)

func main() {
	log := logger.New("signal-processor")
	cfg := config.MustLoad()

	log.Info().
		Strs("brokers", cfg.KafkaBrokers).
		Str("input_topic", cfg.KafkaTopicInput).
		Str("signals_topic", cfg.KafkaTopicSignals).
		Dur("window_size", cfg.WindowSize).
		Dur("tick_interval", cfg.TickInterval).
		Msg("signal-processor starting")

	// ── channels ────────────────────────────────────────────────────────────
	obsCh := make(chan *domain.LogObservation, cfg.ObsChanSize)
	snapshotCh := make(chan *domain.WindowSnapshot, cfg.SnapshotChanSize)
	signalCh := make(chan *domain.Signal, cfg.SignalChanSize)

	// ── components ──────────────────────────────────────────────────────────
	winMgr := window.NewManager(
		cfg.WindowSize,
		cfg.TickInterval,
		snapshotCh,
		log,
	)
	winMgr.SetCapacity(cfg.RingCapacity, cfg.MaxDimensions)

	baselineTracker := baseline.NewTracker()

	agg := aggregator.New(snapshotCh, signalCh, baselineTracker, log)

	consumer := intake.NewKafkaConsumer(
		cfg.KafkaBrokers,
		cfg.KafkaTopicInput,
		cfg.KafkaGroupID,
		cfg.KafkaMaxBytes,
		cfg.KafkaCommitInterval,
		obsCh,
		log,
	)

	writer := output.NewSignalWriter(cfg.KafkaBrokers, cfg.KafkaTopicSignals, log)

	// ── query / recent signal store ─────────────────────────────────────────
	store := query.NewStore(defaultStoreSize)
	queryHandler := query.NewHandler(store)

	// ── context ─────────────────────────────────────────────────────────────
	ctx, cancel := context.WithCancel(context.Background())

	// ── goroutines ──────────────────────────────────────────────────────────

	// 1. Observation fan-in: drain obsCh → window manager
	go func() {
		for {
			select {
			case obs := <-obsCh:
				winMgr.Push(obs)
			case <-ctx.Done():
				return
			}
		}
	}()

	// 2. Window manager (emits snapshots on tick)
	go winMgr.Run(ctx)

	// 3. Aggregator (snapshot → signal)
	go agg.Run(ctx)

	// 4. Signal writer + store fan-out
	go func() {
		for {
			select {
			case sig := <-signalCh:
				store.Add(sig)
				if err := writer.Write(ctx, sig); err != nil {
					log.Error().Err(err).Str("signal_id", sig.ID).Msg("signal write failed")
				}
			case <-ctx.Done():
				return
			}
		}
	}()

	// 5. Kafka consumer
	go consumer.Run(ctx)

	// ── HTTP: query API ──────────────────────────────────────────────────────
	apiRouter := chi.NewRouter()
	apiRouter.Use(chimw.Recoverer)
	apiRouter.Use(chimw.RequestID)
	apiRouter.Use(chimw.RealIP)
	queryHandler.Mount(apiRouter)

	apiSrv := &http.Server{
		Addr:         cfg.HTTPAddr,
		Handler:      apiRouter,
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 10 * time.Second,
		IdleTimeout:  30 * time.Second,
	}

	// ── HTTP: Prometheus metrics ─────────────────────────────────────────────
	metricsMux := http.NewServeMux()
	metricsMux.Handle("/metrics", promhttp.Handler())
	metricsSrv := &http.Server{
		Addr:         cfg.MetricsAddr,
		Handler:      metricsMux,
		ReadTimeout:  5 * time.Second,
		WriteTimeout: 5 * time.Second,
	}

	go func() {
		log.Info().Str("addr", cfg.HTTPAddr).Msg("API server listening")
		if err := apiSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatal().Err(err).Msg("API server failed")
		}
	}()
	go func() {
		log.Info().Str("addr", cfg.MetricsAddr).Msg("metrics server listening")
		if err := metricsSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatal().Err(err).Msg("metrics server failed")
		}
	}()

	// ── graceful shutdown ────────────────────────────────────────────────────
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit
	log.Info().Msg("shutdown signal received")

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer shutdownCancel()

	// Step 1: stop HTTP servers
	_ = apiSrv.Shutdown(shutdownCtx)
	_ = metricsSrv.Shutdown(shutdownCtx)

	// Step 2: cancel pipeline context (stops consumer, window mgr, aggregator, writer goroutines)
	cancel()

	// Step 3: close Kafka consumer
	if err := consumer.Close(); err != nil {
		log.Warn().Err(err).Msg("consumer close error")
	}

	// Step 4: close signal writer
	if err := writer.Close(); err != nil {
		log.Warn().Err(err).Msg("signal writer close error")
	}

	log.Info().Msg("signal-processor stopped cleanly")
}

const defaultStoreSize = 10_000
