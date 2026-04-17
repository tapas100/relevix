// Package intake reads NormalizedLogs from Kafka and pushes LogObservations
// into the window manager.
package intake

import (
	"context"
	"encoding/json"
	"time"

	"github.com/rs/zerolog"
	kafka "github.com/segmentio/kafka-go"
	"github.com/tapas100/relevix/services/signal-processor/internal/domain"
	"github.com/tapas100/relevix/services/signal-processor/internal/metrics"
)

// KafkaConsumer reads NormalizedLogs from the normalized log topic.
type KafkaConsumer struct {
	reader   *kafka.Reader
	obsCh    chan<- *domain.LogObservation
	log      zerolog.Logger
}

// NewKafkaConsumer creates a consumer.
func NewKafkaConsumer(
	brokers []string,
	topic, groupID string,
	maxBytes int,
	commitInterval time.Duration,
	obsCh chan<- *domain.LogObservation,
	log zerolog.Logger,
) *KafkaConsumer {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers:        brokers,
		Topic:          topic,
		GroupID:        groupID,
		MinBytes:       1,
		MaxBytes:       maxBytes,
		CommitInterval: commitInterval,
		StartOffset:    kafka.LastOffset,
		Logger:         kafka.LoggerFunc(log.Debug().Msgf),
		ErrorLogger:    kafka.LoggerFunc(log.Error().Msgf),
	})
	return &KafkaConsumer{
		reader: reader,
		obsCh:  obsCh,
		log:    log.With().Str("component", "kafka_consumer").Logger(),
	}
}

// Run consumes messages until ctx is cancelled.
func (c *KafkaConsumer) Run(ctx context.Context) {
	c.log.Info().Msg("kafka consumer started")
	defer c.log.Info().Msg("kafka consumer stopped")

	for {
		msg, err := c.reader.FetchMessage(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			c.log.Error().Err(err).Msg("kafka fetch error")
			continue
		}

		var nlog domain.NormalizedLog
		if err := json.Unmarshal(msg.Value, &nlog); err != nil {
			c.log.Warn().Err(err).Msg("unmarshal failed — skipping")
			metrics.LogsSkipped.Inc()
			_ = c.reader.CommitMessages(ctx, msg)
			continue
		}

		obs := domain.ExtractObservation(&nlog)
		metrics.LogsConsumed.Inc()

		// Blocking push — backpressure stalls consumer if window manager is slow.
		select {
		case c.obsCh <- obs:
		case <-ctx.Done():
			return
		}

		if err := c.reader.CommitMessages(ctx, msg); err != nil {
			c.log.Warn().Err(err).Msg("commit failed")
		}
	}
}

// Close releases the reader.
func (c *KafkaConsumer) Close() error {
	return c.reader.Close()
}
