package window_test

import (
	"testing"
	"time"

	"github.com/tapas100/relevix/services/signal-processor/internal/domain"
	"github.com/tapas100/relevix/services/signal-processor/internal/window"
)

func obs(latencyMS float64, ts time.Time) *domain.LogObservation {
	return &domain.LogObservation{
		TenantID:    "t1",
		ServiceName: "svc",
		Environment: "test",
		LatencyMS:   latencyMS,
		Timestamp:   ts,
	}
}

func TestRingBuffer_Push_Snapshot(t *testing.T) {
	rb := window.NewRingBuffer(4)
	now := time.Now()

	for _, ms := range []float64{10, 20, 30, 40} {
		rb.Push(obs(ms, now))
	}

	key := domain.DimensionKey{TenantID: "t1", ServiceName: "svc", Environment: "test"}
	snap := rb.Snapshot(key, time.Minute, now.Add(time.Second))

	if snap.Count != 4 {
		t.Fatalf("want Count=4, got %d", snap.Count)
	}
	if len(snap.LatencySamples) != 4 {
		t.Fatalf("want 4 latency samples, got %d", len(snap.LatencySamples))
	}
}

func TestRingBuffer_Overflow(t *testing.T) {
	rb := window.NewRingBuffer(3)
	now := time.Now()

	// push 5 observations into a capacity-3 buffer
	for i := 1; i <= 5; i++ {
		rb.Push(obs(float64(i*10), now))
	}

	key := domain.DimensionKey{TenantID: "t1", ServiceName: "svc", Environment: "test"}
	snap := rb.Snapshot(key, time.Minute, now.Add(time.Second))

	// only 3 most-recent should survive
	if snap.Count != 3 {
		t.Fatalf("want Count=3, got %d", snap.Count)
	}
}

func TestRingBuffer_WindowFiltering(t *testing.T) {
	rb := window.NewRingBuffer(10)
	now := time.Now()
	old := now.Add(-2 * time.Minute)

	rb.Push(obs(100, old)) // outside window
	rb.Push(obs(10, now))  // inside
	rb.Push(obs(20, now))  // inside

	key := domain.DimensionKey{TenantID: "t1", ServiceName: "svc", Environment: "test"}
	snap := rb.Snapshot(key, time.Minute, now.Add(time.Second))

	if snap.Count != 2 {
		t.Fatalf("want Count=2 (old obs filtered), got %d", snap.Count)
	}
}

func TestPercentile(t *testing.T) {
	sorted := []float64{1, 2, 3, 4, 5, 6, 7, 8, 9, 10}

	p50 := window.Percentile(sorted, 50)
	if p50 != 5 {
		t.Errorf("p50: want 5, got %v", p50)
	}

	p95 := window.Percentile(sorted, 95)
	if p95 != 10 {
		t.Errorf("p95: want 10, got %v", p95)
	}

	// single element
	p99 := window.Percentile([]float64{42}, 99)
	if p99 != 42 {
		t.Errorf("single element p99: want 42, got %v", p99)
	}
}

func TestPercentile_Empty(t *testing.T) {
	if got := window.Percentile(nil, 95); got != 0 {
		t.Errorf("empty: want 0, got %v", got)
	}
}
