// Package window — WindowManager.
//
// WindowManager is the central coordinator. It:
//   1. Receives LogObservations from the pipeline.
//   2. Routes each observation to the correct RingBuffer
//      (keyed by DimensionKey = tenantId+service+env).
//   3. On each tick, snapshots every active buffer and emits
//      WindowSnapshots downstream to the aggregator.
//
// Memory model:
//   At most maxDimensions ring buffers exist simultaneously.
//   When the limit is reached, new dimensions are rejected with a metric.
//   This prevents unbounded memory growth from cardinality explosion.
package window

import (
	"context"
	"sync"
	"time"

	"github.com/rs/zerolog"
	"github.com/tapas100/relevix/services/signal-processor/internal/domain"
	"github.com/tapas100/relevix/services/signal-processor/internal/metrics"
)

const (
	defaultRingCapacity = 16_384 // per-dimension buffer size
	defaultMaxDimensions = 10_000
)

// Manager holds all ring buffers and drives the tick-based snapshot cycle.
type Manager struct {
	mu            sync.RWMutex
	buffers       map[string]*RingBuffer // key → DimensionKey.String()
	keys          map[string]domain.DimensionKey
	windowSize    time.Duration
	tickInterval  time.Duration
	ringCapacity  int
	maxDimensions int
	snapshotCh    chan<- *domain.WindowSnapshot
	log           zerolog.Logger
}

// NewManager creates a WindowManager.
//   windowSize   — duration of the sliding window (e.g. 60s)
//   tickInterval — how often to emit snapshots (e.g. 10s)
//   snapshotCh   — channel that receives WindowSnapshots for aggregation
func NewManager(
	windowSize time.Duration,
	tickInterval time.Duration,
	snapshotCh chan<- *domain.WindowSnapshot,
	log zerolog.Logger,
) *Manager {
	return &Manager{
		buffers:       make(map[string]*RingBuffer),
		keys:          make(map[string]domain.DimensionKey),
		windowSize:    windowSize,
		tickInterval:  tickInterval,
		ringCapacity:  defaultRingCapacity,
		maxDimensions: defaultMaxDimensions,
		snapshotCh:    snapshotCh,
		log:           log.With().Str("component", "window_manager").Logger(),
	}
}

// SetCapacity overrides the per-dimension ring buffer capacity and the maximum
// number of tracked dimensions.  Must be called before any observations arrive.
func (m *Manager) SetCapacity(ringCapacity, maxDimensions int) {
	m.mu.Lock()
	m.ringCapacity = ringCapacity
	m.maxDimensions = maxDimensions
	m.mu.Unlock()
}

// Push routes a LogObservation to the appropriate ring buffer.// It is safe to call from multiple goroutines concurrently.
func (m *Manager) Push(obs *domain.LogObservation) {
	key := domain.DimensionKey{
		TenantID:    obs.TenantID,
		ServiceName: obs.ServiceName,
		Environment: obs.Environment,
	}
	ks := key.String()

	m.mu.RLock()
	buf, exists := m.buffers[ks]
	m.mu.RUnlock()

	if !exists {
		m.mu.Lock()
		// Double-check after acquiring write lock.
		if buf, exists = m.buffers[ks]; !exists {
			if len(m.buffers) >= m.maxDimensions {
				m.mu.Unlock()
				metrics.DimensionLimitExceeded.Inc()
				m.log.Warn().
					Str("key", ks).
					Int("limit", m.maxDimensions).
					Msg("dimension limit reached — observation dropped")
				return
			}
			buf = NewRingBuffer(m.ringCapacity)
			m.buffers[ks] = buf
			m.keys[ks] = key
			metrics.ActiveDimensions.Set(float64(len(m.buffers)))
		}
		m.mu.Unlock()
	}

	buf.Push(obs)
	metrics.ObservationsBuffered.Inc()
}

// Run starts the tick loop. Blocks until ctx is cancelled.
func (m *Manager) Run(ctx context.Context) {
	ticker := time.NewTicker(m.tickInterval)
	defer ticker.Stop()

	m.log.Info().
		Dur("windowSize", m.windowSize).
		Dur("tickInterval", m.tickInterval).
		Msg("window manager started")

	for {
		select {
		case <-ctx.Done():
			m.log.Info().Msg("window manager stopped")
			return
		case t := <-ticker.C:
			m.emitSnapshots(t)
		}
	}
}

// emitSnapshots snapshots every active buffer and sends to snapshotCh.
func (m *Manager) emitSnapshots(now time.Time) {
	m.mu.RLock()
	// Copy the map to avoid holding the read lock during snapshot computation.
	type entry struct {
		buf *RingBuffer
		key domain.DimensionKey
	}
	entries := make([]entry, 0, len(m.buffers))
	for ks, buf := range m.buffers {
		entries = append(entries, entry{buf: buf, key: m.keys[ks]})
	}
	m.mu.RUnlock()

	for _, e := range entries {
		snap := e.buf.Snapshot(e.key, m.windowSize, now)
		if snap.Count == 0 {
			continue // skip empty windows — no signals to emit
		}
		select {
		case m.snapshotCh <- snap:
		default:
			// snapshotCh full — downstream aggregator is too slow.
			metrics.SnapshotDropped.Inc()
		}
	}
	metrics.TicksTotal.Inc()
}

// ActiveDimensionCount returns the number of tracked dimension keys.
func (m *Manager) ActiveDimensionCount() int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return len(m.buffers)
}
