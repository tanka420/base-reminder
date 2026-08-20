/**
 * src/db/migrate.ts
 *
 * Simple migration runner for SQL migration files in src/db/migrations/.
 *
 * Design:
 *  - Pure SQL files named NNN_description.sql (e.g. 001_base_users.sql)
 *  - Tracking table: schema_migrations (migration_id, applied_at)
 *  - Idempotent: skips already-applied migrations
 *  - Transactional: each migration runs in its own transaction
 *  - Ordered by filename (lexicographic)
 *
 * Usage:
 *   npm run migrate              — apply pending migrations (compiled JS)
 *   npm run migrate:dev          — apply pending migrations (TypeScript / tsx)
 */

import { readdir, readFile } from "fs/promises";
import { join } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

import "dotenv/config";
import { initPool, getClient, closePool } from "./connection.js";
import { logger } from "../logging/logger.js";

import { existsSync } from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const candidate1 = join(__dirname, "migrations");
const candidate2 = join(process.cwd(), "src/db/migrations");
const MIGRATIONS_DIR = existsSync(candidate1) ? candidate1 : candidate2;

/** Ensure the tracking table exists */
async function ensureTrackingTable(
  client: Awaited<ReturnType<typeof getClient>>
): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      migration_id  VARCHAR(255) PRIMARY KEY,
      applied_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

/** Return set of already-applied migration IDs */
async function getApplied(
  client: Awaited<ReturnType<typeof getClient>>
): Promise<Set<string>> {
  const result = await client.query<{ migration_id: string }>(
    "SELECT migration_id FROM schema_migrations ORDER BY migration_id"
  );
  return new Set(result.rows.map((r) => r.migration_id));
}

/** Run all pending migrations */
export async function runMigrations(): Promise<void> {
  const client = await getClient();

  try {
    await client.query("BEGIN");
    await ensureTrackingTable(client);
    const applied = await getApplied(client);
    await client.query("COMMIT");

    // Read migration files
    let files: string[];
    try {
      files = (await readdir(MIGRATIONS_DIR))
        .filter((f) => f.endsWith(".sql"))
        .sort(); // lexicographic order = numeric order for NNN_ prefix
    } catch {
      logger.warn({
        msg: "migrations directory not found or empty",
        dir: MIGRATIONS_DIR,
      });
      return;
    }

    let applied_count = 0;
    let skipped_count = 0;

    for (const file of files) {
      if (applied.has(file)) {
        skipped_count++;
        logger.debug({ msg: "migration already applied, skipping", file });
        continue;
      }

      const sql = await readFile(join(MIGRATIONS_DIR, file), "utf-8");

      logger.info({ msg: "applying migration", file });

      const migClient = await getClient();
      try {
        await migClient.query("BEGIN");
        await migClient.query(sql);
        await migClient.query(
          "INSERT INTO schema_migrations (migration_id) VALUES ($1)",
          [file]
        );
        await migClient.query("COMMIT");
        applied_count++;
        logger.info({ msg: "migration applied", file });
      } catch (err) {
        await migClient.query("ROLLBACK");
        logger.error({
          msg: "migration failed — rolled back",
          file,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      } finally {
        migClient.release();
      }
    }

    logger.info({
      msg: "migrations complete",
      applied: applied_count,
      skipped: skipped_count,
    });
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    console.error("[migrate] DATABASE_URL is required");
    process.exit(1);
  }

  initPool(databaseUrl);

  runMigrations()
    .then(() => {
      console.log("Migrations finished.");
    })
    .catch((err: unknown) => {
      console.error("Migration error:", err);
      process.exit(1);
    })
    .finally(() => closePool());
}
