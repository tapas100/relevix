/**
 * SeverityBadge — colour-coded pill for a Severity value.
 */
import type { Severity } from '@relevix/types';

const LABELS: Record<Severity, string> = {
  page:     'PAGE',
  critical: 'CRIT',
  warning:  'WARN',
  info:     'INFO',
};

interface Props { severity: Severity }

export function SeverityBadge({ severity }: Props) {
  return (
    <span
      style={{
        display:       'inline-block',
        padding:       '2px 8px',
        borderRadius:  '999px',
        fontSize:      '11px',
        fontWeight:    600,
        letterSpacing: '0.05em',
        color:         'var(--bg)',
        background:    `var(--sev-${severity})`,
      }}
    >
      {LABELS[severity]}
    </span>
  );
}
