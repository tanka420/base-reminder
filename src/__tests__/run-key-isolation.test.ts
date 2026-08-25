/**
 * src/__tests__/run-key-isolation.test.ts
 *
 * Integration test verifying that dry-run, manual, and test runs
 * never consume or block that day's scheduled morning run key.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { newDb } from "pg-mem";
import { readFile } from "fs/promises";
import { join } from "path";
import { setPoolForTesting } from "../db/connection.js";
import {
  createReminderRun,
  getReminderRunByKey,
  formatScheduledRunKey,
  formatManualRunKey,
  formatTestRunKey,
  formatDryRunKey,
} from "../db/queries/runs.js";

describe("Run Key Namespacing & Idempotency Isolation (pg-mem)", () => {
  let db: ReturnType<typeof newDb>;
  let pool: any;

  beforeAll(async () => {
    db = newDb();
    const { Pool } = db.adapters.createPg();
    pool = new Pool();
    setPoolForTesting(pool);

    const client = await pool.connect();
    try {
      const mig1 = await readFile(join(process.cwd(), "src/db/migrations/001_base_users.sql"), "utf-8");
      const mig2 = await readFile(join(process.cwd(), "src/db/migrations/002_m1b_pipeline.sql"), "utf-8");
      const mig4 = await readFile(join(process.cwd(), "src/db/migrations/004_m2b_delivery_metadata.sql"), "utf-8");
      await client.query(mig1);
      await client.query(mig2);
      await client.query(mig4);
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    await pool.end();
  });

  it("allows multiple manual and test runs on the same date without blocking scheduled run", async () => {
    const today = "2026-08-21";

    // 1. Execute a manual test run earlier in the morning
    const manualKey1 = formatManualRunKey();
    const manualId1 = await createReminderRun(manualKey1, today);
    expect(manualId1).not.toBeNull();

    // 2. Execute a single-user test run
    const testKey1 = formatTestRunKey("Digital01");
    const testId1 = await createReminderRun(testKey1, today);
    expect(testId1).not.toBeNull();

    // 3. Execute another test run for same user
    const testKey2 = formatTestRunKey("Digital01");
    const testId2 = await createReminderRun(testKey2, today);
    expect(testId2).not.toBeNull();

    // 4. Verify scheduled run key is STILL available and creates successfully at 08:00
    const scheduledKey = formatScheduledRunKey(today);
    const scheduledId = await createReminderRun(scheduledKey, today);
    expect(scheduledId).not.toBeNull();

    // 5. Verify that a duplicate scheduled run on same date is blocked (idempotency)
    const duplicateScheduledId = await createReminderRun(scheduledKey, today);
    expect(duplicateScheduledId).toBeNull();

    // 6. Verify distinct run records exist in database
    const manualRecord = await getReminderRunByKey(manualKey1);
    const testRecord = await getReminderRunByKey(testKey1);
    const scheduledRecord = await getReminderRunByKey(scheduledKey);

    expect(manualRecord?.id).toBe(manualId1);
    expect(testRecord?.id).toBe(testId1);
    expect(scheduledRecord?.id).toBe(scheduledId);
  });
});
