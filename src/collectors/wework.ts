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

/**
 * Classify a task for reminder inclusion based on status, review state, and deadline.
 */
export function classifyWeworkTask(
  task: BaseWeworkTask,
  timezone: string,
  now: Date = new Date()
): { actionable: boolean; isDueToday: boolean; isOverdue: boolean; deadlineSeconds?: number } {
  // 1. Only incomplete tasks (status === "0") can be actionable
  if (task.status !== "0") {
    return { actionable: false, isDueToday: false, isOverdue: false };
  }

  // 2. Exclude tasks currently under review (review === "1" or review === 1)
  const isUnderReview = task.review === "1" || task.review === 1;
  if (isUnderReview) {
    return { actionable: false, isDueToday: false, isOverdue: false };
  }

  const rawDeadline = task.deadline !== undefined && task.deadline !== null ? Number(task.deadline) : 0;
  const deadlineSeconds = Number.isFinite(rawDeadline) && rawDeadline > 0 ? rawDeadline : undefined;
  const hasTime = Number(task.deadline_has_time) === 1;
  const apiOverdue = task.overdue === 1 || task.overdue === "1";

  const todayStr = formatTzDate(now, timezone);
  const nowSeconds = Math.floor(now.getTime() / 1000);

  let isDueToday = false;
  let isOverdue = false;

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

  const actionable = isDueToday || isOverdue;
  return { actionable, isDueToday, isOverdue, deadlineSeconds };
}

/**
 * Collect actionable tasks for a specific user.
 * Sorted: Overdue (oldest first) -> Due Today.
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
      isOverdue: classification.isOverdue,
      isDueToday: classification.isDueToday,
      url,
      projectId: task.project_id,
    });
  }

  // Sort items: overdue first (oldest deadline first), then due today
  actionableItems.sort((a, b) => {
    if (a.isOverdue && !b.isOverdue) return -1;
    if (!a.isOverdue && b.isOverdue) return 1;
    const aDead = a.deadline ?? 0;
    const bDead = b.deadline ?? 0;
    return aDead - bDead;
  });

  return actionableItems;
}
