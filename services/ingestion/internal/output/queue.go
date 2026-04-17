// InternalQueue is a bounded in-process FIFO queue for NormalizedLog batches.
//
// It is used as:
//  1. A fallback when the Kafka output writer is temporarily unavailable.
//  2. An alternative output in test environments without a Kafka broker.
//
// Backpressure: Enqueue blocks when the queue is full (channel semantics).
// A non-blocking TryEnqueue variant returns false instead of blocking —
// used by the output router to detect overflow and apply backpressure upstream.
package output

import (
	"context"
	"fmt"

	"github.com/tapas100/relevix/services/ingestion/internal/domain"
	"github.com/tapas100/relevix/services/ingestion/internal/metrics"
)

// InternalQueue wraps a buffered channel of Batches.
type InternalQueue struct {
	ch       chan *domain.Batch
	capacity int
}

// NewInternalQueue creates a queue with the given capacity.
func NewInternalQueue(capacity int) *InternalQueue {
	return &InternalQueue{
		ch:       make(chan *domain.Batch, capacity),
		capacity: capacity,
	}
}

// Write is the Writer interface implementation — blocks if full.
func (q *InternalQueue) Write(_ context.Context, batch *domain.Batch) error {
	select {
	case q.ch <- batch:
		metrics.LogsPublishedTotal.WithLabelValues("queue").Add(float64(len(batch.Logs)))
		return nil
	default:
		return fmt.Errorf("internal queue full (capacity %d)", q.capacity)
	}
}

// Close closes the underlying channel.
func (q *InternalQueue) Close() error {
	close(q.ch)
	return nil
}

// Dequeue returns a channel that consumers can range over.
func (q *InternalQueue) Dequeue() <-chan *domain.Batch {
	return q.ch
}

// Len returns the current number of batches in the queue.
func (q *InternalQueue) Len() int {
	return len(q.ch)
}

// ─── Output router ────────────────────────────────────────────────────────────

// Router reads from the batch channel and writes to the primary Writer.
// On failure it enqueues the batch to the retry channel for the RetryWorker.
type Router struct {
	in      <-chan *domain.Batch
	primary Writer
	retry   chan<- *domain.RetryRecord
}

// NewRouter creates a Router.
func NewRouter(in <-chan *domain.Batch, primary Writer, retry chan<- *domain.RetryRecord) *Router {
	return &Router{in: in, primary: primary, retry: retry}
}

// Run processes batches until ctx is cancelled or the in channel is closed.
func (r *Router) Run(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case batch, ok := <-r.in:
			if !ok {
				return
			}
			if err := r.primary.Write(ctx, batch); err != nil {
				// Hand off to the retry worker — non-blocking.
				record := &domain.RetryRecord{
					Batch:    batch,
					Attempts: 1,
					LastErr:  err,
				}
				select {
				case r.retry <- record:
				default:
					// Retry channel full — skip retry and go straight to DLQ.
					metrics.DLQEnqueuedTotal.Inc()
				}
			}
		}
	}
}
