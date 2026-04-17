package scorer_test

import (
	"math"
	"testing"
	"time"

	"github.com/tapas100/relevix/services/rule-engine/internal/domain"
	"github.com/tapas100/relevix/services/rule-engine/internal/scorer"
)

// ─── helpers ──────────────────────────────────────────────────────────────────

func newScorer(opts ...func(*scorerOpts)) *scorer.Scorer {
	o := &scorerOpts{
		weights: scorer.DefaultWeights(),
		norm:    scorer.DefaultNormConfig(),
		mode:    scorer.ScoringMultiplicative,
	}
	for _, fn := range opts {
		fn(o)
	}
	return scorer.New(o.weights, o.norm, o.mode)
}

type scorerOpts struct {
	weights scorer.WeightConfig
	norm    scorer.NormConfig
	mode    scorer.ScoringMode
}

func withMode(m scorer.ScoringMode) func(*scorerOpts) {
	return func(o *scorerOpts) { o.mode = m }
}
func withWeights(w scorer.WeightConfig) func(*scorerOpts) {
	return func(o *scorerOpts) { o.weights = w }
}
func withNorm(n scorer.NormConfig) func(*scorerOpts) {
	return func(o *scorerOpts) { o.norm = n }
}

func makeInsight(id string, sev domain.Severity, conf float64, ageSeconds float64, imp scorer.ImpactInput, priority int) scorer.Insight {
	return scorer.Insight{
		ID:         id,
		RuleID:     id,
		RuleName:   id,
		Severity:   sev,
		Confidence: conf,
		FiredAt:    time.Now().Add(-time.Duration(ageSeconds) * time.Second),
		Impact:     imp,
		Priority:   priority,
	}
}

func highImpact() scorer.ImpactInput {
	return scorer.ImpactInput{AffectedServiceCount: 8, RequestsPerSecond: 500, IsUserFacing: true}
}
func lowImpact() scorer.ImpactInput {
	return scorer.ImpactInput{AffectedServiceCount: 1, RequestsPerSecond: 10, IsUserFacing: false}
}

// ─── normalisation unit tests ─────────────────────────────────────────────────

func TestNormalise_Severity(t *testing.T) {
	s := newScorer()
	cases := []struct {
		sev  domain.Severity
		want float64
	}{
		{domain.SeverityPage, 1.0},
		{domain.SeverityCritical, 0.8},
		{domain.SeverityWarning, 0.5},
		{domain.SeverityInfo, 0.2},
	}
	for _, tc := range cases {
		ins := makeInsight("x", tc.sev, 1.0, 0, scorer.ImpactInput{ExplicitScore: 1.0}, 10)
		comp := s.Score(ins)
		if math.Abs(comp.SeverityNorm-tc.want) > 1e-9 {
			t.Errorf("severity %q: want %.2f, got %.4f", tc.sev, tc.want, comp.SeverityNorm)
		}
	}
}

func TestNormalise_Recency_JustFired(t *testing.T) {
	s := newScorer()
	ins := makeInsight("r", domain.SeverityWarning, 1.0, 0, scorer.ImpactInput{ExplicitScore: 1.0}, 10)
	comp := s.Score(ins)
	// age≈0 → recency≈1.0
	if comp.RecencyNorm < 0.99 {
		t.Errorf("just-fired: recency want ≥0.99, got %.4f", comp.RecencyNorm)
	}
}

func TestNormalise_Recency_AtHalfLife(t *testing.T) {
	norm := scorer.DefaultNormConfig()
	norm.RecencyHalfLifeSecs = 300
	s := newScorer(withNorm(norm))

	ins := makeInsight("r", domain.SeverityWarning, 1.0, 300, scorer.ImpactInput{ExplicitScore: 1.0}, 10)
	comp := s.Score(ins)
	// age=300s = halfLife → recency should be ≈0.5
	if math.Abs(comp.RecencyNorm-0.5) > 0.02 {
		t.Errorf("at half-life: recency want ≈0.5, got %.4f", comp.RecencyNorm)
	}
}

func TestNormalise_Recency_VeryOld(t *testing.T) {
	s := newScorer()
	// 10× half-life old
	ins := makeInsight("r", domain.SeverityWarning, 1.0, 3000, scorer.ImpactInput{ExplicitScore: 1.0}, 10)
	comp := s.Score(ins)
	// 2^(-10) ≈ 0.001
	if comp.RecencyNorm > 0.01 {
		t.Errorf("very old: recency want <0.01, got %.4f", comp.RecencyNorm)
	}
}

func TestNormalise_Impact_Explicit(t *testing.T) {
	s := newScorer()
	ins := makeInsight("i", domain.SeverityWarning, 1.0, 0, scorer.ImpactInput{ExplicitScore: 0.75}, 10)
	comp := s.Score(ins)
	if math.Abs(comp.ImpactNorm-0.75) > 1e-9 {
		t.Errorf("explicit impact: want 0.75, got %.4f", comp.ImpactNorm)
	}
}

