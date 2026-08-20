/**
 * src/base-api/deep-links.ts
 *
 * Centralized Base Deep-Link Builder.
 *
 * Canonical URL Rules:
 *  - Wework:   https://wework.base.vn/tasks?task={task_id}
 *  - Workflow: https://workflow.base.vn/job/{job_id}
 *  - Request:  https://request.base.vn/home?request={request_id}
 *
 * Guarantees:
 *  - Requires canonical Base object IDs (sourceId).
 *  - Never accepts or constructs legacy/internal routes (e.g. /task/<encoded> or task.link).
 *  - Encodes ID components safely.
 */

/**
 * Build canonical deep-link for a Wework task.
 */
export function buildWeworkDeepLink(taskId: number | string): string {
  const cleanId = encodeURIComponent(String(taskId).trim());
  return `https://wework.base.vn/tasks?task=${cleanId}`;
}

/**
 * Build canonical deep-link for a Workflow job.
 */
export function buildWorkflowDeepLink(jobId: number | string): string {
  const cleanId = encodeURIComponent(String(jobId).trim());
  return `https://workflow.base.vn/job/${cleanId}`;
}

/**
 * Build canonical deep-link for a Request item.
 */
export function buildRequestDeepLink(requestId: number | string): string {
  const cleanId = encodeURIComponent(String(requestId).trim());
  return `https://request.base.vn/home?request=${cleanId}`;
}
