/**
 * src/index.ts
 *
 * Application entry point.
 *
 * Startup sequence:
 *  1. Load and validate core config (fail fast on missing required vars)
 *  2. Initialize logger
 *  3. Initialize database pool
 *  4. Run migrations (001, 002, 003, 004)
 *  5. Start health endpoint
 *  6. Initialize Scheduler Framework (disabled by default)
 *  7. Start Telegram Bot if ENABLE_TELEGRAM_BOT=true (subsystem isolation)
 *  8. Register graceful shutdown handlers
 */

import { loadConfig, loadTelegramConfig, loadSmtpConfig } from "./config/index.js";
import { logger } from "./logging/logger.js";
import { initPool, closePool } from "./db/connection.js";
import { runMigrations } from "./db/migrate.js";
import { startHealthServer, stopHealthServer, recordTelegramBotStatus } from "./health/server.js";
import { initScheduler, stopScheduler, checkMissedRun } from "./scheduler/cron.js";
import { initTelegramBot } from "./telegram/bot.js";

async function main(): Promise<void> {
  // --- 1. Load core config ---
  let config;
  try {
    config = loadConfig();
  } catch (err) {
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
    const errMsg = err instanceof Error ? (err.message || (err as any).errors?.[0]?.message || String(err)) : String(err);
    logger.fatal({
      msg: "migration failed — cannot start",
      error: errMsg,
    });
    await closePool();
    process.exit(1);
  }

  // --- 4. Start health endpoint ---
  startHealthServer(config.healthHost, config.healthPort);

  // --- 5. Initialize Scheduler Framework (disabled by default in M2A) ---
  initScheduler(config);

  // Check for missed run if scheduler is enabled
  try {
    await checkMissedRun(config);
  } catch (err) {
    logger.warn({
      msg: "missed run check failed",
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // --- 6. Start Telegram Bot if enabled ---
  let stopBot: (() => Promise<void>) | undefined;

  if (config.enableTelegramBot) {
    try {
      const telegramConfig = loadTelegramConfig();
      const smtpConfig = loadSmtpConfig();

      const botResult = await initTelegramBot({
        telegramConfig,
        smtpConfig,
        baseAccountToken: config.baseAccountToken,
        baseWeWorkToken: config.baseWeWorkToken,
        baseWorkflowToken: config.baseWorkflowToken,
        baseRequestToken: config.baseRequestToken,
        reminderTimezone: config.reminderTimezone,
        baseApiTimeoutMs: config.baseApiTimeoutMs,
        baseApiConcurrency: config.baseApiConcurrency,
      });

      stopBot = botResult.stop;
      recordTelegramBotStatus("up");

      logger.info({ msg: "telegram bot subsystem active" });
    } catch (err) {
      recordTelegramBotStatus("down");
      logger.error({
        msg: "failed to start telegram bot subsystem",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } else {
    recordTelegramBotStatus("disabled");
    logger.info({ msg: "telegram bot subsystem is disabled (ENABLE_TELEGRAM_BOT=false)" });
  }

  logger.info({
    msg: "base-reminder system ready",
    health_url: `http://${config.healthHost}:${config.healthPort}/health`,
    cron_scheduler_enabled: config.enableCronScheduler,
    telegram_bot_enabled: config.enableTelegramBot,
    business_timezone: config.reminderTimezone,
  });

  // --- 7. Graceful shutdown ---
  let shuttingDown = false;

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ msg: "shutdown signal received", signal });

    try {
      if (stopBot) {
        await stopBot();
      }
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
