/**
 * src/collectors/workflow.ts
 *
 * Collector for Base Workflow active jobs.
 *
 * Filtering rules:
 *  - status === "0" or state === "active"
 *  - job.username === targetUsername (verified as current stage assignee)
 */

import { WorkflowApiClient, type BaseWorkflowJob } from "../base-api/workflow.js";
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
 * Collect all active jobs currently assigned to a user.
 */
export async function collectWorkflowJobs(
  client: WorkflowApiClient,
  username: string
): Promise<ActionableJob[]> {
  const allJobs = await client.getAllActiveJobs(username);
  const actionableJobs: ActionableJob[] = [];

  for (const job of allJobs) {
    if (!isJobActionableForUser(job, username)) continue;

    const rawStageDeadline = job.stage_deadline ? Number(job.stage_deadline) : 0;
    const stageDeadline =
      Number.isFinite(rawStageDeadline) && rawStageDeadline > 0
        ? rawStageDeadline
        : undefined;

    const url = job.hid
      ? `https://workflow.base.vn/job/${job.hid}`
      : "https://workflow.base.vn";

    actionableJobs.push({
      id: job.id,
      name: job.name || (job.title ?? `Job #${job.id}`),
      stageName: job.stage_export?.name,
      workflowName: job.workflow_export?.name,
      stageDeadline,
      url,
    });
  }

  return actionableJobs;
}
