/**
 * src/collectors/wework.ts
 *
 * Collector for Base Wework tasks.
 *
 * Filtering rules:
 *  - status === "0" (incomplete only)
 *  - AND review !== "1" and review !== 1 (exclude tasks currently under review)
 *  - AND (overdue === 1 OR deadline === today in timezone)
 *
 * Review State Verification:
 *  - Real Base API field: `task.review`
 *  - Observed values: "0" = normal active/incomplete or done, "1" / 1 = currently submitted for review.
 *  - Rationale: When an assignee submits a task for review to their manager/assigner,
 *    the assignee does not currently need to take action. Reminding them creates noise.
 *    Review-state exclusion is additive and preserves normal active tasks.
 *
 * Timezone & Deadline semantics (Asia/Ho_Chi_Minh UTC+7):
 *  - deadline_has_time = 0 (date-only): If date is today, isDueToday = true and isOverdue = false.
 *  - deadline_has_time = 1 (time-specific): If today and now > deadline, isDueToday = true AND isOverdue = true.
 *  - past date: isOverdue = true, isDueToday = false.
 *  - future date: excluded from reminder.
 */

import { WeworkApiClient, type BaseWeworkTask } from "../base-api/wework.js";
import { buildWeworkDeepLink } from "../base-api/deep-links.js";
import type { ActionableTask } from "../digest/types.js";

