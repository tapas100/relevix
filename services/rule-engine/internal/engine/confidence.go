// Package engine — confidence scoring system.
//
// Confidence is a [0, 1] float that answers:
//   "How certain are we that this match represents a real problem?"
//
// Algorithm:
//   1. Start from rule.Confidence.Base.
//   2. Compute a weighted sum of matched conditions:
//        weightedScore = Σ(weight_i) for each matched condition_i
//        maxWeight     = Σ(weight_i) for all conditions with weight > 0
//        condScore     = weightedScore / maxWeight  (0 if maxWeight == 0)
//   3. Blend base with condScore:
//        confidence = base * (1 - condBlend) + condScore * condBlend
//      where condBlend = 0.4 (conditions contribute 40% of final score).
//   4. Apply modifiers in order (additive deltas, clamped after each step).
//   5. Clamp final result to [0, 1].
//
// This design means:
//   - A rule can fire with base confidence even when weights aren't set.
//   - High-weight conditions amplify confidence; low sample counts reduce it.
//   - Contextual modifiers (prod vs staging, z-score magnitude) fine-tune.
package engine

import (
	"github.com/tapas100/relevix/services/rule-engine/internal/domain"
)

const condBlend = 0.4 // weight of condition-derived score in final blend

// ComputeConfidence returns the final confidence score for a rule that has
// already matched. matchedWeights is the slice of weights from conditions that
// evaluated to true; allWeights is from all non-selector conditions.
func ComputeConfidence(
	cfg domain.ConfidenceConfig,
	matchedWeights []float64,
	allWeights []float64,
	ctx map[string]any,
) float64 {

	// Step 1: weighted condition score
	condScore := weightedScore(matchedWeights, allWeights)

	// Step 2: blend base + condition score
	conf := cfg.Base*(1-condBlend) + condScore*condBlend

	// Step 3: apply modifiers
	for _, mod := range cfg.Modifiers {
		matched, _ := EvalConditionV2(mod.When, ctx)
		if matched {
			conf += mod.Adjust
		}
		conf = clamp01(conf)
	}

	return clamp01(conf)
}

// weightedScore computes Σmatched / Σall, or 0 if all weights are 0.
func weightedScore(matched, all []float64) float64 {
	total := sum(all)
	if total == 0 {
		return 0
	}
	return clamp01(sum(matched) / total)
}

func sum(s []float64) float64 {
	var t float64
	for _, v := range s {
		t += v
	}
	return t
}

func clamp01(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 1 {
		return 1
	}
	return v
}
