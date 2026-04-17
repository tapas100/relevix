package pipeline_test

import (
	"context"
	"testing"
	"time"

	"github.com/rs/zerolog"
	"github.com/tapas100/relevix/services/ingestion/internal/domain"
	"github.com/tapas100/relevix/services/ingestion/internal/pipeline"
)

// TestBatcher_SizeTrigger verifies that a batch is flushed when it reaches
// the configured size, without waiting for the timer.
func TestBatcher_SizeTrigger(t *testing.T) {
	in := make(chan *domain.NormalizedLog, 10)
	out := make(chan *domain.Batch, 5)
	log := zerolog.Nop()

	batcher := pipeline.NewBatcher(in, out, 3, 1*time.Second, log)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	go batcher.Run(ctx)

	// Send exactly batchSize logs.
	for range 3 {
		in <- &domain.NormalizedLog{ID: "x"}
	}

	select {
	case batch := <-out:
		if len(batch.Logs) != 3 {
			t.Errorf("want 3 logs, got %d", len(batch.Logs))
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timeout waiting for size-triggered flush")
	}
}

// TestBatcher_TimerTrigger verifies that a partial batch is flushed after the
// flush interval, even when it hasn't reached the size limit.
func TestBatcher_TimerTrigger(t *testing.T) {
	in := make(chan *domain.NormalizedLog, 10)
	out := make(chan *domain.Batch, 5)
	log := zerolog.Nop()

	batcher := pipeline.NewBatcher(in, out, 100, 50*time.Millisecond, log)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	go batcher.Run(ctx)

	// Send only 1 log — won't hit size limit.
	in <- &domain.NormalizedLog{ID: "y"}

	select {
	case batch := <-out:
		if len(batch.Logs) != 1 {
			t.Errorf("want 1 log, got %d", len(batch.Logs))
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("timeout waiting for timer-triggered flush")
	}
}

// TestBatcher_DrainOnCancel verifies that any buffered logs are flushed when
// ctx is cancelled.
func TestBatcher_DrainOnCancel(t *testing.T) {
	in := make(chan *domain.NormalizedLog, 10)
	out := make(chan *domain.Batch, 5)
	log := zerolog.Nop()

	batcher := pipeline.NewBatcher(in, out, 100, 10*time.Second, log)

	ctx, cancel := context.WithCancel(context.Background())

	done := make(chan struct{})
	go func() {
		batcher.Run(ctx)
		close(done)
	}()

	in <- &domain.NormalizedLog{ID: "z1"}
	in <- &domain.NormalizedLog{ID: "z2"}

	// Cancel context — batcher should drain remaining logs.
	cancel()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("batcher did not stop after context cancel")
	}

	select {
	case batch := <-out:
		if len(batch.Logs) != 2 {
			t.Errorf("want 2 drained logs, got %d", len(batch.Logs))
		}
	default:
		t.Error("expected a drain batch in output channel")
	}
}
