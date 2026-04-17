// Package retry — test helpers.
// NewWorkerForTest creates a Worker without a real DLQWriter, for unit tests.
package retry

import (
	"context"
	"time"

	"github.com/rs/zerolog"
	"github.com/tapas100/relevix/services/ingestion/internal/domain"
	"github.com/tapas100/relevix/services/ingestion/internal/output"
)

// testRetryWriter wraps a Writer so we can pass the same bidirectional
// channel as both in and the re-enqueue target.
type testWorker struct {
	in          chan *domain.RetryRecord
	writer      output.Writer
	maxAttempts int
	baseDelay   time.Duration
	log         zerolog.Logger
}

// NewWorkerForTest creates a lightweight retry worker without a DLQ writer.
// Exhausted retries are silently dropped (acceptable for unit tests).
func NewWorkerForTest(
	in chan *domain.RetryRecord,
	writer output.Writer,
	log zerolog.Logger,
	maxAttempts int,
	baseDelay time.Duration,
) *testWorker {
	return &testWorker{
		in:          in,
		writer:      writer,
		maxAttempts: maxAttempts,
		baseDelay:   baseDelay,
		log:         log,
	}
}

func (w *testWorker) Run(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case record, ok := <-w.in:
			if !ok {
				return
			}
			if record.Attempts > w.maxAttempts {
				continue // drop — no real DLQ in tests
			}
			if delay := time.Until(record.NextAt); delay > 0 {
				select {
				case <-time.After(delay):
				case <-ctx.Done():
					return
				}
			}
			if err := w.writer.Write(ctx, record.Batch); err != nil {
				record.Attempts++
				record.LastErr = err
				record.NextAt = time.Now().Add(BackoffDelay(w.baseDelay, record.Attempts))
				select {
				case w.in <- record:
				default:
				}
			}
		}
	}
}
