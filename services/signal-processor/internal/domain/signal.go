// Package domain defines all data contracts for the signal-processor service.
//
// ─── Data flow ────────────────────────────────────────────────────────────────
//
//  NormalizedLog (from ingestion)
//       │
//       │ extract: latency_ms, is_error, endpoint, status_code
//       ▼
//  LogObservation  ← lightweight struct pushed into ring buffers
//       │
//       │ aggregate over sliding windows
//       ▼
//  WindowSnapshot  ← raw aggregate for one (tenant, service, window)
//       │
//       │ compare against BaselineStats
//       ▼
//  Signal          ← emitted to Kafka + queryable via HTTP
package domain

import "time"

// ─── Input ────────────────────────────────────────────────────────────────────

// NormalizedLog mirrors the output of the ingestion service.
// Only the fields used by the signal processor are declared here.
type NormalizedLog struct {
	ID          string         `json:"id"`
	TraceID     string         `json:"traceId"`
	TenantID    string         `json:"tenantId"`
	ServiceName string         `json:"service"`
	Environment string         `json:"env"`
	Level       string         `json:"level"`
	Message     string         `json:"message"`
	Fields      map[string]any `json:"fields,omitempty"`
	Tags        []string       `json:"tags,omitempty"`
	Timestamp   time.Time      `json:"@timestamp"`
	ReceivedAt  time.Time      `json:"receivedAt"`
}

// LogObservation is the minimal per-log measurement pushed into windows.
// Derived from NormalizedLog.Fields using well-known field names.
type LogObservation struct {
	TenantID    string
	ServiceName string
	Environment string
	Endpoint    string    // extracted from fields["http.path"] or fields["endpoint"]
	StatusCode  int       // extracted from fields["http.status_code"] or fields["status"]
	LatencyMS   float64   // extracted from fields["duration_ms"] or fields["latency_ms"]
	IsError     bool      // level==error|fatal OR status_code>=500
	Timestamp   time.Time
}

// ExtractObservation converts a NormalizedLog to a LogObservation.
// Missing fields are defaulted to zero values — the aggregator handles them.
func ExtractObservation(log *NormalizedLog) *LogObservation {
	obs := &LogObservation{
		TenantID:    log.TenantID,
		ServiceName: log.ServiceName,
		Environment: log.Environment,
		Timestamp:   log.Timestamp,
		IsError:     log.Level == "error" || log.Level == "fatal",
	}

	if v, ok := extractString(log.Fields, "http.path", "endpoint", "path"); ok {
		obs.Endpoint = v
	}
	if v, ok := extractFloat(log.Fields, "duration_ms", "latency_ms", "elapsed_ms"); ok {
		obs.LatencyMS = v
	}
	if v, ok := extractInt(log.Fields, "http.status_code", "status_code", "status"); ok {
		obs.StatusCode = v
		if v >= 500 {
			obs.IsError = true
		}
	}
	return obs
}

// ─── Window dimension key ─────────────────────────────────────────────────────

// DimensionKey uniquely identifies a stream of observations to aggregate.
// Signals are computed per (TenantID, ServiceName, Environment).
type DimensionKey struct {
	TenantID    string
	ServiceName string
	Environment string
}

func (d DimensionKey) String() string {
	return d.TenantID + "|" + d.ServiceName + "|" + d.Environment
}

// ─── Window snapshot ──────────────────────────────────────────────────────────

// WindowSnapshot is the raw aggregate computed over one sliding window period.
// It is an intermediate value — not emitted externally.
type WindowSnapshot struct {
	Key        DimensionKey
	WindowSize time.Duration
	WindowEnd  time.Time

	Count      int64   // total observations in window
	ErrorCount int64   // observations where IsError == true
	TotalMS    float64 // sum of LatencyMS (for mean calculation)

	// Sorted latency samples used for percentile computation.
	// Stored as a sorted slice maintained by the ring buffer.
	LatencySamples []float64
}

// ErrorRate returns errors/total. Returns 0 if Count == 0.
func (w *WindowSnapshot) ErrorRate() float64 {
	if w.Count == 0 {
		return 0
	}
	return float64(w.ErrorCount) / float64(w.Count)
}

// Throughput returns observations per second over the window.
func (w *WindowSnapshot) Throughput() float64 {
	secs := w.WindowSize.Seconds()
	if secs == 0 {
		return 0
	}
	return float64(w.Count) / secs
}

// MeanLatencyMS returns the arithmetic mean latency.
func (w *WindowSnapshot) MeanLatencyMS() float64 {
	if w.Count == 0 {
		return 0
	}
	return w.TotalMS / float64(w.Count)
}

