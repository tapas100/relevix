// Package window implements the sliding window ring buffer.
//
// Design: fixed-size circular buffer of LogObservations, keyed by time bucket.
//
// Why a ring buffer over a heap or sorted list?
//   - O(1) insertions — no sorting during write, critical at 10k obs/s.
//   - O(n) snapshot — one pass over the buffer to collect the window's data.
//   - Fixed memory — no unbounded growth regardless of throughput.
//   - Eviction is implicit — old slots are overwritten by the ring pointer.
//
// Percentile calculation uses T-Digest for accuracy with low memory (~50 bytes
// per centroid). We implement a simple sorted-sample approach here since
// our ring buffer has a fixed max size (e.g. 10,000 samples per window),
// which keeps it dependency-free and predictable.
package window

import (
	"sort"
	"sync"
	"time"

	"github.com/tapas100/relevix/services/signal-processor/internal/domain"
)

// RingBuffer is a fixed-capacity circular store of LogObservations.
// It is goroutine-safe via a single mutex — at 10k inserts/s the lock
// contention per key is negligible since keys are per-(tenant, service).
type RingBuffer struct {
	mu       sync.Mutex
	buf      []*domain.LogObservation
	capacity int
	head     int  // next write position
	size     int  // current number of entries (≤ capacity)
}

// NewRingBuffer creates a buffer with the given capacity.
// capacity should be: windowDuration / expectedInterval * safetyFactor
// e.g. 60s window at 100 obs/s = 6,000 → use 8,192 (next power of 2).
func NewRingBuffer(capacity int) *RingBuffer {
	return &RingBuffer{
		buf:      make([]*domain.LogObservation, capacity),
		capacity: capacity,
	}
}

// Push adds an observation to the buffer.
// If the buffer is full, the oldest entry is overwritten (LRU eviction).
func (r *RingBuffer) Push(obs *domain.LogObservation) {
	r.mu.Lock()
	r.buf[r.head] = obs
	r.head = (r.head + 1) % r.capacity
	if r.size < r.capacity {
		r.size++
	}
	r.mu.Unlock()
}

// Snapshot collects all observations within [windowStart, windowEnd]
// and returns a WindowSnapshot. Observations outside the time range are
// ignored — this is what makes it a "sliding" window.
func (r *RingBuffer) Snapshot(
	key domain.DimensionKey,
	windowSize time.Duration,
	windowEnd time.Time,
) *domain.WindowSnapshot {
	windowStart := windowEnd.Add(-windowSize)

	r.mu.Lock()
	size := r.size
	buf := make([]*domain.LogObservation, size)
	// Walk the ring from oldest → newest.
	for i := range size {
		idx := (r.head - size + i + r.capacity) % r.capacity
		buf[i] = r.buf[idx]
	}
	r.mu.Unlock()

	snap := &domain.WindowSnapshot{
		Key:            key,
		WindowSize:     windowSize,
		WindowEnd:      windowEnd,
		LatencySamples: make([]float64, 0, size),
	}

	for _, obs := range buf {
		if obs == nil {
			continue
		}
		if obs.Timestamp.Before(windowStart) || obs.Timestamp.After(windowEnd) {
			continue
		}
		snap.Count++
		if obs.IsError {
			snap.ErrorCount++
		}
		if obs.LatencyMS > 0 {
			snap.TotalMS += obs.LatencyMS
			snap.LatencySamples = append(snap.LatencySamples, obs.LatencyMS)
		}
	}

	// Sort samples for percentile calculation.
	sort.Float64s(snap.LatencySamples)
	return snap
}

// Len returns the current number of buffered observations.
func (r *RingBuffer) Len() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.size
}

// ─── Percentile calculation ───────────────────────────────────────────────────

// Percentile computes the p-th percentile (0–100) of a sorted float64 slice.
// Uses the "nearest rank" method — no interpolation, consistent with most
// monitoring systems (Prometheus, Datadog).
//
// Returns 0 if samples is empty.
func Percentile(sorted []float64, p float64) float64 {
	n := len(sorted)
	if n == 0 {
		return 0
	}
	if p <= 0 {
		return sorted[0]
	}
	if p >= 100 {
		return sorted[n-1]
	}
	// Nearest rank formula: ceil(p/100 * n) - 1
	rank := int(p/100*float64(n)+0.5) - 1
	if rank < 0 {
		rank = 0
	}
	if rank >= n {
		rank = n - 1
	}
	return sorted[rank]
}
