/**
 * src/sync/sync-cli.ts
 *
 * CLI entry point for: npm run sync:users
 *
 * Runs user sync independently of the main app process.
 * Does not start the health server or scheduler.
 * Useful for manual verification before scheduler automation exists.
 *
 * Exit codes:
 *   0 — sync completed successfully
 *   1 — configuration error or sync failure
 */

import { loadConfig } from "../config/index.js";
import { initPool, closePool } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { AccountApiClient } from "../base-api/account.js";
import { syncUsers } from "./user-sync.js";
import { logger } from "../logging/logger.js";

async function main(): Promise<void> {
  // Load and validate config (fails fast on missing required vars)
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  // Initialize database pool
  initPool(config.databaseUrl);

  try {
    // Ensure schema is up to date
    logger.info({ msg: "running migrations before sync" });
    await runMigrations();

    // Initialize Account API client
    const accountClient = new AccountApiClient(
      config.baseAccountToken,
      config.baseApiTimeoutMs,
      config.baseApiConcurrency
    );

    // Run sync
    const result = await syncUsers(accountClient);

    // Human-readable summary to stdout (for manual verification)
    console.log("\n✅ User sync completed:");
    console.log(`   Total in workspace : ${result.total}`);
    console.log(`   Created (new)      : ${result.created}`);
    console.log(`   Updated (existing) : ${result.updated}`);
    console.log(`   Deactivated        : ${result.deactivated}`);
    console.log("");
  } catch (err) {
    logger.error({
      msg: "sync:users failed",
      error: err instanceof Error ? err.message : String(err),
    });
    console.error(
      "\n❌ Sync failed:",
      err instanceof Error ? err.message : String(err)
    );
    process.exit(1);
  } finally {
    await closePool();
  }
}

main();
