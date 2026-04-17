/**
 * MetricsGraph — dual-panel area chart: P95 latency (ms) + Error rate (%).
 *
 * Uses Recharts AreaChart so the graphs are:
 *  - Responsive (fills available width)
 *  - Animated on data change
 *  - Gradient-filled for visual depth
 *
 * Both charts share the same x-axis (time) so vertical alignment is implicit.
 */
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from 'recharts';
import type { ServiceMetrics } from '../types/metrics';

// ── Helpers ───────────────────────────────────────────────────────────────────

function shortTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function tickFormatter(v: number, unit: string): string {
  return `${String(Math.round(v))}${unit}`;
}

// ── Sub-chart ─────────────────────────────────────────────────────────────────

interface ChartProps {
  data:       { t: string; v: number }[];
  color:      string;
  gradientId: string;
  unit:       string;
  label:      string;
}

function MiniChart({ data, color, gradientId, unit, label }: ChartProps) {
  const chartData = data.map((p) => ({ t: shortTime(p.t), v: Number(p.v.toFixed(2)) }));

  return (
    <div>
      <p
        style={{
          fontSize:     12,
          fontWeight:   500,
          color:        'var(--text-muted)',
          marginBottom: 'var(--space-2)',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
        }}
      >
        {label}
      </p>

      <ResponsiveContainer width="100%" height={120}>
        <AreaChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%"  stopColor={color} stopOpacity={0.25} />
              <stop offset="95%" stopColor={color} stopOpacity={0}    />
            </linearGradient>
          </defs>

          <CartesianGrid
            strokeDasharray="3 3"
            stroke="var(--border)"
            vertical={false}
          />

          <XAxis
            dataKey="t"
            tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
            tickLine={false}
            axisLine={false}
            interval="preserveStartEnd"
          />

          <YAxis
            tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v: number) => tickFormatter(v, unit)}
            width={42}
          />

          <Tooltip
            contentStyle={{
              background:   'var(--surface-alt)',
              border:       '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)',
              fontSize:     12,
            }}
            labelStyle={{ color: 'var(--text-muted)' }}
            formatter={(v: number) => [`${String(v)}${unit}`, label]}
          />

          <Area
            type="monotone"
            dataKey="v"
            stroke={color}
            strokeWidth={2}
            fill={`url(#${gradientId})`}
            dot={false}
            activeDot={{ r: 3, strokeWidth: 0 }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

// ── Public component ──────────────────────────────────────────────────────────

interface Props { metrics: ServiceMetrics }

export function MetricsGraph({ metrics }: Props) {
  return (
    <div
      style={{
        background:   'var(--surface)',
        border:       '1px solid var(--border)',
        borderRadius: 'var(--radius-md)',
        padding:      'var(--space-5)',
        display:      'flex',
        flexDirection: 'column',
        gap:          'var(--space-6)',
      }}
    >
      <MiniChart
        data={metrics.latency}
        color="var(--sev-warning)"
        gradientId="latency-grad"
        unit="ms"
        label="P95 Latency"
      />
      <MiniChart
        data={metrics.errorRate}
        color="var(--sev-page)"
        gradientId="error-grad"
        unit="%"
        label="Error Rate"
      />
    </div>
  );
}
