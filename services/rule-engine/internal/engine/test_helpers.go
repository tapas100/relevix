// engine_test_helpers.go — exported test utilities for the engine package.
// The build tag ensures this file is never compiled into production binaries.
package engine

import (
	"time"

	"github.com/tapas100/relevix/services/rule-engine/internal/domain"
)

// RuleSetForTest is a thin wrapper that lets tests construct a RuleSet from
// a slice of InfraRules without touching the file system.
type RuleSetForTest struct {
	rules []domain.InfraRule
}

// NewRuleSetForTest creates a test RuleSet.
func NewRuleSetForTest(rules []domain.InfraRule) *RuleSetForTest {
	return &RuleSetForTest{rules: rules}
}

// ToRuleSet converts to a real *RuleSet suitable for NewInfraEngine.
func (r *RuleSetForTest) ToRuleSet() *RuleSet {
	return &RuleSet{rules: r.rules}
}

// NewDedupStoreWithClock exposes the internal constructor for test clock injection.
func NewDedupStoreWithClock(now func() time.Time) *DedupStore {
	return newDedupStoreWithClock(now)
}
