// Package metrics registers and exposes all Prometheus metrics for the
// ingestion service. All variables are package-level singletons,
// registered once at init time.
//
// Naming convention:  relevix_ingestion_<subsystem>_<name>_<unit>
package metrics

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

// ─── Intake ───────────────────────────────────────────────────────────────────

// LogsReceivedTotal counts raw logs accepted by the intake layer.
var LogsReceivedTotal = promauto.NewCounterVec(
	prometheus.CounterOpts{
		Namespace: "relevix",
		Subsystem: "ingestion",
		Name:      "logs_received_total",
		Help:      "Total number of raw logs received, partitioned by source (http|kafka).",
	},
	[]string{"source", "tenant_id"},
)

// LogsRejectedTotal counts logs rejected at the intake (validation / backpressure).
var LogsRejectedTotal = promauto.NewCounterVec(
	prometheus.CounterOpts{
		Namespace: "relevix",
		Subsystem: "ingestion",
		Name:      "logs_rejected_total",
		Help:      "Total number of logs rejected at intake.",
	},
	[]string{"source", "reason"},
)

// IntakeChannelUtilization tracks the current fill level of the intake channel.
var IntakeChannelUtilization = promauto.NewGauge(
	prometheus.GaugeOpts{
		Namespace: "relevix",
		Subsystem: "ingestion",
		Name:      "intake_channel_utilization_ratio",
		Help:      "Fill ratio of the intake channel (0.0–1.0). At 1.0 backpressure kicks in.",
	},
)

// ─── Pipeline ─────────────────────────────────────────────────────────────────

// NormalizeDurationSeconds measures normalization latency per log.
var NormalizeDurationSeconds = promauto.NewHistogram(
	prometheus.HistogramOpts{
		Namespace: "relevix",
		Subsystem: "ingestion",
		Name:      "normalize_duration_seconds",
		Help:      "Time spent normalizing a single log.",
		Buckets:   []float64{.0001, .0005, .001, .005, .01, .025, .05},
	},
)

// BatchesFlushedTotal counts batches sent to the output layer.
var BatchesFlushedTotal = promauto.NewCounterVec(
	prometheus.CounterOpts{
		Namespace: "relevix",
		Subsystem: "ingestion",
		Name:      "batches_flushed_total",
		Help:      "Total number of batches flushed to output.",
	},
	[]string{"trigger"}, // "size" | "timer"
)

// BatchSizeLogs tracks how many logs are in each flushed batch.
var BatchSizeLogs = promauto.NewHistogram(
	prometheus.HistogramOpts{
		Namespace: "relevix",
		Subsystem: "ingestion",
		Name:      "batch_size_logs",
		Help:      "Number of logs per flushed batch.",
		Buckets:   prometheus.LinearBuckets(10, 10, 25),
	},
)

// OutputChannelUtilization tracks the output channel fill level.
var OutputChannelUtilization = promauto.NewGauge(
	prometheus.GaugeOpts{
		Namespace: "relevix",
		Subsystem: "ingestion",
		Name:      "output_channel_utilization_ratio",
		Help:      "Fill ratio of the output channel (0.0–1.0).",
	},
)

// ─── Output ───────────────────────────────────────────────────────────────────

// LogsPublishedTotal counts normalized logs successfully published to output.
var LogsPublishedTotal = promauto.NewCounterVec(
	prometheus.CounterOpts{
		Namespace: "relevix",
		Subsystem: "ingestion",
		Name:      "logs_published_total",
		Help:      "Total number of normalized logs published to output.",
	},
	[]string{"destination"}, // "kafka" | "queue"
)

// PublishDurationSeconds measures how long a batch write takes.
var PublishDurationSeconds = promauto.NewHistogramVec(
	prometheus.HistogramOpts{
		Namespace: "relevix",
		Subsystem: "ingestion",
		Name:      "publish_duration_seconds",
		Help:      "Time to publish one batch to the output destination.",
		Buckets:   []float64{.001, .005, .01, .025, .05, .1, .25, .5, 1},
	},
	[]string{"destination"},
)

// ─── Retry / DLQ ─────────────────────────────────────────────────────────────

// RetryAttemptsTotal counts retry attempts.
var RetryAttemptsTotal = promauto.NewCounterVec(
	prometheus.CounterOpts{
		Namespace: "relevix",
		Subsystem: "ingestion",
		Name:      "retry_attempts_total",
		Help:      "Total number of output retry attempts.",
	},
	[]string{"attempt_number"},
)

// DLQEnqueuedTotal counts batches sent to the dead-letter queue.
var DLQEnqueuedTotal = promauto.NewCounter(
	prometheus.CounterOpts{
		Namespace: "relevix",
		Subsystem: "ingestion",
		Name:      "dlq_enqueued_total",
		Help:      "Total number of batches sent to the dead-letter queue after exhausting retries.",
	},
)
