package engine_test

import (
	"testing"
	"time"

	"github.com/tapas100/relevix/services/rule-engine/internal/domain"
	"github.com/tapas100/relevix/services/rule-engine/internal/engine"
)

// ── helpers ───────────────────────────────────────────────────────────────────

func baseCtx() domain.EvalContext {
	return domain.EvalContext{
		Signal: domain.SignalContext{
			Kind:        "latency_p95",
			Value:       350.0,
			ZScore:      3.5,
			Anomaly:     "warning",
			SampleCount: 120,
			Throughput:  25.0,
			PrevValue:   300.0,
			WindowSecs:  10.0,
		},
		Baseline: domain.BaselineContext{
			Mean:   200.0,
			StdDev: 40.0,
			N:      50,
		},
		Meta: domain.MetaContext{
			TenantID:    "tenant-1",
			ServiceName: "api-gateway",
			Environment: "production",
		},
	}
}

func singleCondRule(id string, cond domain.ConditionV2, logic domain.ConditionLogicV2) domain.InfraRule {
	return domain.InfraRule{
		ID:             id,
		Version:        1,
		Name:           id,
		Enabled:        true,
		Priority:       10,
		Severity:       domain.SeverityWarning,
		ConditionLogic: logic,
		Conditions:     []domain.ConditionV2{cond},
		Confidence:     domain.ConfidenceConfig{Base: 0.7},
		Action:         domain.ActionAlert,
	}
}

func makeRuleSet(rules ...domain.InfraRule) *engine.RuleSetForTest {
	return engine.NewRuleSetForTest(rules)
}

// ── operator tests ────────────────────────────────────────────────────────────

func TestOp_Between_Match(t *testing.T) {
	ctx := baseCtx().ToFlatMap()
	cond := domain.ConditionV2{Field: "signal.value", Op: domain.OpBetween, Value: []any{300.0, 400.0}, Weight: 1.0}
	m, _ := engine.EvalConditionV2(cond, ctx)
	if !m {
		t.Errorf("between [300,400]: want match for value=350, got false")
	}
}

func TestOp_Between_NoMatch(t *testing.T) {
	ctx := baseCtx().ToFlatMap()
	cond := domain.ConditionV2{Field: "signal.value", Op: domain.OpBetween, Value: []any{400.0, 500.0}, Weight: 1.0}
	m, _ := engine.EvalConditionV2(cond, ctx)
	if m {
		t.Errorf("between [400,500]: want no match for value=350, got true")
	}
}

func TestOp_StddevAbove_Match(t *testing.T) {
	ctx := baseCtx().ToFlatMap()
	// baseline.mean=200, std_dev=40 → threshold = 200 + 3*40 = 320
	// signal.value=350 → should match
	cond := domain.ConditionV2{Field: "signal.value", Op: domain.OpStddevAbove, Value: 3.0, Weight: 1.0}
	m, _ := engine.EvalConditionV2(cond, ctx)
	if !m {
		t.Errorf("stddev_above 3: want match for value=350 (threshold=320), got false")
	}
}

func TestOp_StddevAbove_NoMatch(t *testing.T) {
	ctx := baseCtx().ToFlatMap()
	// threshold = 200 + 5*40 = 400; value=350 → no match
	cond := domain.ConditionV2{Field: "signal.value", Op: domain.OpStddevAbove, Value: 5.0, Weight: 1.0}
	m, _ := engine.EvalConditionV2(cond, ctx)
	if m {
		t.Errorf("stddev_above 5: want no match for value=350 (threshold=400), got true")
	}
}

func TestOp_PercentChange_Drop(t *testing.T) {
	// throughput dropped 60% below baseline
	ctx := domain.EvalContext{
		Signal:   domain.SignalContext{Kind: "throughput", Value: 4.0},
		Baseline: domain.BaselineContext{Mean: 10.0},
	}.ToFlatMap()
	// (4-10)/10 * 100 = -60%
	cond := domain.ConditionV2{Field: "signal.value", Op: domain.OpPercentChange, Value: -40.0, Weight: 1.0}
	m, _ := engine.EvalConditionV2(cond, ctx)
	if !m {
		t.Errorf("percent_change -40: want match for -60%% drop, got false")
	}
}

