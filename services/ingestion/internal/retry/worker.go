// Package retry implements the retry worker with exponential backoff and jitter,
// and a dead-letter queue (DLQ) writer for batches that exhaust all retries.
//
// Retry policy:
//   attempt 1 → base * 2^0 + jitter  (e.g. ~500 ms)
//   attempt 2 → base * 2^1 + jitter  (e.g. ~1 s)
//   attempt 3 → base * 2^2 + jitter  (e.g. ~2 s)
//   attempt N > MaxAttempts → DLQ
//
// The retry channel is bounded. If it fills up (e.g. Kafka is fully down),
// the Router drops new failures directly to the DLQ counter — the system
// degrades gracefully rather than blocking the pipeline.
package retry

import (
	"context"
	"math"
	"math/rand"
	"strconv"
	"time"

	"github.com/rs/zerolog"
	"github.com/tapas100/relevix/services/ingestion/internal/domain"
	"github.com/tapas100/relevix/services/ingestion/internal/metrics"
	"github.com/tapas100/relevix/services/ingestion/internal/output"
)

// Worker processes the retry channel with exponential backoff.
type Worker struct {
	in          <-chan *domain.RetryRecord
	reEnqueue   chan<- *domain.RetryRecord
	writer      output.Writer   // same primary writer — try again
	dlq         *output.DLQWriter
	maxAttempts int
	baseDelay   time.Duration
	log         zerolog.Logger
}

// NewWorker creates a retry Worker.
func NewWorker(
	in <-chan *domain.RetryRecord,
	reEnqueue chan<- *domain.RetryRecord,
	writer output.Writer,
	dlq *output.DLQWriter,
	maxAttempts int,
	baseDelay time.Duration,
	log zerolog.Logger,
) *Worker {
	return &Worker{
		in:          in,
		reEnqueue:   reEnqueue,
		writer:      writer,
		dlq:         dlq,
		maxAttempts: maxAttempts,
		baseDelay:   baseDelay,
		log:         log.With().Str("component", "retry_worker").Logger(),
	}
}

// Run processes retry records until ctx is cancelled.
func (w *Worker) Run(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case record, ok := <-w.in:
			if !ok {
				return
			}
			w.handle(ctx, record)
		}
	}
}

func (w *Worker) handle(ctx context.Context, record *domain.RetryRecord) {
	if record.Attempts > w.maxAttempts {
		w.sendToDLQ(ctx, record)
		return
	}

	// Wait until NextAt (set on the previous attempt).
	if delay := time.Until(record.NextAt); delay > 0 {
		select {
		case <-time.After(delay):
		case <-ctx.Done():
			return
		}
	}

	metrics.RetryAttemptsTotal.WithLabelValues(strconv.Itoa(record.Attempts)).Inc()

	w.log.Warn().
		Int("attempt", record.Attempts).
		Int("logs", len(record.Batch.Logs)).
		Err(record.LastErr).
		Msg("retrying batch")

	if err := w.writer.Write(ctx, record.Batch); err != nil {
		record.Attempts++
		record.LastErr = err
		record.NextAt = time.Now().Add(backoffDelay(w.baseDelay, record.Attempts))

		// Re-enqueue for the next attempt.
		select {
		case w.reEnqueue <- record:
		default:
			// Channel full — escalate to DLQ immediately.
			w.sendToDLQ(ctx, record)
		}
		return
	}

	w.log.Info().
		Int("attempt", record.Attempts).
		Int("logs", len(record.Batch.Logs)).
		Msg("batch successfully retried")
}

func (w *Worker) sendToDLQ(ctx context.Context, record *domain.RetryRecord) {
	w.log.Error().
		Int("attempts", record.Attempts).
		Int("logs", len(record.Batch.Logs)).
		Err(record.LastErr).
		Msg("exhausted retries — sending to DLQ")

	if err := w.dlq.Write(ctx, record); err != nil {
		// DLQ write itself failed — log and drop (last resort).
		w.log.Error().Err(err).Msg("DLQ write failed — batch dropped")
		metrics.DLQEnqueuedTotal.Inc() // still count it as a DLQ event
	}
}

// backoffDelay computes: base * 2^(attempt-1) + random jitter up to 20% of the delay.
func backoffDelay(base time.Duration, attempt int) time.Duration {
	return BackoffDelay(base, attempt)
}

// BackoffDelay is the exported version of backoffDelay for use in tests.
func BackoffDelay(base time.Duration, attempt int) time.Duration {
	exp := math.Pow(2, float64(attempt-1))
	delay := time.Duration(float64(base) * exp)

	// Cap at 30 seconds.
	const maxDelay = 30 * time.Second
	if delay > maxDelay {
		delay = maxDelay
	}

	// Add ±20% jitter to prevent retry storms.
	jitter := time.Duration(rand.Float64() * 0.2 * float64(delay)) //nolint:gosec
	return delay + jitter
}
