/**
 * src/__tests__/account-adapter.test.ts
 *
 * Tests for AccountApiClient adapter:
 *  - getAllUsers() maps response correctly
 *  - getAllUsers() throws on unexpected response shape
 *  - searchByUsername() returns user when found
 *  - searchByUsername() returns null when not found
 *  - Typed fields match docs/base-api-findings.md verified structure
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { AccountApiClient } from "../base-api/account.js";
import { BaseApiClient } from "../base-api/client.js";

let mockPost = vi.fn();

vi.mock("../base-api/client.js", () => {
  return {
    BaseApiClient: vi.fn().mockImplementation(() => ({
      post: (...args: unknown[]) => mockPost(...args),
    })),
  };
});

// Sample user matching verified field structure from base-api-findings.md
const SAMPLE_USER = {
  id: 12345,
  username: "Digital01",
  name: "Mai Thanh Tân",
  first_name: "Thanh Tân",
  last_name: "Mai",
  email: "digital01@example.com",
  status: "0",
  title: "Software Engineer",
  manager: ["huytran"],
  direct_reports: [],
};

beforeEach(() => {
  mockPost = vi.fn();
});

describe("AccountApiClient", () => {
  describe("getAllUsers()", () => {
    it("returns array of users from valid response", async () => {
      mockPost.mockResolvedValueOnce({
        code: 1,
        message: "",
        data: null,
        users: [SAMPLE_USER],
      });
      const client = new AccountApiClient("test-token");

      const users = await client.getAllUsers();

      expect(users).toHaveLength(1);
      expect(users[0]).toEqual(SAMPLE_USER);
    });

    it("returns empty array when users is empty", async () => {
      mockPost.mockResolvedValueOnce({
        code: 1,
        message: "",
        data: null,
        users: [],
      });
      const client = new AccountApiClient("test-token");

      const users = await client.getAllUsers();
      expect(users).toEqual([]);
    });

    it("throws when response has no users array", async () => {
      mockPost.mockResolvedValueOnce({
        code: 0,
        message: "error",
        data: null,
      });
      const client = new AccountApiClient("test-token");

      await expect(client.getAllUsers()).rejects.toThrow("unexpected response shape");
    });

    it("throws when users is null", async () => {
      mockPost.mockResolvedValueOnce({
        code: 1,
        message: "",
        data: null,
        users: null,
      });
      const client = new AccountApiClient("test-token");

      await expect(client.getAllUsers()).rejects.toThrow("unexpected response shape");
    });

    it("maps all confirmed fields from base-api-findings.md", async () => {
      mockPost.mockResolvedValueOnce({
        code: 1,
        message: "",
        data: null,
        users: [SAMPLE_USER],
      });
      const client = new AccountApiClient("test-token");

      const users = await client.getAllUsers();
      const user = users[0]!;

      expect(typeof user.id).toBe("number");
      expect(typeof user.username).toBe("string");
      expect(typeof user.name).toBe("string");
      expect(typeof user.first_name).toBe("string");
      expect(typeof user.last_name).toBe("string");
      expect(typeof user.email).toBe("string");
      expect(typeof user.status).toBe("string");
      expect(typeof user.title).toBe("string");
      expect(Array.isArray(user.manager)).toBe(true);
      expect(Array.isArray(user.direct_reports)).toBe(true);
    });

    it("calls the correct endpoint path", async () => {
      mockPost.mockResolvedValueOnce({
        code: 1,
        message: "",
        data: null,
        users: [],
      });
      const client = new AccountApiClient("test-token");

      await client.getAllUsers();

      expect(mockPost).toHaveBeenCalledWith("/extapi/v1/users");
    });
  });

  describe("searchByUsername()", () => {
    it("returns user when found", async () => {
      mockPost.mockResolvedValueOnce({
        code: 1,
        message: "",
        data: null,
        user: SAMPLE_USER,
      });
      const client = new AccountApiClient("test-token");

      const user = await client.searchByUsername("Digital01");
      expect(user).toEqual(SAMPLE_USER);
    });

    it("returns null when user not found (user: null)", async () => {
      mockPost.mockResolvedValueOnce({
        code: 1,
        message: "",
        data: null,
        user: null,
      });
      const client = new AccountApiClient("test-token");

      const user = await client.searchByUsername("nonexistent");
      expect(user).toBeNull();
    });

    it("returns null when user field is missing", async () => {
      mockPost.mockResolvedValueOnce({
        code: 1,
        message: "",
        data: null,
      });
      const client = new AccountApiClient("test-token");

      const user = await client.searchByUsername("nonexistent");
      expect(user).toBeNull();
    });

    it("calls the correct endpoint with username param", async () => {
      mockPost.mockResolvedValueOnce({
        code: 1,
        message: "",
        data: null,
        user: SAMPLE_USER,
      });
      const client = new AccountApiClient("test-token");

      await client.searchByUsername("Digital01");

      expect(mockPost).toHaveBeenCalledWith(
        "/extapi/v1/user/search.by.username",
        { username: "Digital01" }
      );
    });

    it("passes username as plain string without @ prefix", async () => {
      mockPost.mockResolvedValueOnce({
        code: 1,
        message: "",
        data: null,
        user: null,
      });
      const client = new AccountApiClient("test-token");

      await client.searchByUsername("Executive01");

      const [, params] = mockPost.mock.calls[0] as [string, Record<string, string>];
      expect(params?.["username"]).toBe("Executive01");
      expect(params?.["username"]).not.toMatch(/^@/);
    });
  });

  describe("status field semantics", () => {
    it('status "0" means active (verified in base-api-findings.md)', async () => {
      mockPost.mockResolvedValueOnce({
        code: 1,
        message: "",
        data: null,
        users: [{ ...SAMPLE_USER, status: "0" }],
      });
      const client = new AccountApiClient("test-token");

      const users = await client.getAllUsers();
      expect(users[0]?.status).toBe("0");
    });

    it('status "1" means deactivated', async () => {
      mockPost.mockResolvedValueOnce({
        code: 1,
        message: "",
        data: null,
        users: [{ ...SAMPLE_USER, status: "1" }],
      });
      const client = new AccountApiClient("test-token");

      const users = await client.getAllUsers();
      expect(users[0]?.status).toBe("1");
    });
  });
});
