// Package domain defines the core data model for the ingestion service.
package domain

import "time"

// ─── Raw ingest types (HTTP / Kafka input) ────────────────────────────────────

// EventSchema is the versioned schema identifier for ingested events.
type EventSchema string

const EventSchemaV1 EventSchema = "relevix/event/v1"

// LogSource describes where the log originated.
type LogSource string

const (
	SourceHTTP  LogSource = "http"
	SourceKafka LogSource = "kafka"
)

// LogLevel represents a standard severity level.
type LogLevel string

const (
	LevelTrace   LogLevel = "trace"
	LevelDebug   LogLevel = "debug"
	LevelInfo    LogLevel = "info"
	LevelWarn    LogLevel = "warn"
	LevelError   LogLevel = "error"
	LevelFatal   LogLevel = "fatal"
	LevelUnknown LogLevel = "unknown"
)

// ParseLogLevel normalises a raw string to a LogLevel.
func ParseLogLevel(s string) LogLevel {
	switch s {
	case "trace", "TRACE":
		return LevelTrace
	case "debug", "DEBUG":
		return LevelDebug
	case "info", "INFO", "information", "INFORMATION":
		return LevelInfo
	case "warn", "WARN", "warning", "WARNING":
		return LevelWarn
	case "error", "ERROR", "err", "ERR":
		return LevelError
	case "fatal", "FATAL", "critical", "CRITICAL":
		return LevelFatal
	default:
		return LevelUnknown
	}
}

// RawLog is the wire-format event accepted from HTTP and Kafka sources.
// It is intentionally loose — normalization happens in the pipeline.
type RawLog struct {
	// Required
	TenantID string `json:"tenantId" validate:"required"`
	Message  string `json:"message"  validate:"required"`

	// Optional — normalized/defaulted if missing
	Level       string         `json:"level,omitempty"`
	ServiceName string         `json:"service,omitempty"`
	TraceID     string         `json:"traceId,omitempty"`
	Timestamp   *time.Time     `json:"timestamp,omitempty"` // nil → use ReceivedAt
	Fields      map[string]any `json:"fields,omitempty"`
	Tags        []string       `json:"tags,omitempty"`

	// Set by intake layer — not accepted from callers
	Source     LogSource `json:"-"`
	ReceivedAt time.Time `json:"-"`
}

// BatchRequest is the HTTP request body for the batch ingest endpoint.
type BatchRequest struct {
	Logs []RawLog `json:"logs" validate:"required,min=1,max=500,dive"`
}

// BatchResponse is returned after a batch is submitted.
type BatchResponse struct {
	Accepted   int         `json:"accepted"`
	Rejected   int         `json:"rejected"`
	Rejections []Rejection `json:"rejections"`
}

// Rejection describes a single log that could not be accepted.
type Rejection struct {
	Index  int    `json:"index"`
	Reason string `json:"reason"`
}

// ─── Normalized output ────────────────────────────────────────────────────────

// NormalizedLog is the canonical internal representation produced by the
// normalization pipeline. All downstream consumers (Kafka output, queue)
// work exclusively with this type.
type NormalizedLog struct {
	ID          string         `json:"id"`
	TraceID     string         `json:"traceId"`
	TenantID    string         `json:"tenantId"`
	ServiceName string         `json:"service"`
	Environment string         `json:"env"`
	Level       LogLevel       `json:"level"`
	Message     string         `json:"message"`
	Fields      map[string]any `json:"fields,omitempty"`
	Tags        []string       `json:"tags,omitempty"`
	Timestamp   time.Time      `json:"@timestamp"`
	ReceivedAt  time.Time      `json:"receivedAt"`
	Source      LogSource      `json:"source"`
	SchemaVer   string         `json:"schema"`
}

// ─── Pipeline internals ───────────────────────────────────────────────────────

// Batch is a slice of NormalizedLogs ready for output.
type Batch struct {
	Logs      []*NormalizedLog
	CreatedAt time.Time
}

// RetryRecord wraps a Batch with retry metadata for the retry worker.
type RetryRecord struct {
	Batch    *Batch
	Attempts int
	LastErr  error
	NextAt   time.Time // earliest time to retry
}