/** Helper: Format a Date or Unix timestamp to YYYY-MM-DD in the specified timezone */
export function formatTzDate(dateOrSeconds: Date | number, timezone: string): string {
  const date = typeof dateOrSeconds === "number" ? new Date(dateOrSeconds * 1000) : dateOrSeconds;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export interface WeworkTaskClassification {
  actionable: boolean;
  isDueToday: boolean;
  isOverdue: boolean;
  isStartingToday: boolean;
  isInProgress: boolean;
  deadlineSeconds?: number;
  startDateSeconds?: number;
}

/**
 * Classify a task for reminder inclusion based on status, review state, start date, and deadline.
 *
 * Filtering rules:
 *  - status === "0" (incomplete only)
 *  - AND review !== "1" and review !== 1 (exclude tasks currently under review)
 *  - AND (
 *      isOverdue (overdue === 1 OR deadline < today)
 *      OR isDueToday (deadline === today)
 *      OR isStartingToday (start_time === today)
 *      OR isInProgress (start_time < today OR started === 1 OR complete > 0)
 *    )
 */
export function classifyWeworkTask(
  task: BaseWeworkTask,
  timezone: string,
  now: Date = new Date()
): WeworkTaskClassification {
  // 1. Only incomplete tasks (status === "0") can be actionable
  if (task.status !== "0") {
    return {
      actionable: false,
      isDueToday: false,
      isOverdue: false,
      isStartingToday: false,
      isInProgress: false,
    };
  }

  // 2. Exclude tasks currently under review (review === "1" or review === 1)
  const isUnderReview = task.review === "1" || task.review === 1;
  if (isUnderReview) {
    return {
      actionable: false,
      isDueToday: false,
      isOverdue: false,
      isStartingToday: false,
      isInProgress: false,
    };
  }

  // 3. Parse deadline
  const rawDeadline = task.deadline !== undefined && task.deadline !== null && task.deadline !== "0" && task.deadline !== 0
    ? Number(task.deadline)
    : 0;
  const deadlineSeconds = Number.isFinite(rawDeadline) && rawDeadline > 0 ? rawDeadline : undefined;
  const hasTime = Number(task.deadline_has_time) === 1;
  const apiOverdue = task.overdue === 1 || task.overdue === "1";

  // 4. Parse start date
  const rawStart = task.start_time !== undefined && task.start_time !== null && task.start_time !== "0" && task.start_time !== 0
    ? Number(task.start_time)
    : (task.stime !== undefined && task.stime !== null && task.stime !== "0" && task.stime !== 0 ? Number(task.stime) : 0);
  const startDateSeconds = Number.isFinite(rawStart) && rawStart > 0 ? rawStart : undefined;

  // 5. Parse started flag & progress
  const isStarted = task.started === 1 || task.started === "1";
  const progress = parseFloat(String(task.complete || "0"));
  const hasProgress = Number.isFinite(progress) && progress > 0;

  const todayStr = formatTzDate(now, timezone);
  const nowSeconds = Math.floor(now.getTime() / 1000);

  let isDueToday = false;
  let isOverdue = false;
  let isStartingToday = false;
  let isInProgress = false;

  // Evaluate deadline
  if (deadlineSeconds !== undefined) {
    const deadlineDateStr = formatTzDate(deadlineSeconds, timezone);

    if (deadlineDateStr === todayStr) {
      isDueToday = true;
      if (hasTime) {
        // Time-specific deadline: check if exact time has passed
        if (nowSeconds > deadlineSeconds || apiOverdue) {
          isOverdue = true;
        }
      } else {
        // Date-only deadline: not overdue during the day
        isOverdue = false;
      }
    } else if (deadlineDateStr < todayStr) {
      isOverdue = true;
    }
  } else if (apiOverdue) {
    isOverdue = true;
  }

  // Evaluate start time
  if (startDateSeconds !== undefined) {
    const startDateStr = formatTzDate(startDateSeconds, timezone);
    if (startDateStr === todayStr) {
      isStartingToday = true;
      isInProgress = true;
    } else if (startDateStr < todayStr) {
      // Past start date but incomplete -> actively in progress
      isInProgress = true;
    }
  }

  // Evaluate started flag & progress
  if (isStarted || hasProgress) {
    isInProgress = true;
  }

  const actionable = isOverdue || isDueToday || isInProgress;
  return {
    actionable,
    isDueToday,
    isOverdue,
    isStartingToday,
    isInProgress,
    deadlineSeconds,
    startDateSeconds,
  };
}

/**
 * Collect actionable tasks for a specific user.
 * Sorted: Overdue (oldest first) -> Due Today -> In Progress.
 */
export async function collectWeworkTasks(
  client: WeworkApiClient,
  username: string,
  timezone = "Asia/Ho_Chi_Minh",
  now: Date = new Date()
): Promise<ActionableTask[]> {
  const allTasks = await client.getAllUserTasks(username);
  const actionableItems: ActionableTask[] = [];

  for (const task of allTasks) {
    const classification = classifyWeworkTask(task, timezone, now);
    if (!classification.actionable) continue;

    // Use canonical task.id with centralized builder (NEVER task.link or task.hid)
    const url = buildWeworkDeepLink(task.id);

    actionableItems.push({
      id: task.id,
      name: task.name || (task.display_name ?? `Task #${task.id}`),
      deadline: classification.deadlineSeconds,
      startDate: classification.startDateSeconds,
      isOverdue: classification.isOverdue,
      isDueToday: classification.isDueToday,
      isStartingToday: classification.isStartingToday,
      isInProgress: classification.isInProgress,
      url,
      projectId: task.project_id,
    });
  }

  // Sort items:
  // 1. Overdue first (oldest deadline first)
  // 2. Due today second (earliest deadline first)
  // 3. In Progress third (earliest deadline first, then start date)
  actionableItems.sort((a, b) => {
    // Overdue items first
    if (a.isOverdue && !b.isOverdue) return -1;
    if (!a.isOverdue && b.isOverdue) return 1;

    // Due today items second
    if (a.isDueToday && !b.isDueToday) return -1;
    if (!a.isDueToday && b.isDueToday) return 1;

    // Tie-breaker
    const aDead = a.deadline ?? 0;
    const bDead = b.deadline ?? 0;
    if (aDead !== bDead) {
      if (aDead === 0) return 1;
      if (bDead === 0) return -1;
      return aDead - bDead;
    }

    const aStart = a.startDate ?? 0;
    const bStart = b.startDate ?? 0;
    return aStart - bStart;
  });

  return actionableItems;
}
