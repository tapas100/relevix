/**
 * config.ts — Persistent credential + preference store for the Relevix CLI.
 *
 * Stored at:  ~/.config/relevix-cli/config.json  (via `conf` library)
 *
 * Usage:
 *   import { cfg } from './config.js';
 *   cfg.set('token', 'eyJ...');
 *   const token = cfg.get('token');
 *
 * Commands:
 *   relevix config set <key> <value>
 *   relevix config get <key>
 *   relevix config list
 *   relevix config clear
 */
import Conf from 'conf';

export interface CliConfig {
  /** Gateway base URL. Default: http://localhost:3001 */
  apiUrl:  string;
  /** JWT bearer token — obtained from relevix auth login (future) or set manually. */
  token:   string;
  /** Output format: table (default) | json | yaml */
  format:  'table' | 'json';
  /** Default tenant ID — embedded in the JWT, shown in output. */
  tenant?: string;
}

const DEFAULTS: CliConfig = {
  apiUrl: 'http://localhost:3001',
  token:  '',
  format: 'table',
};

export const cfg = new Conf<CliConfig>({
  projectName: 'relevix-cli',
  defaults:    DEFAULTS,
  schema: {
    apiUrl: { type: 'string' },
    token:  { type: 'string' },
    format: { type: 'string', enum: ['table', 'json'] },
    tenant: { type: 'string' },
  },
});

export function requireToken(): string {
  const token = cfg.get('token');
  if (!token) {
    console.error(
      '\n  ✖  No auth token configured.\n' +
      '     Run:  relevix config set token <your-jwt>\n' +
      '     Docs: https://github.com/tapas100/relevix#authentication\n',
    );
    process.exit(1);
  }
  return token;
}

export function apiUrl(): string {
  return cfg.get('apiUrl').replace(/\/$/, '');
}
