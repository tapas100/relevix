// Package scorer implements the relevance scoring engine for infrastructure
// insights.
//
// Formula (multiplicative mode, default):
//
//	score = severity_norm ^ (wS/W) × confidence ^ (wC/W) × recency_norm ^ (wR/W) × impact_norm ^ (wI/W)
//
// where W = wS + wC + wR + wI (weights are self-normalizing).
//
// Additive mode (weighted arithmetic mean):
//
//	score = (wS·severity + wC·confidence + wR·recency + wI·impact) / W
//
// All four factors are normalised to [0, 1] before scoring:
//   - severity   → enum → fixed weight map
//   - confidence → already [0, 1] from rule engine
//   - recency    → exponential half-life decay:  2^(-age / halfLife)
//   - impact     → blend of affected service count, RPS ratio, and user-facing flag
//
// Multiplicative mode is the default because it naturally penalises any
// single weak factor — a zero-confidence insight scores zero regardless of
// how high the other factors are.
package scorer

import (
	"math"
	"sort"
	"time"

	"github.com/tapas100/relevix/services/rule-engine/internal/domain"
)

// ─── Public types ─────────────────────────────────────────────────────────────

// ScoringMode controls how the four normalised factors are combined.
type ScoringMode int

const (
	// ScoringMultiplicative (default) — weighted geometric mean.
	// Any factor near zero collapses the whole score.
	ScoringMultiplicative ScoringMode = iota

	// ScoringAdditive — weighted arithmetic mean.
	// Weak factors are offset by strong ones.  Use when partial signals
	// (e.g. missing recency data) should not kill an otherwise strong insight.
	ScoringAdditive
)

// WeightConfig controls the relative importance of each scoring dimension.
// Weights are automatically re-normalised so they need not sum to 1.
// Zero weight means "ignore this dimension entirely".
type WeightConfig struct {
	Severity   float64 // default 0.30
	Confidence float64 // default 0.30
	Recency    float64 // default 0.20
	Impact     float64 // default 0.20
}

// DefaultWeights returns a balanced WeightConfig.
func DefaultWeights() WeightConfig {
	return WeightConfig{
		Severity:   0.30,
		Confidence: 0.30,
		Recency:    0.20,
		Impact:     0.20,
	}
}

// NormConfig controls normalisation parameters.
type NormConfig struct {
	// RecencyHalfLifeSecs is the age (in seconds) at which recency_norm = 0.5.
	// Default: 300 (5 minutes).
	RecencyHalfLifeSecs float64

	// ImpactMaxServices is the service count considered "maximum blast radius".
	// Counts above this are clamped to 1.0.  Default: 10.
	ImpactMaxServices int

	// ImpactRPSCeiling is the RPS value mapped to impact_norm = 1.0.
	// Default: 1000 rps.
	ImpactRPSCeiling float64

	// NoiseFloor is the minimum final score for an insight to be included in
	// rankings.  Insights below this threshold are filtered as noise.
	// Default: 0.05.
	NoiseFloor float64

	// TopN is the maximum number of insights returned by Rank.
	// Default: 3.
	TopN int
}

// DefaultNormConfig returns production-ready normalisation defaults.
func DefaultNormConfig() NormConfig {
	return NormConfig{
		RecencyHalfLifeSecs: 300,
		ImpactMaxServices:   10,
		ImpactRPSCeiling:    1000,
		NoiseFloor:          0.05,
		TopN:                3,
	}
}

// ImpactInput carries raw signals used to compute impact_norm.
// Either provide ExplicitScore (overrides all) or let the scorer compute it
// from AffectedServiceCount, RequestsPerSecond, and IsUserFacing.
type ImpactInput struct {
	// AffectedServiceCount is the number of distinct services impacted.
	AffectedServiceCount int

	// RequestsPerSecond is the observed throughput at the moment of firing.
	// Higher RPS = more users affected = higher impact.
	RequestsPerSecond float64

	// IsUserFacing indicates the degraded path is customer-visible.
	// When false, the computed impact is multiplied by 0.7 (internal services
	// matter less than customer-facing ones).
	IsUserFacing bool

	// ExplicitScore, when > 0, bypasses the computed formula entirely.
	// Use this when the caller has a pre-computed blast-radius score.
	ExplicitScore float64
}

// Insight is the unit of input to the scoring engine.
// It is constructed from a domain.RuleMatch plus enrichment data.
type Insight struct {
	// Identity
	ID       string // usually RuleMatch.RuleID + "/" + DedupKey
	RuleID   string
	RuleName string

	// Dimensions (raw — normalised by scorer)
	Severity   domain.Severity
	Confidence float64    // [0, 1] from rule engine
	FiredAt    time.Time  // used to compute recency
	Impact     ImpactInput

	// Tie-breaking metadata
	Priority int      // lower = more important; from InfraRule.Priority
	Tags     []string

	// Pass-through payload for downstream consumers
	ActionPayload map[string]any

	// Source is the originating RuleMatch (nil if constructed manually).
	Source *domain.RuleMatch
}

