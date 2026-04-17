// Package engine — rule loader.
//
// Loads InfraRule lists from YAML or JSON files.
// Validates each rule before accepting it:
//   - ID and Name are required.
//   - Version must be > 0.
//   - Conditions list must be non-empty.
//   - Confidence.Base must be in (0, 1].
//   - Dedup.Window must be positive if a Dedup block is present.
//
// Hot-reload: LoadDir returns a RuleSet whose Reload() method re-reads all
// files without restarting the process. The engine holds a pointer to the
// RuleSet and calls Rules() on every evaluation, so updates are atomic.
package engine

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"gopkg.in/yaml.v3"

	"github.com/tapas100/relevix/services/rule-engine/internal/domain"
)

// RuleSet holds a snapshot of loaded and validated InfraRules.
// It is safe for concurrent read.
type RuleSet struct {
	mu    sync.RWMutex
	rules []domain.InfraRule
	dir   string // directory to reload from
}

// Rules returns a snapshot of the current rule list.
func (rs *RuleSet) Rules() []domain.InfraRule {
	rs.mu.RLock()
	defer rs.mu.RUnlock()
	out := make([]domain.InfraRule, len(rs.rules))
	copy(out, rs.rules)
	return out
}

// Reload re-reads all YAML/JSON files in the configured directory.
// On any parse or validation error the existing rules are kept unchanged.
func (rs *RuleSet) Reload() error {
	fresh, err := loadDir(rs.dir)
	if err != nil {
		return err
	}
	rs.mu.Lock()
	rs.rules = fresh
	rs.mu.Unlock()
	return nil
}

// LoadDir reads every *.yml, *.yaml, and *.json file in dir, parses the
// top-level "rules:" list, validates each rule, and returns a RuleSet.
func LoadDir(dir string) (*RuleSet, error) {
	rules, err := loadDir(dir)
	if err != nil {
		return nil, err
	}
	return &RuleSet{rules: rules, dir: dir}, nil
}

func loadDir(dir string) ([]domain.InfraRule, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, fmt.Errorf("rule loader: read dir %q: %w", dir, err)
	}

	var all []domain.InfraRule
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		if !isRuleFile(name) {
			continue
		}
		path := filepath.Join(dir, name)
		rules, err := loadFile(path)
		if err != nil {
			return nil, fmt.Errorf("rule loader: file %q: %w", path, err)
		}
		all = append(all, rules...)
	}
	return all, nil
}

func loadFile(path string) ([]domain.InfraRule, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	var envelope struct {
		Rules []domain.InfraRule `yaml:"rules" json:"rules"`
	}

	ext := strings.ToLower(filepath.Ext(path))
	switch ext {
	case ".yml", ".yaml":
		if err := yaml.Unmarshal(data, &envelope); err != nil {
			return nil, fmt.Errorf("yaml parse: %w", err)
		}
	case ".json":
		if err := json.Unmarshal(data, &envelope); err != nil {
			return nil, fmt.Errorf("json parse: %w", err)
		}
	default:
		return nil, fmt.Errorf("unsupported file extension: %s", ext)
	}

	for i, r := range envelope.Rules {
		if err := validateRule(r); err != nil {
			return nil, fmt.Errorf("rule[%d] %q: %w", i, r.ID, err)
		}
	}
	return envelope.Rules, nil
}

func validateRule(r domain.InfraRule) error {
	if r.ID == "" {
		return fmt.Errorf("id is required")
	}
	if r.Name == "" {
		return fmt.Errorf("name is required")
	}
	if r.Version <= 0 {
		return fmt.Errorf("version must be > 0")
	}
	if len(r.Conditions) == 0 {
		return fmt.Errorf("at least one condition is required")
	}
	if r.Confidence.Base <= 0 || r.Confidence.Base > 1 {
		return fmt.Errorf("confidence.base must be in (0, 1]")
	}
	if r.Dedup != nil && r.Dedup.Window <= 0 {
		return fmt.Errorf("dedup.window must be positive")
	}
	if r.ConditionLogic == domain.LogicV2MinN && r.MinMatch <= 0 {
		return fmt.Errorf("min_match must be > 0 when condition_logic is MIN_N")
	}
	return nil
}

func isRuleFile(name string) bool {
	ext := strings.ToLower(filepath.Ext(name))
	return ext == ".yml" || ext == ".yaml" || ext == ".json"
}
