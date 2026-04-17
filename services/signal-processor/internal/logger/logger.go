// Package logger provides a zerolog factory for the signal-processor.
package logger

import (
	"io"
	"os"
	"strings"
	"time"

	"github.com/rs/zerolog"
)

// New returns a zerolog.Logger configured from the LOG_LEVEL and LOG_FORMAT
// environment variables.
//
//   - LOG_FORMAT=pretty  →  coloured console output (dev mode)
//   - LOG_FORMAT=json    →  structured JSON (default / production)
func New(service string) zerolog.Logger {
	level := parseLevel(os.Getenv("LOG_LEVEL"))
	zerolog.SetGlobalLevel(level)
	zerolog.TimeFieldFormat = time.RFC3339Nano

	var w io.Writer = os.Stdout
	if strings.EqualFold(os.Getenv("LOG_FORMAT"), "pretty") {
		w = zerolog.ConsoleWriter{Out: os.Stdout, TimeFormat: time.RFC3339}
	}

	return zerolog.New(w).
		With().
		Timestamp().
		Str("service", service).
		Logger()
}

func parseLevel(s string) zerolog.Level {
	switch strings.ToLower(s) {
	case "debug":
		return zerolog.DebugLevel
	case "warn", "warning":
		return zerolog.WarnLevel
	case "error":
		return zerolog.ErrorLevel
	default:
		return zerolog.InfoLevel
	}
}