// FromRuleMatch constructs an Insight from a RuleMatch.
// impact must be supplied by the caller — the rule engine does not track RPS
// or service counts.
func FromRuleMatch(m domain.RuleMatch, priority int, impact ImpactInput) Insight {
	return Insight{
		ID:            m.RuleID + "/" + m.DedupKey,
		RuleID:        m.RuleID,
		RuleName:      m.RuleName,
		Severity:      m.Severity,
		Confidence:    m.Confidence,
		FiredAt:       m.EvaluatedAt,
		Impact:        impact,
		Priority:      priority,
		ActionPayload: m.ActionPayload,
		Source:        &m,
	}
}

// ScoreComponents holds the normalised value of each dimension plus the
// final weighted score.  Returned alongside every RankedInsight for
// introspection, dashboards, and debugging.
type ScoreComponents struct {
	SeverityNorm   float64 `json:"severity_norm"`
	ConfidenceNorm float64 `json:"confidence_norm"`
	RecencyNorm    float64 `json:"recency_norm"`
	ImpactNorm     float64 `json:"impact_norm"`
	FinalScore     float64 `json:"final_score"`
	// Mode records which formula was applied.
	Mode ScoringMode `json:"mode"`
}

// RankedInsight is the output element returned by Rank.
type RankedInsight struct {
	Rank       int             `json:"rank"`
	Insight    Insight         `json:"insight"`
	Components ScoreComponents `json:"components"`
}

// ─── Scorer ───────────────────────────────────────────────────────────────────

// Scorer computes relevance scores for infrastructure insights.
type Scorer struct {
	weights WeightConfig
	norm    NormConfig
	mode    ScoringMode
	clock   func() time.Time // injectable for testing
}

// New creates a Scorer with the given weights, normalisation config, and mode.
func New(w WeightConfig, n NormConfig, mode ScoringMode) *Scorer {
	return &Scorer{
		weights: w,
		norm:    n,
		mode:    mode,
		clock:   time.Now,
	}
}

// NewDefault creates a production Scorer with all defaults.
func NewDefault() *Scorer {
	return New(DefaultWeights(), DefaultNormConfig(), ScoringMultiplicative)
}

// Score computes all four normalised dimensions and the final composite score
// for a single Insight.  It does not perform ranking or noise filtering.
func (s *Scorer) Score(ins Insight) ScoreComponents {
	now := s.clock()

	sev := normaliseSeverity(ins.Severity)
	conf := clamp01(ins.Confidence)
	rec := normaliseRecency(ins.FiredAt, now, s.norm.RecencyHalfLifeSecs)
	imp := normaliseImpact(ins.Impact, s.norm)

	final := s.composite(sev, conf, rec, imp)

	return ScoreComponents{
		SeverityNorm:   sev,
		ConfidenceNorm: conf,
		RecencyNorm:    rec,
		ImpactNorm:     imp,
		FinalScore:     final,
		Mode:           s.mode,
	}
}

// Rank scores all insights, filters noise, applies tie-breaking, and returns
// the top-N ranked insights (default top 3).
func (s *Scorer) Rank(insights []Insight) []RankedInsight {
	type scored struct {
		ins  Insight
		comp ScoreComponents
	}

	// Score every insight.
	candidates := make([]scored, 0, len(insights))
	for _, ins := range insights {
		comp := s.Score(ins)
		if comp.FinalScore < s.norm.NoiseFloor {
			continue // filter noise
		}
		candidates = append(candidates, scored{ins: ins, comp: comp})
	}

	// Sort: primary = FinalScore desc; tie-breaking = see tieBreak().
	sort.SliceStable(candidates, func(i, j int) bool {
		si, sj := candidates[i].comp.FinalScore, candidates[j].comp.FinalScore
		if math.Abs(si-sj) > scoreTieEpsilon {
			return si > sj
		}
		return tieBreak(candidates[i].ins, candidates[j].ins)
	})

	// Take top-N.
	n := s.norm.TopN
	if n <= 0 {
		n = 3
	}
	if len(candidates) < n {
		n = len(candidates)
	}

	out := make([]RankedInsight, n)
	for i := 0; i < n; i++ {
		out[i] = RankedInsight{
			Rank:       i + 1,
			Insight:    candidates[i].ins,
			Components: candidates[i].comp,
		}
	}
	return out
}

// ─── Composite formula ────────────────────────────────────────────────────────

