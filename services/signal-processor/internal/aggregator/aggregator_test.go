package aggregator_test

import (
	"context"
	"testing"
	"time"

	"github.com/rs/zerolog"
	"github.com/tapas100/relevix/services/signal-processor/internal/aggregator"
	"github.com/tapas100/relevix/services/signal-processor/internal/baseline"
	"github.com/tapas100/relevix/services/signal-processor/internal/domain"
)

func nopLogger() zerolog.Logger { return zerolog.Nop() }

func makeSnapshot(count, errCount int, totalMS float64, latencies []float64) *domain.WindowSnapshot {
	return &domain.WindowSnapshot{
		Key:            domain.DimensionKey{TenantID: "t1", ServiceName: "svc", Environment: "test"},
		Count:          int64(count),
		ErrorCount:     int64(errCount),
		TotalMS:        totalMS,
		LatencySamples: latencies,
		WindowSize:     60 * time.Second,
		WindowEnd:      time.Now(),
	}
}

func TestAggregator_EmitsAllSixKinds(t *testing.T) {
	snapshotCh := make(chan *domain.WindowSnapshot, 1)
	signalCh := make(chan *domain.Signal, 20)
	agg := aggregator.New(snapshotCh, signalCh, baseline.NewTracker(), nopLogger())

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go agg.Run(ctx)

	snapshotCh <- makeSnapshot(100, 5, 5000, []float64{10, 20, 30, 40, 50, 60, 70, 80, 90, 100})

	collected := map[domain.SignalKind]*domain.Signal{}
	timeout := time.After(time.Second)
	for len(collected) < 6 {
		select {
		case sig := <-signalCh:
			collected[sig.Kind] = sig
		case <-timeout:
			t.Fatalf("timeout: only received %d/6 signals", len(collected))
		}
	}

	for _, k := range []domain.SignalKind{
		domain.SignalThroughput, domain.SignalErrorRate, domain.SignalMeanLatency,
		domain.SignalLatencyP50, domain.SignalLatencyP95, domain.SignalLatencyP99,
	} {
		if _, ok := collected[k]; !ok {
			t.Errorf("missing signal kind: %s", k)
		}
	}
}

func TestAggregator_NoLatencySignals_WhenEmpty(t *testing.T) {
	snapshotCh := make(chan *domain.WindowSnapshot, 1)
	signalCh := make(chan *domain.Signal, 10)
	agg := aggregator.New(snapshotCh, signalCh, baseline.NewTracker(), nopLogger())

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go agg.Run(ctx)

	snapshotCh <- makeSnapshot(50, 2, 0, nil)

	collected := map[domain.SignalKind]*domain.Signal{}
	timeout := time.After(300 * time.Millisecond)
	for {
		select {
		case sig := <-signalCh:
			collected[sig.Kind] = sig
		case <-timeout:
			goto done
		}
	}
done:
	if len(collected) != 2 {
		t.Errorf("want 2 signals, got %d", len(collected))
	}
	if _, ok := collected[domain.SignalThroughput]; !ok {
		t.Error("expected throughput signal")
	}
	if _, ok := collected[domain.SignalErrorRate]; !ok {
		t.Error("expected error_rate signal")
	}
}

func TestAggregator_ErrorRateValue(t *testing.T) {
	snapshotCh := make(chan *domain.WindowSnapshot, 1)
	signalCh := make(chan *domain.Signal, 10)
	agg := aggregator.New(snapshotCh, signalCh, baseline.NewTracker(), nopLogger())

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go agg.Run(ctx)

	snapshotCh <- makeSnapshot(100, 25, 0, nil)

	timeout := time.After(time.Second)
	for {
		select {
		case sig := <-signalCh:
			if sig.Kind != domain.SignalErrorRate {
				continue
			}
			if sig.Value < 0.249 || sig.Value > 0.251 {
				t.Errorf("error_rate: want 0.25, got %v", sig.Value)
			}
			return
		case <-timeout:
			t.Fatal("timeout waiting for error_rate signal")
		}
	}
}

func TestAggregator_AnomalyDetection(t *testing.T) {
	snapshotCh := make(chan *domain.WindowSnapshot, 50)
	signalCh := make(chan *domain.Signal, 200)
	agg := aggregator.New(snapshotCh, signalCh, baseline.NewTracker(), nopLogger())

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go agg.Run(ctx)

	// Warm up baseline — 35 normal windows (0% errors)
	for i := 0; i < 35; i++ {
		snapshotCh <- makeSnapshot(100, 0, 5000, []float64{50})
	}
	// Drain warm-up signals
	drainDeadline := time.After(2 * time.Second)
drain:
	for {
		select {
		case <-signalCh:
		case <-drainDeadline:
			break drain
		}
	}

	// Spike — 80% errors
	snapshotCh <- makeSnapshot(100, 80, 5000, []float64{50})

	timeout := time.After(2 * time.Second)
	for {
		select {
		case sig := <-signalCh:
			if sig.Kind == domain.SignalErrorRate && sig.Anomaly != domain.AnomalyNone {
				return // pass
			}
		case <-timeout:
			t.Fatal("timeout: no anomaly detected after spike")
		}
	}
}