func TestNormalise_Impact_Computed_UserFacing(t *testing.T) {
	norm := scorer.DefaultNormConfig()
	norm.ImpactMaxServices = 10
	norm.ImpactRPSCeiling = 1000
	s := newScorer(withNorm(norm))

	// 5 services (0.5) × 500 rps (0.5) × user-facing (×1.0)
	// blend = 0.6*0.5 + 0.4*0.5 = 0.5
	ins := makeInsight("i", domain.SeverityWarning, 1.0, 0,
		scorer.ImpactInput{AffectedServiceCount: 5, RequestsPerSecond: 500, IsUserFacing: true}, 10)
	comp := s.Score(ins)
	if math.Abs(comp.ImpactNorm-0.5) > 0.01 {
		t.Errorf("computed impact user-facing: want ≈0.5, got %.4f", comp.ImpactNorm)
	}
}

func TestNormalise_Impact_Computed_InternalService(t *testing.T) {
	norm := scorer.DefaultNormConfig()
	norm.ImpactMaxServices = 10
	norm.ImpactRPSCeiling = 1000
	s := newScorer(withNorm(norm))

	// Same as above but not user-facing → × 0.7
	ins := makeInsight("i", domain.SeverityWarning, 1.0, 0,
		scorer.ImpactInput{AffectedServiceCount: 5, RequestsPerSecond: 500, IsUserFacing: false}, 10)
	comp := s.Score(ins)
	if math.Abs(comp.ImpactNorm-0.35) > 0.01 {
		t.Errorf("computed impact internal: want ≈0.35 (0.5×0.7), got %.4f", comp.ImpactNorm)
	}
}

// ─── composite formula tests ──────────────────────────────────────────────────

func TestComposite_Multiplicative_ZeroFactorCollapses(t *testing.T) {
	s := newScorer(withMode(scorer.ScoringMultiplicative))
	// confidence = 0 → score must be 0
	ins := makeInsight("z", domain.SeverityCritical, 0.0, 0, scorer.ImpactInput{ExplicitScore: 1.0}, 10)
	comp := s.Score(ins)
	if comp.FinalScore != 0 {
		t.Errorf("multiplicative: zero confidence must yield score=0, got %.4f", comp.FinalScore)
	}
}

func TestComposite_Additive_ZeroFactorDoesNotCollapse(t *testing.T) {
	s := newScorer(withMode(scorer.ScoringAdditive))
	ins := makeInsight("a", domain.SeverityCritical, 0.0, 0, scorer.ImpactInput{ExplicitScore: 1.0}, 10)
	comp := s.Score(ins)
	// severity(0.8)×0.3 + confidence(0)×0.3 + recency(≈1)×0.2 + impact(1)×0.2
	// ≈ (0.24 + 0 + 0.2 + 0.2) / 1.0 = 0.64 (approx)
	if comp.FinalScore <= 0 {
		t.Errorf("additive: zero confidence should not collapse score, got %.4f", comp.FinalScore)
	}
}

func TestComposite_Multiplicative_AllOnes(t *testing.T) {
	s := newScorer(withMode(scorer.ScoringMultiplicative))
	ins := makeInsight("p", domain.SeverityPage, 1.0, 0, scorer.ImpactInput{ExplicitScore: 1.0}, 10)
	comp := s.Score(ins)
	if math.Abs(comp.FinalScore-1.0) > 0.01 {
		t.Errorf("all-ones: want ≈1.0, got %.4f", comp.FinalScore)
	}
}

func TestComposite_ScoreInRange(t *testing.T) {
	s := newScorer()
	insights := []scorer.Insight{
		makeInsight("a", domain.SeverityPage, 0.95, 10, highImpact(), 1),
		makeInsight("b", domain.SeverityWarning, 0.40, 600, lowImpact(), 20),
		makeInsight("c", domain.SeverityInfo, 0.10, 3600, scorer.ImpactInput{}, 50),
	}
	for _, ins := range insights {
		comp := s.Score(ins)
		if comp.FinalScore < 0 || comp.FinalScore > 1 {
			t.Errorf("%s: score out of [0,1]: %.4f", ins.ID, comp.FinalScore)
		}
	}
}

// ─── noise filtering ──────────────────────────────────────────────────────────

func TestRank_FiltersNoise(t *testing.T) {
	norm := scorer.DefaultNormConfig()
	norm.NoiseFloor = 0.05
	norm.TopN = 3
	s := newScorer(withNorm(norm))

	insights := []scorer.Insight{
		makeInsight("strong", domain.SeverityCritical, 0.9, 5, highImpact(), 1),
		// Noise: very old, zero confidence, no impact
		makeInsight("noise", domain.SeverityInfo, 0.01, 86400, scorer.ImpactInput{}, 99),
	}
	ranked := s.Rank(insights)
	for _, r := range ranked {
		if r.Insight.ID == "noise" {
			t.Errorf("noise insight should have been filtered, but appeared at rank %d", r.Rank)
		}
	}
}

