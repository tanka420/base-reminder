/**
 * src/__tests__/workflow-collector.test.ts
 *
 * Unit tests for Workflow active jobs classification and current-stage assignee filtering.
 */

import { describe, it, expect } from "vitest";
import { isJobActionableForUser } from "../collectors/workflow.js";
import type { BaseWorkflowJob } from "../base-api/workflow.js";

describe("Workflow Collector & Job Classification", () => {
  it("returns true when user matches job.username (current stage assignee) and job is active", () => {
    const job: BaseWorkflowJob = {
      id: 501,
      name: "Job in Stage 2",
      status: "0",
      state: "active",
      username: "Digital01",
      creator_username: "Executive01",
    };

    expect(isJobActionableForUser(job, "Digital01")).toBe(true);
    expect(isJobActionableForUser(job, "@Digital01")).toBe(true);
    expect(isJobActionableForUser(job, "digital01")).toBe(true); // Case insensitive
  });

  it("returns false for creator when someone else is the current stage assignee", () => {
    const job: BaseWorkflowJob = {
      id: 502,
      name: "Job created by Executive01 but assigned to Digital01",
      status: "0",
      state: "active",
      username: "Digital01", // current stage assignee
      creator_username: "Executive01",
    };

    // Executive01 created it, but is NOT the current stage assignee
    expect(isJobActionableForUser(job, "Executive01")).toBe(false);
  });

  it("returns false when job status is not active (e.g. done or cancelled)", () => {
    const job: BaseWorkflowJob = {
      id: 503,
      name: "Completed Job",
      status: "1", // not 0
      state: "done",
      username: "Digital01",
    };

    expect(isJobActionableForUser(job, "Digital01")).toBe(false);
  });
});
