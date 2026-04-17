/**
 * Dashboard — root layout component.
 *
 * Layout (two-column on wide screens, stacked on narrow):
 *
 *   ┌─────────────────────────────────────────────────────┐
 *   │  Relevix                          refreshed 3s ago  │
 *   │  [All] [checkout] [payment] …                       │
 *   ├───────────────────────┬─────────────────────────────┤
 *   │  Top Insights         │  Metrics                    │
 *   │  ┌────────────────┐   │  ┌─────────────────────┐   │
 *   │  │ #1 PAGE  …     │   │  │  P95 Latency ~~~~    │   │
 *   │  │ #2 CRIT  …     │   │  │  Error Rate  ~~~~    │   │
 *   │  │ #3 WARN  …     │   │  └─────────────────────┘   │
 *   │  └────────────────┘   │                             │
 *   └───────────────────────┴─────────────────────────────┘
 */
import { useState, useMemo } from 'react';
import { useInsights } from '../hooks/useInsights';
import { useMetrics } from '../hooks/useMetrics';
import { InsightsPanel } from './InsightsPanel';
import { ServiceFilter, extractServices } from './ServiceFilter';
import { MetricsGraph } from './MetricsGraph';

function formatAge(iso: string | undefined): string {
  if (!iso) return '';
  const diffSec = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (diffSec < 5)  return 'just now';
  if (diffSec < 60) return `${String(diffSec)}s ago`;
  return `${String(Math.round(diffSec / 60))}m ago`;
}

export function Dashboard() {
  const [service, setService] = useState<string | undefined>(undefined);

  const { data, loading, error, refresh } = useInsights(service, 3);

  const allInsights = useMemo(() => data?.insights ?? [], [data]);
  const services    = useMemo(() => extractServices(allInsights), [allInsights]);
  const metrics     = useMetrics(allInsights, service);

  return (
    <div
      style={{
        minHeight:   '100vh',
        display:     'flex',
        flexDirection: 'column',
        gap:         'var(--space-6)',
        padding:     'var(--space-6)',
        maxWidth:    1200,
        margin:      '0 auto',
        width:       '100%',
      }}
    >
      {/* ── Header ─────────────────────────────────────────── */}
      <header
        style={{
          display:        'flex',
          alignItems:     'center',
          justifyContent: 'space-between',
          gap:            'var(--space-4)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
          {/* Wordmark */}
          <span
            style={{
              fontSize:      20,
              fontWeight:    600,
              letterSpacing: '-0.02em',
              background:    'linear-gradient(135deg, var(--accent), #818cf8)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor:  'transparent',
            }}
          >
            Relevix
          </span>
          <span
            style={{
              fontSize:     12,
              color:        'var(--text-muted)',
              padding:      '2px 8px',
              background:   'var(--surface)',
              border:       '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)',
            }}
          >
            Infrastructure Intelligence
          </span>
        </div>

        {/* Refresh info + button */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
          {data?.computedAt && (
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              computed {formatAge(data.computedAt)}
              {data.fromCache && (
                <span
                  style={{
                    marginLeft:   6,
                    fontSize:     10,
                    color:        'var(--accent)',
                    border:       '1px solid var(--accent-dim)',
                    borderRadius: 'var(--radius-sm)',
                    padding:      '1px 5px',
                  }}
                >
                  cached
                </span>
              )}
            </span>
          )}
          <button
            onClick={refresh}
            aria-label="Refresh insights"
            style={{
              padding:      '5px 14px',
              borderRadius: 'var(--radius-sm)',
              fontSize:     13,
              fontWeight:   500,
              color:        'var(--text)',
              background:   'var(--surface-alt)',
              border:       '1px solid var(--border)',
              transition:   'background var(--transition)',
            }}
          >
            ↺ Refresh
          </button>
        </div>
      </header>

      {/* ── Service filter ──────────────────────────────────── */}
      {!loading && services.length > 0 && (
        <ServiceFilter
          services={services}
          selected={service}
          onChange={setService}
        />
      )}

      {/* ── Main grid ──────────────────────────────────────── */}
      <div
        style={{
          display:             'grid',
          gridTemplateColumns: 'minmax(0,1.2fr) minmax(0,1fr)',
          gap:                 'var(--space-6)',
          alignItems:          'start',
        }}
      >
        {/* Left: insights */}
        <section>
          <h2
            style={{
              fontSize:     13,
              fontWeight:   600,
              color:        'var(--text-muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              marginBottom: 'var(--space-4)',
            }}
          >
            Top Insights
            {data && (
              <span
                style={{
                  marginLeft:   8,
                  fontSize:     11,
                  fontWeight:   400,
                  color:        'var(--text-muted)',
                }}
              >
                ({data.total} total)
              </span>
            )}
          </h2>
          <InsightsPanel data={data} loading={loading} error={error} />
        </section>

        {/* Right: graphs */}
        <section>
          <h2
            style={{
              fontSize:     13,
              fontWeight:   600,
              color:        'var(--text-muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              marginBottom: 'var(--space-4)',
            }}
          >
            Metrics
            <span
              style={{
                marginLeft:   8,
                fontSize:     11,
                fontWeight:   400,
                color:        'var(--text-muted)',
              }}
            >
              (last 60 min)
            </span>
          </h2>
          <MetricsGraph metrics={metrics} />
        </section>
      </div>
    </div>
  );
}