func TestOp_PercentChange_NoDrop(t *testing.T) {
	ctx := domain.EvalContext{
		Signal:   domain.SignalContext{Kind: "throughput", Value: 9.0},
		Baseline: domain.BaselineContext{Mean: 10.0},
	}.ToFlatMap()
	// -10% — doesn't reach -40% threshold
	cond := domain.ConditionV2{Field: "signal.value", Op: domain.OpPercentChange, Value: -40.0, Weight: 1.0}
	m, _ := engine.EvalConditionV2(cond, ctx)
	if m {
		t.Errorf("percent_change -40: want no match for -10%% drop, got true")
	}
}

func TestOp_RateOfChange_Match(t *testing.T) {
	ctx := baseCtx().ToFlatMap()
	// (350 - 300) / 10s = 5 ms/s
	cond := domain.ConditionV2{Field: "signal.value", Op: domain.OpRateOfChange, Value: 4.0, Weight: 1.0}
	m, _ := engine.EvalConditionV2(cond, ctx)
	if !m {
		t.Errorf("rate_of_change >= 4: want match for rate=5, got false")
	}
}

func TestOp_RateOfChange_NoMatch(t *testing.T) {
	ctx := baseCtx().ToFlatMap()
	cond := domain.ConditionV2{Field: "signal.value", Op: domain.OpRateOfChange, Value: 10.0, Weight: 1.0}
	m, _ := engine.EvalConditionV2(cond, ctx)
	if m {
		t.Errorf("rate_of_change >= 10: want no match for rate=5, got true")
	}
}

func TestOp_Exists(t *testing.T) {
	ctx := baseCtx().ToFlatMap()
	cond := domain.ConditionV2{Field: "signal.value", Op: domain.OpExists}
	m, _ := engine.EvalConditionV2(cond, ctx)
	if !m {
		t.Errorf("exists: want true for signal.value, got false")
	}
}

func TestOp_Missing(t *testing.T) {
	ctx := baseCtx().ToFlatMap()
	cond := domain.ConditionV2{Field: "signal.nonexistent", Op: domain.OpMissing}
	m, _ := engine.EvalConditionV2(cond, ctx)
	if !m {
		t.Errorf("missing: want true for nonexistent field, got false")
	}
}

func TestOp_Negate(t *testing.T) {
	ctx := baseCtx().ToFlatMap()
	cond := domain.ConditionV2{Field: "signal.value", Op: domain.OpGte, Value: 500.0, Weight: 1.0, Negate: true}
	m, _ := engine.EvalConditionV2(cond, ctx)
	if !m {
		t.Errorf("negate(gte 500): want match when value=350, got false")
	}
}

// ── condition logic tests ─────────────────────────────────────────────────────

func TestLogic_ALL_AllMatch(t *testing.T) {
	rs := makeRuleSet(domain.InfraRule{
		ID: "all-test", Version: 1, Name: "all", Enabled: true, Priority: 1,
		Severity: domain.SeverityWarning, ConditionLogic: domain.LogicV2All,
		Conditions: []domain.ConditionV2{
			{Field: "signal.value", Op: domain.OpGte, Value: 100.0, Weight: 0.5},
			{Field: "signal.z_score", Op: domain.OpGte, Value: 3.0, Weight: 0.5},
		},
		Confidence: domain.ConfidenceConfig{Base: 0.7},
		Action:     domain.ActionAlert,
	})
	e := engine.NewInfraEngine(rs.ToRuleSet())
	resp := e.Evaluate(baseCtx(), "trace-1")
	if len(resp.Matches) != 1 {
		t.Errorf("ALL: expected 1 match, got %d", len(resp.Matches))
	}
}

