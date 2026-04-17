// Package precompute — SignalFetcher interface and implementations.
//
// The fetcher is the data source for the precompute worker.  The interface
// decouples the worker from Kafka/HTTP/database — swap implementations without
// touching the worker logic.
//
// Implementations provided:
//   KafkaFetcher     — reads from the in-process signal store (Kafka consumer)
//   StaticFetcher    — injects a fixed slice (tests and local dev)
package precompute

import (
	"context"

	"github.com/tapas100/relevix/services/rule-engine/internal/domain"
)

// SignalFetcher returns the latest evaluation contexts for a tenant.
// Each EvalContext represents one signal observation (one tick from the
// signal-processor service).
//
// Implementations must be safe for concurrent use — multiple workers call
// Fetch for different tenants simultaneously.
type SignalFetcher interface {
	Fetch(ctx context.Context, tenantID string) ([]domain.EvalContext, error)
}

// RuleSource returns the active InfraRules for a tenant.
// Rules are typically loaded from the rule loader (YAML files) or a database.
type RuleSource interface {
	RulesForTenant(ctx context.Context, tenantID string) ([]domain.InfraRule, error)
}

// ImpactSource returns the ImpactInput for a given signal.
// Allows callers to inject blast-radius data from a CMDB or dependency graph.
type ImpactSource interface {
	ImpactFor(ctx context.Context, tenantID string, sig domain.EvalContext) (ImpactInput, error)
}

// ImpactInput mirrors scorer.ImpactInput but is redeclared here so the
// precompute package does not create a circular import through scorer.
// The Scheduler converts it to scorer.ImpactInput before calling scorer.Rank.
type ImpactInput struct {
	AffectedServiceCount int
	RequestsPerSecond    float64
	IsUserFacing         bool
	ExplicitScore        float64
}

// ─── StaticFetcher ────────────────────────────────────────────────────────────

// StaticFetcher is used in tests and local dev.  It returns a fixed set of
// EvalContexts regardless of tenantID.
type StaticFetcher struct {
	Contexts []domain.EvalContext
}

func (f *StaticFetcher) Fetch(_ context.Context, _ string) ([]domain.EvalContext, error) {
	out := make([]domain.EvalContext, len(f.Contexts))
	copy(out, f.Contexts)
	return out, nil
}

// ─── StaticRuleSource ─────────────────────────────────────────────────────────

// StaticRuleSource returns the same rule set for every tenant.
// Used in tests and single-tenant deployments.
type StaticRuleSource struct {
	Rules []domain.InfraRule
}

func (r *StaticRuleSource) RulesForTenant(_ context.Context, _ string) ([]domain.InfraRule, error) {
	out := make([]domain.InfraRule, len(r.Rules))
	copy(out, r.Rules)
	return out, nil
}

// ─── StaticImpactSource ───────────────────────────────────────────────────────

// StaticImpactSource returns the same impact for every signal.
// Used in tests.
type StaticImpactSource struct {
	Impact ImpactInput
}

func (s *StaticImpactSource) ImpactFor(_ context.Context, _ string, _ domain.EvalContext) (ImpactInput, error) {
	return s.Impact, nil
}
