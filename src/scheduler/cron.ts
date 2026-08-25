/**
 * src/scheduler/cron.ts
 *
 * Production Cron Scheduler with Missed-Run Cutoff & Dual-Axis Idempotency.
 *
 * Default configuration:
 *  - 08:00 Asia/Ho_Chi_Minh (Mon-Fri)
 *  - Missed-run cutoff: 10:00 Asia/Ho_Chi_Minh
 *  - Disabled by default (ENABLE_CRON_SCHEDULER=false)
 */

import cron, { type ScheduledTask } from "node-cron";
import type { Config } from "../config/index.js";
import { executeReminderPipeline } from "./reminder-job.js";
import { getReminderRunByKey, formatScheduledRunKey } from "../db/queries/runs.js";
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
 * Check if the current time has passed the scheduled morning time (default 08:00).
 */
export function isAfterMorningTime(now: Date, timezone: string, hour = 8, minute = 0): boolean {
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
 * Check if the current time has passed the cutoff hour (default 10:00).
 */
export function isPastCutoffTime(now: Date, timezone: string, cutoffHour = 10, cutoffMinute = 0): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(now);

  const currentHour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const currentMinute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");

  if (currentHour > cutoffHour) return true;
  if (currentHour === cutoffHour && currentMinute >= cutoffMinute) return true;
  return false;
}

/**
 * Inspect whether a scheduled run was missed for today (e.g. server was offline at 08:00).
 * Only executes if:
 *  - Weekday
 *  - Past 08:00
 *  - BEFORE cutoff hour (default 10:00)
 *  - No existing scheduled run in database
 *  - ENABLE_CRON_SCHEDULER is true
 */
export async function checkMissedRun(
  config: Config,
  now: Date = new Date()
): Promise<boolean> {
  const timezone = config.reminderTimezone;
  const isWeekday = isWeekdayInTimezone(now, timezone);
  const isPastScheduledTime = isAfterMorningTime(now, timezone, 8, 0);
  const todayDate = formatTzDate(now, timezone);
  const scheduledKey = formatScheduledRunKey(todayDate);

  if (!isWeekday || !isPastScheduledTime) {
    return false;
  }

  // Check if scheduled run exists (or legacy unnamespaced key)
  const existingRun =
    (await getReminderRunByKey(scheduledKey)) ||
    (await getReminderRunByKey(todayDate));

  if (existingRun !== null) {
    return false;
  }

  const isCutoff = isPastCutoffTime(now, timezone, config.missedRunCutoffHour, 0);

  if (isCutoff) {
    logger.warn({
      msg: "missed reminder run detected for today but time has passed cutoff, skipping automatic delivery",
      date: todayDate,
      cutoff_hour: config.missedRunCutoffHour,
      scheduled_key: scheduledKey,
    });
    return false;
  }

  logger.warn({
    msg: "missed reminder run detected within recovery window (08:00 - 10:00)",
    date: todayDate,
    scheduled_key: scheduledKey,
    scheduler_enabled: config.enableCronScheduler,
  });

  if (config.enableCronScheduler) {
    logger.info({ msg: "executing missed scheduled reminder run now" });
    try {
      await executeReminderPipeline({
        now,
        runType: "scheduled",
      });
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
 * Returns null when disabled by configuration (default).
 */
export function initScheduler(config: Config): ScheduledTask | null {
  if (!config.enableCronScheduler) {
    logger.info({
      msg: "cron scheduler is disabled (default; manual/CLI triggers only)",
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
      logger.info({ msg: "scheduled morning cron triggered", cron: config.reminderCron });
      try {
        await executeReminderPipeline({
          runType: "scheduled",
        });
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
    msg: "production cron scheduler initialized",
    cron_expr: config.reminderCron,
    timezone: config.reminderTimezone,
    cutoff_hour: config.missedRunCutoffHour,
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
