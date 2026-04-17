// Package domain — v2 extensions for infra-intelligence rule engine.
//
// This file adds types required by the DSL v2:
//   - Extended operators (between, percent_change, stddev_above, etc.)
//   - Severity / Action v2 enums
//   - Confidence scoring model
//   - Deduplication descriptor
//   - InfraRule  — superset of the original Rule, loaded from YAML/JSON
//   - EvalContext — typed context passed to the v2 evaluator
//   - RuleMatch   — rich result with confidence, dedup key, ranked position
package domain

import "time"

// ─── Operator extensions ──────────────────────────────────────────────────────

const (
	// Numeric range: value must be a [lo, hi] two-element slice.
	OpBetween RuleOperator = "between"

	// Compares field to (baseline.mean + n * baseline.std_dev).
	// value: float64 — number of standard deviations.
	OpStddevAbove RuleOperator = "stddev_above"

	// Compares field to baseline.mean by percentage.
	// value: float64 — signed percentage change (negative = drop).
	OpPercentChange RuleOperator = "percent_change"

	// Compares the per-second derivative of a signal value.
	// value: float64 — minimum rate of change (units/s).
	OpRateOfChange RuleOperator = "rate_of_change"

	// Field existence checks.
	OpExists  RuleOperator = "exists"
	OpMissing RuleOperator = "missing"
)

// ─── Severity ─────────────────────────────────────────────────────────────────

type Severity string

const (
	SeverityInfo     Severity = "info"
	SeverityWarning  Severity = "warning"
	SeverityCritical Severity = "critical"
	SeverityPage     Severity = "page"
)

// SeverityWeight returns a numeric weight used in ranking.
func SeverityWeight(s Severity) float64 {
	switch s {
	case SeverityPage:
		return 1.0
	case SeverityCritical:
		return 0.8
	case SeverityWarning:
		return 0.5
	case SeverityInfo:
		return 0.2
	default:
		return 0.1
	}
}

// ─── Action v2 ────────────────────────────────────────────────────────────────

const (
	ActionAlert          RuleAction = "alert"
	ActionEscalate       RuleAction = "escalate"
	ActionSuppress       RuleAction = "suppress"
	ActionCreateIncident RuleAction = "create_incident"
	// ActionEnrich and ActionFlag already declared in rule.go
)

// ─── Condition v2 ─────────────────────────────────────────────────────────────

// ConditionV2 extends RuleCondition with a weight for confidence scoring.
type ConditionV2 struct {
	Field    string       `yaml:"field"    json:"field"`
	Op       RuleOperator `yaml:"op"       json:"op"`
	Value    any          `yaml:"value"    json:"value"`
	Negate   bool         `yaml:"negate"   json:"negate,omitempty"`
	// Weight is the contribution of this condition to the rule's confidence
	// score when it matches. Weights across conditions need not sum to 1 —
	// the engine normalises them.
	Weight   float64      `yaml:"weight"   json:"weight"`
}

// ─── Confidence model ─────────────────────────────────────────────────────────

// ConfidenceModifier adjusts the running confidence score when its When
// condition evaluates to true.
type ConfidenceModifier struct {
	When   ConditionV2 `yaml:"when"   json:"when"`
	Adjust float64     `yaml:"adjust" json:"adjust"`
}

// ConfidenceConfig holds the confidence scoring parameters for a rule.
type ConfidenceConfig struct {
	// Base is the starting confidence when the rule first matches.
	Base      float64              `yaml:"base"      json:"base"`
	Modifiers []ConfidenceModifier `yaml:"modifiers" json:"modifiers,omitempty"`
}

// ─── Deduplication ────────────────────────────────────────────────────────────

// DedupConfig prevents alert storms by grouping repeated firings.
type DedupConfig struct {
	// Key is a Go text/template string evaluated against the EvalContext.
	// Firings with the same resolved key within Window are deduplicated.
	Key    string        `yaml:"key"      json:"key"`
	Window time.Duration `yaml:"window"   json:"window"`
	// MaxFire is the maximum number of times this rule can fire per
	// dedup key per Window. 0 means unlimited (dedup disabled).
	MaxFire int           `yaml:"max_fire" json:"max_fire"`
}

// ─── ConditionLogic v2 ────────────────────────────────────────────────────────

// ConditionLogicV2 adds MIN_N to the existing ALL/ANY logic.
type ConditionLogicV2 string

const (
	LogicV2All  ConditionLogicV2 = "ALL"
	LogicV2Any  ConditionLogicV2 = "ANY"
	LogicV2MinN ConditionLogicV2 = "MIN_N"
)

// ─── InfraRule ────────────────────────────────────────────────────────────────

