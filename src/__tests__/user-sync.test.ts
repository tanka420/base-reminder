/**
 * src/__tests__/user-sync.test.ts
 *
 * Tests for syncUsers():
 *  - Upserts create new users
 *  - Upserts update existing users (username, display_name, email, is_active)
 *  - Users not in API response are deactivated (is_active = false)
 *  - Never deletes users (soft deactivation only)
 *  - status === "0" → is_active = true
 *  - status !== "0" → is_active = false
 *  - Idempotent: running twice produces same result
 *  - Uses transaction (BEGIN/COMMIT on success, ROLLBACK on error)
 *  - On API failure: propagates error (does not silently return)
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { syncUsers } from "../sync/user-sync.js";
import type { AccountApiClient } from "../base-api/account.js";
import type { BaseAccountUser } from "../base-api/account.js";

// Mock database connection module
vi.mock("../db/connection.js", () => {
  const queryMock = vi.fn();
  const releaseMock = vi.fn();
  const clientMock = {
    query: queryMock,
    release: releaseMock,
  };
  return {
    getClient: vi.fn().mockResolvedValue(clientMock),
    __clientMock: clientMock,
  };
});

// Mock logger to suppress output during tests
vi.mock("../logging/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
  },
}));

// Helper to build a BaseAccountUser fixture
function makeUser(overrides: Partial<BaseAccountUser> = {}): BaseAccountUser {
  return {
    id: 1001,
    username: "TestUser01",
    name: "Test User One",
    first_name: "User One",
    last_name: "Test",
    email: "test01@example.com",
    status: "0",
    title: "Engineer",
    manager: [],
    direct_reports: [],
    ...overrides,
  };
}

// Helper to make a mock AccountApiClient
function makeAccountClient(users: BaseAccountUser[]): AccountApiClient {
  return {
    getAllUsers: vi.fn().mockResolvedValue(users),
    searchByUsername: vi.fn(),
  } as unknown as AccountApiClient;
}

// Get the mocked client query mock
async function getClientMock(): Promise<{ query: Mock; release: Mock }> {
  const { __clientMock } = await import("../db/connection.js") as unknown as {
    __clientMock: { query: Mock; release: Mock };
  };
  return __clientMock;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("syncUsers()", () => {
  it("calls getAllUsers from the Account API", async () => {
    const users = [makeUser()];
    const accountClient = makeAccountClient(users);
    const { query } = await getClientMock();

    // Mock UPSERT returning 1 row with created=true
    query.mockImplementation(async (sql: string) => {
      if (typeof sql === "string" && sql.includes("INSERT INTO base_users")) {
        return { rows: [{ created: true }], rowCount: 1 };
      }
      if (typeof sql === "string" && sql.includes("UPDATE base_users")) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    });

    await syncUsers(accountClient);

    expect(accountClient.getAllUsers).toHaveBeenCalledOnce();
  });

  it("returns correct counts: 1 created, 0 updated when user is new", async () => {
    const users = [makeUser()];
    const accountClient = makeAccountClient(users);
    const { query } = await getClientMock();

    query.mockImplementation(async (sql: string) => {
      if (sql?.includes("INSERT INTO base_users")) {
        return { rows: [{ created: true }], rowCount: 1 };
      }
      if (sql?.includes("UPDATE base_users")) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    });

    const result = await syncUsers(accountClient);

    expect(result.total).toBe(1);
    expect(result.created).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.deactivated).toBe(0);
  });

  it("returns correct counts: 0 created, 1 updated when user exists", async () => {
    const users = [makeUser()];
    const accountClient = makeAccountClient(users);
    const { query } = await getClientMock();

    query.mockImplementation(async (sql: string) => {
      if (sql?.includes("INSERT INTO base_users")) {
        return { rows: [{ created: false }], rowCount: 1 };
      }
      if (sql?.includes("UPDATE base_users")) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    });

    const result = await syncUsers(accountClient);

    expect(result.total).toBe(1);
    expect(result.created).toBe(0);
    expect(result.updated).toBe(1);
    expect(result.deactivated).toBe(0);
  });

  it('sets is_active = true when status === "0"', async () => {
    const users = [makeUser({ status: "0" })];
    const accountClient = makeAccountClient(users);
    const { query } = await getClientMock();

    const upsertCalls: Array<{ sql: string; params: unknown[] }> = [];
    query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql?.includes("INSERT INTO base_users")) {
        upsertCalls.push({ sql, params: params ?? [] });
        return { rows: [{ created: true }], rowCount: 1 };
      }
      if (sql?.includes("UPDATE base_users")) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    });

    await syncUsers(accountClient);

    expect(upsertCalls.length).toBe(1);
    // $5 is the is_active parameter
    const isActive = upsertCalls[0]?.params[4];
    expect(isActive).toBe(true);
  });

  it('sets is_active = false when status !== "0"', async () => {
    const users = [makeUser({ status: "1" })]; // deactivated in Base
    const accountClient = makeAccountClient(users);
    const { query } = await getClientMock();

    const upsertCalls: Array<{ sql: string; params: unknown[] }> = [];
    query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql?.includes("INSERT INTO base_users")) {
        upsertCalls.push({ sql, params: params ?? [] });
        return { rows: [{ created: false }], rowCount: 1 };
      }
      if (sql?.includes("UPDATE base_users")) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    });

    await syncUsers(accountClient);

    const isActive = upsertCalls[0]?.params[4];
    expect(isActive).toBe(false);
  });

  it("deactivates users not in API response", async () => {
    // API returns empty (all users left workspace)
    const accountClient = makeAccountClient([]);
    const { query } = await getClientMock();

    query.mockImplementation(async (sql: string) => {
      if (sql?.includes("UPDATE base_users")) {
        return { rows: [{ id: 9999 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const result = await syncUsers(accountClient);

    expect(result.deactivated).toBe(1);
  });

  it("uses a transaction (BEGIN, COMMIT on success)", async () => {
    const users = [makeUser()];
    const accountClient = makeAccountClient(users);
    const { query } = await getClientMock();

    const calls: string[] = [];
    query.mockImplementation(async (sql: string) => {
      calls.push(sql.trim().toUpperCase().split(" ")[0]!);
      if (sql?.includes("INSERT INTO base_users")) {
        return { rows: [{ created: true }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    await syncUsers(accountClient);

    expect(calls).toContain("BEGIN");
    expect(calls).toContain("COMMIT");
    expect(calls).not.toContain("ROLLBACK");
  });

  it("rolls back transaction on database error", async () => {
    const users = [makeUser()];
    const accountClient = makeAccountClient(users);
    const { query } = await getClientMock();

    let callCount = 0;
    query.mockImplementation(async (sql: string) => {
      callCount++;
      if (sql === "BEGIN") return { rows: [], rowCount: 0 };
      if (sql?.includes("INSERT INTO base_users")) {
        throw new Error("DB write failed");
      }
      if (sql === "ROLLBACK") return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    });

    await expect(syncUsers(accountClient)).rejects.toThrow("DB write failed");

    // ROLLBACK must have been called
    const rollbackCall = query.mock.calls.find(
      (args: unknown[]) => args[0] === "ROLLBACK"
    );
    expect(rollbackCall).toBeDefined();
  });

  it("propagates Account API errors (does not swallow)", async () => {
    const accountClient = {
      getAllUsers: vi.fn().mockRejectedValue(new Error("API unavailable")),
      searchByUsername: vi.fn(),
    } as unknown as AccountApiClient;

    await expect(syncUsers(accountClient)).rejects.toThrow("API unavailable");
  });

  it("is idempotent: running twice produces same total/deactivated", async () => {
    const users = [makeUser()];
    const accountClient = makeAccountClient(users);
    const { query } = await getClientMock();

    // Second run: same user already exists
    query.mockImplementation(async (sql: string) => {
      if (sql?.includes("INSERT INTO base_users")) {
        return { rows: [{ created: false }], rowCount: 1 };
      }
      if (sql?.includes("UPDATE base_users")) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    });

    const result1 = await syncUsers(accountClient);
    vi.clearAllMocks();
    query.mockImplementation(async (sql: string) => {
      if (sql?.includes("INSERT INTO base_users")) {
        return { rows: [{ created: false }], rowCount: 1 };
      }
      if (sql?.includes("UPDATE base_users")) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    });
    const result2 = await syncUsers(accountClient);

    expect(result1.total).toBe(result2.total);
    expect(result1.deactivated).toBe(result2.deactivated);
  });

  it("releases the DB client even on DB failure", async () => {
    const users = [makeUser()];
    const accountClient = makeAccountClient(users);
    const { query, release } = await getClientMock();
    query.mockRejectedValue(new Error("DB query failed"));

    try {
      await syncUsers(accountClient);
    } catch {
      // expected
    }

    expect(release).toHaveBeenCalled();
  });
});
