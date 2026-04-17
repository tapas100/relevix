// Package engine — v2 condition evaluator.
//
// Handles all operators from the DSL v2 schema, including the infra-specific
// ones: between, stddev_above, percent_change, rate_of_change, exists, missing.
//
// All functions are pure and goroutine-safe.
package engine

import (
	"fmt"
	"math"
	"strings"

	"github.com/tapas100/relevix/services/rule-engine/internal/domain"
)

// EvalConditionV2 evaluates a ConditionV2 against a flat context map.
// Returns (matched bool, weight float64).
// Weight is 0 if the condition did not match.
func EvalConditionV2(cond domain.ConditionV2, ctx map[string]any) (bool, float64) {
	matched := evalConditionInner(cond, ctx)
	if cond.Negate {
		matched = !matched
	}
	if matched {
		return true, cond.Weight
	}
	return false, 0
}

func evalConditionInner(cond domain.ConditionV2, ctx map[string]any) bool {
	// exists / missing operate on the key, not the value.
	if cond.Op == domain.OpExists {
		return resolvePath(cond.Field, ctx) != nil
	}
	if cond.Op == domain.OpMissing {
		return resolvePath(cond.Field, ctx) == nil
	}

	fieldVal := resolvePath(cond.Field, ctx)
	if fieldVal == nil {
		return false
	}

	switch cond.Op {
	// ── pass-through to original engine for common operators ──────────────────
	case domain.OpEq, domain.OpNeq,
		domain.OpGt, domain.OpGte, domain.OpLt, domain.OpLte,
		domain.OpIn, domain.OpNotIn,
		domain.OpContains, domain.OpStartsWith, domain.OpEndsWith,
		domain.OpRegex:

		// Delegate to original evaluator by wrapping as RuleCondition.
		rc := domain.RuleCondition{
			Field:    cond.Field,
			Operator: cond.Op,
			Value:    cond.Value,
		}
		return evaluateCondition(rc, ctx)

	// ── between [lo, hi] ──────────────────────────────────────────────────────
	case domain.OpBetween:
		fv, ok := toFloat64(fieldVal)
		if !ok {
			return false
		}
		bounds, ok := toBounds(cond.Value)
		if !ok {
			return false
		}
		return fv >= bounds[0] && fv <= bounds[1]

	// ── stddev_above N ────────────────────────────────────────────────────────
	// Reads baseline.std_dev and baseline.mean from the context to compute
	// the dynamic threshold: mean + N*stddev.
	case domain.OpStddevAbove:
		fv, ok := toFloat64(fieldVal)
		if !ok {
			return false
		}
		n, ok := toFloat64(cond.Value)
		if !ok {
			return false
		}
		mean, mOK := toFloat64(resolvePath("baseline.mean", ctx))
		sd, sOK := toFloat64(resolvePath("baseline.std_dev", ctx))
		if !mOK || !sOK || sd == 0 {
			return false
		}
		threshold := mean + n*sd
		return fv >= threshold

	// ── percent_change  ───────────────────────────────────────────────────────
	// Compares field to baseline.mean by percentage.
	// percent_change < 0 → drop below baseline (e.g. throughput loss).
	// percent_change > 0 → rise above baseline (e.g. latency spike).
	case domain.OpPercentChange:
		fv, ok := toFloat64(fieldVal)
		if !ok {
			return false
		}
		threshold, ok := toFloat64(cond.Value)
		if !ok {
			return false
		}
		mean, mOK := toFloat64(resolvePath("baseline.mean", ctx))
		if !mOK || mean == 0 {
			return false
		}
		pct := ((fv - mean) / math.Abs(mean)) * 100.0
		// threshold negative → check if pct ≤ threshold (drop)
		// threshold positive → check if pct ≥ threshold (rise)
		if threshold < 0 {
			return pct <= threshold
		}
		return pct >= threshold

	// ── rate_of_change value/s ────────────────────────────────────────────────
	// Computes (signal.value - signal.prev_value) / signal.window_secs.
	// Fires when the instantaneous rate exceeds the threshold.
	case domain.OpRateOfChange:
		fv, ok := toFloat64(fieldVal)
		if !ok {
			return false
		}
		threshold, ok := toFloat64(cond.Value)
		if !ok {
			return false
		}
		prev, pOK := toFloat64(resolvePath("signal.prev_value", ctx))
		windowSecs, wOK := toFloat64(resolvePath("signal.window_secs", ctx))
		if !pOK || !wOK || windowSecs == 0 {
			return false
		}
		rate := (fv - prev) / windowSecs
		return rate >= threshold
	}

	return false
}

// ── helpers ───────────────────────────────────────────────────────────────────

func toBounds(v any) ([2]float64, bool) {
	// Accept []any, []float64, or []interface{} from YAML/JSON unmarshal.
	switch s := v.(type) {
	case []any:
		if len(s) != 2 {
			return [2]float64{}, false
		}
		lo, lok := toFloat64(s[0])
		hi, hok := toFloat64(s[1])
		if !lok || !hok {
			return [2]float64{}, false
		}
		return [2]float64{lo, hi}, true
	case []float64:
		if len(s) != 2 {
			return [2]float64{}, false
		}
		return [2]float64{s[0], s[1]}, true
	}
	return [2]float64{}, false
}

// FormatConditionV2 returns a human-readable description of a condition.
// Used for logging and debugging.
func FormatConditionV2(c domain.ConditionV2) string {
	neg := ""
	if c.Negate {
		neg = "NOT "
	}
	return fmt.Sprintf("%s%s %s %v (w=%.2f)", neg, c.Field, strings.ToUpper(string(c.Op)), c.Value, c.Weight)
}
