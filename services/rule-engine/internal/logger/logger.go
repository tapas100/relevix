// Package logger provides a zerolog-based structured logger.
//
// All log lines are written as newline-delimited JSON to stdout,
// with the following standard fields on every line:
//   - level, time (@timestamp), service, message
//
// In development (LOG_LEVEL=debug), caller info is added automatically.
package logger

import (
	"os"
	"strings"
	"time"

	"github.com/rs/zerolog"
)

// New creates a configured zerolog.Logger.
// level must be one of: trace, debug, info, warn, error, fatal.
func New(level, service string) zerolog.Logger {
	zerolog.TimeFieldFormat = time.RFC3339Nano
	zerolog.LevelFieldName = "level"
	zerolog.MessageFieldName = "msg"
	zerolog.TimestampFieldName = "@timestamp"

	lvl, err := zerolog.ParseLevel(strings.ToLower(level))
	if err != nil {
		lvl = zerolog.InfoLevel
	}

	base := zerolog.New(os.Stdout).
		Level(lvl).
		With().
		Timestamp().
		Str("service", service).
		Logger()

	// Add caller info at debug level for development convenience
	if lvl <= zerolog.DebugLevel {
		base = base.With().Caller().Logger()
	}

	return base
}
