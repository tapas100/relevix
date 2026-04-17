// Package domain holds the core rule-engine domain model.
// These types mirror the shared TypeScript types in libs/types.
package domain

import "time"

// ─── Rule ────────────────────────────────────────────────────────────────────

// RuleOperator represents the comparison operator for a rule condition.
type RuleOperator string

const (
	OpEq         RuleOperator = "eq"
	OpNeq        RuleOperator = "neq"
	OpGt         RuleOperator = "gt"
	OpGte        RuleOperator = "gte"
	OpLt         RuleOperator = "lt"
	OpLte        RuleOperator = "lte"
	OpIn         RuleOperator = "in"
	OpNotIn      RuleOperator = "not_in"
	OpContains   RuleOperator = "contains"
	OpStartsWith RuleOperator = "starts_with"
	OpEndsWith   RuleOperator = "ends_with"
	OpRegex      RuleOperator = "regex"
)

// RuleAction is the outcome when a rule matches.
type RuleAction string

const (
	ActionAllow     RuleAction = "allow"
	ActionDeny      RuleAction = "deny"
	ActionFlag      RuleAction = "flag"
	ActionEnrich    RuleAction = "enrich"
	ActionTransform RuleAction = "transform"
)

// ConditionLogic controls how multiple conditions are combined.
type ConditionLogic string

const (
	LogicAll ConditionLogic = "ALL" // AND
	LogicAny ConditionLogic = "ANY" // OR
)

// RuleCondition is a single predicate in a rule.
type RuleCondition struct {
	Field    string       `json:"field"`
	Operator RuleOperator `json:"operator"`
	Value    any          `json:"value"`
	Negate   bool         `json:"negate,omitempty"`
}

// Rule is the full rule entity persisted in the database.
type Rule struct {
	ID             string         `json:"id"`
	TenantID       string         `json:"tenantId"`
	Name           string         `json:"name"`
	Description    string         `json:"description,omitempty"`
	Version        int            `json:"version"`
	Priority       int            `json:"priority"`
	Conditions     []RuleCondition `json:"conditions"`
	ConditionLogic ConditionLogic `json:"conditionLogic"`
	Action         RuleAction     `json:"action"`
	ActionPayload  map[string]any `json:"actionPayload,omitempty"`
	IsActive       bool           `json:"isActive"`
	Tags           []string       `json:"tags"`
	CreatedAt      time.Time      `json:"createdAt"`
	UpdatedAt      time.Time      `json:"updatedAt"`
}

// ─── Evaluation ───────────────────────────────────────────────────────────────

// EvaluationRequest is the input to the rule evaluation engine.
type EvaluationRequest struct {
	TenantID string         `json:"tenantId" validate:"required,uuid4"`
	Context  map[string]any `json:"context"  validate:"required"`
	Tags     []string       `json:"tags,omitempty"`
	TraceID  string         `json:"traceId,omitempty"`
}

// EvaluationResult is the per-rule outcome.
type EvaluationResult struct {
	RuleID        string         `json:"ruleId"`
	RuleName      string         `json:"ruleName"`
	Matched       bool           `json:"matched"`
	Action        RuleAction     `json:"action"`
	ActionPayload map[string]any `json:"actionPayload,omitempty"`
	EvaluatedAt   time.Time      `json:"evaluatedAt"`
}

// EvaluationResponse is the aggregate result returned to the caller.
type EvaluationResponse struct {
	TraceID          string             `json:"traceId"`
	Results          []EvaluationResult `json:"results"`
	MatchedCount     int                `json:"matchedCount"`
	EvaluationTimeMs int64              `json:"evaluationTimeMs"`
}
