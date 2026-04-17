/**
 * ServiceFilter — a compact pill selector for known services,
 * plus an "All" default.
 *
 * Services are derived from the live insight data so the list is always
 * accurate — no hardcoded values.
 */
import type { RankedInsight } from '@relevix/types';

interface Props {
  services:  string[];
  selected?: string;
  onChange:  (service: string | undefined) => void;
}

export function ServiceFilter({ services, selected, onChange }: Props) {
  const all = ['__all__', ...services];

  return (
    <div
      role="group"
      aria-label="Service filter"
      style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}
    >
      {all.map((svc) => {
        const isActive = svc === '__all__' ? selected === undefined : selected === svc;
        return (
          <button
            key={svc}
            onClick={() => onChange(svc === '__all__' ? undefined : svc)}
            aria-pressed={isActive}
            style={{
              padding:      '4px 14px',
              borderRadius: '999px',
              fontSize:     13,
              fontWeight:   isActive ? 600 : 400,
              color:        isActive ? 'var(--bg)'    : 'var(--text-muted)',
              background:   isActive ? 'var(--accent)' : 'var(--surface-alt)',
              border:       `1px solid ${isActive ? 'var(--accent)' : 'var(--border)'}`,
              transition:   'all var(--transition)',
            }}
          >
            {svc === '__all__' ? 'All' : svc}
          </button>
        );
      })}
    </div>
  );
}

/** Extracts unique service names from a ranked insight list. */
export function extractServices(insights: RankedInsight[]): string[] {
  const set = new Set<string>();
  for (const ri of insights) {
    const svc = ri.insight.signal?.['service'];
    if (typeof svc === 'string') set.add(svc);
  }
  return [...set].sort();
}
