/**
 * src/__tests__/deep-link-pipeline.test.ts
 *
 * Real-shape regression tests for canonical ID extraction and URL construction
 * across all 3 Base modules (Wework, Workflow, Request).
 *
 * Guarantees:
 *  - Real API payload structures with noisy/legacy fields (e.g. `link`, `hid`, `workflow_id`, `stage_id`)
 *    must NEVER pollute or override canonical deep links.
 */

import { describe, it, expect } from "vitest";
import {
  buildWeworkDeepLink,
  buildWorkflowDeepLink,
  buildRequestDeepLink,
} from "../base-api/deep-links.js";
import { collectWeworkTasks } from "../collectors/wework.js";
import { collectWorkflowJobs } from "../collectors/workflow.js";
import { collectActionableRequests } from "../collectors/request.js";

describe("Base Canonical Deep Links & Real-Payload Pipeline", () => {
  const TZ = "Asia/Ho_Chi_Minh";
  const mockNow = new Date("2026-08-20T01:15:00.000Z");

  describe("Centralized URL Builder", () => {
    it("builds exact canonical Wework deep link", () => {
      expect(buildWeworkDeepLink(10505978)).toBe("https://wework.base.vn/tasks?task=10505978");
      expect(buildWeworkDeepLink("10505978")).toBe("https://wework.base.vn/tasks?task=10505978");
    });

    it("builds exact canonical Workflow deep link", () => {
      expect(buildWorkflowDeepLink(3702233)).toBe("https://workflow.base.vn/job/3702233");
      expect(buildWorkflowDeepLink("3702233")).toBe("https://workflow.base.vn/job/3702233");
    });

    it("builds exact canonical Request deep link", () => {
      expect(buildRequestDeepLink(2851484)).toBe("https://request.base.vn/home?request=2851484");
      expect(buildRequestDeepLink("2851484")).toBe("https://request.base.vn/home?request=2851484");
    });
  });

  describe("Real-Payload Wework Collector Mapping", () => {
    it("ignores task.link or task.hid and uses canonical task.id", async () => {
      const mockClient = {
        getAllUserTasks: async () => [
          {
            id: 10505978,
            name: "Minigame dự đoán Worldcup trên Facebook",
            status: "0",
            overdue: 1,
            link: "https://wework.base.vn/task/b3Blbi1hY3Rpb24tcHJvamVjdA==", // Legacy/encoded link to ignore
            hid: "legacy_hid_999",
            project_id: 456,
          },
        ],
      } as any;

      const tasks = await collectWeworkTasks(mockClient, "Digital01", TZ, mockNow);

      expect(tasks.length).toBe(1);
      expect(tasks[0]?.id).toBe(10505978);
      expect(tasks[0]?.url).toBe("https://wework.base.vn/tasks?task=10505978");
      expect(tasks[0]?.url).not.toContain("legacy");
      expect(tasks[0]?.url).not.toContain("b3Blbi");
    });
  });

  describe("Real-Payload Workflow Collector Mapping", () => {
    it("uses canonical job.id and does NOT accidentally use workflow_id or stage_id", async () => {
      const mockClient = {
        getAllActiveJobs: async () => [
          {
            id: 3702233, // Canonical job ID
            name: "Duyệt thiết kế Landing Page Voltronic",
            status: "0",
            state: "active",
            username: "Digital01",
            workflow_id: 88888, // Must NOT be used
            stage_id: 99999,    // Must NOT be used
            stage_export: { id: 99999, name: "Manager Review" },
            hid: "encoded_job_token",
            stage_deadline: 1787158799, // Past date -> Overdue
          },
        ],
      } as any;

      const jobs = await collectWorkflowJobs(mockClient, "Digital01", TZ, mockNow);

      expect(jobs.length).toBe(1);
      expect(jobs[0]?.id).toBe(3702233);
      expect(jobs[0]?.url).toBe("https://workflow.base.vn/job/3702233");
      expect(jobs[0]?.url).not.toContain("88888");
      expect(jobs[0]?.url).not.toContain("99999");
      expect(jobs[0]?.isOverdue).toBe(true);
      expect(jobs[0]?.isDueToday).toBe(false);
      expect(jobs[0]?.stageName).toBe("Manager Review");
    });
  });

  describe("Real-Payload Request Collector Mapping", () => {
    it("uses canonical request.id and does NOT accidentally use creator_id or user_id", async () => {
      const mockClient = {
        getAllPendingRequests: async () => [
          {
            id: 2851484, // Canonical request ID
            name: "Đề nghị thanh toán ngân sách Facebook Ads",
            status: "0",
            state: "active",
            workflow: "sequential",
            owners: [{ username: "Digital01", approved: 0 }],
            username: "hoa.nt",
            user_id: 11111, // Creator user ID - Must NOT be used
            hid: "encoded_request_token",
            deadline: 1787245199, // Today in VN -> Due Today
          },
        ],
      } as any;

      const requests = await collectActionableRequests(mockClient, "Digital01", TZ, mockNow);

      expect(requests.length).toBe(1);
      expect(requests[0]?.id).toBe(2851484);
      expect(requests[0]?.url).toBe("https://request.base.vn/home?request=2851484");
      expect(requests[0]?.url).not.toContain("11111");
      expect(requests[0]?.isDueToday).toBe(true);
      expect(requests[0]?.isOverdue).toBe(false);
    });
  });
});
