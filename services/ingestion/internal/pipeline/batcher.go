// Package pipeline — batcher stage.
//
// The Batcher accumulates NormalizedLogs from the intake channel and flushes
// a Batch downstream when EITHER:
//   (a) the batch reaches cfg.BatchSize  logs   → "size" trigger
//   (b) cfg.BatchFlushInterval elapses          → "timer" trigger
//
// This dual-trigger model keeps latency bounded while maximising throughput.
//
// Backpressure: if the output channel is full, Flush blocks. The caller
// (the goroutine running Run) will stall, which in turn stalls the normalizer
// workers, which in turn stalls the intake — the pressure propagates up.
package pipeline

import (
	"context"
	"time"

	"github.com/rs/zerolog"
	"github.com/tapas100/relevix/services/ingestion/internal/domain"
	"github.com/tapas100/relevix/services/ingestion/internal/metrics"
)

// Batcher reads NormalizedLogs from in and writes Batches to out.
type Batcher struct {
	in        <-chan *domain.NormalizedLog
	out       chan<- *domain.Batch
	batchSize int
	interval  time.Duration
	log       zerolog.Logger
}

// NewBatcher creates a Batcher.
//   in        — normalized log stream (output of worker pool)
//   out       — batch stream (input to output writer)
//   batchSize — max logs per batch
//   interval  — max time before a partial batch is flushed
func NewBatcher(
	in <-chan *domain.NormalizedLog,
	out chan<- *domain.Batch,
	batchSize int,
	interval time.Duration,
	log zerolog.Logger,
) *Batcher {
	return &Batcher{
		in:        in,
		out:       out,
		batchSize: batchSize,
		interval:  interval,
		log:       log.With().Str("component", "batcher").Logger(),
	}
}

// Run processes logs until ctx is cancelled.
// It drains any remaining buffered logs before returning.
func (b *Batcher) Run(ctx context.Context) {
	buf := make([]*domain.NormalizedLog, 0, b.batchSize)
	ticker := time.NewTicker(b.interval)
	defer ticker.Stop()

	flush := func(trigger string) {
		if len(buf) == 0 {
			return
		}
		batch := &domain.Batch{
			Logs:      buf,
			CreatedAt: time.Now().UTC(),
		}
		// Blocking send — applies backpressure if the output channel is full.
		b.out <- batch

		metrics.BatchesFlushedTotal.WithLabelValues(trigger).Inc()
		metrics.BatchSizeLogs.Observe(float64(len(buf)))
		metrics.OutputChannelUtilization.Set(float64(len(b.out)) / float64(cap(b.out)))

		b.log.Debug().
			Int("size", len(buf)).
			Str("trigger", trigger).
			Msg("batch flushed")

		// Reset — allocate a fresh slice to avoid holding refs to old logs.
		buf = make([]*domain.NormalizedLog, 0, b.batchSize)
	}

	for {
		select {
		case log, ok := <-b.in:
			if !ok {
				// Upstream closed — flush remainder and exit.
				flush("drain")
				return
			}
			buf = append(buf, log)
			if len(buf) >= b.batchSize {
				flush("size")
				ticker.Reset(b.interval) // restart timer after a size-triggered flush
			}

		case <-ticker.C:
			flush("timer")

		case <-ctx.Done():
			// Drain the input channel before exiting so we don't drop in-flight logs.
			for {
				select {
				case log, ok := <-b.in:
					if !ok {
						flush("drain")
						return
					}
					buf = append(buf, log)
					if len(buf) >= b.batchSize {
						flush("size")
					}
				default:
					flush("drain")
					return
				}
			}
		}
	}
}
