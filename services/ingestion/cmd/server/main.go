// Package main is the entrypoint for the Relevix ingestion service.
//
// Pipeline topology:
//
//HTTP POST /v1/ingest/batch ──┐
//                              ├─► intakeCh ─► WorkerPool ─► normalizedCh ─► Batcher ─► batchCh
//Kafka consumer ──────────────┘                                                              │
//                                                                        ┌───────────────────┤
//                                                                        ▼                   ▼
//                                                                 KafkaWriter           InternalQueue
//                                                                        │ (on error)
//                                                                        ▼
//                                                                   retryCh ─► RetryWorker ─► DLQ
//
// Backpressure propagates upstream:
//   batchCh full → Batcher blocks → normalizedCh back-pressures WorkerPool
//   → intakeCh back-pressures HTTP (returns 503) and Kafka consumer (lags).
package main

import (
	"context"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"
	chimw "github.com/go-chi/chi/v5/middleware"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/tapas100/relevix/services/ingestion/internal/config"
	"github.com/tapas100/relevix/services/ingestion/internal/domain"
	"github.com/tapas100/relevix/services/ingestion/internal/handler"
	"github.com/tapas100/relevix/services/ingestion/internal/intake"
	"github.com/tapas100/relevix/services/ingestion/internal/logger"
	"github.com/tapas100/relevix/services/ingestion/internal/output"
	"github.com/tapas100/relevix/services/ingestion/internal/pipeline"
	"github.com/tapas100/relevix/services/ingestion/internal/retry"
)

func main() {
	cfg := config.MustLoad()
	log := logger.New(cfg.LogLevel, cfg.ServiceName)

	log.Info().
		Str("version", cfg.ServiceVersion).
		Str("env", cfg.Environment).
		Msg("starting ingestion service")

	// ── Channels (bounded — backpressure backbone) ────────────────────────────
	//
	// intakeCh: raw logs from HTTP + Kafka → normalizer workers
	// normalizedCh: normalized logs → batcher
	// batchCh: ready batches → output router
	// retryCh: failed batches → retry worker
	intakeCh     := make(chan *domain.RawLog,        cfg.IntakeBufferSize)
	normalizedCh := make(chan *domain.NormalizedLog,  cfg.IntakeBufferSize/2)
	batchCh      := make(chan *domain.Batch,          cfg.OutputBufferSize)
	retryCh      := make(chan *domain.RetryRecord,    cfg.RetryBufferSize)

	// ── Pipeline components ───────────────────────────────────────────────────

	normalizer  := pipeline.NewNormalizer(cfg.Environment)
	workerPool  := pipeline.NewWorkerPool(intakeCh, normalizedCh, normalizer, cfg.WorkerCount, log)
	batcher     := pipeline.NewBatcher(normalizedCh, batchCh, cfg.BatchSize, cfg.BatchFlushInterval, log)

	kafkaOut    := output.NewKafkaWriter(cfg.KafkaBrokers, cfg.KafkaTopicOutput, log)
	dlqWriter   := output.NewDLQWriter(cfg.KafkaBrokers, cfg.KafkaTopicDLQ, log)
	router      := output.NewRouter(batchCh, kafkaOut, retryCh)
	retryWorker := retry.NewWorker(retryCh, retryCh, kafkaOut, dlqWriter, cfg.MaxRetryAttempts, cfg.RetryBaseDelay, log)

	// ── Kafka consumer ────────────────────────────────────────────────────────

	kafkaConsumer := intake.NewKafkaConsumer(
		cfg.KafkaBrokers,
		cfg.KafkaTopicInput,
		cfg.KafkaGroupID,
		cfg.KafkaMaxBytes,
		cfg.KafkaCommitInterval,
		intakeCh,
		log,
	)

	// ── HTTP server ───────────────────────────────────────────────────────────

	r := chi.NewRouter()
	r.Use(chimw.RealIP)
	r.Use(chimw.RequestID)
	r.Use(chimw.Recoverer)
	r.Get("/health", handler.Health())
	r.Post("/v1/ingest/batch", handler.IngestBatch(log, intakeCh, cfg.BatchSize))

	srv := &http.Server{
		Addr:         cfg.Addr(),
		Handler:      r,
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	// ── Metrics server ────────────────────────────────────────────────────────

	var metricsSrv *http.Server
	if cfg.MetricsPort > 0 {
		mux := http.NewServeMux()
		mux.Handle("/metrics", promhttp.Handler())
		metricsSrv = &http.Server{
			Addr:         cfg.MetricsAddr(),
			Handler:      mux,
			ReadTimeout:  5 * time.Second,
			WriteTimeout: 5 * time.Second,
		}
		go func() {
			log.Info().Str("addr", metricsSrv.Addr).Msg("metrics server started")
			if err := metricsSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
				log.Error().Err(err).Msg("metrics server error")
			}
		}()
	}

	// ── Launch pipeline goroutines ────────────────────────────────────────────

	ctx, cancel := context.WithCancel(context.Background())

	go workerPool.Run(ctx)
	go batcher.Run(ctx)
	go router.Run(ctx)
	go retryWorker.Run(ctx)
	go kafkaConsumer.Run(ctx)

	// ── Start HTTP server ─────────────────────────────────────────────────────

	go func() {
		log.Info().Str("addr", srv.Addr).Msg("HTTP server started")
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatal().Err(err).Msg("HTTP server error")
		}
	}()

	// ── Graceful shutdown ─────────────────────────────────────────────────────

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	log.Info().Msg("shutdown signal received — draining pipeline…")

	// 1. Stop accepting new work.
	shutCtx, shutCancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer shutCancel()
	_ = srv.Shutdown(shutCtx)

	// 2. Cancel pipeline context — workers drain their channels before exiting.
	cancel()

	// 3. Close Kafka consumer so it stops fetching.
	if err := kafkaConsumer.Close(); err != nil {
		log.Warn().Err(err).Msg("kafka consumer close error")
	}

	// 4. Close output writers.
	if err := kafkaOut.Close(); err != nil {
		log.Warn().Err(err).Msg("kafka writer close error")
	}
	if err := dlqWriter.Close(); err != nil {
		log.Warn().Err(err).Msg("dlq writer close error")
	}

	// 5. Stop metrics server.
	if metricsSrv != nil {
		_ = metricsSrv.Shutdown(shutCtx)
	}

	log.Info().Msg("ingestion service stopped cleanly")
}
