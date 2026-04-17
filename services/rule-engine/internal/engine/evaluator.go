// Package engine implements the core rule evaluation logic.
//
// Design principles:
//   - Pure functions: Evaluate takes inputs, returns outputs, no side effects.
//   - Deterministic: rules are sorted by priority (ascending) before evaluation.
//   - Context-safe: Evaluate is goroutine-safe (reads only).
package engine

import (
	"fmt"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/tapas100/relevix/services/rule-engine/internal/domain"
)

// Evaluate runs all active rules against the provided context.
// Rules are evaluated in ascending priority order (0 = highest priority).
// All rules are always evaluated (no short-circuit by default) to return
// the full result set. Callers can filter by Matched == true.
func Evaluate(rules []domain.Rule, req domain.EvaluationRequest) domain.EvaluationResponse {
	start := time.Now()

	// Sort by priority (stable to keep insertion order for ties)
	sorted := make([]domain.Rule, len(rules))
	copy(sorted, rules)
	sort.SliceStable(sorted, func(i, j int) bool {
		return sorted[i].Priority < sorted[j].Priority
	})

	results := make([]domain.EvaluationResult, 0, len(sorted))
	matchedCount := 0

	for _, rule := range sorted {
		if !rule.IsActive {
			continue
		}
		matched := evaluateRule(rule, req.Context)
		result := domain.EvaluationResult{
			RuleID:      rule.ID,
			RuleName:    rule.Name,
			Matched:     matched,
			Action:      rule.Action,
			EvaluatedAt: time.Now().UTC(),
		}
		if matched {
			result.ActionPayload = rule.ActionPayload
			matchedCount++
		}
		results = append(results, result)
	}

	return domain.EvaluationResponse{
		TraceID:          req.TraceID,
		Results:          results,
		MatchedCount:     matchedCount,
		EvaluationTimeMs: time.Since(start).Milliseconds(),
	}
}

// evaluateRule checks whether a single rule matches the context.
func evaluateRule(rule domain.Rule, ctx map[string]any) bool {
	if len(rule.Conditions) == 0 {
		return false
	}

	results := make([]bool, len(rule.Conditions))
	for i, cond := range rule.Conditions {
		result := evaluateCondition(cond, ctx)
		if cond.Negate {
			result = !result
		}
		results[i] = result
	}

	switch rule.ConditionLogic {
	case domain.LogicAll:
		for _, r := range results {
			if !r {
				return false
			}
		}
		return true
	case domain.LogicAny:
		for _, r := range results {
			if r {
				return true
			}
		}
		return false
	default:
		return false
	}
}

// evaluateCondition evaluates a single condition against the context.
// Field supports dot-notation: "user.address.country"
func evaluateCondition(cond domain.RuleCondition, ctx map[string]any) bool {
	fieldVal := resolvePath(cond.Field, ctx)
	if fieldVal == nil {
		return false
	}

	switch cond.Operator {
	case domain.OpEq:
		return reflect.DeepEqual(fieldVal, cond.Value)
	case domain.OpNeq:
		return !reflect.DeepEqual(fieldVal, cond.Value)
	case domain.OpGt, domain.OpGte, domain.OpLt, domain.OpLte:
		return compareNumeric(fieldVal, cond.Value, cond.Operator)
	case domain.OpIn:
		return containsValue(cond.Value, fieldVal)
	case domain.OpNotIn:
		return !containsValue(cond.Value, fieldVal)
	case domain.OpContains:
		return strings.Contains(fmt.Sprintf("%v", fieldVal), fmt.Sprintf("%v", cond.Value))
	case domain.OpStartsWith:
		return strings.HasPrefix(fmt.Sprintf("%v", fieldVal), fmt.Sprintf("%v", cond.Value))
	case domain.OpEndsWith:
		return strings.HasSuffix(fmt.Sprintf("%v", fieldVal), fmt.Sprintf("%v", cond.Value))
	case domain.OpRegex:
		pattern, ok := cond.Value.(string)
		if !ok {
			return false
		}
		re, err := regexp.Compile(pattern)
		if err != nil {
			return false
		}
		return re.MatchString(fmt.Sprintf("%v", fieldVal))
	}
	return false
}

// resolvePath extracts a value from a nested map using dot-notation.
func resolvePath(path string, ctx map[string]any) any {
	parts := strings.Split(path, ".")
	current := any(ctx)
	for _, part := range parts {
		m, ok := current.(map[string]any)
		if !ok {
			return nil
		}
		current, ok = m[part]
		if !ok {
			return nil
		}
	}
	return current
}

// compareNumeric compares two values numerically.
func compareNumeric(a, b any, op domain.RuleOperator) bool {
	af, aok := toFloat64(a)
	bf, bok := toFloat64(b)
	if !aok || !bok {
		return false
	}
	switch op {
	case domain.OpGt:
		return af > bf
	case domain.OpGte:
		return af >= bf
	case domain.OpLt:
		return af < bf
	case domain.OpLte:
		return af <= bf
	}
	return false
}

func toFloat64(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case float32:
		return float64(n), true
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	case int32:
		return float64(n), true
	}
	return 0, false
}

func containsValue(list, target any) bool {
	rv := reflect.ValueOf(list)
	if rv.Kind() != reflect.Slice {
		return false
	}
	for i := range rv.Len() {
		if reflect.DeepEqual(rv.Index(i).Interface(), target) {
			return true
		}
	}
	return false
}
