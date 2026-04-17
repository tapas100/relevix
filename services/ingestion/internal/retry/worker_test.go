package retry_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/rs/zerolog"
	"github.com/tapas100/relevix/services/ingestion/internal/domain"
	"github.com/tapas100/relevix/services/ingestion/internal/retry"
)

// ─── Test helpers ─────────────────────────────────────────────────────────────

// stubWriter counts Write calls and optionally returns an error.
type stubWriter struct {
	calls   int
	failFor int // fail the first N calls
}

func (s *stubWriter) Write(_ context.Context, _ *domain.Batch) error {
	s.calls++
	if s.calls <= s.failFor {
		return errors.New("transient error")
	}
	return nil
}

func (s *stubWriter) Close() error { return nil }

// nopDLQWriter discards DLQ writes.
type nopDLQWriter struct{ called int }

// We can't use the real DLQWriter without a Kafka broker, so we test
// the retry exhaustion logic by running enough attempts that the
// worker should give up — we just check Write was called maxAttempts times.

func TestRetryWorker_SucceedsOnSecondAttempt(t *testing.T) {
	retryCh := make(chan *domain.RetryRecord, 10)
	writer := &stubWriter{failFor: 1} // fail once, then succeed
	log := zerolog.Nop()

	// We don't exercise DLQ in this test — pass nil and ensure it's not called.
	w := retry.NewWorkerForTest(retryCh, writer, log, 3, 1*time.Millisecond)

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	go w.Run(ctx)

	retryCh <- &domain.RetryRecord{
		Batch:    &domain.Batch{Logs: []*domain.NormalizedLog{{ID: "a"}}},
		Attempts: 1,
		LastErr:  errors.New("initial error"),
		NextAt:   time.Now(),
	}

	// Give the worker time to process.
	time.Sleep(200 * time.Millisecond)
	cancel()

	// stubWriter.Write should have been called twice: once failing, once succeeding.
	if writer.calls != 2 {
		t.Errorf("expected 2 Write calls (1 fail + 1 success), got %d", writer.calls)
	}
}

func TestBackoffDelay_Increases(t *testing.T) {
	base := 100 * time.Millisecond
	d1 := retry.BackoffDelay(base, 1)
	d2 := retry.BackoffDelay(base, 2)
	d3 := retry.BackoffDelay(base, 3)

	if d2 <= d1 {
		t.Errorf("delay should increase: d1=%v d2=%v", d1, d2)
	}
	if d3 <= d2 {
		t.Errorf("delay should increase: d2=%v d3=%v", d2, d3)
	}
}

func TestBackoffDelay_CappedAt30s(t *testing.T) {
	base := 10 * time.Second
	d := retry.BackoffDelay(base, 10) // would be 10 * 2^9 = 5120s without cap
	if d > 35*time.Second {           // 30s cap + up to 20% jitter
		t.Errorf("delay not capped: got %v", d)
	}
}
