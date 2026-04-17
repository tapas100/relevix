// Package output writes normalized log batches to their destinations:
//   - KafkaWriter  → Kafka topic (primary, high-throughput path)
//   - InternalQueue → in-process bounded ring buffer (fallback / testing)
package output

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/rs/zerolog"
	kafka "github.com/segmentio/kafka-go"
	"github.com/tapas100/relevix/services/ingestion/internal/domain"
	"github.com/tapas100/relevix/services/ingestion/internal/metrics"
)

// Writer is the interface satisfied by all output destinations.
type Writer interface {
	// Write sends a batch to the destination. Implementations must be
	// goroutine-safe. Returns an error if the write fails and should be retried.
	Write(ctx context.Context, batch *domain.Batch) error
	// Close flushes any pending data and releases resources.
	Close() error
}

// ─── Kafka writer ─────────────────────────────────────────────────────────────

// KafkaWriter publishes normalized log batches to a Kafka topic.
// It uses kafka-go's synchronous WriteMessages which respects context deadlines.
//
// Performance knobs (set via kafka.WriterConfig):
//   - BatchSize / BatchBytes / BatchTimeout control how kafka-go internally
//     groups messages before a network write — distinct from our Batcher stage.
//   - Async=false ensures we get write confirmation (and errors) synchronously.
//   - RequiredAcks=RequireOne gives durable writes without the latency of all-ISR.
type KafkaWriter struct {
	writer *kafka.Writer
	log    zerolog.Logger
}

// NewKafkaWriter creates a KafkaWriter targeting the given topic.
func NewKafkaWriter(brokers []string, topic string, log zerolog.Logger) *KafkaWriter {
	w := &kafka.Writer{
		Addr:                   kafka.TCP(brokers...),
		Topic:                  topic,
		Balancer:               &kafka.Hash{}, // partition by TenantID for ordering
		MaxAttempts:            1,             // retry logic is handled by our retryer
		BatchSize:              100,
		BatchBytes:             5 << 20, // 5 MiB per Kafka batch
		BatchTimeout:           10 * time.Millisecond,
		WriteTimeout:           10 * time.Second,
		RequiredAcks:           kafka.RequireOne,
		Async:                  false,
		AllowAutoTopicCreation: false, // topics should be provisioned in advance
		Compression:            kafka.Snappy,
		Logger:                 kafka.LoggerFunc(log.Debug().Msgf),
		ErrorLogger:            kafka.LoggerFunc(log.Error().Msgf),
	}
	return &KafkaWriter{writer: w, log: log.With().Str("component", "kafka_writer").Logger()}
}

// Write serialises each NormalizedLog to JSON and publishes the batch.
// The TenantID is used as the Kafka message key to ensure per-tenant ordering.
func (k *KafkaWriter) Write(ctx context.Context, batch *domain.Batch) error {
	if len(batch.Logs) == 0 {
		return nil
	}

	msgs := make([]kafka.Message, 0, len(batch.Logs))
	for _, l := range batch.Logs {
		payload, err := json.Marshal(l)
		if err != nil {
			// Skip unparseable logs rather than failing the whole batch.
			k.log.Warn().Err(err).Str("logId", l.ID).Msg("marshal failed, skipping log")
			continue
		}
		msgs = append(msgs, kafka.Message{
			Key:   []byte(l.TenantID),
			Value: payload,
		})
	}

	start := time.Now()
	err := k.writer.WriteMessages(ctx, msgs...)
	elapsed := time.Since(start).Seconds()

	metrics.PublishDurationSeconds.WithLabelValues("kafka").Observe(elapsed)
	if err != nil {
		return fmt.Errorf("kafka write failed: %w", err)
	}

	metrics.LogsPublishedTotal.WithLabelValues("kafka").Add(float64(len(msgs)))
	return nil
}

// Close flushes pending messages and closes the underlying writer.
func (k *KafkaWriter) Close() error {
	return k.writer.Close()
}

// ─── DLQ writer ───────────────────────────────────────────────────────────────

// DLQWriter publishes undeliverable batches to the dead-letter Kafka topic.
// It wraps each batch in an envelope that includes the original error.
type DLQWriter struct {
	writer *kafka.Writer
	log    zerolog.Logger
}

// NewDLQWriter creates a DLQWriter targeting the given dead-letter topic.
func NewDLQWriter(brokers []string, topic string, log zerolog.Logger) *DLQWriter {
	w := &kafka.Writer{
		Addr:         kafka.TCP(brokers...),
		Topic:        topic,
		Balancer:     &kafka.LeastBytes{},
		MaxAttempts:  5,
		WriteTimeout: 15 * time.Second,
		RequiredAcks: kafka.RequireAll, // durability is paramount for DLQ
		Compression:  kafka.Gzip,
	}
	return &DLQWriter{writer: w, log: log.With().Str("component", "dlq_writer").Logger()}
}

type dlqEnvelope struct {
	FailedAt time.Time          `json:"failedAt"`
	Reason   string             `json:"reason"`
	Attempts int                `json:"attempts"`
	Logs     []*domain.NormalizedLog `json:"logs"`
}

// Write publishes the failed batch to the DLQ topic.
func (d *DLQWriter) Write(ctx context.Context, record *domain.RetryRecord) error {
	env := dlqEnvelope{
		FailedAt: time.Now().UTC(),
		Reason:   record.LastErr.Error(),
		Attempts: record.Attempts,
		Logs:     record.Batch.Logs,
	}
	payload, err := json.Marshal(env)
	if err != nil {
		return fmt.Errorf("dlq marshal failed: %w", err)
	}
	err = d.writer.WriteMessages(ctx, kafka.Message{Value: payload})
	if err != nil {
		return fmt.Errorf("dlq write failed: %w", err)
	}
	metrics.DLQEnqueuedTotal.Inc()
	d.log.Warn().
		Int("logs", len(record.Batch.Logs)).
		Int("attempts", record.Attempts).
		Msg("batch sent to DLQ")
	return nil
}

// Close flushes the DLQ writer.
func (d *DLQWriter) Close() error {
	return d.writer.Close()
}
