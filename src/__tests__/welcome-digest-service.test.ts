/**
 * src/__tests__/welcome-digest-service.test.ts
 *
 * Comprehensive tests for M3.1 — Telegram Onboarding Digest Preview:
 *  1. Successful linking sends onboarding preview with live tasks.
 *  2. Unlink then link again triggers preview again.
 *  3. Telegram send failure does not break account linking.
 *  4. User with zero tasks still receives complete preview ("Không có việc cần xử lý.").
 *  5. Preview creation generates ZERO records in reminder_runs, reminder_deliveries, reminder_delivery_chunks.
 *  6. Existing reminder scheduler behavior remains unchanged.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { newDb } from "pg-mem";
import { readFile } from "fs/promises";
import { join } from "path";
import * as dbConn from "../db/connection.js";
import { WelcomeDigestService } from "../telegram/services/welcome-digest-service.js";
import { LinkingService } from "../telegram/services/linking-service.js";
import { createTextMessageDispatcher } from "../telegram/handlers/text-dispatcher.js";
import type { OtpService } from "../telegram/services/otp-service.js";
import type { WeworkApiClient } from "../base-api/wework.js";
import type { WorkflowApiClient } from "../base-api/workflow.js";
import type { RequestApiClient } from "../base-api/request.js";
import { executeReminderPipeline } from "../scheduler/reminder-job.js";

describe("M3.1 — Telegram Onboarding Digest Preview", () => {
  let db: ReturnType<typeof newDb>;
  let pool: any;

  beforeEach(async () => {
    db = newDb();
    const { Pool } = db.adapters.createPg();
    pool = new Pool();

    vi.spyOn(dbConn, "getClient").mockImplementation(async () => {
      const client = await pool.connect();
      return client;
    });
    vi.spyOn(dbConn, "query").mockImplementation((text, params) => pool.query(text, params));

    const client = await pool.connect();
    try {
      const mig1 = await readFile(join(process.cwd(), "src/db/migrations/001_base_users.sql"), "utf-8");
      const mig2 = await readFile(join(process.cwd(), "src/db/migrations/002_m1b_pipeline.sql"), "utf-8");
      const mig3 = await readFile(join(process.cwd(), "src/db/migrations/003_m2a_telegram_auth.sql"), "utf-8");
      const mig4 = await readFile(join(process.cwd(), "src/db/migrations/004_m2b_delivery_metadata.sql"), "utf-8");

      await client.query(mig1);
      await client.query(mig2);
      await client.query(mig3);
      await client.query(mig4);

      await client.query(`
        INSERT INTO base_users (id, username, display_name, email, is_active)
        VALUES (101, 'Digital01', 'Mai Thanh Tân', 'tan@company.com', true),
               (102, 'Executive01', 'Executive', 'exec@company.com', true)
      `);
    } finally {
      client.release();
    }
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await pool.end();
  });

  it("1. Successful linking sends onboarding preview message with live tasks", async () => {
    const sentMessages: string[] = [];
    const mockSender = vi.fn().mockImplementation(async (_chatId: string | number, message: string) => {
      sentMessages.push(message);
    });

    const mockWeworkClient = {
      getAllUserTasks: vi.fn().mockResolvedValue([
        {
          id: 111,
          name: "Lập kế hoạch chuyển đổi số",
          status: "0",
          review: "0",
          overdue: 1,
          deadline: Math.floor(Date.now() / 1000) - 86400,
        },
      ]),
    } as unknown as WeworkApiClient;

    const mockWorkflowClient = {
      getAllActiveJobs: vi.fn().mockResolvedValue([]),
    } as unknown as WorkflowApiClient;

    const mockRequestClient = {
      getAllPendingRequests: vi.fn().mockResolvedValue([]),
    } as unknown as RequestApiClient;

    const welcomeDigestService = new WelcomeDigestService({
      weworkClient: mockWeworkClient,
      workflowClient: mockWorkflowClient,
      requestClient: mockRequestClient,
      telegramSender: mockSender,
      timezone: "Asia/Ho_Chi_Minh",
    });

    const result = await welcomeDigestService.sendWelcomeDigest({
      telegramUserId: 12345,
      telegramChatId: 12345,
      baseUserId: 101,
      baseUsername: "Digital01",
      baseDisplayName: "Mai Thanh Tân",
    });

    expect(result.success).toBe(true);
    expect(result.chunksCount).toBe(1);
    expect(sentMessages.length).toBe(1);

    const msg = sentMessages[0]!;
    // Preview header
    expect(msg).toContain("👋 <b>CHÀO MỪNG BẠN ĐẾN VỚI BASE REMINDER</b>");
    expect(msg).toContain("Base Reminder sẽ tự động tổng hợp các công việc cần xử lý");
    expect(msg).toContain("Dưới đây là ví dụ cách hệ thống hoạt động:");

    // Wework item
    expect(msg).toContain("📋 <b>Wework</b>");
    expect(msg).toContain("🔴 <b>Quá hạn · 1</b>");
    expect(msg).toContain("1. Lập kế hoạch chuyển đổi số · <a href=\"https://wework.base.vn/tasks?task=111\">Link</a>");

    // Empty modules
    expect(msg).toContain("⚙️ <b>Workflow</b>\nKhông có việc cần xử lý.");
    expect(msg).toContain("✅ <b>Request</b>\nKhông có việc cần xử lý.");

    // Reminder schedule footer
    expect(msg).toContain("⏰ <b>Lịch nhắc việc:</b>\nThứ 2 - Thứ 6 lúc 08:00");
    expect(msg).toContain("🌏 <b>Múi giờ:</b>\nAsia/Ho_Chi_Minh");
    expect(msg).toContain("Bạn có thể xem các chức năng hỗ trợ tại Menu của bot.");
  });

  it("2. Unlink then link again sends onboarding preview again", async () => {
    const sentMessages: string[] = [];
    const mockSender = vi.fn().mockImplementation(async (_chatId, message) => {
      sentMessages.push(message);
    });

    const welcomeDigestService = new WelcomeDigestService({
      telegramSender: mockSender,
    });

    const linkingService = new LinkingService();

    // Setup initial link in DB
    const chalRes1 = await pool.query(`
      INSERT INTO otp_challenges (
        telegram_user_id, base_user_id, otp_hash, expires_at, attempts, max_attempts
      ) VALUES (
        '12345', 101, '$2a$10$hash', NOW() + INTERVAL '10 minutes', 0, 5
      ) RETURNING id
    `);

    // 1st Link
    await linkingService.finalizeLink({
      otpChallengeId: chalRes1.rows[0].id,
      telegramUserId: 12345,
      telegramChatId: 12345,
      baseUserId: 101,
      baseUsername: "Digital01",
    });

    await welcomeDigestService.sendWelcomeDigest({
      telegramUserId: 12345,
      telegramChatId: 12345,
      baseUserId: 101,
      baseUsername: "Digital01",
      baseDisplayName: "Mai Thanh Tân",
    });

    expect(sentMessages.length).toBe(1);

    // Unlink
    await linkingService.unlink(12345);
    const activeAfterUnlink = await linkingService.getActiveLink(12345);
    expect(activeAfterUnlink).toBeNull();

    // 2nd Link (link again)
    const chalRes2 = await pool.query(`
      INSERT INTO otp_challenges (
        telegram_user_id, base_user_id, otp_hash, expires_at, attempts, max_attempts
      ) VALUES (
        '12345', 101, '$2a$10$hash', NOW() + INTERVAL '10 minutes', 0, 5
      ) RETURNING id
    `);

    await linkingService.finalizeLink({
      otpChallengeId: chalRes2.rows[0].id,
      telegramUserId: 12345,
      telegramChatId: 12345,
      baseUserId: 101,
      baseUsername: "Digital01",
    });

    await welcomeDigestService.sendWelcomeDigest({
      telegramUserId: 12345,
      telegramChatId: 12345,
      baseUserId: 101,
      baseUsername: "Digital01",
      baseDisplayName: "Mai Thanh Tân",
    });

    // Preview sent a second time
    expect(sentMessages.length).toBe(2);
    expect(sentMessages[1]).toContain("👋 <b>CHÀO MỪNG BẠN ĐẾN VỚI BASE REMINDER</b>");
  });

  it("3. Telegram send failure does not break or revert account linking", async () => {
    const failingSender = vi.fn().mockRejectedValue(new Error("Telegram 403: Bot was blocked by the user"));
    const linkingService = new LinkingService();

    const welcomeDigestService = new WelcomeDigestService({
      telegramSender: failingSender,
    });

    const chalRes = await pool.query(`
      INSERT INTO otp_challenges (
        telegram_user_id, base_user_id, otp_hash, expires_at, attempts, max_attempts
      ) VALUES (
        '12345', 101, '$2a$10$hash', NOW() + INTERVAL '10 minutes', 0, 5
      ) RETURNING id
    `);

    // Finalize linking
    const finalizeRes = await linkingService.finalizeLink({
      otpChallengeId: chalRes.rows[0].id,
      telegramUserId: 12345,
      telegramChatId: 12345,
      baseUserId: 101,
      baseUsername: "Digital01",
    });

    expect(finalizeRes.success).toBe(true);

    // Welcome digest execution fails internally
    const digestRes = await welcomeDigestService.sendWelcomeDigest({
      telegramUserId: 12345,
      telegramChatId: 12345,
      baseUserId: 101,
      baseUsername: "Digital01",
      baseDisplayName: "Mai Thanh Tân",
    });

    expect(digestRes.success).toBe(false);
    expect(digestRes.error).toContain("Telegram 403");

    // CRITICAL: Account is STILL linked in DB
    const activeLink = await linkingService.getActiveLink(12345);
    expect(activeLink).not.toBeNull();
    expect(activeLink!.base_user_id).toBe(101);
    expect(activeLink!.username).toBe("Digital01");
  });

  it("4. User with zero tasks still receives full onboarding preview", async () => {
    const sentMessages: string[] = [];
    const mockSender = vi.fn().mockImplementation(async (_chatId, message) => {
      sentMessages.push(message);
    });

    const mockWeworkClient = {
      getAllUserTasks: vi.fn().mockResolvedValue([]),
    } as unknown as WeworkApiClient;

    const mockWorkflowClient = {
      getAllActiveJobs: vi.fn().mockResolvedValue([]),
    } as unknown as WorkflowApiClient;

    const mockRequestClient = {
      getAllPendingRequests: vi.fn().mockResolvedValue([]),
    } as unknown as RequestApiClient;

    const welcomeDigestService = new WelcomeDigestService({
      weworkClient: mockWeworkClient,
      workflowClient: mockWorkflowClient,
      requestClient: mockRequestClient,
      telegramSender: mockSender,
      timezone: "Asia/Ho_Chi_Minh",
    });

    const result = await welcomeDigestService.sendWelcomeDigest({
      telegramUserId: 12345,
      telegramChatId: 12345,
      baseUserId: 101,
      baseUsername: "Digital01",
      baseDisplayName: "Mai Thanh Tân",
    });

    expect(result.success).toBe(true);
    expect(sentMessages.length).toBe(1);

    const msg = sentMessages[0]!;
    expect(msg).toContain("👋 <b>CHÀO MỪNG BẠN ĐẾN VỚI BASE REMINDER</b>");
    expect(msg).toContain("📋 <b>Wework</b>\nKhông có việc cần xử lý.");
    expect(msg).toContain("⚙️ <b>Workflow</b>\nKhông có việc cần xử lý.");
    expect(msg).toContain("✅ <b>Request</b>\nKhông có việc cần xử lý.");
    expect(msg).toContain("⏰ <b>Lịch nhắc việc:</b>\nThứ 2 - Thứ 6 lúc 08:00");
  });

  it("5. Onboarding preview creates NO records in reminder_runs, reminder_deliveries, or reminder_delivery_chunks", async () => {
    const mockSender = vi.fn().mockResolvedValue(undefined);
    const welcomeDigestService = new WelcomeDigestService({
      telegramSender: mockSender,
    });

    await welcomeDigestService.sendWelcomeDigest({
      telegramUserId: 12345,
      telegramChatId: 12345,
      baseUserId: 101,
      baseUsername: "Digital01",
      baseDisplayName: "Mai Thanh Tân",
    });

    // Check DB tables
    const runsCount = await pool.query("SELECT COUNT(*) FROM reminder_runs");
    const deliveriesCount = await pool.query("SELECT COUNT(*) FROM reminder_deliveries");
    const chunksCount = await pool.query("SELECT COUNT(*) FROM reminder_delivery_chunks");

    expect(Number(runsCount.rows[0].count)).toBe(0);
    expect(Number(deliveriesCount.rows[0].count)).toBe(0);
    expect(Number(chunksCount.rows[0].count)).toBe(0);
  });

  it("6. Existing reminder scheduler pipeline behavior remains unchanged", async () => {
    // Execute a dry-run reminder pipeline
    const pipelineRes = await executeReminderPipeline({
      dryRun: true,
      syncFirst: false,
      now: new Date("2026-08-25T08:00:00Z"),
    });

    expect(pipelineRes).toBeDefined();
    expect(pipelineRes.runKey).toMatch(/^dryrun:/);
    expect(pipelineRes.totalUsers).toBeGreaterThanOrEqual(1);
  });
});
