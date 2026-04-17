// Package query exposes a lightweight HTTP API for inspecting recent signals.
package query

import (
	"encoding/json"
	"net/http"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/tapas100/relevix/services/signal-processor/internal/domain"
)

const defaultRecentLimit = 500

// Store is a bounded in-memory buffer of recently emitted signals.
// It is safe for concurrent use.
type Store struct {
	mu      sync.RWMutex
	signals []*domain.Signal
	cap     int
	head    int
	size    int
}

// NewStore creates a store that retains at most cap signals.
func NewStore(cap int) *Store {
	return &Store{
		signals: make([]*domain.Signal, cap),
		cap:     cap,
	}
}

// Add inserts a signal into the ring, overwriting the oldest on overflow.
func (s *Store) Add(sig *domain.Signal) {
	s.mu.Lock()
	s.signals[s.head] = sig
	s.head = (s.head + 1) % s.cap
	if s.size < s.cap {
		s.size++
	}
	s.mu.Unlock()
}

// Query returns signals matching all non-empty filter values, ordered newest first.
func (s *Store) Query(tenantID, serviceName, kind string, from, to time.Time) []*domain.Signal {
	s.mu.RLock()
	defer s.mu.RUnlock()

	out := make([]*domain.Signal, 0, 64)
	for i := 0; i < s.size; i++ {
		idx := (s.head - 1 - i + s.cap) % s.cap
		sig := s.signals[idx]
		if sig == nil {
			continue
		}
		if tenantID != "" && sig.TenantID != tenantID {
			continue
		}
		if serviceName != "" && sig.ServiceName != serviceName {
			continue
		}
		if kind != "" && string(sig.Kind) != kind {
			continue
		}
		if !from.IsZero() && sig.WindowEnd.Before(from) {
			continue
		}
		if !to.IsZero() && sig.WindowEnd.After(to) {
			continue
		}
		out = append(out, sig)
	}
	return out
}

// ── HTTP handler ──────────────────────────────────────────────────────────────

// Handler mounts signal query endpoints onto a chi router.
type Handler struct {
	store *Store
}

// NewHandler creates a handler backed by store.
func NewHandler(store *Store) *Handler {
	return &Handler{store: store}
}

// Mount registers routes on r.
func (h *Handler) Mount(r chi.Router) {
	r.Get("/signals", h.getSignals)
	r.Get("/health", h.health)
}

// getSignals godoc
//
//	GET /signals?tenant=&service=&kind=&from=&to=
func (h *Handler) getSignals(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()

	var from, to time.Time
	if s := q.Get("from"); s != "" {
		t, err := time.Parse(time.RFC3339, s)
		if err != nil {
			http.Error(w, `{"error":"invalid 'from' timestamp, use RFC3339"}`, http.StatusBadRequest)
			return
		}
		from = t
	}
	if s := q.Get("to"); s != "" {
		t, err := time.Parse(time.RFC3339, s)
		if err != nil {
			http.Error(w, `{"error":"invalid 'to' timestamp, use RFC3339"}`, http.StatusBadRequest)
			return
		}
		to = t
	}

	signals := h.store.Query(
		q.Get("tenant"),
		q.Get("service"),
		q.Get("kind"),
		from, to,
	)

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"count":   len(signals),
		"signals": signals,
	})
}

func (h *Handler) health(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(`{"status":"ok","service":"signal-processor"}`))
}