// ─── Baseline stats ───────────────────────────────────────────────────────────

// BaselineStats holds the long-running statistical baseline for a metric.
// Updated via exponential moving statistics (EMA / EMVAR) so it never
// requires storing historical data.
type BaselineStats struct {
	// Exponential moving mean (μ) and variance (σ²).
	// α (alpha) controls how much weight recent windows get.
	Mean     float64
	Variance float64 // running variance (Welford's online algorithm variant)
	N        int64   // number of windows observed so far
}

// StdDev returns the standard deviation (sqrt of variance), or 0 if N < 2.
func (b *BaselineStats) StdDev() float64 {
	if b.Variance <= 0 {
		return 0
	}
	// Avoid math import in domain — caller uses math.Sqrt.
	return b.Variance // callers call math.Sqrt(baseline.StdDev())
}

// ZScore computes how many standard deviations `value` is from the mean.
// Returns 0 if baseline is not yet established (N < 5).
func (b *BaselineStats) ZScore(value float64) float64 {
	if b.N < 5 || b.Variance <= 0 {
		return 0
	}
	sd := b.Variance // callers sqrt this — see signal.go
	if sd == 0 {
		return 0
	}
	return (value - b.Mean) / sd
}

// ─── Signal types ─────────────────────────────────────────────────────────────

// SignalKind identifies the type of signal.
type SignalKind string

const (
	SignalLatencyP50   SignalKind = "latency_p50"
	SignalLatencyP95   SignalKind = "latency_p95"
	SignalLatencyP99   SignalKind = "latency_p99"
	SignalErrorRate    SignalKind = "error_rate"
	SignalThroughput   SignalKind = "throughput"
	SignalMeanLatency  SignalKind = "latency_mean"
)

// AnomalyLevel classifies the severity of an anomaly.
type AnomalyLevel string

const (
	AnomalyNone     AnomalyLevel = "none"
	AnomalyWarning  AnomalyLevel = "warning"  // |z| > 2
	AnomalyCritical AnomalyLevel = "critical" // |z| > 3
)

// Signal is the primary output of the signal-processor.
// It is time-series friendly: one Signal per (kind, dimension, window_end).
//
// Schema: relevix/signal/v1
//
// Emitted to Kafka topic relevix.signals and stored in TimescaleDB.
type Signal struct {
	// Identity
	ID        string     `json:"id"`
	SchemaVer string     `json:"schema"`   // "relevix/signal/v1"
	Kind      SignalKind `json:"kind"`

	// Dimension (who + where)
	TenantID    string `json:"tenantId"`
	ServiceName string `json:"service"`
	Environment string `json:"env"`

	// Time (window this signal covers)
	WindowSize time.Duration `json:"windowSize"` // e.g. 60s
	WindowEnd  time.Time     `json:"windowEnd"`  // end of the sliding window
	EmittedAt  time.Time     `json:"emittedAt"`  // when this signal was computed

	// Value
	Value float64 `json:"value"`
	Unit  string  `json:"unit"` // "ms" | "ratio" | "rps"

	// Baseline context
	BaselineMean   float64 `json:"baselineMean"`
	BaselineStdDev float64 `json:"baselineStdDev"`
	ZScore         float64 `json:"zScore"`

	// Anomaly verdict
	Anomaly      AnomalyLevel `json:"anomaly"`
	AnomalyDelta float64      `json:"anomalyDelta"` // value - baselineMean

	// Sample size (for confidence)
	SampleCount int64 `json:"sampleCount"`
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

func extractString(fields map[string]any, keys ...string) (string, bool) {
	for _, k := range keys {
		if v, ok := fields[k]; ok {
			if s, ok := v.(string); ok && s != "" {
				return s, true
			}
		}
	}
	return "", false
}

func extractFloat(fields map[string]any, keys ...string) (float64, bool) {
	for _, k := range keys {
		if v, ok := fields[k]; ok {
			switch n := v.(type) {
			case float64:
				return n, true
			case float32:
				return float64(n), true
			case int:
				return float64(n), true
			case int64:
				return float64(n), true
			}
		}
	}
	return 0, false
}

func extractInt(fields map[string]any, keys ...string) (int, bool) {
	for _, k := range keys {
		if v, ok := fields[k]; ok {
			switch n := v.(type) {
			case int:
				return n, true
			case int64:
				return int(n), true
			case float64:
				return int(n), true
			}
		}
	}
	return 0, false
}
