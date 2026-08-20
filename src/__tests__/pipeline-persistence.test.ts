/**
 * src/__tests__/pipeline-persistence.test.ts
 *
 * Tests PostgreSQL schema migration 002 (reminder_runs, reminder_deliveries),
 * run-key uniqueness, foreign keys, and delivery persistence constraints.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { newDb } from "pg-mem";
import { readFile } from "fs/promises";
import { join } from "path";

describe("Pipeline Persistence & Schema Constraints (pg-mem)", () => {
  let db: ReturnType<typeof newDb>;
  let pool: any;

  beforeAll(async () => {
    db = newDb();
    const { Pool } = db.adapters.createPg();
    pool = new Pool();

    // 1. Run migration 001
    const mig1Sql = await readFile(
      join(process.cwd(), "src/db/migrations/001_base_users.sql"),
      "utf-8"
    );
    const client = await pool.connect();
    try {
      await client.query(mig1Sql);

      // 2. Run migration 002
      const mig2Sql = await readFile(
        join(process.cwd(), "src/db/migrations/002_m1b_pipeline.sql"),
        "utf-8"
      );
      await client.query(mig2Sql);

      // Seed test users in base_users
      await client.query(`
        INSERT INTO base_users (id, username, display_name, email, is_active)
        VALUES (1001, 'Digital01', 'Mai Thanh Tân', 'digital01@example.com', true),
               (1002, 'Executive01', 'Executive User', 'exec01@example.com', true)
      `);
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    await pool.end();
  });

  it("enforces run_key unique constraint on reminder_runs", async () => {
    const client = await pool.connect();
    try {
      // First insert succeeds
      await client.query(
        `INSERT INTO reminder_runs (run_key, run_date, status)
         VALUES ('2026-08-20', '2026-08-20', 'started')`
      );

      // Duplicate insert with same run_key throws unique violation error
      await expect(
        client.query(
          `INSERT INTO reminder_runs (run_key, run_date, status)
           VALUES ('2026-08-20', '2026-08-20', 'started')`
        )
      ).rejects.toThrow();

      // Verify only 1 run row exists for this date
      const count = await client.query(
        `SELECT COUNT(*) FROM reminder_runs WHERE run_key = '2026-08-20'`
      );
      expect(Number(count.rows[0].count)).toBe(1);
    } finally {
      client.release();
    }
  });

  it("stores delivery operational metadata without content/titles", async () => {
    const client = await pool.connect();
    try {
      const runRes = await client.query(
        `SELECT id FROM reminder_runs WHERE run_key = '2026-08-20'`
      );
      const runId = runRes.rows[0].id;

      await client.query(
        `INSERT INTO reminder_deliveries (
          run_id, base_user_id, status,
          wework_status, wework_count,
          workflow_status, workflow_count,
          request_status, request_count,
          is_partial
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          runId,
          1001,
          "pending",
          "ok",
          2,
          "ok",
          1,
          "ok",
          0,
          false,
        ]
      );

      const delivery = await client.query(
        `SELECT * FROM reminder_deliveries WHERE run_id = $1 AND base_user_id = 1001`,
        [runId]
      );

      expect(delivery.rows.length).toBe(1);
      const row = delivery.rows[0];
      expect(row.wework_count).toBe(2);
      expect(row.workflow_count).toBe(1);
      expect(row.request_count).toBe(0);
      expect(row.status).toBe("pending");
      expect(row.is_partial).toBe(false);

      // Verify no task_title, job_name, or content columns exist in schema
      expect(row.task_title).toBeUndefined();
      expect(row.job_name).toBeUndefined();
      expect(row.content).toBeUndefined();
    } finally {
      client.release();
    }
  });

  it("enforces unique constraint on (run_id, base_user_id) in reminder_deliveries", async () => {
    const client = await pool.connect();
    try {
      const runRes = await client.query(
        `SELECT id FROM reminder_runs WHERE run_key = '2026-08-20'`
      );
      const runId = runRes.rows[0].id;

      // Inserting second delivery for same user in same run without ON CONFLICT must fail
      await expect(
        client.query(
          `INSERT INTO reminder_deliveries (run_id, base_user_id, status)
           VALUES ($1, 1001, 'pending')`,
          [runId]
        )
      ).rejects.toThrow();
    } finally {
      client.release();
    }
  });
});
