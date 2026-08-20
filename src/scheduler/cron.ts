/**
 * src/scheduler/cron.ts
 *
 * Cron scheduler framework with missed-run detection and idempotency.
 *
 * Note (M1B contract):
 *  - Automatic 08:15 execution is DISABLED by default (enableCronScheduler: false).
 *  - M2 will enable scheduled employee delivery.
 */

import cron, { type ScheduledTask } from "node-cron";
import type { Config } from "../config/index.js";
import { executeReminderPipeline } from "./reminder-job.js";
import { getReminderRunByKey } from "../db/queries/runs.js";
import { formatTzDate } from "../collectors/wework.js";
import { logger } from "../logging/logger.js";

let activeCronTask: ScheduledTask | null = null;

/**
 * Check if today is a business day (Monday through Friday) in the specified timezone.
 */
export function isWeekdayInTimezone(now: Date, timezone: string): boolean {
  const dayName = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
  }).format(now);

  return dayName !== "Sat" && dayName !== "Sun";
}

/**
 * Check if the current time has passed 08:15 in the specified timezone.
 */
export function isAfterMorningTime(now: Date, timezone: string, hour = 8, minute = 15): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(now);

  const currentHour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const currentMinute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");

  if (currentHour > hour) return true;
  if (currentHour === hour && currentMinute >= minute) return true;
  return false;
}

/**
 * Inspect whether a scheduled run was missed for today (e.g. server was offline at 08:15).
 * Only triggers pipeline execution if enableCronScheduler is true.
 */
export async function checkMissedRun(
  config: Config,
  now: Date = new Date()
): Promise<boolean> {
  const timezone = config.reminderTimezone;
  const isWeekday = isWeekdayInTimezone(now, timezone);
  const isPastScheduledTime = isAfterMorningTime(now, timezone, 8, 15);
  const todayKey = formatTzDate(now, timezone);

  if (!isWeekday || !isPastScheduledTime) {
    return false;
  }

  const existingRun = await getReminderRunByKey(todayKey);
  if (existingRun !== null) {
    return false;
  }

  logger.warn({
    msg: "missed reminder run detected for today",
    date: todayKey,
    scheduler_enabled: config.enableCronScheduler,
  });

  if (config.enableCronScheduler) {
    logger.info({ msg: "executing missed reminder run now" });
    try {
      await executeReminderPipeline({ now });
      return true;
    } catch (err) {
      logger.error({
        msg: "failed to execute missed reminder run",
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  return false;
}

/**
 * Initialize the cron scheduler.
 * Returns null when disabled by configuration (M1B default).
 */
export function initScheduler(config: Config): ScheduledTask | null {
  if (!config.enableCronScheduler) {
    logger.info({
      msg: "cron scheduler is disabled (M1B default; manual/CLI triggers only)",
      cron_expr: config.reminderCron,
      timezone: config.reminderTimezone,
    });
    return null;
  }

  if (activeCronTask !== null) {
    logger.warn({ msg: "scheduler already initialized — ignoring" });
    return activeCronTask;
  }

  activeCronTask = cron.schedule(
    config.reminderCron,
    async () => {
      logger.info({ msg: "cron schedule triggered", cron: config.reminderCron });
      try {
        await executeReminderPipeline();
      } catch (err) {
        logger.error({
          msg: "scheduled reminder pipeline error",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    {
      timezone: config.reminderTimezone,
    }
  );

  logger.info({
    msg: "cron scheduler initialized",
    cron_expr: config.reminderCron,
    timezone: config.reminderTimezone,
  });

  return activeCronTask;
}

/**
 * Stop the cron scheduler during graceful shutdown.
 */
export function stopScheduler(): void {
  if (activeCronTask !== null) {
    activeCronTask.stop();
    activeCronTask = null;
    logger.info({ msg: "cron scheduler stopped" });
  }
}
