package engine

import (
	"testing"
	"time"

	"github.com/tapas100/relevix/services/rule-engine/internal/domain"
)

func makeRule(logic domain.ConditionLogic, conds ...domain.RuleCondition) domain.Rule {
	return domain.Rule{
		ID:             "rule-1",
		Name:           "Test Rule",
		IsActive:       true,
		Priority:       1,
		ConditionLogic: logic,
		Action:         domain.ActionAllow,
		Conditions:     conds,
		CreatedAt:      time.Now(),
		UpdatedAt:      time.Now(),
	}
}

func TestEvaluate_SimpleEq(t *testing.T) {
	rule := makeRule(domain.LogicAll, domain.RuleCondition{
		Field: "user.country", Operator: domain.OpEq, Value: "US",
	})

	resp := Evaluate([]domain.Rule{rule}, domain.EvaluationRequest{
		TenantID: "tenant-1",
		Context:  map[string]any{"user": map[string]any{"country": "US"}},
		TraceID:  "trace-1",
	})

	if resp.MatchedCount != 1 {
		t.Errorf("expected 1 match, got %d", resp.MatchedCount)
	}
	if !resp.Results[0].Matched {
		t.Error("expected rule to match")
	}
}

func TestEvaluate_NegatedCondition(t *testing.T) {
	rule := makeRule(domain.LogicAll, domain.RuleCondition{
		Field: "user.country", Operator: domain.OpEq, Value: "US", Negate: true,
	})

	resp := Evaluate([]domain.Rule{rule}, domain.EvaluationRequest{
		TenantID: "tenant-1",
		Context:  map[string]any{"user": map[string]any{"country": "US"}},
	})

	if resp.MatchedCount != 0 {
		t.Errorf("expected 0 matches, got %d", resp.MatchedCount)
	}
}

func TestEvaluate_AnyLogic(t *testing.T) {
	rule := makeRule(
		domain.LogicAny,
		domain.RuleCondition{Field: "score", Operator: domain.OpGte, Value: float64(90)},
		domain.RuleCondition{Field: "vip", Operator: domain.OpEq, Value: true},
	)

	resp := Evaluate([]domain.Rule{rule}, domain.EvaluationRequest{
		TenantID: "tenant-1",
		Context:  map[string]any{"score": float64(50), "vip": true},
	})

	if resp.MatchedCount != 1 {
		t.Errorf("expected 1 match, got %d", resp.MatchedCount)
	}
}

func TestEvaluate_InactiveRuleSkipped(t *testing.T) {
	rule := makeRule(domain.LogicAll, domain.RuleCondition{
		Field: "x", Operator: domain.OpEq, Value: "y",
	})
	rule.IsActive = false

	resp := Evaluate([]domain.Rule{rule}, domain.EvaluationRequest{
		TenantID: "tenant-1",
		Context:  map[string]any{"x": "y"},
	})

	if len(resp.Results) != 0 {
		t.Errorf("expected inactive rule to be skipped")
	}
}
