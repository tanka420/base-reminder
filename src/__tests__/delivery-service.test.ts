/**
 * src/__tests__/delivery-service.test.ts
 *
 * Integration tests for DeliveryService with pg-mem:
 *  - Migration 004 schema verification
 *  - Multi-chunk tracking in reminder_delivery_chunks
 *  - Partial multi-chunk failure: chunk 1 delivered, chunk 2 fails permanently -> chunk 1 not resent
 *  - Stale sending crash recovery -> ambiguous state
 *  - Zero message body persistence audit
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { newDb } from "pg-mem";
import { readFile } from "fs/promises";
import { join } from "path";
import { setPoolForTesting } from "../db/connection.js";
import { DeliveryService } from "../delivery/delivery-service.js";
import { TelegramClient } from "../telegram/telegram-client.js";
import { batchInsertDeliveries, getDeliveriesByRunId } from "../db/queries/deliveries.js";
import { getChunksByDeliveryId } from "../db/queries/chunks.js";
import type { UserDigest } from "../digest/types.js";
import type { ActiveBaseUser } from "../db/queries/users.js";

describe("DeliveryService & Multi-Chunk State Tracking (pg-mem)", () => {
  let db: ReturnType<typeof newDb>;
  let pool: any;

  beforeAll(async () => {
    db = newDb();
    const { Pool } = db.adapters.createPg();
    pool = new Pool();
    setPoolForTesting(pool);

    const client = await pool.connect();
    try {
      // 1. Run migrations 001, 002, 003, 004
      const mig1 = await readFile(join(process.cwd(), "src/db/migrations/001_base_users.sql"), "utf-8");
      const mig2 = await readFile(join(process.cwd(), "src/db/migrations/002_m1b_pipeline.sql"), "utf-8");
      const mig3 = await readFile(join(process.cwd(), "src/db/migrations/003_m2a_telegram_auth.sql"), "utf-8");
      const mig4 = await readFile(join(process.cwd(), "src/db/migrations/004_m2b_delivery_metadata.sql"), "utf-8");

      await client.query(mig1);
      await client.query(mig2);
      await client.query(mig3);
      await client.query(mig4);

      // Seed base_users & telegram_links
      await client.query(`
        INSERT INTO base_users (id, username, display_name, email, is_active)
        VALUES (101, 'user1', 'User One', 'user1@example.com', true),
               (102, 'user2', 'User Two', 'user2@example.com', true),
               (103, 'user3', 'User Three', 'user3@example.com', true)
      `);

      await client.query(`
        INSERT INTO telegram_links (base_user_id, telegram_user_id, telegram_chat_id, reminders_enabled)
        VALUES (101, '90001', '90001', true),
               (102, '90002', '90002', true),
               (103, '90003', '90003', false) -- paused
      `);

      // Seed a run
      const runInsertRes = await client.query(`
        INSERT INTO reminder_runs (run_key, run_date, status)
        VALUES ('test:run:1', '2026-08-21', 'started')
        RETURNING id
      `);
      testRunId = runInsertRes.rows[0]?.id ?? 1;
    } finally {
      client.release();
    }
  });

  let testRunId = 1;

  afterAll(async () => {
    await pool.end();
  });

  it("delivers single message digest successfully and updates chunks & delivery status", async () => {
    const mockSend = vi.fn().mockResolvedValue({ success: true, messageId: 5555, attempts: 1 });
    const mockClient = { sendMessage: mockSend } as unknown as TelegramClient;

    const deliveryService = new DeliveryService(mockClient);

    const user: ActiveBaseUser = {
      id: 101,
      username: "user1",
      display_name: "User One",
      email: "user1@example.com",
      is_active: true,
    };

    const digest: UserDigest = {
      baseUserId: 101,
      username: "user1",
      displayName: "User One",
      status: "ready",
      isPartial: false,
      wework: { status: "ok", items: [{ id: 1, name: "Task 1", isOverdue: true, isDueToday: false, url: "https://wework.base.vn/tasks?task=1" }] },
      workflow: { status: "ok", items: [] },
      request: { status: "ok", items: [] },
      counts: { wework: 1, workflow: 0, request: 0, total: 1 },
    };

    // Seed delivery record
    await batchInsertDeliveries(testRunId, [{
      baseUserId: 101,
      status: "pending",
      weworkStatus: "ok",
      weworkCount: 1,
      workflowStatus: "ok",
      workflowCount: 0,
      requestStatus: "ok",
      requestCount: 0,
      isPartial: false,
    }]);

    const result = await deliveryService.deliverUserDigest({
      runId: testRunId,
      user,
      digest,
    });

    expect(result.status).toBe("delivered");
    expect(result.chunksTotal).toBe(1);
    expect(result.chunksSent).toBe(1);

    const deliveries = await getDeliveriesByRunId(testRunId);
    const d101 = deliveries.find((d) => d.base_user_id === 101);
    expect(d101?.status).toBe("delivered");
    expect(d101?.chunks_sent).toBe(1);
    expect(d101?.chunks_total).toBe(1);
    expect(d101?.telegram_message_id).toBe(5555);

    const chunks = await getChunksByDeliveryId(d101!.id);
    expect(chunks.length).toBe(1);
    expect(chunks[0]?.status).toBe("delivered");
    expect(chunks[0]?.telegram_message_id).toBe(5555);
  });

  it("handles multi-chunk failure safely without resending already delivered chunk 1", async () => {
    // Generate many tasks so formatter produces 2 chunks
    const tasks = Array.from({ length: 45 }, (_, i) => ({
      id: i + 1,
      name: `Nhiệm vụ dài số ${i + 1} cần thực hiện hoàn thành trước thời hạn quy định trên hệ thống`,
      isOverdue: false,
      isDueToday: true,
      url: `https://wework.base.vn/tasks?task=${i + 1}`,
    }));

    const digest: UserDigest = {
      baseUserId: 102,
      username: "user2",
      displayName: "User Two",
      status: "ready",
      isPartial: false,
      wework: { status: "ok", items: tasks },
      workflow: { status: "ok", items: [] },
      request: { status: "ok", items: [] },
      counts: { wework: tasks.length, workflow: 0, request: 0, total: tasks.length },
    };

    const user: ActiveBaseUser = {
      id: 102,
      username: "user2",
      display_name: "User Two",
      email: "user2@example.com",
      is_active: true,
    };

    // Seed delivery record
    await batchInsertDeliveries(testRunId, [{
      baseUserId: 102,
      status: "pending",
      weworkStatus: "ok",
      weworkCount: tasks.length,
      workflowStatus: "ok",
      workflowCount: 0,
      requestStatus: "ok",
      requestCount: 0,
      isPartial: false,
    }]);

    // Mock: chunk 1 succeeds, chunk 2 fails permanently (e.g. rate limit / network failure)
    const mockSend = vi.fn()
      .mockResolvedValueOnce({ success: true, messageId: 6001, attempts: 1 })
      .mockResolvedValueOnce({ success: false, errorCode: "TELEGRAM_5XX", errorMessage: "Bad Gateway", attempts: 3 });

    const mockClient = { sendMessage: mockSend } as unknown as TelegramClient;
    const deliveryService = new DeliveryService(mockClient);

    const result = await deliveryService.deliverUserDigest({
      runId: testRunId,
      user,
      digest,
    });

    expect(result.status).toBe("error");
    expect(result.chunksSent).toBe(1);
    expect(result.chunksTotal).toBeGreaterThan(1);
    expect(result.telegramErrorCode).toBe("TELEGRAM_5XX");

    const deliveries = await getDeliveriesByRunId(testRunId);
    const d102 = deliveries.find((d) => d.base_user_id === 102);
    expect(d102?.status).toBe("error");
    expect(d102?.chunks_sent).toBe(1);

    const chunks = await getChunksByDeliveryId(d102!.id);
    expect(chunks.length).toBeGreaterThan(1);
    // Chunk 0 delivered
    expect(chunks[0]?.status).toBe("delivered");
    expect(chunks[0]?.telegram_message_id).toBe(6001);
    // Chunk 1 error
    expect(chunks[1]?.status).toBe("error");
    expect(chunks[1]?.error_code).toBe("TELEGRAM_5XX");

    // Ensure sendMessage was only called for chunk 0 and chunk 1 (not retrying chunk 0)
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it("skips delivery when user has reminders paused (/stop)", async () => {
    const mockSend = vi.fn();
    const mockClient = { sendMessage: mockSend } as unknown as TelegramClient;
    const deliveryService = new DeliveryService(mockClient);

    const user: ActiveBaseUser = {
      id: 103,
      username: "user3",
      display_name: "User Three",
      email: "user3@example.com",
      is_active: true,
    };

    const digest: UserDigest = {
      baseUserId: 103,
      username: "user3",
      displayName: "User Three",
      status: "ready",
      isPartial: false,
      wework: { status: "ok", items: [{ id: 9, name: "Task 9", isOverdue: false, isDueToday: true, url: "https://wework.base.vn/tasks?task=9" }] },
      workflow: { status: "ok", items: [] },
      request: { status: "ok", items: [] },
      counts: { wework: 1, workflow: 0, request: 0, total: 1 },
    };

    await batchInsertDeliveries(testRunId, [{
      baseUserId: 103,
      status: "pending",
      weworkStatus: "ok",
      weworkCount: 1,
      workflowStatus: "ok",
      workflowCount: 0,
      requestStatus: "ok",
      requestCount: 0,
      isPartial: false,
    }]);

    const result = await deliveryService.deliverUserDigest({
      runId: testRunId,
      user,
      digest,
    });

    expect(result.status).toBe("skipped");
    expect(mockSend).not.toHaveBeenCalled();

    const deliveries = await getDeliveriesByRunId(testRunId);
    const d103 = deliveries.find((d) => d.base_user_id === 103);
    expect(d103?.status).toBe("skipped");
  });

  it("recovers stale sending deliveries and chunks to ambiguous state", async () => {
    const client = await pool.connect();
    try {
      // Seed a delivery and chunk in 'sending' state with old timestamp
      const runRes = await client.query(`INSERT INTO reminder_runs (run_key, run_date, status) VALUES ('old:run:2', '2026-08-20', 'started') RETURNING id`);
      const oldRunId = runRes.rows[0].id;

      const delRes = await client.query(`
        INSERT INTO reminder_deliveries (run_id, base_user_id, status, delivery_started_at)
        VALUES ($1, 101, 'sending', NOW() - INTERVAL '10 minutes')
        RETURNING id
      `, [oldRunId]);
      const oldDelId = delRes.rows[0].id;

      await client.query(`
        INSERT INTO reminder_delivery_chunks (delivery_id, chunk_index, status, updated_at)
        VALUES ($1, 0, 'sending', NOW() - INTERVAL '10 minutes')
      `, [oldDelId]);

      const deliveryService = new DeliveryService({} as any);
      const recovery = await deliveryService.recoverStaleSending(5);

      expect(recovery.staleDeliveries).toBeGreaterThanOrEqual(1);
      expect(recovery.staleChunks).toBeGreaterThanOrEqual(1);

      const updatedDel = await client.query(`SELECT status, telegram_error_code FROM reminder_deliveries WHERE id = $1`, [oldDelId]);
      expect(updatedDel.rows[0].status).toBe("error");
      expect(updatedDel.rows[0].telegram_error_code).toBe("AMBIGUOUS_AFTER_CRASH");

      const updatedChunk = await client.query(`SELECT status, error_code FROM reminder_delivery_chunks WHERE delivery_id = $1`, [oldDelId]);
      expect(updatedChunk.rows[0].status).toBe("ambiguous");
      expect(updatedChunk.rows[0].error_code).toBe("AMBIGUOUS_AFTER_CRASH");
    } finally {
      client.release();
    }
  });

  it("audits that NO message body or task title content is saved in reminder_deliveries or reminder_delivery_chunks", async () => {
    const client = await pool.connect();
    try {
      const delColumns = await client.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'reminder_deliveries'
      `);
      const delCols = delColumns.rows.map((r: any) => r.column_name);

      expect(delCols).not.toContain("message_body");
      expect(delCols).not.toContain("content");
      expect(delCols).not.toContain("body");
      expect(delCols).not.toContain("digest_json");

      const chunkColumns = await client.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'reminder_delivery_chunks'
      `);
      const chunkCols = chunkColumns.rows.map((r: any) => r.column_name);

      expect(chunkCols).not.toContain("chunk_body");
      expect(chunkCols).not.toContain("content");
      expect(chunkCols).not.toContain("html");
      expect(chunkCols).not.toContain("text");
    } finally {
      client.release();
    }
  });
});