func TestLogic_ALL_PartialFail(t *testing.T) {
	rs := makeRuleSet(domain.InfraRule{
		ID: "all-fail", Version: 1, Name: "all", Enabled: true, Priority: 1,
		Severity: domain.SeverityWarning, ConditionLogic: domain.LogicV2All,
		Conditions: []domain.ConditionV2{
			{Field: "signal.value", Op: domain.OpGte, Value: 100.0, Weight: 0.5},
			{Field: "signal.value", Op: domain.OpGte, Value: 1000.0, Weight: 0.5}, // won't match
		},
		Confidence: domain.ConfidenceConfig{Base: 0.7},
		Action:     domain.ActionAlert,
	})
	e := engine.NewInfraEngine(rs.ToRuleSet())
	resp := e.Evaluate(baseCtx(), "trace-1")
	if len(resp.Matches) != 0 {
		t.Errorf("ALL partial fail: expected 0 matches, got %d", len(resp.Matches))
	}
}

func TestLogic_ANY_OneMatch(t *testing.T) {
	rs := makeRuleSet(domain.InfraRule{
		ID: "any-test", Version: 1, Name: "any", Enabled: true, Priority: 1,
		Severity: domain.SeverityWarning, ConditionLogic: domain.LogicV2Any,
		Conditions: []domain.ConditionV2{
			{Field: "signal.value", Op: domain.OpGte, Value: 9999.0, Weight: 0.5}, // no match
			{Field: "signal.z_score", Op: domain.OpGte, Value: 3.0, Weight: 0.5},  // match
		},
		Confidence: domain.ConfidenceConfig{Base: 0.7},
		Action:     domain.ActionAlert,
	})
	e := engine.NewInfraEngine(rs.ToRuleSet())
	resp := e.Evaluate(baseCtx(), "trace-1")
	if len(resp.Matches) != 1 {
		t.Errorf("ANY one match: expected 1 match, got %d", len(resp.Matches))
	}
}

func TestLogic_MinN_Satisfied(t *testing.T) {
	rs := makeRuleSet(domain.InfraRule{
		ID: "minn-test", Version: 1, Name: "minn", Enabled: true, Priority: 1,
		Severity: domain.SeverityWarning, ConditionLogic: domain.LogicV2MinN, MinMatch: 2,
		Conditions: []domain.ConditionV2{
			{Field: "signal.value", Op: domain.OpGte, Value: 100.0, Weight: 0.33},  // match
			{Field: "signal.z_score", Op: domain.OpGte, Value: 3.0, Weight: 0.33},  // match
			{Field: "signal.value", Op: domain.OpGte, Value: 9999.0, Weight: 0.34}, // no match
		},
		Confidence: domain.ConfidenceConfig{Base: 0.55},
		Action:     domain.ActionAlert,
	})
	e := engine.NewInfraEngine(rs.ToRuleSet())
	resp := e.Evaluate(baseCtx(), "trace-1")
	if len(resp.Matches) != 1 {
		t.Errorf("MIN_N=2 with 2 matches: expected 1 match, got %d", len(resp.Matches))
	}
}

func TestLogic_MinN_NotSatisfied(t *testing.T) {
	rs := makeRuleSet(domain.InfraRule{
		ID: "minn-fail", Version: 1, Name: "minn", Enabled: true, Priority: 1,
		Severity: domain.SeverityWarning, ConditionLogic: domain.LogicV2MinN, MinMatch: 3,
		Conditions: []domain.ConditionV2{
			{Field: "signal.value", Op: domain.OpGte, Value: 100.0, Weight: 0.5},   // match
			{Field: "signal.value", Op: domain.OpGte, Value: 9999.0, Weight: 0.5},  // no match
		},
		Confidence: domain.ConfidenceConfig{Base: 0.55},
		Action:     domain.ActionAlert,
	})
	e := engine.NewInfraEngine(rs.ToRuleSet())
	resp := e.Evaluate(baseCtx(), "trace-1")
	if len(resp.Matches) != 0 {
		t.Errorf("MIN_N=3 with only 1 match: expected 0, got %d", len(resp.Matches))
	}
}

// ── confidence scoring tests ──────────────────────────────────────────────────

