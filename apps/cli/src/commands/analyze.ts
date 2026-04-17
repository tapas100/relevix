/**
 * analyze.ts — `relevix analyze [--service <name>] [--json]`
 *
 * Fetches root cause + AI explanation in parallel and renders a rich
 * terminal panel showing:
 *   - Top root cause (severity, confidence, timeline)
 *   - Recommendations
 *   - AI narrative summary (or deterministic fallback)
 *   - Supporting insights table
 *
 * Examples:
 *   relevix analyze
 *   relevix analyze --service checkout
 *   relevix analyze --service payment --json
 */
import type { Command } from 'commander';
import ora from 'ora';
import chalk from 'chalk';
import { api } from '../client.js';
import {
  printRootCause,
  printNarrative,
  printInsightsTable,
  outputJson,
  isJsonMode,
} from '../utils/format.js';

interface AnalyzeOptions {
  service?: string;
  json?:    boolean;
}

export function registerAnalyze(program: Command): void {
  program
    .command('analyze')
    .description('Deep-dive analysis: root cause + AI narrative + supporting insights')
    .option('-s, --service <name>', 'Scope analysis to a specific service')
    .option('--json',               'Output raw JSON instead of formatted table')
    .action(async (opts: AnalyzeOptions) => {
      const spinner = ora('Fetching analysis…').start();

      try {
        // Fetch root-cause and AI explanation in parallel
        const [rootCause, explain] = await Promise.all([
          api.rootCause(opts.service ? { service: opts.service } : {}),
          api.explain(opts.service   ? { service: opts.service } : {}),
        ]);

        spinner.stop();

        if (isJsonMode(opts)) {
          outputJson({ rootCause, explain });
          return;
        }

        const scopeLabel = opts.service
          ? chalk.cyan(opts.service)
          : chalk.dim('all services');

        console.log(
          `\n  ${chalk.bold('Relevix Analysis')}  —  ${scopeLabel}` +
          chalk.dim(`  (computed ${new Date(rootCause.computedAt).toLocaleTimeString()})`),
        );

        // ── AI Narrative ──────────────────────────────────────────────────
        printNarrative(explain.narrative);

        // ── Root Cause ────────────────────────────────────────────────────
        console.log(chalk.bold('  Root Cause'));
        printRootCause(rootCause.rootCause);

        // ── Supporting Insights ───────────────────────────────────────────
        if (rootCause.supporting.length > 0) {
          console.log(chalk.bold('  Supporting Signals'));
          printInsightsTable(rootCause.supporting);
        }

      } catch (err) {
        spinner.fail(chalk.red('Analysis failed'));
        console.error(chalk.dim('  ' + String(err instanceof Error ? err.message : err)));
        process.exit(1);
      }
    });
}
