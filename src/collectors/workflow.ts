/**
 * src/collectors/workflow.ts
 *
 * Collector for Base Workflow active jobs.
 *
 * Filtering rules:
 *  - status === "0" or state === "active"
 *  - job.username === targetUsername (verified as current stage assignee)
 *
 * Deadline Classification:
 *  - local date < today in timezone -> isOverdue = true
 *  - local date == today in timezone -> isDueToday = true
 *  - missing deadline -> neither (neutral)
 */

import { WorkflowApiClient, type BaseWorkflowJob } from "../base-api/workflow.js";
import { buildWorkflowDeepLink } from "../base-api/deep-links.js";
import { formatTzDate } from "./wework.js";
import type { ActionableJob } from "../digest/types.js";

/** Helper: Clean username string (removes @ prefix and trims) */
function cleanUsername(u: string): string {
  return u.startsWith("@") ? u.slice(1).trim().toLowerCase() : u.trim().toLowerCase();
}

/**
 * Check if a workflow job is currently assigned to the given user in its active stage.
 */
export function isJobActionableForUser(
  job: BaseWorkflowJob,
  targetUsername: string
): boolean {
  const isActive = job.status === "0" || job.state === "active";
  if (!isActive) return false;

  const currentAssignee = cleanUsername(job.username || "");
  const target = cleanUsername(targetUsername);

  return currentAssignee === target;
}

/**
 * Classify a workflow job deadline against the current date in the specified timezone.
 */
export function classifyWorkflowJob(
  job: BaseWorkflowJob,
  timezone: string,
  now: Date = new Date()
): { isOverdue: boolean; isDueToday: boolean; stageDeadline?: number } {
  const rawDeadline = job.stage_deadline !== undefined && job.stage_deadline !== null && job.stage_deadline !== ""
    ? Number(job.stage_deadline)
    : (job.deadline !== undefined && job.deadline !== null && job.deadline !== "" ? Number(job.deadline) : 0);

  const stageDeadline = Number.isFinite(rawDeadline) && rawDeadline > 0 ? rawDeadline : undefined;

  if (stageDeadline === undefined) {
    return { isOverdue: false, isDueToday: false, stageDeadline: undefined };
  }

  const todayStr = formatTzDate(now, timezone);
  const deadlineDateStr = formatTzDate(stageDeadline, timezone);

  let isDueToday = false;
  let isOverdue = false;

  if (deadlineDateStr < todayStr) {
    isOverdue = true;
  } else if (deadlineDateStr === todayStr) {
    isDueToday = true;
  }

  return { isOverdue, isDueToday, stageDeadline };
}

/**
 * Collect all active jobs currently assigned to a user.
 * Sorted: Overdue (oldest first) -> Due Today -> Others.
 */
export async function collectWorkflowJobs(
  client: WorkflowApiClient,
  username: string,
  timezone = "Asia/Ho_Chi_Minh",
  now: Date = new Date()
): Promise<ActionableJob[]> {
  const allJobs = await client.getAllActiveJobs(username);
  const actionableJobs: ActionableJob[] = [];

  for (const job of allJobs) {
    if (!isJobActionableForUser(job, username)) continue;

    const classification = classifyWorkflowJob(job, timezone, now);

    // Use canonical job.id with centralized builder (NEVER workflow_id or stage_id)
    const url = buildWorkflowDeepLink(job.id);

    actionableJobs.push({
      id: job.id,
      name: job.name || (job.title ?? `Job #${job.id}`),
      stageName: job.stage_export?.name,
      workflowName: job.workflow_export?.name,
      stageDeadline: classification.stageDeadline,
      isOverdue: classification.isOverdue,
      isDueToday: classification.isDueToday,
      url,
    });
  }

  // Sort items: overdue first (oldest deadline first), then due today, then neutral
  actionableJobs.sort((a, b) => {
    if (a.isOverdue && !b.isOverdue) return -1;
    if (!a.isOverdue && b.isOverdue) return 1;
    if (a.isDueToday && !b.isDueToday) return -1;
    if (!a.isDueToday && b.isDueToday) return 1;
    const aDead = a.stageDeadline ?? 0;
    const bDead = b.stageDeadline ?? 0;
    return aDead - bDead;
  });

  return actionableJobs;
}
