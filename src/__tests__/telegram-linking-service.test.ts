/**
 * src/__tests__/telegram-linking-service.test.ts
 *
 * Tests linking, relinking (verify-before-switch), error-isolated post-commit alerts,
 * and unlinking in LinkingService.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { newDb } from "pg-mem";
import { readFile } from "fs/promises";
import { join } from "path";
import { LinkingService } from "../telegram/services/linking-service.js";
import * as dbConn from "../db/connection.js";

describe("LinkingService & Verify-Before-Switch Relinking Tests", () => {
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

      await client.query(mig1);
      await client.query(mig2);
      await client.query(mig3);

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

  it("creates initial active account link upon OTP completion", async () => {
    const linkingService = new LinkingService();

    // Create an active challenge in DB
    const chalRes = await pool.query(`
      INSERT INTO otp_challenges (
        telegram_user_id, base_user_id, otp_hash, expires_at, attempts, max_attempts
      ) VALUES (
        '11111', 101, '$2a$10$hash', NOW() + INTERVAL '10 minutes', 0, 5
      ) RETURNING id
    `);

    const result = await linkingService.finalizeLink({
      otpChallengeId: chalRes.rows[0].id,
      telegramUserId: 11111,
      telegramChatId: 11111,
      baseUserId: 101,
      baseUsername: "Digital01",
    });

    expect(result.success).toBe(true);
    expect(result.isRelink).toBe(false);

    // Verify active link
    const activeLink = await linkingService.getActiveLink(11111);
    expect(activeLink).not.toBeNull();
    expect(activeLink!.base_user_id).toBe(101);
    expect(activeLink!.username).toBe("Digital01");
    expect(activeLink!.reminders_enabled).toBe(true);

    // Verify OTP consumed
    const chalRow = await pool.query("SELECT * FROM otp_challenges WHERE id = $1", [chalRes.rows[0].id]);
    expect(chalRow.rows[0].consumed_at).not.toBeNull();

    // Verify conversation state
    const convRow = await pool.query("SELECT * FROM telegram_conversations WHERE telegram_user_id = '11111'");
    expect(convRow.rows[0].state).toBe("LINKED");
  });

  it("handles Case B relinking: original link active until OTP succeeds, then notifies previous Telegram user", async () => {
    const mockNotifier = vi.fn().mockResolvedValue(undefined);
    const linkingService = new LinkingService(mockNotifier);

    // 1. Initial link: Base 101 ↔ Telegram 11111
    await pool.query(`
      INSERT INTO telegram_links (base_user_id, telegram_user_id, telegram_chat_id, reminders_enabled)
      VALUES (101, 11111, 11111, true)
    `);

    // Verify initial link is active for 11111
    const initialLink = await linkingService.getActiveLink(11111);
    expect(initialLink).not.toBeNull();

    // 2. Telegram 22222 requests to link Base 101
    const chalRes = await pool.query(`
      INSERT INTO otp_challenges (
        telegram_user_id, base_user_id, otp_hash, expires_at, attempts, max_attempts
      ) VALUES (
        '22222', 101, '$2a$10$hash', NOW() + INTERVAL '10 minutes', 0, 5
      ) RETURNING id
    `);

    // 3. During OTP stage, 11111 link is STILL active (verify-before-switch)
    const linkBeforeFinalize = await linkingService.getActiveLink(11111);
    expect(linkBeforeFinalize).not.toBeNull();

    // 4. Finalize linking for 22222
    const finalizeRes = await linkingService.finalizeLink({
      otpChallengeId: chalRes.rows[0].id,
      telegramUserId: 22222,
      telegramChatId: 22222,
      baseUserId: 101,
      baseUsername: "Digital01",
    });

    expect(finalizeRes.success).toBe(true);
    expect(finalizeRes.isRelink).toBe(true);

    // 5. Verify 22222 is now active link
    const newActiveLink = await linkingService.getActiveLink(22222);
    expect(newActiveLink).not.toBeNull();
    expect(newActiveLink!.base_user_id).toBe(101);

    // 6. Verify 11111 is now unlinked
    const oldActiveLink = await linkingService.getActiveLink(11111);
    expect(oldActiveLink).toBeNull();

    // 7. Verify security alert sent to previous user 11111
    expect(mockNotifier).toHaveBeenCalledTimes(1);
    expect(mockNotifier).toHaveBeenCalledWith(
      "11111",
      expect.stringContaining("Cảnh báo bảo mật")
    );
  });

  it("notification failure after successful relink does NOT roll back or invalidate the new link", async () => {
    const failingNotifier = vi.fn().mockRejectedValue(new Error("Telegram network error"));
    const linkingService = new LinkingService(failingNotifier);

    // Existing link
    await pool.query(`
      INSERT INTO telegram_links (base_user_id, telegram_user_id, telegram_chat_id, reminders_enabled)
      VALUES (101, 11111, 11111, true)
    `);

    const chalRes = await pool.query(`
      INSERT INTO otp_challenges (
        telegram_user_id, base_user_id, otp_hash, expires_at, attempts, max_attempts
      ) VALUES (
        '33333', 101, '$2a$10$hash', NOW() + INTERVAL '10 minutes', 0, 5
      ) RETURNING id
    `);

    // Finalize link
    const res = await linkingService.finalizeLink({
      otpChallengeId: chalRes.rows[0].id,
      telegramUserId: 33333,
      telegramChatId: 33333,
      baseUserId: 101,
      baseUsername: "Digital01",
    });

    expect(res.success).toBe(true);
    expect(res.isRelink).toBe(true);

    // New link is valid and persisted despite notification exception
    const activeLink = await linkingService.getActiveLink(33333);
    expect(activeLink).not.toBeNull();
    expect(activeLink!.base_user_id).toBe(101);

    // Audit log should capture PREVIOUS_NOTIFICATION_FAILED
    const auditLogs = await pool.query(
      "SELECT * FROM audit_log WHERE event_type = 'PREVIOUS_NOTIFICATION_FAILED'"
    );
    expect(auditLogs.rows.length).toBe(1);
  });

  it("unlinks active account cleanly", async () => {
    const linkingService = new LinkingService();

    await pool.query(`
      INSERT INTO telegram_links (base_user_id, telegram_user_id, telegram_chat_id, reminders_enabled)
      VALUES (101, 44444, 44444, true)
    `);

    const unlinked = await linkingService.unlink(44444);
    expect(unlinked).toBe(true);

    const activeLink = await linkingService.getActiveLink(44444);
    expect(activeLink).toBeNull();

    // Verify audit log
    const audit = await pool.query("SELECT * FROM audit_log WHERE event_type = 'UNLINK'");
    expect(audit.rows.length).toBe(1);
  });

  it("pauses and resumes reminder notifications", async () => {
    const linkingService = new LinkingService();

    await pool.query(`
      INSERT INTO telegram_links (base_user_id, telegram_user_id, telegram_chat_id, reminders_enabled)
      VALUES (101, 55555, 55555, true)
    `);

    // Pause
    await linkingService.toggleReminders(55555, false);
    let link = await linkingService.getActiveLink(55555);
    expect(link!.reminders_enabled).toBe(false);

    // Resume
    await linkingService.toggleReminders(55555, true);
    link = await linkingService.getActiveLink(55555);
    expect(link!.reminders_enabled).toBe(true);
  });
});
