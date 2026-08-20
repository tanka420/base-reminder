/**
 * src/__tests__/pagination-termination.test.ts
 *
 * Unit tests for Adapter pagination termination conditions and infinite loop guards.
 */

import { describe, it, expect, vi } from "vitest";
import { WeworkApiClient } from "../base-api/wework.js";
import { WorkflowApiClient } from "../base-api/workflow.js";
import { RequestApiClient } from "../base-api/request.js";

describe("Adapter Pagination Termination & Loop Guards", () => {
  describe("Wework Pagination", () => {
    it("terminates when page returns < 100 items", async () => {
      const client = new WeworkApiClient("mock_token");
      const mockTasks = Array.from({ length: 35 }, (_, i) => ({
        id: i + 1,
        name: `Task ${i + 1}`,
        status: "0",
      }));

      const getUserTasksSpy = vi
        .spyOn(client, "getUserTasks")
        .mockResolvedValueOnce({ tasks: mockTasks, total: 35 });

      const all = await client.getAllUserTasks("Digital01");

      expect(all.length).toBe(35);
      expect(getUserTasksSpy).toHaveBeenCalledTimes(1);
    });

    it("terminates when API returns duplicate tasks on next page (loop guard)", async () => {
      const client = new WeworkApiClient("mock_token");
      const page1 = Array.from({ length: 100 }, (_, i) => ({
        id: i + 1,
        name: `Task ${i + 1}`,
        status: "0",
      }));
      // Page 2 returns same items as page 1
      const page2 = [...page1];

      const getUserTasksSpy = vi
        .spyOn(client, "getUserTasks")
        .mockResolvedValueOnce({ tasks: page1, total: 500 })
        .mockResolvedValueOnce({ tasks: page2, total: 500 });

      const all = await client.getAllUserTasks("Digital01");

      expect(all.length).toBe(100);
      expect(getUserTasksSpy).toHaveBeenCalledTimes(2);
    });

    it("terminates when page returns empty array", async () => {
      const client = new WeworkApiClient("mock_token");
      vi.spyOn(client, "getUserTasks").mockResolvedValueOnce({ tasks: [], total: 0 });

      const all = await client.getAllUserTasks("Digital01");
      expect(all.length).toBe(0);
    });
  });

  describe("Workflow Pagination", () => {
    it("terminates when nextPageId is undefined or matches current cursor", async () => {
      const client = new WorkflowApiClient("mock_token");
      const page1Jobs = [
        { id: 1, name: "Job 1", status: "0", username: "Digital01" },
      ];
      const page2Jobs = [
        { id: 2, name: "Job 2", status: "0", username: "Digital01" },
      ];

      const getActiveJobsSpy = vi
        .spyOn(client, "getActiveJobs")
        .mockResolvedValueOnce({ jobs: page1Jobs, nextPageId: "cursor_page_2" })
        .mockResolvedValueOnce({ jobs: page2Jobs, nextPageId: undefined });

      const all = await client.getAllActiveJobs("Digital01");

      expect(all.length).toBe(2);
      expect(getActiveJobsSpy).toHaveBeenCalledTimes(2);
    });

    it("terminates if page returns empty array", async () => {
      const client = new WorkflowApiClient("mock_token");
      vi.spyOn(client, "getActiveJobs").mockResolvedValueOnce({ jobs: [] });

      const all = await client.getAllActiveJobs("Digital01");
      expect(all.length).toBe(0);
    });
  });

  describe("Request Pagination", () => {
    it("terminates when page returns < 20 items", async () => {
      const client = new RequestApiClient("mock_token");
      const requests = Array.from({ length: 7 }, (_, i) => ({
        id: i + 1,
        name: `Request ${i + 1}`,
        status: "0",
        workflow: "sequential",
      }));

      const listSpy = vi
        .spyOn(client, "listPendingRequests")
        .mockResolvedValueOnce({ requests, totalItems: 7 });

      const all = await client.getAllPendingRequests("Digital01");

      expect(all.length).toBe(7);
      expect(listSpy).toHaveBeenCalledTimes(1);
    });

    it("terminates when totalItems is reached across multiple pages", async () => {
      const client = new RequestApiClient("mock_token");
      const page1 = Array.from({ length: 20 }, (_, i) => ({
        id: i + 1,
        name: `Request ${i + 1}`,
        status: "0",
      }));
      const page2 = Array.from({ length: 20 }, (_, i) => ({
        id: i + 21,
        name: `Request ${i + 21}`,
        status: "0",
      }));

      const listSpy = vi
        .spyOn(client, "listPendingRequests")
        .mockResolvedValueOnce({ requests: page1, totalItems: 40 })
        .mockResolvedValueOnce({ requests: page2, totalItems: 40 });

      const all = await client.getAllPendingRequests("Digital01");

      expect(all.length).toBe(40);
      expect(listSpy).toHaveBeenCalledTimes(2);
    });
  });
});
