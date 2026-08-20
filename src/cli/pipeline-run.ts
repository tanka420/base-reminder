/**
 * src/cli/pipeline-run.ts
 *
 * Standalone manual execution of the complete pipeline (with DB persistence).
 * Useful for ops / verification.
 *
 * Usage:
 *   npm run pipeline:run
 *   npm run pipeline:run -- --force
 */

import { loadConfig } from "../config/index.js";
import { initPool, closePool } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { executeReminderPipeline } from "../scheduler/reminder-job.js";

async function main(): Promise<void> {
  const force = process.argv.includes("--force");
  const config = loadConfig();
  initPool(config.databaseUrl);

  try {
    await runMigrations();

    const result = await executeReminderPipeline({
      force,
      syncFirst: true,
    });

    if (result.skipped) {
      console.log(`Pipeline skipped: ${result.skipReason}. Use --force to re-run.`);
    } else {
      console.log(`Pipeline run completed successfully.`);
      console.log(`Run ID: ${result.runId}, Key: ${result.runKey}`);
      console.log(`Total Users: ${result.totalUsers} (Ready: ${result.usersReady}, Empty: ${result.usersEmpty}, Partial: ${result.usersPartial}, Error: ${result.usersError})`);
      console.log(`Duration: ${(result.durationMs / 1000).toFixed(2)}s`);
    }
  } catch (err) {
    console.error("Pipeline run error:", err instanceof Error ? err.message : err);
    process.exit(1);
  } finally {
    await closePool();
  }
}

main();
