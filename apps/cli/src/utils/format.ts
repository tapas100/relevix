/**
 * format.ts — Terminal rendering helpers.
 *
 * All output goes through these helpers so the --json flag is a single
 * branch: if JSON mode, just JSON.stringify the raw data; otherwise use
 * the rich table/colour renderers.
 */
import chalk, { type ChalkInstance } from 'chalk';
import Table from 'cli-table3';
import type { RankedInsight, RootCause, Severity, AiNarrative } from '@relevix/types';
import { cfg } from '../config.js';

// ─── Severity colours ─────────────────────────────────────────────────────────

const SEV_COLOR: Record<Severity, ChalkInstance> = {
  page:     chalk.bgRed.white.bold,
  critical: chalk.red.bold,
  warning:  chalk.yellow,
  info:     chalk.cyan,
};

export function severityLabel(s: Severity): string {
  return SEV_COLOR[s](` ${s.toUpperCase()} `);
}

// ─── Score bar ────────────────────────────────────────────────────────────────

export function scoreBar(value: number, width = 16): string {
  const filled = Math.round(value * width);
  const bar    = '█'.repeat(filled) + '░'.repeat(width - filled);
  const pct    = `${String(Math.round(value * 100))}%`.padStart(4);
  return `${chalk.cyan(bar)} ${chalk.dim(pct)}`;
}

// ─── Time helpers ─────────────────────────────────────────────────────────────

export function timeAgo(iso: string): string {
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (d < 60)   return `${String(d)}s ago`;
  if (d < 3600) return `${String(Math.floor(d / 60))}m ago`;
  return `${String(Math.floor(d / 3600))}h ago`;
}

// ─── JSON output gate ─────────────────────────────────────────────────────────

export function outputJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

export function isJsonMode(flags: { json?: boolean }): boolean {
  return flags.json === true || cfg.get('format') === 'json';
}

// ─── Insights table ───────────────────────────────────────────────────────────

export function printInsightsTable(insights: RankedInsight[]): void {
  if (insights.length === 0) {
    console.log(chalk.dim('  No insights found for the given filters.\n'));
    return;
  }

  const t = new Table({
    head: [
      chalk.bold('#'),
      chalk.bold('Severity'),
      chalk.bold('Rule'),
      chalk.bold('Confidence'),
      chalk.bold('Composite'),
      chalk.bold('Fired'),
    ],
    style: { head: [], border: ['dim'] },
    colWidths: [4, 12, 36, 20, 20, 14],
    wordWrap: true,
  });

  for (const ri of insights) {
    const { insight, components, rank } = ri;
    t.push([
      chalk.dim(String(rank)),
      severityLabel(insight.severity),
      chalk.white(insight.ruleName),
      scoreBar(insight.confidence, 12),
      scoreBar(components.composite, 12),
      chalk.dim(timeAgo(insight.firedAt)),
    ]);
  }

  console.log(t.toString());
}

// ─── Root-cause panel ─────────────────────────────────────────────────────────

export function printRootCause(rc: RootCause | null): void {
  if (!rc) {
    console.log(chalk.green('  ✓  No active root cause detected — system looks healthy.\n'));
    return;
  }

  const divider = chalk.dim('─'.repeat(60));

  console.log(`\n${divider}`);
  console.log(
    `  ${severityLabel(rc.severity)}  ${chalk.bold(rc.ruleId)}  ` +
    chalk.dim(`(confidence: ${String(Math.round(rc.confidence * 100))}%)`),
  );
  console.log(divider);
  console.log(`\n  ${chalk.white(rc.explanation)}\n`);

  if (rc.affectedComponents.length > 0) {
    console.log(chalk.dim('  Affected:  ') + rc.affectedComponents.join(', '));
  }

  console.log(chalk.dim(`  Detected:  `) + timeAgo(rc.timeline.detectedAt));
  if (rc.timeline.estimatedStartAt) {
    console.log(chalk.dim(`  Est. start:`) + ' ' + timeAgo(rc.timeline.estimatedStartAt));
  }

  console.log(`\n${chalk.bold('  Recommendations:')}`);
  rc.recommendations.forEach((r, i) => {
    console.log(`  ${chalk.cyan(String(i + 1) + '.')} ${r}`);
  });
  console.log('');
}

// ─── AI narrative panel ───────────────────────────────────────────────────────

export function printNarrative(n: AiNarrative): void {
  const tag = n.source === 'ai'
    ? chalk.magenta('[AI]')
    : chalk.dim('[fallback]');

  const divider = chalk.dim('─'.repeat(60));

  console.log(`\n${divider}`);
  console.log(`  ${tag}  ${chalk.bold.white(n.summary)}`);
  console.log(divider);
  console.log(`\n  ${chalk.dim('Explanation:')}  ${n.explanation}\n`);
  console.log(chalk.bold('  Next actions:'));
  n.actions.forEach((a, i) => {
    console.log(`  ${chalk.cyan(String(i + 1) + '.')} ${a}`);
  });
  console.log('');
}

// ─── Side-by-side compare table ───────────────────────────────────────────────

export function printCompare(
  services: [string, string],
  left:  RankedInsight[],
  right: RankedInsight[],
): void {
  const maxRows = Math.max(left.length, right.length, 1);

  console.log(
    `\n  ${chalk.bold('Comparing')}  ` +
    chalk.cyan(services[0]) + chalk.dim('  vs  ') + chalk.cyan(services[1]) + '\n',
  );

  const t = new Table({
    head: [
      chalk.bold(services[0]),
      chalk.bold(services[1]),
    ],
    style: { head: [], border: ['dim'] },
    colWidths: [44, 44],
    wordWrap: true,
  });

  for (let i = 0; i < maxRows; i++) {
    t.push([
      left[i]  ? insightCell(left[i]!)  : chalk.dim('—'),
      right[i] ? insightCell(right[i]!) : chalk.dim('—'),
    ]);
  }

  console.log(t.toString());

  // Summary line
  const winner = left.length === 0 && right.length === 0
    ? null
    : left.length <= right.length ? services[0] : services[1];

  if (winner) {
    const loser = winner === services[0] ? services[1] : services[0];
    console.log(
      `\n  ${chalk.green('▲ ' + winner)} has fewer active issues than ${chalk.red(loser)}\n`,
    );
  }
}

function insightCell(ri: RankedInsight): string {
  return (
    `${severityLabel(ri.insight.severity)} ${chalk.white(ri.insight.ruleName)}\n` +
    `${chalk.dim('composite')} ${scoreBar(ri.components.composite, 10)} ` +
    chalk.dim(timeAgo(ri.insight.firedAt))
  );
}
