/**
 * services/db.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Singleton postgres.js client for the API gateway.
 *
 * Why postgres.js?
 *   - Zero dependencies, 40x faster than pg for Node 18+
 *   - Native ESM, TypeScript types built-in
 *   - Connection pool with idle timeout
 *
 * Usage:
 *   import { getDb } from './db.js';
 *   const sql = getDb();
 *   const rows = await sql`SELECT * FROM rules WHERE tenant_id = ${tenantId}`;
 */
import postgres from 'postgres';

let _db: postgres.Sql | null = null;

export function getDb(): postgres.Sql {
  if (!_db) {
    const url = process.env['DATABASE_URL'];
    if (!url) throw new Error('DATABASE_URL is not set');
    _db = postgres(url, {
      max:         10,         // connection pool size
      idle_timeout: 20,        // close idle connections after 20s
      connect_timeout: 5,      // fail fast if postgres is down
      transform: postgres.camel, // snake_case columns → camelCase JS keys
    });
  }
  return _db;
}

export async function closeDb(): Promise<void> {
  if (_db) { await _db.end(); _db = null; }
}
