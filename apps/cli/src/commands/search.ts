/**
 * search.ts — `relevix search <query> [--service <name>] [--severity <level>] [--json]`
 *
 * Full-text search over indexed insights.
 *
 * Examples:
 *   relevix search "latency spike"
 *   relevix search "error rate" --service checkout
 *   relevix search "cascading failure" --severity critical --json
 */
import type { Command } from 'commander';
import ora from 'ora';
import chalk from 'chalk';
import Table from 'cli-table3';
import { api } from '../client.js';
import { severityLabel, scoreBar, timeAgo, outputJson, isJsonMode } from '../utils/format.js';
import type { Severity } from '@relevix/types';

interface SearchOptions {
  service?:  string;
  severity?: string;
  limit?:    string;
  json?:     boolean;
}

export function registerSearch(program: Command): void {
  program
    .command('search <query>')
    .description('Full-text search over indexed insights')
    .option('-s, --service <name>',             'Filter by service')
    .option('--severity <level>',               'Minimum severity (page|critical|warning|info)')
    .option('-n, --limit <number>',             'Max results (1–50)', '10')
    .option('--json',                           'Output raw JSON')
    .action(async (query: string, opts: SearchOptions) => {
      const limit   = Math.min(50, Math.max(1, parseInt(opts.limit ?? '10', 10)));
      const spinner = ora(`Searching for "${query}"…`).start();

      try {
        const result = await api.search({
          q:     query,
          limit,
          ...(opts.service  && { service: opts.service }),
          ...(opts.severity && { minSeverity: opts.severity as Severity }),
        });

        spinner.stop();

        if (isJsonMode(opts)) {
          outputJson(result);
          return;
        }

        console.log(
          `\n  ${chalk.bold('Search Results')}  ${chalk.dim(`"${query}"`)}` +
          chalk.dim(`  ${String(result.total)} hits · ${String(result.took)}ms\n`),
        );

        if (result.hits.length === 0) {
          console.log(chalk.dim('  No results found.\n'));
          return;
        }

        const t = new Table({
          head: [
            chalk.bold('Score'),
            chalk.bold('Severity'),
            chalk.bold('Rule'),
            chalk.bold('Explanation'),
            chalk.bold('Fired'),
          ],
          style: { head: [], border: ['dim'] },
          colWidths: [8, 12, 28, 36, 12],
          wordWrap: true,
        });

        for (const hit of result.hits) {
          const { document: doc } = hit;
          // Show highlighted explanation if available, otherwise plain
          const hl = hit.highlights?.['explanation']?.[0] ?? hit.highlights?.['searchText']?.[0];
          const explanationText = hl
            ? hl.replace(/<mark>/g, chalk.yellow.bold('')).replace(/<\/mark>/g, chalk.reset(''))
            : doc.explanation.slice(0, 80) + (doc.explanation.length > 80 ? '…' : '');

          t.push([
            chalk.dim(hit.score.toFixed(2)),
            severityLabel(doc.severity),
            chalk.white(doc.ruleName),
            explanationText,
            chalk.dim(timeAgo(doc.firedAt)),
          ]);
        }

        console.log(t.toString() + '\n');

      } catch (err) {
        spinner.fail(chalk.red('Search failed'));
        console.error(chalk.dim('  ' + String(err instanceof Error ? err.message : err)));
        process.exit(1);
      }
    });
}
