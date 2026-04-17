package baseline_test

import (
	"math"
	"testing"

	"github.com/tapas100/relevix/services/signal-processor/internal/baseline"
	"github.com/tapas100/relevix/services/signal-processor/internal/domain"
)

var dim = domain.DimensionKey{TenantID: "t1", ServiceName: "svc", Environment: "prod"}

func TestTracker_BootstrapPhase(t *testing.T) {
	tr := baseline.NewTracker()
	for i := 0; i < 29; i++ {
		tr.Update(dim, domain.SignalMeanLatency, 100.0)
	}
	bs, ok := tr.Get(dim, domain.SignalMeanLatency)
	if !ok {
		t.Fatal("expected BaselineStats to exist")
	}
	if bs.N != 29 {
		t.Fatalf("want N=29, got N=%d", bs.N)
	}
	if bs.Variance > 1e-9 {
		t.Errorf("all-same values: expected Variance≈0, got %v", bs.Variance)
	}
}

func TestTracker_ZScore_WarmUpGuard(t *testing.T) {
	tr := baseline.NewTracker()
	for i := 0; i < 4; i++ {
		tr.Update(dim, domain.SignalMeanLatency, float64(i))
	}
	bs, _ := tr.Get(dim, domain.SignalMeanLatency)
	if z := baseline.ZScore(bs, 999.0); z != 0 {
		t.Errorf("warm-up guard: want z=0, got %v", z)
	}
}

func TestTracker_ZScore_AfterBootstrap(t *testing.T) {
	tr := baseline.NewTracker()
	for i := 0; i < 31; i++ {
		tr.Update(dim, domain.SignalMeanLatency, 100.0)
	}
	bs, ok := tr.Get(dim, domain.SignalMeanLatency)
	if !ok {
		t.Fatal("expected baseline to exist after 31 updates")
	}
	z := baseline.ZScore(bs, 200.0)
	if math.IsInf(z, 0) || math.IsNaN(z) {
		t.Errorf("ZScore must be finite when stddev=0, got %v", z)
	}
}

func TestTracker_ClassifyAnomaly(t *testing.T) {
	cases := []struct {
		z    float64
		want domain.AnomalyLevel
	}{
		{0.5, domain.AnomalyNone},
		{2.1, domain.AnomalyWarning},
		{-2.5, domain.AnomalyWarning},
		{3.1, domain.AnomalyCritical},
		{-3.1, domain.AnomalyCritical},
	}
	for _, tc := range cases {
		if got := baseline.ClassifyAnomaly(tc.z); got != tc.want {
			t.Errorf("z=%.1f: want %v, got %v", tc.z, tc.want, got)
		}
	}
}

func TestTracker_StdDev(t *testing.T) {
	tr := baseline.NewTracker()
	for _, v := range []float64{2, 4, 4, 4, 5, 5, 7, 9} {
		tr.Update(dim, domain.SignalErrorRate, v)
	}
	bs, _ := tr.Get(dim, domain.SignalErrorRate)
	sd := baseline.StdDev(bs)
	if math.Abs(sd-2.138) > 0.5 {
		t.Errorf("StdDev: want ≈2.138, got %v", sd)
	}
}
