/**
 * insights.ts — `relevix insights [--service <name>] [--limit N] [--json]`
 *
 * Lists ranked infrastructure insights with score breakdown.
 *
 * Examples:
 *   relevix insights
 *   relevix insights --service checkout --limit 5
 *   relevix insights --json
 */
import type { Command } from 'commander';
import ora from 'ora';
import chalk from 'chalk';
import { api } from '../client.js';
import {
  printInsightsTable,
  scoreBar,
  severityLabel,
  outputJson,
  isJsonMode,
} from '../utils/format.js';

interface InsightsOptions {
  service?: string;
  limit?:   string;
  json?:    boolean;
}

export function registerInsights(program: Command): void {
  program
    .command('insights')
    .description('List ranked infrastructure insights')
    .option('-s, --service <name>', 'Filter by service name')
    .option('-n, --limit <number>',  'Max number of insights to return (1–50)', '10')
    .option('--json',                'Output raw JSON')
    .action(async (opts: InsightsOptions) => {
      const limit   = Math.min(50, Math.max(1, parseInt(opts.limit ?? '10', 10)));
      const spinner = ora('Fetching insights…').start();

      try {
        const data = await api.insights(
          opts.service ? { service: opts.service, limit } : { limit },
        );

        spinner.stop();

        if (isJsonMode(opts)) {
          outputJson(data);
          return;
        }

        const scopeLabel = opts.service ? chalk.cyan(opts.service) : chalk.dim('all services');
        console.log(
          `\n  ${chalk.bold('Insights')}  —  ${scopeLabel}` +
          chalk.dim(`  ${String(data.total)} total · computed ${new Date(data.computedAt).toLocaleTimeString()}`),
        );

        printInsightsTable(data.insights);

        // Score legend
        console.log(
          chalk.dim('  Scores:  ') +
          'composite ' + scoreBar(0.8, 8) + '  ' +
          'confidence ' + scoreBar(0.6, 8) + chalk.dim('  (example)\n'),
        );

      } catch (err) {
        spinner.fail(chalk.red('Failed to fetch insights'));
        console.error(chalk.dim('  ' + String(err instanceof Error ? err.message : err)));
        process.exit(1);
      }
    });
}
