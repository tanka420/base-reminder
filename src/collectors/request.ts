/**
 * src/collectors/request.ts
 *
 * Collector for Base Request actionable approval requests.
 *
 * Logic rules (M0.1 verified + fail-closed):
 *  - status === "0" required
 *  - if state property exists, state === "active" required
 *  - sequential: only first owner in owners array with approved === 0 is actionable
 *  - parallel: all owners with approved === 0 are actionable
 *  - any other workflow value: return false (fail closed)
 *
 * Deadline Classification:
 *  - local date < today in timezone -> isOverdue = true
 *  - local date == today in timezone -> isDueToday = true
 *  - missing deadline -> neither (neutral)
 */

import { RequestApiClient, type BaseRequestItem } from "../base-api/request.js";
import { buildRequestDeepLink } from "../base-api/deep-links.js";
import { formatTzDate } from "./wework.js";
import type { ActionableRequest } from "../digest/types.js";

/** Helper: Clean username string (removes @ prefix and trims) */
function cleanUsername(u: string): string {
  return u.startsWith("@") ? u.slice(1).trim().toLowerCase() : u.trim().toLowerCase();
}

/**
 * Determine if a pending request is currently actionable for the given user.
 */
export function isRequestActionableForUser(
  request: BaseRequestItem,
  targetUsername: string
): boolean {
  if (request.status !== "0") return false;
  if (request.state !== undefined && request.state !== "active") return false;

  const target = cleanUsername(targetUsername);
  const owners = Array.isArray(request.owners) ? request.owners : [];
  const workflow = request.workflow ? request.workflow.toLowerCase().trim() : undefined;

  if (workflow === "sequential") {
    // First owner in chain who has not yet approved (approved === 0)
    const currentApprover = owners.find((o) => o.approved === 0);
    if (!currentApprover) return false;

    const approverName = cleanUsername(currentApprover.username || "");
    return approverName === target;
  }

  if (workflow === "parallel") {
    // Any owner who has not yet approved
    return owners.some((o) => {
      if (o.approved !== 0) return false;
      const approverName = cleanUsername(o.username || "");
      return approverName === target;
    });
  }

  // Fail closed for any other or missing workflow type
  return false;
}

/**
 * Classify a request deadline against the current date in the specified timezone.
 */
export function classifyRequestItem(
  request: BaseRequestItem,
  timezone: string,
  now: Date = new Date()
): { isOverdue: boolean; isDueToday: boolean; deadline?: number } {
  const rawDeadline = request.deadline !== undefined && request.deadline !== null && request.deadline !== ""
    ? Number(request.deadline)
    : 0;

  const deadline = Number.isFinite(rawDeadline) && rawDeadline > 0 ? rawDeadline : undefined;

  if (deadline === undefined) {
    return { isOverdue: false, isDueToday: false, deadline: undefined };
  }

  const todayStr = formatTzDate(now, timezone);
  const deadlineDateStr = formatTzDate(deadline, timezone);

  let isDueToday = false;
  let isOverdue = false;

  if (deadlineDateStr < todayStr) {
    isOverdue = true;
  } else if (deadlineDateStr === todayStr) {
    isDueToday = true;
  }

  return { isOverdue, isDueToday, deadline };
}

/**
 * Collect all actionable approval requests for a user.
 * Sorted: Overdue (oldest first) -> Due Today -> Others.
 */
export async function collectActionableRequests(
  client: RequestApiClient,
  username: string,
  timezone = "Asia/Ho_Chi_Minh",
  now: Date = new Date()
): Promise<ActionableRequest[]> {
  const allRequests = await client.getAllPendingRequests(username);
  const actionableItems: ActionableRequest[] = [];

  for (const req of allRequests) {
    if (!isRequestActionableForUser(req, username)) continue;

    const classification = classifyRequestItem(req, timezone, now);

    // Use canonical request.id with centralized builder (NEVER workflow_id or owner_id)
    const url = buildRequestDeepLink(req.id);

    actionableItems.push({
      id: req.id,
      name: req.name || `Request #${req.id}`,
      creatorUsername: req.username || "unknown",
      workflow: (req.workflow?.toLowerCase() === "parallel" ? "parallel" : "sequential"),
      url,
      deadline: classification.deadline,
      isOverdue: classification.isOverdue,
      isDueToday: classification.isDueToday,
    });
  }

  // Sort items: overdue first (oldest deadline first), then due today, then neutral
  actionableItems.sort((a, b) => {
    if (a.isOverdue && !b.isOverdue) return -1;
    if (!a.isOverdue && b.isOverdue) return 1;
    if (a.isDueToday && !b.isDueToday) return -1;
    if (!a.isDueToday && b.isDueToday) return 1;
    const aDead = a.deadline ?? 0;
    const bDead = b.deadline ?? 0;
    return aDead - bDead;
  });

  return actionableItems;
}