func TestConfidence_ModifierAddsWhenConditionTrue(t *testing.T) {
	cfg := domain.ConfidenceConfig{
		Base: 0.6,
		Modifiers: []domain.ConfidenceModifier{
			{
				When:   domain.ConditionV2{Field: "meta.environment", Op: domain.OpEq, Value: "production"},
				Adjust: +0.15,
			},
		},
	}
	ctx := baseCtx().ToFlatMap()
	got := engine.ComputeConfidence(cfg, []float64{0.5}, []float64{0.5}, ctx)
	// base*0.6 + condScore*0.4 + 0.15 modifier
	if got < 0.74 {
		t.Errorf("confidence with prod modifier: want ≥0.74, got %.4f", got)
	}
}

func TestConfidence_ModifierSubtractsWhenConditionTrue(t *testing.T) {
	cfg := domain.ConfidenceConfig{
		Base: 0.8,
		Modifiers: []domain.ConfidenceModifier{
			{
				When:   domain.ConditionV2{Field: "signal.sample_count", Op: domain.OpLt, Value: float64(200)},
				Adjust: -0.20,
			},
		},
	}
	ctx := baseCtx().ToFlatMap() // sample_count = 120 < 200
	got := engine.ComputeConfidence(cfg, []float64{0.5}, []float64{0.5}, ctx)
	if got > 0.7 {
		t.Errorf("confidence with low-sample penalty: want ≤0.7, got %.4f", got)
	}
}

func TestConfidence_ClampedToOne(t *testing.T) {
	cfg := domain.ConfidenceConfig{
		Base: 1.0,
		Modifiers: []domain.ConfidenceModifier{
			{When: domain.ConditionV2{Field: "signal.value", Op: domain.OpGte, Value: 1.0}, Adjust: +0.5},
		},
	}
	ctx := baseCtx().ToFlatMap()
	got := engine.ComputeConfidence(cfg, []float64{1.0}, []float64{1.0}, ctx)
	if got > 1.0 {
		t.Errorf("confidence must be clamped to 1.0, got %.4f", got)
	}
}

// ── deduplication tests ───────────────────────────────────────────────────────

func TestDedup_SuppressesAfterMaxFire(t *testing.T) {
	now := time.Now()
	clock := func() time.Time { return now }
	store := engine.NewDedupStoreWithClock(clock)

	rule := domain.InfraRule{
		ID:      "dedup-test",
		Version: 1,
		Dedup: &domain.DedupConfig{
			Key:     "{{ index .meta \"tenant_id\" }}/test",
			Window:  5 * time.Minute,
			MaxFire: 2,
		},
	}
	ctx := baseCtx().ToFlatMap()

	_, s1 := store.Check(rule, ctx)
	_, s2 := store.Check(rule, ctx)
	_, s3 := store.Check(rule, ctx) // 3rd — should be suppressed

	if s1 || s2 {
		t.Errorf("first two fires should not be suppressed, got s1=%v s2=%v", s1, s2)
	}
	if !s3 {
		t.Errorf("third fire should be suppressed, got false")
	}
}

func TestDedup_ResetsAfterWindow(t *testing.T) {
	now := time.Now()
	clock := func() time.Time { return now }
	store := engine.NewDedupStoreWithClock(clock)

	rule := domain.InfraRule{
		ID: "dedup-reset", Version: 1,
		Dedup: &domain.DedupConfig{Key: "key", Window: time.Minute, MaxFire: 1},
	}
	ctx := baseCtx().ToFlatMap()

	store.Check(rule, ctx)             // fire 1 — consumes quota
	_, s2 := store.Check(rule, ctx)    // suppressed
	if !s2 {
		t.Error("expected suppression before window reset")
	}

	// Advance clock past window
	now = now.Add(2 * time.Minute)
	_, s3 := store.Check(rule, ctx) // new window — should not be suppressed
	if s3 {
		t.Error("expected no suppression after window reset")
	}
}

// ── ranking tests ─────────────────────────────────────────────────────────────

