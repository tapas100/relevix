package pipeline_test

import (
	"testing"
	"time"

	"github.com/tapas100/relevix/services/ingestion/internal/domain"
	"github.com/tapas100/relevix/services/ingestion/internal/pipeline"
)

func TestNormalizer_BasicFields(t *testing.T) {
	n := pipeline.NewNormalizer("test")
	ts := time.Now().UTC()

	raw := &domain.RawLog{
		TenantID:    "tenant-1",
		Message:     "hello world",
		Level:       "info",
		ServiceName: "auth-service",
		TraceID:     "trace-abc",
		Timestamp:   &ts,
		Source:      domain.SourceHTTP,
		ReceivedAt:  ts,
	}

	got := n.Normalize(raw)

	if got.TenantID != "tenant-1" {
		t.Errorf("TenantID: want tenant-1, got %q", got.TenantID)
	}
	if got.Level != domain.LevelInfo {
		t.Errorf("Level: want info, got %q", got.Level)
	}
	if got.ServiceName != "auth-service" {
		t.Errorf("ServiceName: want auth-service, got %q", got.ServiceName)
	}
	if got.Environment != "test" {
		t.Errorf("Environment: want test, got %q", got.Environment)
	}
	if got.TraceID != "trace-abc" {
		t.Errorf("TraceID: want trace-abc, got %q", got.TraceID)
	}
	if got.ID == "" {
		t.Error("ID must be set")
	}
	if got.SchemaVer == "" {
		t.Error("SchemaVer must be set")
	}
}

func TestNormalizer_DefaultsUnknownFields(t *testing.T) {
	n := pipeline.NewNormalizer("prod")
	now := time.Now().UTC()

	raw := &domain.RawLog{
		TenantID:   "t1",
		Message:    "msg",
		Level:      "GARBAGE",
		ReceivedAt: now,
		Source:     domain.SourceKafka,
	}

	got := n.Normalize(raw)

	if got.Level != domain.LevelUnknown {
		t.Errorf("want unknown level, got %q", got.Level)
	}
	if got.ServiceName != "unknown" {
		t.Errorf("want 'unknown' service, got %q", got.ServiceName)
	}
	if got.TraceID == "" {
		t.Error("TraceID should be auto-generated when missing")
	}
	// Timestamp must fall back to ReceivedAt when nil
	if got.Timestamp != now {
		t.Errorf("Timestamp mismatch: want %v, got %v", now, got.Timestamp)
	}
}

func TestNormalizer_FutureDriftFallback(t *testing.T) {
	n := pipeline.NewNormalizer("prod")
	now := time.Now().UTC()
	farFuture := now.Add(48 * time.Hour)

	raw := &domain.RawLog{
		TenantID:   "t1",
		Message:    "drifted",
		ReceivedAt: now,
		Timestamp:  &farFuture,
		Source:     domain.SourceHTTP,
	}

	got := n.Normalize(raw)

	// Far-future timestamp should be replaced by ReceivedAt.
	if !got.Timestamp.Equal(now) {
		t.Errorf("expected drift fallback to ReceivedAt (%v), got %v", now, got.Timestamp)
	}
}

func TestNormalizer_MessageTruncation(t *testing.T) {
	n := pipeline.NewNormalizer("test")
	huge := make([]byte, 70_000)
	for i := range huge {
		huge[i] = 'x'
	}
	now := time.Now().UTC()
	raw := &domain.RawLog{
		TenantID:   "t1",
		Message:    string(huge),
		ReceivedAt: now,
		Source:     domain.SourceHTTP,
	}

	got := n.Normalize(raw)

	// Should be truncated well below 70 KiB
	if len(got.Message) >= 70_000 {
		t.Error("message was not truncated")
	}
}

func TestParseLogLevel(t *testing.T) {
	cases := []struct {
		input string
		want  domain.LogLevel
	}{
		{"info", domain.LevelInfo},
		{"INFO", domain.LevelInfo},
		{"information", domain.LevelInfo},
		{"WARN", domain.LevelWarn},
		{"warning", domain.LevelWarn},
		{"error", domain.LevelError},
		{"ERR", domain.LevelError},
		{"debug", domain.LevelDebug},
		{"TRACE", domain.LevelTrace},
		{"fatal", domain.LevelFatal},
		{"critical", domain.LevelFatal},
		{"garbage", domain.LevelUnknown},
		{"", domain.LevelUnknown},
	}
	for _, tc := range cases {
		got := domain.ParseLogLevel(tc.input)
		if got != tc.want {
			t.Errorf("ParseLogLevel(%q): want %q, got %q", tc.input, tc.want, got)
		}
	}
}