// ─── top-N tests ──────────────────────────────────────────────────────────────

func TestRank_ReturnsAtMostTopN(t *testing.T) {
	norm := scorer.DefaultNormConfig()
	norm.TopN = 3
	s := newScorer(withNorm(norm))

	insights := []scorer.Insight{
		makeInsight("a", domain.SeverityPage, 0.95, 5, highImpact(), 1),
		makeInsight("b", domain.SeverityCritical, 0.85, 30, highImpact(), 2),
		makeInsight("c", domain.SeverityWarning, 0.70, 120, highImpact(), 5),
		makeInsight("d", domain.SeverityWarning, 0.60, 200, lowImpact(), 10),
		makeInsight("e", domain.SeverityInfo, 0.50, 400, lowImpact(), 20),
	}
	ranked := s.Rank(insights)
	if len(ranked) > 3 {
		t.Errorf("want at most 3 results, got %d", len(ranked))
	}
}

func TestRank_RanksAssignedCorrectly(t *testing.T) {
	s := newScorer()
	insights := []scorer.Insight{
		makeInsight("a", domain.SeverityPage, 0.95, 5, highImpact(), 1),
		makeInsight("b", domain.SeverityCritical, 0.80, 60, highImpact(), 2),
		makeInsight("c", domain.SeverityWarning, 0.70, 300, highImpact(), 5),
	}
	ranked := s.Rank(insights)
	for i, r := range ranked {
		if r.Rank != i+1 {
			t.Errorf("rank[%d].Rank = %d, want %d", i, r.Rank, i+1)
		}
	}
}

func TestRank_OrderedByScoreDescending(t *testing.T) {
	s := newScorer()
	insights := []scorer.Insight{
		makeInsight("low", domain.SeverityInfo, 0.3, 500, lowImpact(), 50),
		makeInsight("high", domain.SeverityPage, 0.95, 5, highImpact(), 1),
		makeInsight("mid", domain.SeverityWarning, 0.6, 120, highImpact(), 10),
	}
	ranked := s.Rank(insights)
	if len(ranked) == 0 {
		t.Fatal("expected ranked results")
	}
	if ranked[0].Insight.ID != "high" {
		t.Errorf("rank 1: want 'high', got %q", ranked[0].Insight.ID)
	}
}

func TestRank_FewerThanTopNInputs(t *testing.T) {
	norm := scorer.DefaultNormConfig()
	norm.TopN = 3
	s := newScorer(withNorm(norm))

	insights := []scorer.Insight{
		makeInsight("only", domain.SeverityCritical, 0.9, 5, highImpact(), 1),
	}
	ranked := s.Rank(insights)
	if len(ranked) != 1 {
		t.Errorf("want 1 result (fewer than TopN), got %d", len(ranked))
	}
}

func TestRank_EmptyInput(t *testing.T) {
	s := newScorer()
	ranked := s.Rank(nil)
	if len(ranked) != 0 {
		t.Errorf("empty input: want 0 results, got %d", len(ranked))
	}
}

// ─── tie-breaking tests ───────────────────────────────────────────────────────

func TestTieBreak_ByPriority(t *testing.T) {
	s := newScorer(withMode(scorer.ScoringAdditive))

	// Both identical except priority — lower priority number wins.
	imp := scorer.ImpactInput{ExplicitScore: 0.5}
	a := makeInsight("a", domain.SeverityWarning, 0.7, 60, imp, 1)  // priority 1
	b := makeInsight("b", domain.SeverityWarning, 0.7, 60, imp, 10) // priority 10

	ranked := s.Rank([]scorer.Insight{b, a}) // intentionally reversed
	if ranked[0].Insight.ID != "a" {
		t.Errorf("tie: lower priority should rank first, got %q", ranked[0].Insight.ID)
	}
}

func TestTieBreak_BySeverityWhenPriorityEqual(t *testing.T) {
	s := newScorer(withMode(scorer.ScoringAdditive))

	imp := scorer.ImpactInput{ExplicitScore: 0.5}
	a := makeInsight("a", domain.SeverityCritical, 0.5, 60, imp, 5)
	b := makeInsight("b", domain.SeverityWarning, 0.5, 60, imp, 5)

	ranked := s.Rank([]scorer.Insight{b, a})
	if ranked[0].Insight.ID != "a" {
		t.Errorf("tie: higher severity should rank first, got %q", ranked[0].Insight.ID)
	}
}