func TestRanking_HigherSeverityScoresFirst(t *testing.T) {
	infoRule := domain.InfraRule{
		ID: "info-rule", Version: 1, Name: "info", Enabled: true, Priority: 5,
		Severity: domain.SeverityInfo, ConditionLogic: domain.LogicV2All,
		Conditions: []domain.ConditionV2{{Field: "signal.value", Op: domain.OpGte, Value: 1.0, Weight: 1.0}},
		Confidence: domain.ConfidenceConfig{Base: 0.9},
		Action:     domain.ActionAlert,
	}
	critRule := domain.InfraRule{
		ID: "crit-rule", Version: 1, Name: "critical", Enabled: true, Priority: 1,
		Severity: domain.SeverityCritical, ConditionLogic: domain.LogicV2All,
		Conditions: []domain.ConditionV2{{Field: "signal.value", Op: domain.OpGte, Value: 1.0, Weight: 1.0}},
		Confidence: domain.ConfidenceConfig{Base: 0.7},
		Action:     domain.ActionEscalate,
	}

	rs := makeRuleSet(infoRule, critRule)
	e := engine.NewInfraEngine(rs.ToRuleSet())
	resp := e.Evaluate(baseCtx(), "trace-rank")

	if len(resp.Matches) < 2 {
		t.Fatalf("expected 2 matches, got %d", len(resp.Matches))
	}
	if resp.Matches[0].RuleID != "crit-rule" {
		t.Errorf("critical rule should rank first, got %q first", resp.Matches[0].RuleID)
	}
}

func TestRanking_TopMatchIsFirstNonSuppressed(t *testing.T) {
	now := time.Now()
	clock := func() time.Time { return now }

	highRule := domain.InfraRule{
		ID: "high", Version: 1, Name: "high", Enabled: true, Priority: 1,
		Severity: domain.SeverityCritical, ConditionLogic: domain.LogicV2All,
		Conditions: []domain.ConditionV2{{Field: "signal.value", Op: domain.OpGte, Value: 1.0, Weight: 1.0}},
		Confidence: domain.ConfidenceConfig{Base: 0.9},
		Action:     domain.ActionAlert,
		Dedup:      &domain.DedupConfig{Key: "high", Window: time.Minute, MaxFire: 1},
	}
	lowRule := domain.InfraRule{
		ID: "low", Version: 1, Name: "low", Enabled: true, Priority: 20,
		Severity: domain.SeverityInfo, ConditionLogic: domain.LogicV2All,
		Conditions: []domain.ConditionV2{{Field: "signal.value", Op: domain.OpGte, Value: 1.0, Weight: 1.0}},
		Confidence: domain.ConfidenceConfig{Base: 0.5},
		Action:     domain.ActionAlert,
	}

	rs := makeRuleSet(highRule, lowRule)
	dedup := engine.NewDedupStoreWithClock(clock)
	e := engine.NewInfraEngineWithDedup(rs.ToRuleSet(), dedup)

	// First evaluation — highRule fires, not suppressed.
	e.Evaluate(baseCtx(), "trace-1")

	// Second evaluation — highRule is suppressed by dedup; lowRule is top match.
	resp := e.Evaluate(baseCtx(), "trace-2")

	if resp.TopMatch == nil {
		t.Fatal("expected a TopMatch, got nil")
	}
	if resp.TopMatch.RuleID != "low" {
		t.Errorf("expected TopMatch to be 'low' (high suppressed), got %q", resp.TopMatch.RuleID)
	}
}

// ── disabled rule test ────────────────────────────────────────────────────────

func TestDisabledRule_NeverMatches(t *testing.T) {
	rs := makeRuleSet(domain.InfraRule{
		ID: "disabled", Version: 1, Name: "off", Enabled: false, Priority: 1,
		Severity: domain.SeverityCritical, ConditionLogic: domain.LogicV2All,
		Conditions: []domain.ConditionV2{{Field: "signal.value", Op: domain.OpGte, Value: 1.0, Weight: 1.0}},
		Confidence: domain.ConfidenceConfig{Base: 0.9},
		Action:     domain.ActionAlert,
	})
	e := engine.NewInfraEngine(rs.ToRuleSet())
	resp := e.Evaluate(baseCtx(), "trace-disabled")
	if len(resp.Matches) != 0 {
		t.Errorf("disabled rule should never match, got %d matches", len(resp.Matches))
	}
}
