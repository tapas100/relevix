/**
 * InsightsPanel — the top-3 insights list with a loading skeleton and
 * an empty state.
 */
import type { InsightsData } from '@relevix/types';
import { InsightCard } from './InsightCard';

// ── Skeleton ──────────────────────────────────────────────────────────────────

function Skeleton() {
  return (
    <div
      style={{
        background:   'var(--surface)',
        border:       '1px solid var(--border)',
        borderRadius: 'var(--radius-md)',
        padding:      'var(--space-5)',
        height:       160,
        animation:    'pulse 1.5s ease-in-out infinite',
      }}
    />
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────

function Empty() {
  return (
    <div
      style={{
        textAlign:    'center',
        padding:      'var(--space-8)',
        color:        'var(--text-muted)',
        background:   'var(--surface)',
        border:       '1px dashed var(--border)',
        borderRadius: 'var(--radius-md)',
      }}
    >
      <div style={{ fontSize: 32, marginBottom: 'var(--space-3)' }}>✓</div>
      <p style={{ fontWeight: 500 }}>No active insights</p>
      <p style={{ fontSize: 12, marginTop: 'var(--space-1)' }}>System is operating normally.</p>
    </div>
  );
}

// ── Panel ─────────────────────────────────────────────────────────────────────

interface Props {
  data:    InsightsData | null;
  loading: boolean;
  error:   string | null;
}

export function InsightsPanel({ data, loading, error }: Props) {
  if (loading) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <Skeleton />
        <Skeleton />
        <Skeleton />
      </div>
    );
  }

  if (error) {
    return (
      <div
        style={{
          padding:      'var(--space-4)',
          borderRadius: 'var(--radius-md)',
          background:   'rgba(248,113,113,.08)',
          border:       '1px solid rgba(248,113,113,.3)',
          color:        'var(--sev-page)',
          fontSize:     13,
        }}
      >
        {error}
      </div>
    );
  }

  const insights = data?.insights ?? [];

  if (insights.length === 0) return <Empty />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      {insights.map((ri) => (
        <InsightCard key={ri.insight.id} rankedInsight={ri} />
      ))}
    </div>
  );
}
