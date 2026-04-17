// Package pipeline implements the normalize → enrich → batch stages of the
// ingestion pipeline.
package pipeline

import (
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/tapas100/relevix/services/ingestion/internal/domain"
)

const (
	maxMessageBytes = 64 * 1024 // 64 KiB — truncate beyond this
	schemaVersion   = "relevix/log/v1"
)

// Normalizer converts a RawLog into a NormalizedLog.
// It is stateless and goroutine-safe.
type Normalizer struct {
	environment string
}

// NewNormalizer creates a Normalizer that stamps the given environment
// on every log it processes.
func NewNormalizer(environment string) *Normalizer {
	return &Normalizer{environment: environment}
}

// Normalize processes a single RawLog into a NormalizedLog.
// It never returns an error — malformed fields are defaulted, not dropped.
func (n *Normalizer) Normalize(raw *domain.RawLog) *domain.NormalizedLog {
	now := time.Now().UTC()

	// Determine timestamp: use provided value, otherwise fall back to ReceivedAt.
	ts := raw.ReceivedAt
	if raw.Timestamp != nil && !raw.Timestamp.IsZero() {
		ts = raw.Timestamp.UTC()
		// Guard against far-future / ancient timestamps (drift > 24h → use ReceivedAt).
		drift := ts.Sub(now)
		if drift > 24*time.Hour || drift < -24*time.Hour {
			ts = raw.ReceivedAt
		}
	}

	// Sanitise message — truncate oversized payloads.
	msg := sanitizeMessage(raw.Message)

	// Build the fields map — shallow copy so we don't mutate the original.
	fields := make(map[string]any, len(raw.Fields))
	for k, v := range raw.Fields {
		fields[k] = v
	}

	// Copy tags.
	tags := make([]string, len(raw.Tags))
	copy(tags, raw.Tags)

	return &domain.NormalizedLog{
		ID:          uuid.NewString(),
		TraceID:     coalesce(raw.TraceID, uuid.NewString()),
		TenantID:    raw.TenantID,
		ServiceName: coalesce(raw.ServiceName, "unknown"),
		Environment: n.environment,
		Level:       domain.ParseLogLevel(raw.Level),
		Message:     msg,
		Fields:      fields,
		Tags:        tags,
		Timestamp:   ts,
		ReceivedAt:  raw.ReceivedAt,
		Source:      raw.Source,
		SchemaVer:   schemaVersion,
	}
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// sanitizeMessage truncates the message if it exceeds maxMessageBytes and
// ensures the string is valid UTF-8.
func sanitizeMessage(s string) string {
	s = strings.TrimSpace(s)
	if len(s) <= maxMessageBytes {
		if utf8.ValidString(s) {
			return s
		}
		return strings.ToValidUTF8(s, "?")
	}
	// Truncate at a valid UTF-8 boundary.
	truncated := s[:maxMessageBytes]
	for !utf8.ValidString(truncated) {
		truncated = truncated[:len(truncated)-1]
	}
	return truncated + " [truncated]"
}

// coalesce returns the first non-empty string.
func coalesce(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}