// InfraRule is the full DSL v2 rule loaded from YAML or JSON.
// It is a superset of the original Rule and does not break existing callers.
type InfraRule struct {
	// Identity
	ID          string   `yaml:"id"          json:"id"`
	Version     int      `yaml:"version"     json:"version"`
	Name        string   `yaml:"name"        json:"name"`
	Description string   `yaml:"description" json:"description,omitempty"`
	Enabled     bool     `yaml:"enabled"     json:"enabled"`
	Priority    int      `yaml:"priority"    json:"priority"`
	Severity    Severity `yaml:"severity"    json:"severity"`
	Tags        []string `yaml:"tags"        json:"tags,omitempty"`

	// Conditions
	ConditionLogic ConditionLogicV2 `yaml:"condition_logic" json:"condition_logic"`
	MinMatch       int              `yaml:"min_match"       json:"min_match,omitempty"`
	Conditions     []ConditionV2   `yaml:"conditions"      json:"conditions"`

	// Confidence
	Confidence ConfidenceConfig `yaml:"confidence" json:"confidence"`

	// Action
	Action        RuleAction     `yaml:"action"         json:"action"`
	ActionPayload map[string]any `yaml:"action_payload" json:"action_payload,omitempty"`

	// Deduplication
	Dedup *DedupConfig `yaml:"dedup" json:"dedup,omitempty"`
}

// ─── Evaluation context ───────────────────────────────────────────────────────

// SignalContext carries the signal fields accessible as signal.* in rules.
type SignalContext struct {
	Kind        string  `json:"kind"`
	Value       float64 `json:"value"`
	ZScore      float64 `json:"z_score"`
	Anomaly     string  `json:"anomaly"`
	SampleCount int64   `json:"sample_count"`
	// Throughput is the co-located throughput signal value (set by enricher).
	Throughput  float64 `json:"throughput"`
	// PrevValue is the signal value from the previous tick (for rate_of_change).
	PrevValue   float64 `json:"prev_value"`
	WindowSecs  float64 `json:"window_secs"`
}

// BaselineContext carries baseline fields accessible as baseline.* in rules.
type BaselineContext struct {
	Mean   float64 `json:"mean"`
	StdDev float64 `json:"std_dev"`
	N      int64   `json:"n"`
}

// MetaContext carries request metadata accessible as meta.* in rules.
type MetaContext struct {
	TenantID    string `json:"tenant_id"`
	ServiceName string `json:"service"`
	Environment string `json:"environment"`
}

// EvalContext is the structured context passed to the v2 evaluator.
// The flat map used by the original evaluator is built from this struct.
type EvalContext struct {
	Signal   SignalContext         `json:"signal"`
	Baseline BaselineContext       `json:"baseline"`
	Meta     MetaContext           `json:"meta"`
	Context  map[string]any       `json:"context,omitempty"` // arbitrary extra fields
}

// ToFlatMap converts EvalContext into the nested map[string]any expected by
// the condition evaluator. The key format is "<namespace>.<field>".
func (e EvalContext) ToFlatMap() map[string]any {
	m := map[string]any{
		"signal": map[string]any{
			"kind":         e.Signal.Kind,
			"value":        e.Signal.Value,
			"z_score":      e.Signal.ZScore,
			"anomaly":      e.Signal.Anomaly,
			"sample_count": e.Signal.SampleCount,
			"throughput":   e.Signal.Throughput,
			"prev_value":   e.Signal.PrevValue,
			"window_secs":  e.Signal.WindowSecs,
		},
		"baseline": map[string]any{
			"mean":    e.Baseline.Mean,
			"std_dev": e.Baseline.StdDev,
			"n":       e.Baseline.N,
		},
		"meta": map[string]any{
			"tenant_id":   e.Meta.TenantID,
			"service":     e.Meta.ServiceName,
			"environment": e.Meta.Environment,
		},
	}
	// Merge extra context fields under "context.*"
	if len(e.Context) > 0 {
		m["context"] = e.Context
	}
	return m
}

// ─── Match result ─────────────────────────────────────────────────────────────

// RuleMatch is the rich result of a single rule evaluation.
type RuleMatch struct {
	RuleID        string         `json:"rule_id"`
	RuleName      string         `json:"rule_name"`
	Severity      Severity       `json:"severity"`
	Action        RuleAction     `json:"action"`
	ActionPayload map[string]any `json:"action_payload,omitempty"`

	// Confidence is the computed confidence score in [0, 1].
	Confidence float64 `json:"confidence"`

	// Score is the final ranking score (confidence × severity weight).
	Score float64 `json:"score"`

	// MatchedConditions is the count of conditions that matched.
	MatchedConditions int `json:"matched_conditions"`

	// DedupKey is the resolved deduplication key (empty if no dedup config).
	DedupKey string `json:"dedup_key,omitempty"`

	// Suppressed is true when the dedup window has already consumed MaxFire.
	Suppressed bool `json:"suppressed"`

	EvaluatedAt time.Time `json:"evaluated_at"`
}

// ─── Engine response ──────────────────────────────────────────────────────────

// InfraEvalResponse is returned by the v2 engine.
type InfraEvalResponse struct {
	TraceID string `json:"trace_id"`

	// Matches contains all rules that fired, sorted by Score descending.
	Matches []RuleMatch `json:"matches"`

	// TopMatch is the highest-scoring non-suppressed match, or nil.
	TopMatch *RuleMatch `json:"top_match,omitempty"`

	// SuppressedCount is the number of matches filtered by deduplication.
	SuppressedCount int `json:"suppressed_count"`

	EvaluationTimeMs int64 `json:"evaluation_time_ms"`
}
