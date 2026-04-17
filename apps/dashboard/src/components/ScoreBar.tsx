/**
 * ScoreBar — narrow horizontal bar visualising a 0–1 score.
 * Used to show the four component scores on an InsightCard.
 */
interface Props {
  label: string;
  value: number;   // 0–1
  color?: string;
}

export function ScoreBar({ label, value, color = 'var(--accent)' }: Props) {
  const pct = Math.round(value * 100);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
      <span style={{ width: 72, color: 'var(--text-muted)', fontSize: 12, flexShrink: 0 }}>
        {label}
      </span>
      <div
        style={{
          flex:         1,
          height:       4,
          borderRadius: 2,
          background:   'var(--border)',
          overflow:     'hidden',
        }}
      >
        <div
          style={{
            width:        `${String(pct)}%`,
            height:       '100%',
            background:   color,
            borderRadius: 2,
            transition:   'width 0.4s ease',
          }}
        />
      </div>
      <span style={{ width: 32, textAlign: 'right', fontSize: 12, color: 'var(--text-muted)' }}>
        {pct}%
      </span>
    </div>
  );
}
