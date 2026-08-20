/**
 * src/db/connection.ts
 *
 * PostgreSQL connection pool using node-postgres (pg).
 *
 * Security: DATABASE_URL contains credentials. It is passed to pg.Pool
 * directly and never logged, printed, or included in error messages.
 */

import { Pool, type PoolClient, type QueryResult } from "pg";
import { logger } from "../logging/logger.js";

let pool: Pool | null = null;

/**
 * Initialize the connection pool.
 * Must be called once at startup before any query.
 * DATABASE_URL must never appear in log output.
 */
export function initPool(databaseUrl: string): void {
  if (pool !== null) {
    logger.warn({ msg: "initPool called more than once — ignoring" });
    return;
  }
  pool = new Pool({
    connectionString: databaseUrl,
    max: 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

  pool.on("error", (err) => {
    // Log error class / message only — connection string must not appear here
    logger.error({ msg: "pg pool idle client error", error: err.message });
  });
}

/**
 * Get the active pool. Throws if initPool has not been called.
 */
export function getPool(): Pool {
  if (pool === null) {
    throw new Error(
      "[db] Pool not initialized. Call initPool(databaseUrl) first."
    );
  }
  return pool;
}

/**
 * Execute a parameterized query using the pool.
 * Convenience wrapper for single-shot queries.
 */
export async function query<T extends object = Record<string, unknown>>(
  sql: string,
  params?: unknown[]
): Promise<QueryResult<T>> {
  return getPool().query<T>(sql, params);
}

/**
 * Acquire a client from the pool for transactions.
 * Caller is responsible for client.release().
 */
export async function getClient(): Promise<PoolClient> {
  return getPool().connect();
}

/**
 * Test database connectivity. Returns latency in ms.
 * Used by health endpoint only.
 */
export async function pingDatabase(): Promise<number> {
  const start = Date.now();
  await query("SELECT 1");
  return Date.now() - start;
}

/**
 * Gracefully close the pool.
 * Call on SIGTERM / SIGINT.
 */
export async function closePool(): Promise<void> {
  if (pool !== null) {
    await pool.end();
    pool = null;
    logger.info({ msg: "pg pool closed" });
  }
}
