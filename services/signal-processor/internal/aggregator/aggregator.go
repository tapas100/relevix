// Package aggregator converts WindowSnapshots into Signals.
//
// For each snapshot it computes all signal kinds, queries the baseline tracker
// for the current statistical baseline, runs anomaly detection, and emits
// complete Signal structs to the signal channel.
//
// One Aggregator goroutine is sufficient: the bottleneck is the window tick
// (every 10s), not individual snapshot processing. The aggregator processes
// each snapshot in microseconds.
package aggregator

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/rs/zerolog"
	"github.com/tapas100/relevix/services/signal-processor/internal/baseline"
	"github.com/tapas100/relevix/services/signal-processor/internal/domain"
	"github.com/tapas100/relevix/services/signal-processor/internal/metrics"
	"github.com/tapas100/relevix/services/signal-processor/internal/window"
)

const schemaVersion = "relevix/signal/v1"

// Aggregator converts WindowSnapshots to Signals.
type Aggregator struct {
	snapshots <-chan *domain.WindowSnapshot
	signals   chan<- *domain.Signal
	baseline  *baseline.Tracker
	log       zerolog.Logger
}

// New creates an Aggregator.
//   snapshots — WindowSnapshot stream from the window manager
//   signals   — Signal output stream to the emitter
func New(
	snapshots <-chan *domain.WindowSnapshot,
	signals chan<- *domain.Signal,
	tracker *baseline.Tracker,
	log zerolog.Logger,
) *Aggregator {
	return &Aggregator{
		snapshots: snapshots,
		signals:   signals,
		baseline:  tracker,
		log:       log.With().Str("component", "aggregator").Logger(),
	}
}

// Run processes snapshots until ctx is cancelled.
func (a *Aggregator) Run(ctx context.Context) {
	a.log.Info().Msg("aggregator started")
	for {
		select {
		case <-ctx.Done():
			a.log.Info().Msg("aggregator stopped")
			return
		case snap, ok := <-a.snapshots:
			if !ok {
				return
			}
			a.process(snap)
		}
	}
}

// process derives all signals from one WindowSnapshot.
func (a *Aggregator) process(snap *domain.WindowSnapshot) {
	start := time.Now()

	// Compute raw values for all signal kinds.
	type measurement struct {
		kind  domain.SignalKind
		value float64
		unit  string
	}

	measurements := []measurement{
		{domain.SignalThroughput, snap.Throughput(), "rps"},
		{domain.SignalErrorRate, snap.ErrorRate(), "ratio"},
		{domain.SignalMeanLatency, snap.MeanLatencyMS(), "ms"},
		{domain.SignalLatencyP50, window.Percentile(snap.LatencySamples, 50), "ms"},
		{domain.SignalLatencyP95, window.Percentile(snap.LatencySamples, 95), "ms"},
		{domain.SignalLatencyP99, window.Percentile(snap.LatencySamples, 99), "ms"},
	}

	for _, m := range measurements {
		// Skip latency signals if no samples exist (service has no timed requests).
		if isLatencySignal(m.kind) && len(snap.LatencySamples) == 0 {
			continue
		}

		// Update baseline with new observed value.
		bs := a.baseline.Update(snap.Key, m.kind, m.value)
		sd := baseline.StdDev(bs)
		z := baseline.ZScore(bs, m.value)
		anomaly := baseline.ClassifyAnomaly(z)

		sig := &domain.Signal{
			ID:             uuid.NewString(),
			SchemaVer:      schemaVersion,
			Kind:           m.kind,
			TenantID:       snap.Key.TenantID,
			ServiceName:    snap.Key.ServiceName,
			Environment:    snap.Key.Environment,
			WindowSize:     snap.WindowSize,
			WindowEnd:      snap.WindowEnd,
			EmittedAt:      time.Now().UTC(),
			Value:          m.value,
			Unit:           m.unit,
			BaselineMean:   bs.Mean,
			BaselineStdDev: sd,
			ZScore:         z,
			Anomaly:        anomaly,
			AnomalyDelta:   m.value - bs.Mean,
			SampleCount:    snap.Count,
		}

		select {
		case a.signals <- sig:
			metrics.SignalsEmitted.WithLabelValues(string(m.kind), string(anomaly)).Inc()
		default:
			metrics.SignalsDropped.WithLabelValues(string(m.kind)).Inc()
			a.log.Warn().
				Str("kind", string(m.kind)).
				Str("tenant", snap.Key.TenantID).
				Msg("signal channel full — signal dropped")
		}

		if anomaly != domain.AnomalyNone {
			a.log.Warn().
				Str("kind", string(m.kind)).
				Str("tenant", snap.Key.TenantID).
				Str("service", snap.Key.ServiceName).
				Str("anomaly", string(anomaly)).
				Float64("value", m.value).
				Float64("baseline", bs.Mean).
				Float64("zScore", z).
				Msg("anomaly detected")
		}
	}

	metrics.AggregationDuration.Observe(time.Since(start).Seconds())
}

func isLatencySignal(k domain.SignalKind) bool {
	switch k {
	case domain.SignalLatencyP50, domain.SignalLatencyP95,
		domain.SignalLatencyP99, domain.SignalMeanLatency:
		return true
	}
	return false
}