// scoreTieEpsilon is the tolerance below which two scores are considered equal.
const scoreTieEpsilon = 1e-9

func (s *Scorer) composite(sev, conf, rec, imp float64) float64 {
	w := s.weights
	W := w.Severity + w.Confidence + w.Recency + w.Impact
	if W == 0 {
		return 0
	}

	switch s.mode {
	case ScoringMultiplicative:
		// Weighted geometric mean:
		//   score = sev^(wS/W) × conf^(wC/W) × rec^(wR/W) × imp^(wI/W)
		//
		// Implemented as exp(Σ wi/W · ln(fi)) to handle zero factors cleanly.
		// If any factor with non-zero weight is exactly 0, score = 0.
		factors := [4]float64{sev, conf, rec, imp}
		weights := [4]float64{w.Severity, w.Confidence, w.Recency, w.Impact}
		logSum := 0.0
		for i := 0; i < 4; i++ {
			if weights[i] == 0 {
				continue
			}
			if factors[i] <= 0 {
				return 0 // any zero factor with nonzero weight → score = 0
			}
			logSum += (weights[i] / W) * math.Log(factors[i])
		}
		return clamp01(math.Exp(logSum))

	default: // ScoringAdditive
		return clamp01((w.Severity*sev + w.Confidence*conf + w.Recency*rec + w.Impact*imp) / W)
	}
}

// ─── Tie-breaking ─────────────────────────────────────────────────────────────

// tieBreak defines a deterministic total order for equal-scored insights.
//
// Order (first criterion that differs wins):
//  1. Priority ascending  — lower number = more important rule
//  2. Severity weight descending — critical > warning > info
//  3. FiredAt descending  — newer firing beats older (freshest evidence first)
//  4. ID ascending        — lexical, purely for determinism
func tieBreak(a, b Insight) bool {
	if a.Priority != b.Priority {
		return a.Priority < b.Priority
	}
	wa, wb := domain.SeverityWeight(a.Severity), domain.SeverityWeight(b.Severity)
	if math.Abs(wa-wb) > 1e-9 {
		return wa > wb
	}
	if !a.FiredAt.Equal(b.FiredAt) {
		return a.FiredAt.After(b.FiredAt)
	}
	return a.ID < b.ID
}

// ─── Normalisation functions ──────────────────────────────────────────────────

// normaliseSeverity maps Severity enum to a [0, 1] float.
// Uses domain.SeverityWeight which is already tuned for infra priority.
func normaliseSeverity(s domain.Severity) float64 {
	return domain.SeverityWeight(s)
}

// normaliseRecency computes exponential half-life decay.
//
//	recency = 2^(-age_seconds / halfLifeSecs)
//
// At age=0     → 1.0  (just fired)
// At age=halfLife → 0.5  (half as relevant)
// At age=∞     → 0.0  (ancient, irrelevant)
func normaliseRecency(firedAt, now time.Time, halfLifeSecs float64) float64 {
	if halfLifeSecs <= 0 {
		halfLifeSecs = 300
	}
	ageSecs := now.Sub(firedAt).Seconds()
	if ageSecs < 0 {
		ageSecs = 0 // clock skew guard — future timestamps treated as "just now"
	}
	return math.Pow(2, -ageSecs/halfLifeSecs)
}

// normaliseImpact computes a [0, 1] impact score from raw ImpactInput.
//
// Formula:
//
//	svcFactor = clamp01(affectedCount / maxServices)
//	rpsFactor = clamp01(rps / rpsCeiling)
//	blendFactor = 0.6·svcFactor + 0.4·rpsFactor
//	impact_norm = blendFactor × (1.0 if user-facing else 0.7)
//
// When ExplicitScore > 0, it bypasses this formula entirely.
func normaliseImpact(inp ImpactInput, cfg NormConfig) float64 {
	if inp.ExplicitScore > 0 {
		return clamp01(inp.ExplicitScore)
	}

	maxSvc := float64(cfg.ImpactMaxServices)
	if maxSvc <= 0 {
		maxSvc = 10
	}
	rpsCeil := cfg.ImpactRPSCeiling
	if rpsCeil <= 0 {
		rpsCeil = 1000
	}

	svcFactor := clamp01(float64(inp.AffectedServiceCount) / maxSvc)
	rpsFactor := clamp01(inp.RequestsPerSecond / rpsCeil)

	blend := 0.6*svcFactor + 0.4*rpsFactor

	multiplier := 1.0
	if !inp.IsUserFacing {
		multiplier = 0.7
	}

	return clamp01(blend * multiplier)
}

// clamp01 restricts v to the closed interval [0, 1].
func clamp01(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 1 {
		return 1
	}
	return v
}
