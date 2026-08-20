/**
 * src/digest/types.ts
 *
 * Channel-agnostic structured digest data types.
 *
 * Digest status contract:
 *  - 'empty':   All 3 modules 'ok' AND total items == 0
 *  - 'ready':   All 3 modules 'ok' AND total items > 0
 *  - 'partial': At least 1 module 'error' AND at least 1 module 'ok'
 *  - 'error':   All 3 modules 'error'
 */

export type ModuleStatus = "ok" | "error" | "pending";
export type DigestStatus = "empty" | "ready" | "partial" | "error";

export interface ActionableTask {
  id: number;
  name: string;
  deadline?: number; // Unix seconds
  isOverdue: boolean;
  isDueToday: boolean;
  url: string;
  projectId?: number;
}

export interface ActionableJob {
  id: number;
  name: string;
  stageName?: string;
  workflowName?: string;
  stageDeadline?: number; // Unix seconds
  url: string;
}

export interface ActionableRequest {
  id: number;
  name: string;
  creatorUsername: string;
  workflow: "sequential" | "parallel";
  url: string;
  deadline?: number; // Unix seconds
}

export interface ModuleResult<T> {
  status: ModuleStatus;
  items: T[];
  error?: string;
}

export interface UserDigest {
  baseUserId: number;
  username: string;
  displayName: string;
  status: DigestStatus;
  isPartial: boolean;
  wework: ModuleResult<ActionableTask>;
  workflow: ModuleResult<ActionableJob>;
  request: ModuleResult<ActionableRequest>;
  counts: {
    wework: number;
    workflow: number;
    request: number;
    total: number;
  };
}
