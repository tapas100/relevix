// Package precompute — Prometheus metrics.
//
// All metrics use the "relevix_precompute_" prefix and are registered on the
// default Prometheus registry so they appear alongside chi middleware metrics
// already used in the rule-engine HTTP server.
package precompute

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

// Metrics holds all Prometheus instruments for the precompute subsystem.
// A single instance is shared across all workers and the scheduler.
type Metrics struct {
	// CycleDuration tracks the end-to-end wall-clock time of a full scheduler
	// cycle (all tenants processed), in milliseconds.
	CycleDuration prometheus.Histogram

	// WorkerDuration tracks per-tenant compute time in milliseconds.
	WorkerDuration *prometheus.HistogramVec

	// LockSkipsTotal counts the number of times a worker skipped a tenant
	// because another replica/goroutine already held the Redis SETNX lock.
	LockSkipsTotal prometheus.Counter

	// ErrorsTotal counts worker-level errors by kind.
	ErrorsTotal *prometheus.CounterVec

	// CacheHitsTotal counts calls to ReadResult that returned a non-nil cached
	// result (used by the query handler).
	CacheHitsTotal prometheus.Counter

	// CacheMissesTotal counts calls to ReadResult that returned nil.
	CacheMissesTotal prometheus.Counter

	// SignalsProcessed counts the total number of EvalContexts evaluated
	// across all tenants and cycles.
	SignalsProcessed prometheus.Counter

	// InsightsEmitted counts the total number of ranked insights written to
	// Redis across all cycles.
	InsightsEmitted prometheus.Counter

	// TenantsActive is a gauge reflecting the current size of the tenant SET.
	TenantsActive prometheus.Gauge
}

// NewMetrics creates and registers all Prometheus instruments.
// Calling this more than once in the same process will panic (duplicate
// registration); construct a single instance in main.go and pass it around.
func NewMetrics() *Metrics {
	return &Metrics{
		CycleDuration: promauto.NewHistogram(prometheus.HistogramOpts{
			Name:    "relevix_precompute_cycle_duration_ms",
			Help:    "Wall-clock time for one full precompute cycle across all tenants (ms).",
			Buckets: prometheus.ExponentialBuckets(50, 2, 10), // 50ms … ~25s
		}),
		WorkerDuration: promauto.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "relevix_precompute_worker_duration_ms",
			Help:    "Per-tenant compute time in milliseconds.",
			Buckets: prometheus.ExponentialBuckets(10, 2, 10), // 10ms … ~5s
		}, []string{"tenant_id"}),
		LockSkipsTotal: promauto.NewCounter(prometheus.CounterOpts{
			Name: "relevix_precompute_lock_skips_total",
			Help: "Number of times a worker was skipped due to an existing Redis lock.",
		}),
		ErrorsTotal: promauto.NewCounterVec(prometheus.CounterOpts{
			Name: "relevix_precompute_errors_total",
			Help: "Worker errors by kind (fetch|rules|eval|store|lock).",
		}, []string{"kind"}),
		CacheHitsTotal: promauto.NewCounter(prometheus.CounterOpts{
			Name: "relevix_precompute_cache_hits_total",
			Help: "Number of ReadResult calls that returned a cached result.",
		}),
		CacheMissesTotal: promauto.NewCounter(prometheus.CounterOpts{
			Name: "relevix_precompute_cache_misses_total",
			Help: "Number of ReadResult calls that returned a cache miss.",
		}),
		SignalsProcessed: promauto.NewCounter(prometheus.CounterOpts{
			Name: "relevix_precompute_signals_processed_total",
			Help: "Total EvalContexts evaluated across all precompute cycles.",
		}),
		InsightsEmitted: promauto.NewCounter(prometheus.CounterOpts{
			Name: "relevix_precompute_insights_emitted_total",
			Help: "Total ranked insights written to Redis across all cycles.",
		}),
		TenantsActive: promauto.NewGauge(prometheus.GaugeOpts{
			Name: "relevix_precompute_tenants_active",
			Help: "Current number of tenants registered for precomputation.",
		}),
	}
}

// RecordCycleDuration is a helper so callers don't need to import prometheus.
func (m *Metrics) RecordCycleDuration(ms int64) {
	m.CycleDuration.Observe(float64(ms))
}

// RecordWorkerDuration records per-tenant duration.
func (m *Metrics) RecordWorkerDuration(tenantID string, ms int64) {
	m.WorkerDuration.WithLabelValues(tenantID).Observe(float64(ms))
}

// IncError increments the error counter for kind (fetch|rules|eval|store|lock).
func (m *Metrics) IncError(kind string) {
	m.ErrorsTotal.WithLabelValues(kind).Inc()
}
