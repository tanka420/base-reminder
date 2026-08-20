/**
 * src/index.ts
 *
 * Application entry point — M1A Core Foundation.
 *
 * Startup sequence:
 *  1. Load and validate config (fail fast on missing required vars)
 *  2. Initialize logger
 *  3. Initialize database pool
 *  4. Run migrations
 *  5. Start health endpoint
 *  6. Register graceful shutdown handlers
 *
 * Not yet implemented (M1B+):
 *  - Data collectors (Wework, Workflow, Request)
 *  - Digest builder
 *  - Scheduler (node-cron)
 *  - Telegram bot (M2)
 */

import { loadConfig } from "./config/index.js";
import { logger } from "./logging/logger.js";
import { initPool, closePool } from "./db/connection.js";
import { runMigrations } from "./db/migrate.js";
import { startHealthServer, stopHealthServer } from "./health/server.js";
import { initScheduler, stopScheduler, checkMissedRun } from "./scheduler/cron.js";

async function main(): Promise<void> {
  // --- 1. Load config ---
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    // Use console.error because logger may not be initialized yet
    console.error("[fatal]", err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  logger.info({
    msg: "base-reminder starting",
    node_env: config.nodeEnv,
    log_level: config.logLevel,
  });

  // --- 2. Initialize database pool ---
  initPool(config.databaseUrl);

  // --- 3. Run migrations ---
  try {
    await runMigrations();
  } catch (err) {
    logger.fatal({
      msg: "migration failed — cannot start",
      error: err instanceof Error ? err.message : String(err),
    });
    await closePool();
    process.exit(1);
  }

  // --- 4. Start health endpoint ---
  startHealthServer(config.healthHost, config.healthPort);

  // --- 5. Initialize Scheduler Framework (disabled by default in M1B) ---
  initScheduler(config);

  // Check for missed run if enabled
  try {
    await checkMissedRun(config);
  } catch (err) {
    logger.warn({
      msg: "missed run check failed",
      error: err instanceof Error ? err.message : String(err),
    });
  }

  logger.info({
    msg: "m1b action pipeline ready",
    health_url: `http://${config.healthHost}:${config.healthPort}/health`,
    cron_scheduler_enabled: config.enableCronScheduler,
  });

  // --- 6. Graceful shutdown ---
  let shuttingDown = false;

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ msg: "shutdown signal received", signal });

    try {
      stopScheduler();
      await stopHealthServer();
      await closePool();
      logger.info({ msg: "graceful shutdown complete" });
      process.exit(0);
    } catch (err) {
      logger.error({
        msg: "error during shutdown",
        error: err instanceof Error ? err.message : String(err),
      });
      process.exit(1);
    }
  }

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("uncaughtException", (err) => {
    logger.fatal({
      msg: "uncaught exception",
      error: err.message,
      stack: err.stack,
    });
    void shutdown("uncaughtException");
  });
  process.on("unhandledRejection", (reason) => {
    logger.fatal({
      msg: "unhandled promise rejection",
      reason: reason instanceof Error ? reason.message : String(reason),
    });
    void shutdown("unhandledRejection");
  });
}

main();
