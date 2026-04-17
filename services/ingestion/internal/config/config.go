// Package config loads and validates configuration from environment variables.
// All required variables panic at startup — fail-fast over silent misconfiguration.
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config holds all tunables for the ingestion service.
type Config struct {
	// Identity
	ServiceName    string
	ServiceVersion string
	Environment    string // development | staging | production
	LogLevel       string

	// HTTP server
	Host string
	Port int

	// ── Pipeline ──────────────────────────────────────────────────────────────

	// IntakeBufferSize is the capacity of the channel between intake and pipeline.
	// At 10k rps this should be >= 10_000. When full, HTTP returns 503, Kafka pauses.
	IntakeBufferSize int

	// WorkerCount is the number of concurrent normalize+enrich goroutines.
	WorkerCount int

	// BatchSize is the max number of logs per output batch.
	BatchSize int

	// BatchFlushInterval is the max time before a partial batch is flushed.
	BatchFlushInterval time.Duration

	// OutputBufferSize is the capacity of the channel feeding the output writer.
	OutputBufferSize int

	// ── Retry / DLQ ───────────────────────────────────────────────────────────

	// MaxRetryAttempts before a batch is sent to the DLQ.
	MaxRetryAttempts int

	// RetryBaseDelay is the initial delay for exponential backoff.
	RetryBaseDelay time.Duration

	// RetryBufferSize is the capacity of the retry channel.
	RetryBufferSize int

	// ── Kafka input ───────────────────────────────────────────────────────────
	KafkaBrokers         []string
	KafkaClientID        string
	KafkaGroupID         string
	KafkaTopicInput      string // topic to consume raw logs from
	KafkaTopicOutput     string // topic to produce normalized logs to
	KafkaTopicDLQ        string // dead-letter topic
	KafkaMaxBytes        int    // max message size in bytes
	KafkaCommitInterval  time.Duration

	// ── Storage ───────────────────────────────────────────────────────────────
	DatabaseURL string

	// ── Observability ─────────────────────────────────────────────────────────
	MetricsPort int // Prometheus /metrics port (0 = disabled)
}

func (c *Config) Addr() string {
	return fmt.Sprintf("%s:%d", c.Host, c.Port)
}

func (c *Config) MetricsAddr() string {
	return fmt.Sprintf("%s:%d", c.Host, c.MetricsPort)
}

// MustLoad reads all config from environment variables.
// Panics with a descriptive message on any missing required variable.
func MustLoad() *Config {
	brokers := requireEnv("KAFKA_BROKERS")
	return &Config{
		ServiceName:    requireEnv("SERVICE_NAME"),
		ServiceVersion: getEnv("SERVICE_VERSION", "0.0.0"),
		Environment:    getEnv("ENVIRONMENT", "development"),
		LogLevel:       getEnv("LOG_LEVEL", "info"),
		Host:           getEnv("HOST", "0.0.0.0"),
		Port:           getIntEnv("PORT", 4000),

		// Pipeline
		IntakeBufferSize:   getIntEnv("INTAKE_BUFFER_SIZE", 50_000),
		WorkerCount:        getIntEnv("WORKER_COUNT", 32),
		BatchSize:          getIntEnv("BATCH_SIZE", 250),
		BatchFlushInterval: getDurationEnv("BATCH_FLUSH_INTERVAL", 200*time.Millisecond),
		OutputBufferSize:   getIntEnv("OUTPUT_BUFFER_SIZE", 10_000),

		// Retry / DLQ
		MaxRetryAttempts: getIntEnv("MAX_RETRY_ATTEMPTS", 3),
		RetryBaseDelay:   getDurationEnv("RETRY_BASE_DELAY", 500*time.Millisecond),
		RetryBufferSize:  getIntEnv("RETRY_BUFFER_SIZE", 5_000),

		// Kafka input
		KafkaBrokers:        splitTrim(brokers, ","),
		KafkaClientID:       getEnv("KAFKA_CLIENT_ID", "relevix-ingestion"),
		KafkaGroupID:        getEnv("KAFKA_GROUP_ID", "relevix-ingestion-group"),
		KafkaTopicInput:     getEnv("KAFKA_TOPIC_INPUT", "relevix.logs.raw"),
		KafkaTopicOutput:    getEnv("KAFKA_TOPIC_OUTPUT", "relevix.logs.normalized"),
		KafkaTopicDLQ:       getEnv("KAFKA_TOPIC_DLQ", "relevix.logs.dlq"),
		KafkaMaxBytes:       getIntEnv("KAFKA_MAX_BYTES", 10<<20), // 10 MiB
		KafkaCommitInterval: getDurationEnv("KAFKA_COMMIT_INTERVAL", time.Second),

		// Storage
		DatabaseURL: requireEnv("DATABASE_URL"),

		// Observability
		MetricsPort: getIntEnv("METRICS_PORT", 9090),
	}
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

func requireEnv(key string) string {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		panic(fmt.Sprintf("❌ required env var %q is not set", key))
	}
	return v
}

func getEnv(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}

func getIntEnv(key string, fallback int) int {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return fallback
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		panic(fmt.Sprintf("❌ env var %q must be an integer, got %q", key, v))
	}
	return n
}

func getDurationEnv(key string, fallback time.Duration) time.Duration {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return fallback
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		panic(fmt.Sprintf("❌ env var %q must be a duration (e.g. 200ms), got %q", key, v))
	}
	return d
}

func splitTrim(s, sep string) []string {
	parts := strings.Split(s, sep)
	result := make([]string, 0, len(parts))
	for _, p := range parts {
		if t := strings.TrimSpace(p); t != "" {
			result = append(result, t)
		}
	}
	return result
}

