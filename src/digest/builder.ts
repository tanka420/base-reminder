/**
 * src/digest/builder.ts
 *
 * Channel-agnostic structured digest builder.
 *
 * Status Contract (architecture-review.md v1.1):
 *  - 'empty':   All 3 modules 'ok' AND total items == 0 (isPartial = false)
 *  - 'ready':   All 3 modules 'ok' AND total items > 0 (isPartial = false)
 *  - 'partial': At least 1 module 'error' AND at least 1 module 'ok' (isPartial = true)
 *  - 'error':   All 3 modules 'error' (isPartial = true)
 *
 * Error isolation:
 *  - Succeeded module with 0 items = valid ok status, 0 count.
 *  - Failed module = error status, never masked as 0 items.
 */

import type {
  ActionableTask,
  ActionableJob,
  ActionableRequest,
  ModuleResult,
  UserDigest,
  DigestStatus,
} from "./types.js";

export interface BuildUserDigestParams {
  baseUserId: number;
  username: string;
  displayName: string;
  wework: ModuleResult<ActionableTask>;
  workflow: ModuleResult<ActionableJob>;
  request: ModuleResult<ActionableRequest>;
}

/**
 * Assemble a structured UserDigest from the results of individual module collectors.
 */
export function buildUserDigest(params: BuildUserDigestParams): UserDigest {
  const { baseUserId, username, displayName, wework, workflow, request } = params;

  const weworkCount = wework.status === "ok" ? wework.items.length : 0;
  const workflowCount = workflow.status === "ok" ? workflow.items.length : 0;
  const requestCount = request.status === "ok" ? request.items.length : 0;
  const totalCount = weworkCount + workflowCount + requestCount;

  const modules = [wework, workflow, request];
  const okCount = modules.filter((m) => m.status === "ok").length;
  const errorCount = modules.filter((m) => m.status === "error").length;

  let status: DigestStatus;
  let isPartial: boolean;

  if (okCount === 3) {
    status = totalCount > 0 ? "ready" : "empty";
    isPartial = false;
  } else if (errorCount === 3) {
    status = "error";
    isPartial = true;
  } else {
    // Mixed ok and error
    status = "partial";
    isPartial = true;
  }

  return {
    baseUserId,
    username,
    displayName,
    status,
    isPartial,
    wework,
    workflow,
    request,
    counts: {
      wework: weworkCount,
      workflow: workflowCount,
      request: requestCount,
      total: totalCount,
    },
  };
}
