/**
 * src/__tests__/request-collector.test.ts
 *
 * Unit tests for Request approval logic:
 *  - status === "0" required
 *  - state === "active" if state present
 *  - sequential: only first owner in chain with approved === 0 is actionable
 *  - parallel: any owner with approved === 0 is actionable
 *  - unknown/missing workflow: returns false (fail closed)
 */

import { describe, it, expect } from "vitest";
import { isRequestActionableForUser } from "../collectors/request.js";
import type { BaseRequestItem } from "../base-api/request.js";

describe("Request Collector & isRequestActionableForUser", () => {
  describe("Sequential Approval Workflow", () => {
    it("returns true for the FIRST approver in chain with approved=0", () => {
      const request: BaseRequestItem = {
        id: 701,
        name: "Purchase Request",
        status: "0",
        state: "active",
        workflow: "sequential",
        owners: [
          { username: "HCNS01", approved: 0 },
          { username: "Executive01", approved: 0 },
          { username: "AccountManager01", approved: 0 },
        ],
      };

      // HCNS01 is first in line with approved=0 -> actionable
      expect(isRequestActionableForUser(request, "HCNS01")).toBe(true);
      expect(isRequestActionableForUser(request, "@HCNS01")).toBe(true);

      // Executive01 and AccountManager01 are later in chain -> NOT actionable yet
      expect(isRequestActionableForUser(request, "Executive01")).toBe(false);
      expect(isRequestActionableForUser(request, "AccountManager01")).toBe(false);
    });

    it("returns true for SECOND approver after first approver has approved (approved=1)", () => {
      const request: BaseRequestItem = {
        id: 702,
        name: "Expense Claim",
        status: "0",
        state: "active",
        workflow: "sequential",
        owners: [
          { username: "HCNS01", approved: 1 }, // Already approved
          { username: "Executive01", approved: 0 }, // Current turn!
          { username: "AccountManager01", approved: 0 },
        ],
      };

      // HCNS01 already approved -> false
      expect(isRequestActionableForUser(request, "HCNS01")).toBe(false);

      // Executive01 is now first with approved=0 -> true
      expect(isRequestActionableForUser(request, "Executive01")).toBe(true);

      // AccountManager01 still waiting -> false
      expect(isRequestActionableForUser(request, "AccountManager01")).toBe(false);
    });

    it("returns false if all approvers have approved (approved=1)", () => {
      const request: BaseRequestItem = {
        id: 703,
        name: "Done Request",
        status: "0",
        state: "active",
        workflow: "sequential",
        owners: [
          { username: "HCNS01", approved: 1 },
          { username: "Executive01", approved: 1 },
        ],
      };

      expect(isRequestActionableForUser(request, "HCNS01")).toBe(false);
      expect(isRequestActionableForUser(request, "Executive01")).toBe(false);
    });
  });

  describe("Parallel Approval Workflow", () => {
    it("returns true for all approvers with approved=0 in parallel workflow", () => {
      const request: BaseRequestItem = {
        id: 704,
        name: "Marketing Event Proposal",
        status: "0",
        state: "active",
        workflow: "parallel",
        owners: [
          { username: "MarketingManager", approved: 0 },
          { username: "ChiefAccountant", approved: 0 },
          { username: "Director", approved: 1 },
        ],
      };

      // Both pending approvers can approve simultaneously
      expect(isRequestActionableForUser(request, "MarketingManager")).toBe(true);
      expect(isRequestActionableForUser(request, "ChiefAccountant")).toBe(true);

      // Director already approved
      expect(isRequestActionableForUser(request, "Director")).toBe(false);
    });
  });

  describe("Fail-Closed & Status Enforcement", () => {
    it("returns false if status is not '0' (e.g. approved '1' or rejected '-1')", () => {
      const request: BaseRequestItem = {
        id: 705,
        name: "Approved Request",
        status: "1",
        state: "active",
        workflow: "sequential",
        owners: [{ username: "Executive01", approved: 0 }],
      };

      expect(isRequestActionableForUser(request, "Executive01")).toBe(false);
    });

    it("returns false if state property exists and is not 'active'", () => {
      const request: BaseRequestItem = {
        id: 706,
        name: "Closed Request",
        status: "0",
        state: "closed",
        workflow: "sequential",
        owners: [{ username: "Executive01", approved: 0 }],
      };

      expect(isRequestActionableForUser(request, "Executive01")).toBe(false);
    });

    it("returns false (fails closed) for unknown or missing workflow type", () => {
      const requestWithUnknownWorkflow: BaseRequestItem = {
        id: 707,
        name: "Odd Request",
        status: "0",
        state: "active",
        workflow: "custom_matrix_approval",
        owners: [{ username: "Executive01", approved: 0 }],
      };

      expect(isRequestActionableForUser(requestWithUnknownWorkflow, "Executive01")).toBe(false);

      const requestWithoutWorkflow: BaseRequestItem = {
        id: 708,
        name: "No Workflow Request",
        status: "0",
        state: "active",
        owners: [{ username: "Executive01", approved: 0 }],
      };

      expect(isRequestActionableForUser(requestWithoutWorkflow, "Executive01")).toBe(false);
    });
  });
});
