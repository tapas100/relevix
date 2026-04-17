// Package middleware provides HTTP middleware for the rule-engine service.
package middleware

import (
	"context"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5/middleware"
	"github.com/rs/zerolog"
)

type contextKey string

const traceIDKey contextKey = "traceId"

// TraceContext extracts the X-Request-ID header (set by chi's RequestID
// middleware) and stores it in the context as traceId.
func TraceContext(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		traceID := middleware.GetReqID(r.Context())
		ctx := context.WithValue(r.Context(), traceIDKey, traceID)
		w.Header().Set("X-Trace-Id", traceID)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// TraceIDFromContext retrieves the traceId from the context.
func TraceIDFromContext(ctx context.Context) string {
	if v, ok := ctx.Value(traceIDKey).(string); ok {
		return v
	}
	return ""
}

// RequestLogger logs each HTTP request using zerolog.
func RequestLogger(log zerolog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
			start := time.Now()

			defer func() {
				log.Info().
					Str("method", r.Method).
					Str("path", r.URL.Path).
					Int("status", ww.Status()).
					Int64("latencyMs", time.Since(start).Milliseconds()).
					Str("traceId", middleware.GetReqID(r.Context())).
					Msg("request")
			}()

			next.ServeHTTP(ww, r)
		})
	}
}
