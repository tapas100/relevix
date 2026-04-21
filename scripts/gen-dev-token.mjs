#!/usr/bin/env node
/**
 * gen-dev-token.mjs
 *
 * Generates a long-lived development JWT and prints the DEV_TOKEN= line
 * ready to paste into .env.
 *
 * Usage:
 *   node scripts/gen-dev-token.mjs
 *   node scripts/gen-dev-token.mjs --months 12   # custom expiry
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dir, '../.env');

// ── Read JWT_SECRET from .env ─────────────────────────────────────────────────
function readEnvKey(key) {
  if (!fs.existsSync(envPath)) return undefined;
  const match = fs.readFileSync(envPath, 'utf8')
    .split('\n')
    .find(l => l.startsWith(key + '='));
  return match?.slice(key.length + 1).trim();
}

const SECRET = readEnvKey('JWT_SECRET');
if (!SECRET) {
  console.error('❌  JWT_SECRET not found in .env — cannot sign token');
  process.exit(1);
}

// ── Parse args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const monthsIdx = args.indexOf('--months');
const months = monthsIdx !== -1 ? Number(args[monthsIdx + 1]) : 6;

// ── Build token ───────────────────────────────────────────────────────────────
const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const exp = now + Math.round(months * 30.5 * 24 * 3600);

const payload = {
  sub:      'dev-user',
  tenantId: 'a0000000-0000-0000-0000-000000000001',
  name:     'Dev User',
  role:     'admin',
  iat:      now,
  exp,
};

const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
const sig = crypto.createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url');
const token = `${h}.${p}.${sig}`;

const expiresAt = new Date(exp * 1000).toISOString().slice(0, 10);

console.log('\n✅  Dev token generated (expires %s)\n', expiresAt);
console.log('DEV_TOKEN=' + token);
console.log('\nPaste the line above into your .env file.\n');
