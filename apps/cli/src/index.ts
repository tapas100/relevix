#!/usr/bin/env node
/**
 * Relevix CLI — entry point
 *
 * Commands:
 *   relevix analyze [--service <name>] [--json]
 *   relevix insights [--service <name>] [--limit N] [--json]
 *   relevix compare <serviceA> <serviceB> [--json]
 *   relevix search <query> [--service <name>] [--severity <level>] [--json]
 *   relevix config set <key> <value>
 *   relevix config get <key>
 *   relevix config list
 */
import { Command } from 'commander';
import chalk from 'chalk';
import { registerAnalyze }  from './commands/analyze.js';
import { registerInsights } from './commands/insights.js';
import { registerCompare }  from './commands/compare.js';
import { registerSearch }   from './commands/search.js';
import { cfg, apiUrl }      from './config.js';

const program = new Command();

program
  .name('relevix')
  .description('Relevix CLI — infrastructure insight analysis from your terminal')
  .version('0.1.0')
  .addHelpText('after', `
${chalk.bold('Examples:')}
  ${chalk.cyan('relevix analyze')}                         Full analysis for all services
  ${chalk.cyan('relevix analyze --service checkout')}      Scope to checkout service
  ${chalk.cyan('relevix insights --limit 5')}              Top 5 ranked insights
  ${chalk.cyan('relevix compare nginx haproxy')}           Side-by-side comparison
  ${chalk.cyan('relevix search "latency spike"')}          Full-text insight search
  ${chalk.cyan('relevix config set apiUrl http://...')}    Set gateway URL
  ${chalk.cyan('relevix config set token eyJ...')}         Set auth token

${chalk.dim('Current API URL: ' + apiUrl())}
`);

// ── Register all commands ──────────────────────────────────────────────────────
registerAnalyze(program);
registerInsights(program);
registerCompare(program);
registerSearch(program);

// ── Config command ─────────────────────────────────────────────────────────────
const configCmd = program.command('config').description('Get or set CLI configuration');

configCmd
  .command('set <key> <value>')
  .description('Set a config value  (keys: apiUrl, token, format, tenant)')
  .action((key: string, value: string) => {
    const allowed = ['apiUrl', 'token', 'format', 'tenant'];
    if (!allowed.includes(key)) {
      console.error(chalk.red(`Unknown config key: ${key}`));
      console.error(chalk.dim('Allowed: ' + allowed.join(', ')));
      process.exit(1);
    }
    cfg.set(key as never, value);
    console.log(chalk.green(`✓  ${key} = ${key === 'token' ? value.slice(0, 12) + '…' : value}`));
  });

configCmd
  .command('get <key>')
  .description('Get a config value')
  .action((key: string) => {
    const val = cfg.get(key as never) as unknown;
    if (val === undefined) {
      console.error(chalk.red(`Key not found: ${key}`));
      process.exit(1);
    }
    console.log(key === 'token' ? String(val).slice(0, 12) + '…' : String(val));
  });

configCmd
  .command('list')
  .description('Show all config values')
  .action(() => {
    const all = cfg.store;
    for (const [k, v] of Object.entries(all)) {
      const display = k === 'token' && typeof v === 'string' && v.length > 0
        ? v.slice(0, 12) + '…'
        : String(v);
      console.log(`  ${chalk.cyan(k.padEnd(12))} ${display}`);
    }
  });

configCmd
  .command('clear')
  .description('Reset all config to defaults')
  .action(() => {
    cfg.clear();
    console.log(chalk.yellow('⚠  Config cleared. Defaults restored.'));
  });

// ── Parse ──────────────────────────────────────────────────────────────────────
program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(chalk.red('\n  Unexpected error:'), err);
  process.exit(1);
});