func TestTieBreak_NewerFiringWins(t *testing.T) {
	s := newScorer(withMode(scorer.ScoringAdditive))

	imp := scorer.ImpactInput{ExplicitScore: 0.5}
	now := time.Now()
	a := scorer.Insight{ID: "a", RuleID: "a", Severity: domain.SeverityWarning, Confidence: 0.7,
		FiredAt: now.Add(-30 * time.Second), Impact: imp, Priority: 5} // newer
	b := scorer.Insight{ID: "b", RuleID: "b", Severity: domain.SeverityWarning, Confidence: 0.7,
		FiredAt: now.Add(-120 * time.Second), Impact: imp, Priority: 5} // older

	ranked := s.Rank([]scorer.Insight{b, a})
	if ranked[0].Insight.ID != "a" {
		t.Errorf("tie: newer firing should rank first, got %q", ranked[0].Insight.ID)
	}
}

func TestTieBreak_DeterministicByID(t *testing.T) {
	s := newScorer(withMode(scorer.ScoringAdditive))

	// Completely identical except ID
	firedAt := time.Now().Add(-60 * time.Second)
	imp := scorer.ImpactInput{ExplicitScore: 0.5}
	a := scorer.Insight{ID: "aardvark", RuleID: "x", Severity: domain.SeverityWarning, Confidence: 0.7, FiredAt: firedAt, Impact: imp, Priority: 5}
	b := scorer.Insight{ID: "zebra", RuleID: "x", Severity: domain.SeverityWarning, Confidence: 0.7, FiredAt: firedAt, Impact: imp, Priority: 5}

	ranked := s.Rank([]scorer.Insight{b, a})
	if ranked[0].Insight.ID != "aardvark" {
		t.Errorf("tie: lexically smaller ID should rank first, got %q", ranked[0].Insight.ID)
	}
}

// ─── dynamic weights tests ────────────────────────────────────────────────────

func TestDynamicWeights_RecencyHeavy(t *testing.T) {
	// When recency weight is dominant, a fresh low-severity insight should
	// outscore a stale high-severity one.
	w := scorer.WeightConfig{Severity: 0.1, Confidence: 0.1, Recency: 0.7, Impact: 0.1}
	norm := scorer.DefaultNormConfig()
	norm.TopN = 2
	s := newScorer(withWeights(w), withNorm(norm), withMode(scorer.ScoringAdditive))

	fresh := makeInsight("fresh", domain.SeverityInfo, 0.8, 5, scorer.ImpactInput{ExplicitScore: 0.5}, 5)
	stale := makeInsight("stale", domain.SeverityPage, 0.9, 3600, scorer.ImpactInput{ExplicitScore: 0.8}, 1)

	ranked := s.Rank([]scorer.Insight{stale, fresh})
	if ranked[0].Insight.ID != "fresh" {
		t.Errorf("recency-heavy weights: fresh insight should rank first, got %q", ranked[0].Insight.ID)
	}
}

func TestDynamicWeights_SeverityHeavy(t *testing.T) {
	w := scorer.WeightConfig{Severity: 0.8, Confidence: 0.1, Recency: 0.05, Impact: 0.05}
	norm := scorer.DefaultNormConfig()
	norm.TopN = 2
	s := newScorer(withWeights(w), withNorm(norm), withMode(scorer.ScoringAdditive))

	highSev := makeInsight("page", domain.SeverityPage, 0.5, 600, scorer.ImpactInput{ExplicitScore: 0.3}, 10)
	lowSev := makeInsight("info", domain.SeverityInfo, 0.99, 5, scorer.ImpactInput{ExplicitScore: 0.9}, 1)

	ranked := s.Rank([]scorer.Insight{lowSev, highSev})
	if ranked[0].Insight.ID != "page" {
		t.Errorf("severity-heavy: page-severity should rank first, got %q", ranked[0].Insight.ID)
	}
}

// ─── FromRuleMatch integration test ──────────────────────────────────────────

func TestFromRuleMatch_FieldMapping(t *testing.T) {
	m := domain.RuleMatch{
		RuleID:     "rule-123",
		RuleName:   "High Error Rate",
		Severity:   domain.SeverityCritical,
		Confidence: 0.82,
		DedupKey:   "tenant-1/api/error_rate",
		EvaluatedAt: time.Now(),
	}
	imp := scorer.ImpactInput{AffectedServiceCount: 3, RequestsPerSecond: 200, IsUserFacing: true}
	ins := scorer.FromRuleMatch(m, 5, imp)

	if ins.Confidence != 0.82 {
		t.Errorf("confidence not mapped: want 0.82, got %v", ins.Confidence)
	}
	if ins.Severity != domain.SeverityCritical {
		t.Errorf("severity not mapped: want critical, got %v", ins.Severity)
	}
	if ins.Source == nil {
		t.Error("Source should not be nil after FromRuleMatch")
	}
}
