// Package output serialises Signal structs and writes them to Kafka.
package output

import (
	"context"
	"encoding/json"
	"time"

	"github.com/rs/zerolog"
	kafka "github.com/segmentio/kafka-go"
	"github.com/tapas100/relevix/services/signal-processor/internal/domain"
	"github.com/tapas100/relevix/services/signal-processor/internal/metrics"
)

// SignalWriter publishes Signal messages to the configured Kafka topic.
type SignalWriter struct {
	writer *kafka.Writer
	log    zerolog.Logger
}

// NewSignalWriter creates a writer keyed by TenantID.
func NewSignalWriter(brokers []string, topic string, log zerolog.Logger) *SignalWriter {
	w := &kafka.Writer{
		Addr:         kafka.TCP(brokers...),
		Topic:        topic,
		Balancer:     &kafka.Hash{},
		Compression:  kafka.Snappy,
		RequiredAcks: kafka.RequireOne,
		WriteTimeout: 5 * time.Second,
		ReadTimeout:  5 * time.Second,
	}
	return &SignalWriter{
		writer: w,
		log:    log.With().Str("component", "signal_writer").Logger(),
	}
}

// Write serialises and publishes a Signal.  Errors are logged but not fatal.
func (sw *SignalWriter) Write(ctx context.Context, sig *domain.Signal) error {
	b, err := json.Marshal(sig)
	if err != nil {
		sw.log.Error().Err(err).Str("signal_id", sig.ID).Msg("marshal error")
		return err
	}

	msg := kafka.Message{
		Key:   []byte(sig.TenantID),
		Value: b,
	}
	if err := sw.writer.WriteMessages(ctx, msg); err != nil {
		metrics.SignalWriteErrors.Inc()
		sw.log.Error().Err(err).Str("signal_id", sig.ID).Msg("write error")
		return err
	}

	metrics.SignalsWritten.WithLabelValues(string(sig.Kind)).Inc()
	return nil
}

// Close flushes and closes the underlying writer.
func (sw *SignalWriter) Close() error {
	return sw.writer.Close()
}
