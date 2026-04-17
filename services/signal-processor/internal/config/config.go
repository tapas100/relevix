// Package config loads and validates signal-processor configuration from env.
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config holds all runtime configuration for the signal-processor.
type Config struct {
	// Kafka
	KafkaBrokers      []string
	KafkaGroupID      string
	KafkaTopicInput   string // relevix.logs.normalized
	KafkaTopicSignals string // relevix.signals
	KafkaMaxBytes     int
	KafkaCommitInterval time.Duration

	// Window
	WindowSize    time.Duration // observation look-back (default 60s)
	TickInterval  time.Duration // how often snapshots are emitted (default 10s)
	RingCapacity  int           // capacity of each ring buffer (default 16384)
	MaxDimensions int           // max (tenant,svc,env) keys (default 10000)

	// Channels
	ObsChanSize      int // intake → window manager (default 50000)
	SnapshotChanSize int // window manager → aggregator (default 2000)
	SignalChanSize   int // aggregator → writer (default 5000)

	// HTTP
	HTTPAddr    string
	MetricsAddr string
}

// MustLoad loads config from environment variables.  It panics on missing
// required values so the service fails fast at startup.
func MustLoad() *Config {
	return &Config{
		KafkaBrokers:        splitCSV(requireEnv("KAFKA_BROKERS")),
		KafkaGroupID:        getEnv("KAFKA_GROUP_ID", "signal-processor"),
		KafkaTopicInput:     getEnv("KAFKA_TOPIC_INPUT", "relevix.logs.normalized"),
		KafkaTopicSignals:   getEnv("KAFKA_TOPIC_SIGNALS", "relevix.signals"),
		KafkaMaxBytes:       requireIntEnv("KAFKA_MAX_BYTES", 1<<20), // 1 MiB
		KafkaCommitInterval: requireDurationEnv("KAFKA_COMMIT_INTERVAL", 500*time.Millisecond),

		WindowSize:    requireDurationEnv("WINDOW_SIZE", 60*time.Second),
		TickInterval:  requireDurationEnv("TICK_INTERVAL", 10*time.Second),
		RingCapacity:  requireIntEnv("RING_CAPACITY", 16384),
		MaxDimensions: requireIntEnv("MAX_DIMENSIONS", 10000),

		ObsChanSize:      requireIntEnv("OBS_CHAN_SIZE", 50000),
		SnapshotChanSize: requireIntEnv("SNAPSHOT_CHAN_SIZE", 2000),
		SignalChanSize:   requireIntEnv("SIGNAL_CHAN_SIZE", 5000),

		HTTPAddr:    getEnv("HTTP_ADDR", ":8082"),
		MetricsAddr: getEnv("METRICS_ADDR", ":9092"),
	}
}

// ── helpers ──────────────────────────────────────────────────────────────────

func requireEnv(key string) string {
	v := os.Getenv(key)
	if v == "" {
		panic(fmt.Sprintf("signal-processor: required env var %q is not set", key))
	}
	return v
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func requireIntEnv(key string, fallback int) int {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		panic(fmt.Sprintf("signal-processor: env var %q must be an integer, got %q", key, v))
	}
	return n
}

func requireDurationEnv(key string, fallback time.Duration) time.Duration {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		panic(fmt.Sprintf("signal-processor: env var %q must be a duration, got %q", key, v))
	}
	return d
}

func splitCSV(s string) []string {
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if t := strings.TrimSpace(p); t != "" {
			out = append(out, t)
		}
	}
	return out
}
