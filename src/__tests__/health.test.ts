/**
 * src/__tests__/health.test.ts
 *
 * Tests for internal health endpoint:
 *  - DB status up/down reflected
 *  - Passive Base API status tracking
 *  - No secrets or sensitive user data in health response
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import http from "http";
import {
  recordBaseApiSuccess,
  startHealthServer,
  stopHealthServer,
} from "../health/server.js";
import * as dbConnection from "../db/connection.js";
import * as runsQuery from "../db/queries/runs.js";

function fetchHealth(host: string, port: number): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://${host}:${port}/health`, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) });
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("error", reject);
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("Health Server", () => {
  it("returns 200 and healthy when DB is up", async () => {
    vi.spyOn(dbConnection, "pingDatabase").mockResolvedValue(5);
    const server = startHealthServer("127.0.0.1", 3099);

    try {
      const res = await fetchHealth("127.0.0.1", 3099);
      expect(res.status).toBe(200);
      expect(res.body["status"]).toBe("healthy");
      const checks = res.body["checks"] as Record<string, unknown>;
      expect(checks["database"]).toEqual({ status: "up", latency_ms: 5 });
    } finally {
      await stopHealthServer();
    }
  });

  it("returns 503 and unhealthy when DB ping fails", async () => {
    vi.spyOn(dbConnection, "pingDatabase").mockRejectedValue(new Error("Connection refused"));
    const server = startHealthServer("127.0.0.1", 3098);

    try {
      const res = await fetchHealth("127.0.0.1", 3098);
      expect(res.status).toBe(503);
      expect(res.body["status"]).toBe("unhealthy");
      const checks = res.body["checks"] as Record<string, unknown>;
      expect((checks["database"] as Record<string, unknown>)["status"]).toBe("down");
    } finally {
      await stopHealthServer();
    }
  });

  it("reflects recorded passive Base API success timestamps", async () => {
    vi.spyOn(dbConnection, "pingDatabase").mockResolvedValue(2);
    recordBaseApiSuccess("account");

    const server = startHealthServer("127.0.0.1", 3097);

    try {
      const res = await fetchHealth("127.0.0.1", 3097);
      const checks = res.body["checks"] as Record<string, unknown>;
      const accountCheck = checks["base_api_account"] as { status: string; last_success: string };
      expect(accountCheck.status).toBe("up");
      expect(accountCheck.last_success).not.toBeNull();
      expect(new Date(accountCheck.last_success).getTime()).toBeGreaterThan(0);
    } finally {
      await stopHealthServer();
    }
  });

  it("does not expose secrets, tokens, or PII in health response", async () => {
    vi.spyOn(dbConnection, "pingDatabase").mockResolvedValue(1);
    const server = startHealthServer("127.0.0.1", 3096);

    try {
      const res = await fetchHealth("127.0.0.1", 3096);
      const rawJson = JSON.stringify(res.body);

      expect(rawJson).not.toContain("token");
      expect(rawJson).not.toContain("password");
      expect(rawJson).not.toContain("secret");
      expect(rawJson).not.toContain("email");
    } finally {
      await stopHealthServer();
    }
  });

  it("reflects latest persisted reminder run from PostgreSQL", async () => {
    vi.spyOn(dbConnection, "pingDatabase").mockResolvedValue(1);
    const mockRun: runsQuery.ReminderRunRecord = {
      id: 1,
      run_date: "2026-08-20",
      run_key: "2026-08-20",
      status: "completed",
      users_total: 26,
      users_delivered: 0,
      users_empty: 10,
      users_error: 0,
      started_at: new Date("2026-08-20T01:15:00.000Z"),
      completed_at: new Date("2026-08-20T01:15:08.000Z"),
      error_message: null,
      created_at: new Date("2026-08-20T01:15:00.000Z"),
    };
    vi.spyOn(runsQuery, "getLatestReminderRun").mockResolvedValue(mockRun);

    const server = startHealthServer("127.0.0.1", 3095);

    try {
      const res = await fetchHealth("127.0.0.1", 3095);
      const checks = res.body["checks"] as Record<string, unknown>;
      const lastRun = checks["last_reminder_run"] as Record<string, unknown>;
      expect(lastRun).toBeDefined();
      expect(lastRun["date"]).toBe("2026-08-20");
      expect(lastRun["status"]).toBe("completed");
      expect(lastRun["total"]).toBe(26);
      expect(lastRun["empty"]).toBe(10);
      expect(lastRun["ready"]).toBe(16);
      expect(lastRun["durationMs"]).toBe(8000);
    } finally {
      await stopHealthServer();
    }
  });
});
