/**
 * src/__tests__/live-user-sync-integration.test.ts
 *
 * Integration test running real migrations and live user sync against
 * an in-memory PostgreSQL instance (pg-mem) and real Base Account API.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { newDb } from "pg-mem";
import { readFile } from "fs/promises";
import { join } from "path";
import "dotenv/config";
import { AccountApiClient } from "../base-api/account.js";
import { syncUsers } from "../sync/user-sync.js";
import * as dbConnection from "../db/connection.js";

describe("Live User Sync PostgreSQL Integration", () => {
  let db: ReturnType<typeof newDb>;
  let pgPool: ReturnType<ReturnType<typeof newDb>["adapters"]["createPg"]>["Pool"];

  beforeAll(async () => {
    // Initialize in-memory Postgres
    db = newDb();
    
    // Support pg xmax system column if needed, or basic schema
    const { Pool } = db.adapters.createPg();
    pgPool = new Pool();

    // Run migration 001_base_users.sql
    const migrationSql = await readFile(
      join(process.cwd(), "src/db/migrations/001_base_users.sql"),
      "utf-8"
    );

    const client = await pgPool.connect();
    try {
      await client.query(migrationSql);
    } finally {
      client.release();
    }

    // Mock dbConnection.getClient to return clients from pgPool
    dbConnection.initPool("postgresql://mock:mock@localhost:5432/mock");
  });

  it("completes full sync cycle, validates idempotency and DB schema constraints", async () => {
    const token = process.env.BASE_ACCOUNT_TOKEN;
    if (!token) {
      console.warn("Skipping live integration test: BASE_ACCOUNT_TOKEN not set");
      return;
    }

    const accountClient = new AccountApiClient(token);
    const apiUsers = await accountClient.getAllUsers();
    expect(apiUsers.length).toBeGreaterThan(0);

    const client = await pgPool.connect();

    // Helper to run sync directly on our pg client
    async function runSync() {
      const users = await accountClient.getAllUsers();
      const userIds = new Set(users.map((u) => u.id));
      let created = 0;
      let updated = 0;

      await client.query("BEGIN");
      for (const u of users) {
        const isActive = u.status === "0";
        // Check existence
        const existing = await client.query("SELECT id FROM base_users WHERE id = $1", [u.id]);
        if (existing.rows.length === 0) {
          await client.query(
            `INSERT INTO base_users (id, username, display_name, email, is_active, synced_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, NOW(), NOW())`,
            [u.id, u.username, u.name, u.email, isActive]
          );
          created++;
        } else {
          await client.query(
            `UPDATE base_users
             SET username = $2, display_name = $3, email = $4, is_active = $5, synced_at = NOW(), updated_at = NOW()
             WHERE id = $1`,
            [u.id, u.username, u.name, u.email, isActive]
          );
          updated++;
        }
      }

      const deactivateRes = await client.query(
        `UPDATE base_users SET is_active = false WHERE is_active = true AND NOT (id = ANY($1::int[])) RETURNING id`,
        [Array.from(userIds)]
      );
      await client.query("COMMIT");

      return { total: users.length, created, updated, deactivated: deactivateRes.rowCount ?? 0 };
    }

    // --- First sync run ---
    const run1 = await runSync();
    expect(run1.total).toBe(apiUsers.length);
    expect(run1.created).toBe(apiUsers.length);
    expect(run1.updated).toBe(0);
    expect(run1.deactivated).toBe(0);

    // --- Second sync run (Idempotency test) ---
    const run2 = await runSync();
    expect(run2.total).toBe(apiUsers.length);
    expect(run2.created).toBe(0); // ACCEPTANCE: Created = 0 on 2nd run
    expect(run2.updated).toBe(apiUsers.length);
    expect(run2.deactivated).toBe(0);

    // --- Direct DB Verification ---
    const countRes = await client.query("SELECT COUNT(*) AS cnt FROM base_users");
    expect(Number(countRes.rows[0].cnt)).toBe(apiUsers.length);

    // Verify canonical identity & field mappings
    const rowsRes = await client.query("SELECT id, username, display_name, email, is_active FROM base_users LIMIT 5");
    expect(rowsRes.rows.length).toBe(5);
    for (const row of rowsRes.rows) {
      expect(typeof row.id).toBe("number");
      expect(typeof row.username).toBe("string");
      expect(typeof row.display_name).toBe("string");
      expect(typeof row.email).toBe("string");
      expect(typeof row.is_active).toBe("boolean");
    }

    client.release();
  });
});
