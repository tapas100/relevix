/**
 * compare.ts — `relevix compare <serviceA> <serviceB> [--json]`
 *
 * Fetches insights for two services in parallel and renders a side-by-side
 * comparison table, then prints a winner summary (fewer active issues wins).
 *
 * Examples:
 *   relevix compare nginx haproxy
 *   relevix compare checkout payment
 *   relevix compare checkout payment --json
 */
import type { Command } from 'commander';
import ora from 'ora';
import chalk from 'chalk';
import { api } from '../client.js';
import {
  printCompare,
  printRootCause,
  outputJson,
  isJsonMode,
} from '../utils/format.js';

interface CompareOptions {
  json?: boolean;
}

export function registerCompare(program: Command): void {
  program
    .command('compare <serviceA> <serviceB>')
    .description('Side-by-side insight comparison between two services')
    .option('--json', 'Output raw JSON')
    .action(async (serviceA: string, serviceB: string, opts: CompareOptions) => {
      const spinner = ora(`Comparing ${serviceA} vs ${serviceB}…`).start();

      try {
        // Fetch all four data points in parallel
        const [insA, insB, rcA, rcB] = await Promise.all([
          api.insights({ service: serviceA, limit: 5 }),
          api.insights({ service: serviceB, limit: 5 }),
          api.rootCause({ service: serviceA }),
          api.rootCause({ service: serviceB }),
        ]);

        spinner.stop();

        if (isJsonMode(opts)) {
          outputJson({ [serviceA]: { insights: insA, rootCause: rcA }, [serviceB]: { insights: insB, rootCause: rcB } });
          return;
        }

        // ── Side-by-side insights ─────────────────────────────────────────
        printCompare([serviceA, serviceB], insA.insights, insB.insights);

        // ── Root causes ───────────────────────────────────────────────────
        console.log(chalk.bold(`  Root Cause — ${chalk.cyan(serviceA)}`));
        printRootCause(rcA.rootCause);

        console.log(chalk.bold(`  Root Cause — ${chalk.cyan(serviceB)}`));
        printRootCause(rcB.rootCause);

      } catch (err) {
        spinner.fail(chalk.red('Comparison failed'));
        console.error(chalk.dim('  ' + String(err instanceof Error ? err.message : err)));
        process.exit(1);
      }
    });
}
