package logger

import (
	"os"
	"strings"
	"time"

	"github.com/rs/zerolog"
)

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

	if lvl <= zerolog.DebugLevel {
		base = base.With().Caller().Logger()
	}
	return base
}
