// Package intake implements the Kafka consumer group reader.
//
// The consumer reads raw log messages from the input Kafka topic, deserialises
// them into domain.RawLog, and forwards them to the same intakeCh channel
// used by the HTTP handler — giving both intake paths a unified pipeline.
//
// Backpressure:
//   When intakeCh is full, the consumer pauses FetchMessage and waits.
//   This naturally applies backpressure back through Kafka consumer lag —
//   the consumer group stops advancing its offset, Kafka retains messages,
//   and lag metrics alert the operator to scale the pipeline.
package intake

import (
	"context"
	"encoding/json"
	"time"

	"github.com/rs/zerolog"
	kafka "github.com/segmentio/kafka-go"
	"github.com/tapas100/relevix/services/ingestion/internal/domain"
	"github.com/tapas100/relevix/services/ingestion/internal/metrics"
)

// KafkaConsumer reads from a Kafka topic and pushes into the intake channel.
type KafkaConsumer struct {
	reader   *kafka.Reader
	intakeCh chan<- *domain.RawLog
	log      zerolog.Logger
}

// NewKafkaConsumer creates a KafkaConsumer.
//   brokers        — Kafka broker addresses
//   topic          — topic to consume from
//   groupID        — consumer group ID
//   maxBytes       — max bytes per fetch
//   commitInterval — how often to auto-commit offsets
//   intakeCh       — destination channel (shared with HTTP intake)
func NewKafkaConsumer(
	brokers []string,
	topic, groupID string,
	maxBytes int,
	commitInterval time.Duration,
	intakeCh chan<- *domain.RawLog,
	log zerolog.Logger,
) *KafkaConsumer {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers:        brokers,
		Topic:          topic,
		GroupID:        groupID,
		MinBytes:       1,
		MaxBytes:       maxBytes,
		CommitInterval: commitInterval,
		// StartOffset controls what happens when the consumer group has no
		// committed offset (e.g. first start).
		StartOffset: kafka.LastOffset,
		// Logger wired to our structured logger.
		Logger:      kafka.LoggerFunc(log.Debug().Msgf),
		ErrorLogger: kafka.LoggerFunc(log.Error().Msgf),
	})

	return &KafkaConsumer{
		reader:   reader,
		intakeCh: intakeCh,
		log:      log.With().Str("component", "kafka_consumer").Str("topic", topic).Logger(),
	}
}

// Run starts consuming messages until ctx is cancelled.
// It blocks the calling goroutine — launch with go consumer.Run(ctx).
func (c *KafkaConsumer) Run(ctx context.Context) {
	c.log.Info().Msg("kafka consumer started")
	defer c.log.Info().Msg("kafka consumer stopped")

	for {
		// FetchMessage blocks until a message is available or ctx is cancelled.
		msg, err := c.reader.FetchMessage(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return // normal shutdown
			}
			c.log.Error().Err(err).Msg("kafka fetch error")
			continue
		}

		raw, err := c.decode(msg)
		if err != nil {
			c.log.Warn().
				Err(err).
				Str("offset", formatOffset(msg.Offset)).
				Msg("message decode failed — skipping")
			metrics.LogsRejectedTotal.WithLabelValues("kafka", "decode_error").Inc()
			// Commit even on decode failure — a bad message is not retryable here.
			_ = c.reader.CommitMessages(ctx, msg)
			continue
		}

		// Blocking send — stalls consumer (backpressure) if channel is full.
		select {
		case c.intakeCh <- raw:
			metrics.LogsReceivedTotal.WithLabelValues("kafka", raw.TenantID).Inc()
			metrics.IntakeChannelUtilization.Set(
				float64(len(c.intakeCh)) / float64(cap(c.intakeCh)),
			)
			// Commit after successful handoff.
			if err := c.reader.CommitMessages(ctx, msg); err != nil {
				c.log.Warn().Err(err).Msg("commit failed")
			}
		case <-ctx.Done():
			return
		}
	}
}

// Close releases the Kafka reader.
func (c *KafkaConsumer) Close() error {
	return c.reader.Close()
}

// decode deserialises a Kafka message into a RawLog.
func (c *KafkaConsumer) decode(msg kafka.Message) (*domain.RawLog, error) {
	var raw domain.RawLog
	if err := json.Unmarshal(msg.Value, &raw); err != nil {
		return nil, err
	}
	raw.Source = domain.SourceKafka
	raw.ReceivedAt = time.Now().UTC()
	return &raw, nil
}

func formatOffset(offset int64) string {
	return string(rune(offset))
}
