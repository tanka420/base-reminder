/**
 * src/cli/reminder-dry-run.ts
 *
 * CLI Acceptance Command:
 *   npm run reminder:dry-run
 *
 * Features:
 *  - Executes full reminder data collection pipeline across all active users in dry-run mode.
 *  - Output safety: prints summary counts table only, avoiding dumping task titles for all users.
 *  - Read-only: does not write delivery records or run records to DB.
 */

import { loadConfig } from "../config/index.js";
import { initPool, closePool } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { executeReminderPipeline } from "../scheduler/reminder-job.js";
import { formatTzDate } from "../collectors/wework.js";

async function main(): Promise<void> {
  const config = loadConfig();
  initPool(config.databaseUrl);

  try {
    try {
      await runMigrations();
    } catch {
      // DB offline — continue dry-run with direct Base API
    }

    const now = new Date();
    const tz = config.reminderTimezone;

    console.log(`\n========================================================================`);
    console.log(` BASE REMINDER — PIPELINE DRY-RUN (M1B)`);
    console.log(` Date: ${formatTzDate(now, tz)} | Timezone: ${tz}`);
    console.log(` Mode: Dry-Run (Read-only, no DB writes, summary table only)`);
    console.log(`========================================================================\n`);

    const result = await executeReminderPipeline({
      dryRun: true,
      syncFirst: true,
      now,
    });

    // Format tabular data
    const tableData = result.digests.map((d, index) => ({
      "#": index + 1,
      ID: d.baseUserId,
      Username: `@${d.username}`,
      Name: d.displayName.length > 22 ? d.displayName.slice(0, 19) + "..." : d.displayName,
      Status: d.status.toUpperCase(),
      Wework: `${d.counts.wework}${d.wework.status === "error" ? " (ERR)" : ""}`,
      Workflow: `${d.counts.workflow}${d.workflow.status === "error" ? " (ERR)" : ""}`,
      Request: `${d.counts.request}${d.request.status === "error" ? " (ERR)" : ""}`,
      Total: d.counts.total,
    }));

    console.table(tableData);

    console.log(`\n--- [DRY-RUN SUMMARY] ---`);
    console.log(`Total Users Processed : ${result.totalUsers}`);
    console.log(`Ready (has actions)   : ${result.usersReady}`);
    console.log(`Empty (0 actions)     : ${result.usersEmpty}`);
    console.log(`Partial (module err)  : ${result.usersPartial}`);
    console.log(`Error (all failed)    : ${result.usersError}`);
    console.log(`Duration              : ${(result.durationMs / 1000).toFixed(2)}s`);
    console.log(`========================================================================\n`);
  } catch (err) {
    console.error("Dry-run error:", err instanceof Error ? err.message : err);
    process.exit(1);
  } finally {
    await closePool();
  }
}

main();
