/**
 * src/__tests__/partial-failure-integration.test.ts
 *
 * Controlled integration test for partial module failures & all-three-failed scenarios:
 *  - 1 module fails, 2 succeed -> overall status = "partial", isPartial = true
 *  - Successful module actions remain present
 *  - Failed module is represented with error string and NOT interpreted as 0 actionable items
 *  - All 3 modules fail -> overall status = "error", isPartial = true
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildUserDigest } from "../digest/builder.js";
import type {
  ActionableTask,
  ActionableJob,
  ActionableRequest,
} from "../digest/types.js";

describe("Partial Failure & Error Isolation Contract (Integration)", () => {
  const dummyTask: ActionableTask = {
    id: 101,
    name: "Important Task",
    isOverdue: true,
    isDueToday: false,
    url: "https://wework.base.vn/task/101",
  };

  const dummyJob: ActionableJob = {
    id: 201,
    name: "Stage 2 Job",
    workflowName: "Approval Flow",
    stageName: "Stage 2",
    url: "https://workflow.base.vn/job/201",
  };

  it("handles 1 collector failure (Wework 503) while Workflow and Request succeed", () => {
    // Simulated collector outputs: Wework fails with 503, Workflow has 1 job, Request has 0 requests
    const digest = buildUserDigest({
      baseUserId: 1001,
      username: "Digital01",
      displayName: "Mai Thanh Tân",
      wework: {
        status: "error",
        items: [],
        error: "Base Wework API 503 Service Unavailable",
      },
      workflow: {
        status: "ok",
        items: [dummyJob],
      },
      request: {
        status: "ok",
        items: [],
      },
    });

    // 1. Overall status is PARTIAL
    expect(digest.status).toBe("partial");
    expect(digest.isPartial).toBe(true);

    // 2. Successful module actions remain present and accurately counted
    expect(digest.workflow.status).toBe("ok");
    expect(digest.workflow.items.length).toBe(1);
    expect(digest.workflow.items[0]?.name).toBe("Stage 2 Job");
    expect(digest.counts.workflow).toBe(1);

    expect(digest.request.status).toBe("ok");
    expect(digest.counts.request).toBe(0);

    // 3. Failed module is represented as error, NOT silently treated as 0 items
    expect(digest.wework.status).toBe("error");
    expect(digest.wework.error).toBe("Base Wework API 503 Service Unavailable");
    expect(digest.counts.wework).toBe(0);

    // 4. Total count reflects only confirmed successful items
    expect(digest.counts.total).toBe(1);
  });

  it("handles all-three-failed scenario -> status = error", () => {
    const digest = buildUserDigest({
      baseUserId: 1001,
      username: "Digital01",
      displayName: "Mai Thanh Tân",
      wework: {
        status: "error",
        items: [],
        error: "Wework Connection Timeout",
      },
      workflow: {
        status: "error",
        items: [],
        error: "Workflow 500 Internal Server Error",
      },
      request: {
        status: "error",
        items: [],
        error: "Request 401 Unauthorized",
      },
    });

    expect(digest.status).toBe("error");
    expect(digest.isPartial).toBe(true);
    expect(digest.counts.total).toBe(0);
    expect(digest.wework.status).toBe("error");
    expect(digest.workflow.status).toBe("error");
    expect(digest.request.status).toBe("error");
  });
});
