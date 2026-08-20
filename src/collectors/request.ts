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
 */

import { RequestApiClient, type BaseRequestItem } from "../base-api/request.js";
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
 * Collect all actionable approval requests for a user.
 */
export async function collectActionableRequests(
  client: RequestApiClient,
  username: string
): Promise<ActionableRequest[]> {
  const allRequests = await client.getAllPendingRequests(username);
  const actionableItems: ActionableRequest[] = [];

  for (const req of allRequests) {
    if (!isRequestActionableForUser(req, username)) continue;

    const rawDeadline = req.deadline ? Number(req.deadline) : 0;
    const deadline =
      Number.isFinite(rawDeadline) && rawDeadline > 0 ? rawDeadline : undefined;

    const url = req.hid
      ? `https://request.base.vn/request/${req.hid}`
      : "https://request.base.vn";

    actionableItems.push({
      id: req.id,
      name: req.name || `Request #${req.id}`,
      creatorUsername: req.username || "unknown",
      workflow: (req.workflow?.toLowerCase() === "parallel" ? "parallel" : "sequential"),
      url,
      deadline,
    });
  }

  return actionableItems;
}
