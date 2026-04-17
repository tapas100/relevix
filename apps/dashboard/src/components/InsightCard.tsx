/**
 * InsightCard — single ranked insight with severity, scores and timing.
 *
 * Layout:
 *  ┌──────────────────────────────────────────────────────┐
 *  │  #1  [PAGE]  latency-p95-spike           2 min ago  │
 *  │  P95 latency exceeded threshold …                    │
 *  │  ▬ composite  92%   ▬ confidence  87%               │
 *  │  ▬ recency    78%   ▬ impact      65%               │
 *  └──────────────────────────────────────────────────────┘
 */
import type { RankedInsight } from '@relevix/types';
import { SeverityBadge } from './SeverityBadge';
import { ScoreBar } from './ScoreBar';

const RULE_LABELS: Record<string, string> = {
  'latency-p95-spike':           'P95 latency exceeded threshold by >3σ.',
  'error-rate-critical':         'Error rate crossed the critical threshold (>5%).',
  'throughput-drop':             'Request throughput dropped >40% from baseline.',
  'cascading-failure-detection': 'Correlated failures detected across multiple services.',
  'baseline-regression':         'Performance regressed 1.5×–2.5× above baseline.',
};

function timeAgo(iso: string): string {
  const diffMs  = Date.now() - new Date(iso).getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1)   return 'just now';
  if (diffMin < 60)  return `${String(diffMin)} min ago`;
  const hrs = Math.floor(diffMin / 60);
  return `${String(hrs)} hr ago`;
}

interface Props { rankedInsight: RankedInsight }

export function InsightCard({ rankedInsight }: Props) {
  const { rank, insight, components } = rankedInsight;
  const desc = RULE_LABELS[insight.ruleId] ?? `Rule "${insight.ruleId}" fired.`;

  return (
    <article
      style={{
        background:   'var(--surface)',
        border:       '1px solid var(--border)',
        borderRadius: 'var(--radius-md)',
        padding:      'var(--space-5)',
        display:      'flex',
        flexDirection: 'column',
        gap:          'var(--space-4)',
        transition:   'border-color var(--transition)',
      }}
    >
      {/* ── Header ─────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
        <span
          style={{
            fontSize:   13,
            fontWeight: 600,
            color:      'var(--text-muted)',
            minWidth:   24,
          }}
        >
          #{rank}
        </span>

        <SeverityBadge severity={insight.severity} />

        <span
          style={{
            flex:       1,
            fontWeight: 500,
            fontSize:   14,
            overflow:   'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={insight.ruleName}
        >
          {insight.ruleName}
        </span>

        <time
          dateTime={insight.firedAt}
          style={{ fontSize: 12, color: 'var(--text-muted)', flexShrink: 0 }}
        >
          {timeAgo(insight.firedAt)}
        </time>
      </div>

      {/* ── Description ─────────────────────────────────────── */}
      <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.6 }}>
        {desc}
      </p>

      {/* ── Score bars ──────────────────────────────────────── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <ScoreBar label="composite"  value={components.composite}  color="var(--accent)" />
        <ScoreBar label="confidence" value={components.confidence} color="var(--sev-info)" />
        <ScoreBar label="recency"    value={components.recency}    color="var(--sev-warning)" />
        <ScoreBar label="impact"     value={components.impact}     color="var(--sev-critical)" />
      </div>
    </article>
  );
}
