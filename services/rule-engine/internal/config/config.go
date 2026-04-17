// Package config loads and validates configuration from environment variables.
// Pattern: read from env → validate with rules → return typed struct.
// No config files are read at runtime. Use .env files via Docker / systemd.
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

// Config holds all configuration for the rule-engine service.
// Fields are exported so they can be read by other packages but never mutated.
type Config struct {
	ServiceName    string
	ServiceVersion string
	LogLevel       string // trace|debug|info|warn|error|fatal

	Host string
	Port int

	DatabaseURL string
	RedisURL    string

	OtelEnabled  bool
	OtelEndpoint string

	// Precompute settings
	PrecomputeTickInterval int // seconds, default 30
	PrecomputeLockTTL      int // seconds, default 24 (< tick so crashed workers release promptly)
	PrecomputeWorkers      int // max concurrent tenant workers, default 0 = numCPU
	RedisResultsTTLFactor  int // resultsTTL = tick × this factor, default 2
}

// Addr returns the combined host:port listen address.
func (c *Config) Addr() string {
	return fmt.Sprintf("%s:%d", c.Host, c.Port)
}

// MustLoad reads all required config from environment variables.
// It panics (via log.Fatal) if any required variable is missing or invalid.
// Call this once at program startup.
func MustLoad() *Config {
	cfg := &Config{
		ServiceName:    requireEnv("SERVICE_NAME"),
		ServiceVersion: getEnv("SERVICE_VERSION", "0.0.0"),
		LogLevel:       getEnv("LOG_LEVEL", "info"),
		Host:           getEnv("HOST", "0.0.0.0"),
		Port:           requireIntEnv("PORT", 8080),
		DatabaseURL:    requireEnv("DATABASE_URL"),
		RedisURL:       requireEnv("REDIS_URL"),
		OtelEnabled:    getBoolEnv("OTEL_ENABLED", false),
		OtelEndpoint:   getEnv("OTEL_EXPORTER_OTLP_ENDPOINT", ""),

		PrecomputeTickInterval: requireIntEnv("PRECOMPUTE_TICK_INTERVAL", 30),
		PrecomputeLockTTL:      requireIntEnv("PRECOMPUTE_LOCK_TTL", 24),
		PrecomputeWorkers:      requireIntEnv("PRECOMPUTE_WORKERS", 0),
		RedisResultsTTLFactor:  requireIntEnv("PRECOMPUTE_RESULTS_TTL_FACTOR", 2),
	}

	return cfg
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

func requireIntEnv(key string, fallback int) int {
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

func getBoolEnv(key string, fallback bool) bool {
	v := strings.TrimSpace(strings.ToLower(os.Getenv(key)))
	switch v {
	case "true", "1", "yes":
		return true
	case "false", "0", "no":
		return false
	default:
		return fallback
	}
}
