// Package baseline implements incremental statistical baseline tracking
// using Welford's online algorithm.
//
// Why Welford's?
//   - Numerically stable (no catastrophic cancellation at large N).
//   - O(1) memory — never stores historical windows.
//   - Single-pass — one update per emitted window snapshot.
//
// The tracker maintains one BaselineStats per (DimensionKey, SignalKind),
// updated after every window tick. After a warm-up period (N ≥ 5 windows),
// the baseline is considered established and anomaly detection activates.
//
// Alpha (EMA weight) controls recency bias:
//   α = 0.1  → slow adaptation (90-window half-life) — good for stable services
//   α = 0.3  → fast adaptation (7-window half-life)  — good for bursty services
//
// We use a hybrid: pure Welford until N=30 (bootstrap), then EMA-weighted
// Welford for online adaptation.
package baseline

import (
	"math"
	"sync"

	"github.com/tapas100/relevix/services/signal-processor/internal/domain"
)

const (
	// alpha is the EMA weight for the exponential moving baseline.
	// 0.1 = adapts slowly, weights ~last 20 windows heavily.
	alpha = 0.1

	// bootstrapN is the number of windows before EMA kicks in.
	bootstrapN = 30
)

// trackerKey indexes baseline stats per (dimension, signal kind).
type trackerKey struct {
	dim  domain.DimensionKey
	kind domain.SignalKind
}

// Tracker maintains BaselineStats for every (dimension, signal) pair.
// It is goroutine-safe.
type Tracker struct {
	mu    sync.RWMutex
	stats map[trackerKey]*domain.BaselineStats
}

// NewTracker creates an empty Tracker.
func NewTracker() *Tracker {
	return &Tracker{
		stats: make(map[trackerKey]*domain.BaselineStats),
	}
}

// Update incorporates a new observed value into the baseline for (dim, kind).
// Returns the updated BaselineStats (a copy — not a pointer to internal state).
func (t *Tracker) Update(dim domain.DimensionKey, kind domain.SignalKind, value float64) domain.BaselineStats {
	k := trackerKey{dim: dim, kind: kind}

	t.mu.Lock()
	defer t.mu.Unlock()

	s, exists := t.stats[k]
	if !exists {
		s = &domain.BaselineStats{}
		t.stats[k] = s
	}

	s.N++

	if s.N <= bootstrapN {
		// ── Welford's online mean and variance (bootstrap phase) ──────────────
		// M₂ accumulates sum of squared deviations.
		// On first call: mean = value, M2 = 0.
		delta := value - s.Mean
		s.Mean += delta / float64(s.N)
		delta2 := value - s.Mean
		// s.Variance holds M2 (sum of squared deviations) during bootstrap.
		s.Variance += delta * delta2
	} else {
		// ── EMA-weighted Welford (online adaptation phase) ─────────────────
		// Converts accumulated M2 to population variance before switching.
		if s.N == bootstrapN+1 {
			s.Variance = s.Variance / float64(bootstrapN-1) // sample variance
		}
		prevMean := s.Mean
		s.Mean = alpha*value + (1-alpha)*s.Mean
		// EMA variance update using the new and old means.
		diff := value - prevMean
		s.Variance = (1-alpha)*s.Variance + alpha*diff*diff
	}

	return *s
}

// Get returns the current baseline stats for (dim, kind), or zero value if
// not yet established.
func (t *Tracker) Get(dim domain.DimensionKey, kind domain.SignalKind) (domain.BaselineStats, bool) {
	k := trackerKey{dim: dim, kind: kind}
	t.mu.RLock()
	defer t.mu.RUnlock()
	if s, ok := t.stats[k]; ok {
		return *s, true
	}
	return domain.BaselineStats{}, false
}

// ─── Z-score and anomaly classification ──────────────────────────────────────

// ZScore returns the Z-score of value against the baseline.
// Returns 0 if baseline is not yet established (N < 5).
func ZScore(bs domain.BaselineStats, value float64) float64 {
	if bs.N < 5 {
		return 0
	}
	sd := StdDev(bs)
	if sd == 0 {
		return 0
	}
	return (value - bs.Mean) / sd
}

// StdDev computes the standard deviation from BaselineStats.
// During bootstrap (N ≤ bootstrapN), Variance holds M2, so we compute
// sample std dev. After bootstrap, Variance is already the EMA variance.
func StdDev(bs domain.BaselineStats) float64 {
	if bs.N < 2 {
		return 0
	}
	var variance float64
	if bs.N <= bootstrapN {
		variance = bs.Variance / float64(bs.N-1) // sample variance from M2
	} else {
		variance = bs.Variance // already EMA variance
	}
	if variance <= 0 {
		return 0
	}
	return math.Sqrt(variance)
}

// ClassifyAnomaly returns the AnomalyLevel for a given Z-score.
//
//	|z| ≤ 2.0  → none     (within ~95% of normal distribution)
//	|z| ≤ 3.0  → warning  (within ~99.7%)
//	|z| > 3.0  → critical (tail event, statistically improbable)
func ClassifyAnomaly(z float64) domain.AnomalyLevel {
	absZ := math.Abs(z)
	switch {
	case absZ > 3.0:
		return domain.AnomalyCritical
	case absZ > 2.0:
		return domain.AnomalyWarning
	default:
		return domain.AnomalyNone
	}
}
