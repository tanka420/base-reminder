/**
 * src/__tests__/digest-builder.test.ts
 *
 * Unit tests for Channel-Agnostic Digest Builder.
 * Tests:
 *  - 'empty' contract: 3 modules ok, 0 items
 *  - 'ready' contract: 3 modules ok, >0 items
 *  - 'partial' contract: 1 or 2 modules error, at least 1 ok
 *  - 'error' contract: all 3 modules error
 *  - Error isolation: error in module does not corrupt counts of succeeded modules
 */

import { describe, it, expect } from "vitest";
import { buildUserDigest } from "../digest/builder.js";
import type {
  ActionableTask,
  ActionableJob,
  ActionableRequest,
} from "../digest/types.js";

describe("Digest Builder (Contract & Status Matrix)", () => {
  const dummyTask: ActionableTask = {
    id: 1,
    name: "Task 1",
    isOverdue: true,
    isDueToday: false,
    url: "https://wework.base.vn/task/1",
  };

  const dummyJob: ActionableJob = {
    id: 2,
    name: "Job 1",
    url: "https://workflow.base.vn/job/2",
  };

  const dummyRequest: ActionableRequest = {
    id: 3,
    name: "Request 1",
    creatorUsername: "Alice",
    workflow: "sequential",
    url: "https://request.base.vn/request/3",
  };

  it("returns status='empty' and isPartial=false when all 3 modules succeed with 0 items", () => {
    const digest = buildUserDigest({
      baseUserId: 10,
      username: "Digital01",
      displayName: "Mai Thanh Tân",
      wework: { status: "ok", items: [] },
      workflow: { status: "ok", items: [] },
      request: { status: "ok", items: [] },
    });

    expect(digest.status).toBe("empty");
    expect(digest.isPartial).toBe(false);
    expect(digest.counts).toEqual({
      wework: 0,
      workflow: 0,
      request: 0,
      total: 0,
    });
  });

  it("returns status='ready' and isPartial=false when all 3 modules succeed and at least one has items", () => {
    const digest = buildUserDigest({
      baseUserId: 10,
      username: "Digital01",
      displayName: "Mai Thanh Tân",
      wework: { status: "ok", items: [dummyTask] },
      workflow: { status: "ok", items: [] },
      request: { status: "ok", items: [dummyRequest] },
    });

    expect(digest.status).toBe("ready");
    expect(digest.isPartial).toBe(false);
    expect(digest.counts).toEqual({
      wework: 1,
      workflow: 0,
      request: 1,
      total: 2,
    });
  });

  it("returns status='partial' and isPartial=true when 1 module fails and 2 succeed", () => {
    const digest = buildUserDigest({
      baseUserId: 10,
      username: "Digital01",
      displayName: "Mai Thanh Tân",
      wework: { status: "error", items: [], error: "Wework 503 Service Unavailable" },
      workflow: { status: "ok", items: [dummyJob] },
      request: { status: "ok", items: [] },
    });

    expect(digest.status).toBe("partial");
    expect(digest.isPartial).toBe(true);
    expect(digest.counts).toEqual({
      wework: 0,
      workflow: 1,
      request: 0,
      total: 1,
    });
    expect(digest.wework.error).toBe("Wework 503 Service Unavailable");
  });

  it("returns status='partial' and isPartial=true when 2 modules fail and 1 succeeds", () => {
    const digest = buildUserDigest({
      baseUserId: 10,
      username: "Digital01",
      displayName: "Mai Thanh Tân",
      wework: { status: "error", items: [], error: "Wework 500" },
      workflow: { status: "error", items: [], error: "Workflow 500" },
      request: { status: "ok", items: [dummyRequest] },
    });

    expect(digest.status).toBe("partial");
    expect(digest.isPartial).toBe(true);
    expect(digest.counts.total).toBe(1);
  });

  it("returns status='error' and isPartial=true when all 3 modules fail", () => {
    const digest = buildUserDigest({
      baseUserId: 10,
      username: "Digital01",
      displayName: "Mai Thanh Tân",
      wework: { status: "error", items: [], error: "Wework Error" },
      workflow: { status: "error", items: [], error: "Workflow Error" },
      request: { status: "error", items: [], error: "Request Error" },
    });

    expect(digest.status).toBe("error");
    expect(digest.isPartial).toBe(true);
    expect(digest.counts.total).toBe(0);
  });

  it("never masks a module error as 0 items (module error isolation)", () => {
    const digest = buildUserDigest({
      baseUserId: 10,
      username: "Digital01",
      displayName: "Mai Thanh Tân",
      wework: { status: "error", items: [], error: "Connection Timeout" },
      workflow: { status: "ok", items: [] },
      request: { status: "ok", items: [] },
    });

    // Even though workflow and request have 0 items, overall status is partial because Wework failed
    expect(digest.status).toBe("partial");
    expect(digest.wework.status).toBe("error");
    expect(digest.isPartial).toBe(true);
  });
});
