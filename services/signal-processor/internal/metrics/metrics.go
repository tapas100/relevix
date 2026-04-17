// Package metrics defines all Prometheus metrics for the signal-processor.
package metrics

import "github.com/prometheus/client_golang/prometheus"

var (
	// ── intake ──────────────────────────────────────────────────────────────
	LogsConsumed = prometheus.NewCounter(prometheus.CounterOpts{
		Namespace: "signal_processor",
		Name:      "logs_consumed_total",
		Help:      "Total NormalizedLog messages consumed from Kafka.",
	})
	LogsSkipped = prometheus.NewCounter(prometheus.CounterOpts{
		Namespace: "signal_processor",
		Name:      "logs_skipped_total",
		Help:      "Messages skipped due to unmarshal errors.",
	})

	// ── window manager ──────────────────────────────────────────────────────
	ActiveDimensions = prometheus.NewGauge(prometheus.GaugeOpts{
		Namespace: "signal_processor",
		Name:      "active_dimensions",
		Help:      "Number of active (tenant, service, env) dimension keys.",
	})
	DimensionLimitExceeded = prometheus.NewCounter(prometheus.CounterOpts{
		Namespace: "signal_processor",
		Name:      "dimension_limit_exceeded_total",
		Help:      "Observations dropped because max_dimensions was reached.",
	})
	ObservationsBuffered = prometheus.NewCounter(prometheus.CounterOpts{
		Namespace: "signal_processor",
		Name:      "observations_buffered_total",
		Help:      "Total observations written into ring buffers.",
	})
	SnapshotDropped = prometheus.NewCounter(prometheus.CounterOpts{
		Namespace: "signal_processor",
		Name:      "snapshot_dropped_total",
		Help:      "Snapshots dropped because the downstream channel was full.",
	})
	TicksTotal = prometheus.NewCounter(prometheus.CounterOpts{
		Namespace: "signal_processor",
		Name:      "window_ticks_total",
		Help:      "Number of window emission ticks.",
	})

	// ── aggregator ──────────────────────────────────────────────────────────
	SignalsEmitted = prometheus.NewCounterVec(prometheus.CounterOpts{
		Namespace: "signal_processor",
		Name:      "signals_emitted_total",
		Help:      "Signals emitted, labelled by kind and anomaly level.",
	}, []string{"kind", "anomaly"})
	SignalsDropped = prometheus.NewCounterVec(prometheus.CounterOpts{
		Namespace: "signal_processor",
		Name:      "signals_dropped_total",
		Help:      "Signals dropped because the output channel was full.",
	}, []string{"kind"})
	AggregationDuration = prometheus.NewHistogram(prometheus.HistogramOpts{
		Namespace: "signal_processor",
		Name:      "aggregation_duration_seconds",
		Help:      "Time spent computing signals from a single snapshot.",
		Buckets:   prometheus.DefBuckets,
	})

	// ── output ──────────────────────────────────────────────────────────────
	SignalsWritten = prometheus.NewCounterVec(prometheus.CounterOpts{
		Namespace: "signal_processor",
		Name:      "signals_written_total",
		Help:      "Signals successfully written to Kafka.",
	}, []string{"kind"})
	SignalWriteErrors = prometheus.NewCounter(prometheus.CounterOpts{
		Namespace: "signal_processor",
		Name:      "signal_write_errors_total",
		Help:      "Errors writing signals to Kafka.",
	})
)

func init() {
	prometheus.MustRegister(
		LogsConsumed,
		LogsSkipped,
		ActiveDimensions,
		DimensionLimitExceeded,
		ObservationsBuffered,
		SnapshotDropped,
		TicksTotal,
		SignalsEmitted,
		SignalsDropped,
		AggregationDuration,
		SignalsWritten,
		SignalWriteErrors,
	)
}
