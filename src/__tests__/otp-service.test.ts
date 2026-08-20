/**
 * src/__tests__/otp-service.test.ts
 *
 * Unit and integration tests for OtpService and OTP lifecycle.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { newDb } from "pg-mem";
import { readFile } from "fs/promises";
import { join } from "path";
import bcrypt from "bcryptjs";
import { OtpService } from "../telegram/services/otp-service.js";
import { SmtpEmailClient } from "../email/smtp-client.js";
import * as dbConn from "../db/connection.js";

describe("OtpService Lifecycle & Security Tests", () => {
  let db: ReturnType<typeof newDb>;
  let pool: any;

  const mockSmtpConfig = {
    host: "smtp.example.com",
    port: 587,
    secure: false,
    requireTls: true,
    user: "test@example.com",
    pass: "password",
    from: "test@example.com",
    otpTtlMinutes: 10,
    otpMaxAttempts: 5,
    otpRateLimitWindowMinutes: 15,
    otpRateLimitMaxRequests: 5,
  };

  beforeEach(async () => {
    db = newDb();
    const { Pool } = db.adapters.createPg();
    pool = new Pool();

    // Mock db/connection module to route to pg-mem pool
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
               (102, 'Executive01', 'Executive', 'exec@company.com', true),
               (103, 'InactiveUser', 'Inactive', 'inactive@company.com', false)
      `);
    } finally {
      client.release();
    }
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await pool.end();
  });

  it("generates 6-digit numeric OTP, hashes with bcrypt, and sends email", async () => {
    const mockSendMail = vi.fn().mockResolvedValue(undefined);
    const mockTransporter: any = { sendMail: mockSendMail };
    const smtpClient = new SmtpEmailClient(mockSmtpConfig, mockTransporter);

    const otpService = new OtpService(mockSmtpConfig, smtpClient);

    const res = await otpService.requestAndSendOtp({
      telegramUserId: 12345,
      baseUser: {
        id: 101,
        username: "Digital01",
        display_name: "Mai Thanh Tân",
        email: "tan@company.com",
        is_active: true,
      },
    });

    expect(res.success).toBe(true);
    expect(res.maskedEmail).toBe("t***n@company.com");
    expect(res.ttlMinutes).toBe(10);
    const firstCall = mockSendMail.mock.calls[0];
    expect(firstCall).toBeDefined();
    const emailCall = firstCall![0];
    expect(emailCall.to).toBe("tan@company.com");
    expect(emailCall.subject).toBe("[Base Reminder] Mã xác thực liên kết tài khoản");

    // Verify OTP hash in DB
    const challenges = await pool.query(
      "SELECT * FROM otp_challenges WHERE telegram_user_id = '12345'"
    );
    expect(challenges.rows.length).toBe(1);
    const challenge = challenges.rows[0];
    expect(challenge.attempts).toBe(0);
    expect(challenge.consumed_at).toBeNull();
    expect(challenge.invalidated_at).toBeNull();

    // Verify bcrypt hash matches the OTP sent in email text
    const match = emailCall.text.match(/Mã xác thực \(OTP\) của bạn là: (\d{6})/);
    expect(match).not.toBeNull();
    const sentOtp = match[1];
    const hashValid = await bcrypt.compare(sentOtp, challenge.otp_hash);
    expect(hashValid).toBe(true);
  });

  it("SMTP failure immediately invalidates newly created challenge and keeps conversation state intact", async () => {
    const mockSendMail = vi.fn().mockRejectedValue(new Error("SMTP connection timeout"));
    const mockTransporter: any = { sendMail: mockSendMail };
    const smtpClient = new SmtpEmailClient(mockSmtpConfig, mockTransporter);

    const otpService = new OtpService(mockSmtpConfig, smtpClient);

    // Prior state
    await pool.query(`
      INSERT INTO telegram_conversations (telegram_user_id, state, context_data)
      VALUES ('12345', 'AWAIT_USERNAME', '{}'::jsonb)
    `);

    const res = await otpService.requestAndSendOtp({
      telegramUserId: 12345,
      baseUser: {
        id: 101,
        username: "Digital01",
        display_name: "Mai Thanh Tân",
        email: "tan@company.com",
        is_active: true,
      },
    });

    expect(res.success).toBe(false);
    expect(res.reason).toBe("smtp_error");

    // Verify challenge was invalidated immediately
    const challenges = await pool.query(
      "SELECT * FROM otp_challenges WHERE telegram_user_id = '12345'"
    );
    expect(challenges.rows.length).toBe(1);
    expect(challenges.rows[0].invalidated_at).not.toBeNull();

    // Verify conversation state was NOT advanced to AWAIT_OTP
    const conv = await pool.query(
      "SELECT * FROM telegram_conversations WHERE telegram_user_id = '12345'"
    );
    expect(conv.rows[0].state).toBe("AWAIT_USERNAME");
  });

  it("enforces dual-axis rate limiting (Telegram user axis: max 5 in 15 min)", async () => {
    const mockSendMail = vi.fn().mockResolvedValue(undefined);
    const mockTransporter: any = { sendMail: mockSendMail };
    const smtpClient = new SmtpEmailClient(mockSmtpConfig, mockTransporter);
    const otpService = new OtpService(mockSmtpConfig, smtpClient);

    const baseUser = {
      id: 101,
      username: "Digital01",
      display_name: "Mai Thanh Tân",
      email: "tan@company.com",
      is_active: true,
    };

    // 5 requests succeed
    for (let i = 0; i < 5; i++) {
      const res = await otpService.requestAndSendOtp({
        telegramUserId: 55555,
        baseUser,
      });
      expect(res.success).toBe(true);
    }

    // 6th request is rate-limited on telegram_user_id axis
    const res6 = await otpService.requestAndSendOtp({
      telegramUserId: 55555,
      baseUser,
    });
    expect(res6.success).toBe(false);
    expect(res6.reason).toBe("tg_limit");
  });

  it("enforces dual-axis rate limiting (Base user axis: max 5 in 15 min across different Telegram accounts)", async () => {
    const mockSendMail = vi.fn().mockResolvedValue(undefined);
    const mockTransporter: any = { sendMail: mockSendMail };
    const smtpClient = new SmtpEmailClient(mockSmtpConfig, mockTransporter);
    const otpService = new OtpService(mockSmtpConfig, smtpClient);

    const baseUser = {
      id: 102,
      username: "Executive01",
      display_name: "Executive",
      email: "exec@company.com",
      is_active: true,
    };

    // 5 different Telegram accounts request OTP for the same Base user
    for (let tgId = 1001; tgId <= 1005; tgId++) {
      const res = await otpService.requestAndSendOtp({
        telegramUserId: tgId,
        baseUser,
      });
      expect(res.success).toBe(true);
    }

    // 6th Telegram account attempting to send OTP to the same Base user is blocked
    const res6 = await otpService.requestAndSendOtp({
      telegramUserId: 1006,
      baseUser,
    });
    expect(res6.success).toBe(false);
    expect(res6.reason).toBe("base_limit");
  });

  it("enforces 1-hour lockout after 3 exhausted OTP challenges", async () => {
    const mockSendMail = vi.fn().mockResolvedValue(undefined);
    const mockTransporter: any = { sendMail: mockSendMail };
    const smtpClient = new SmtpEmailClient(mockSmtpConfig, mockTransporter);
    const otpService = new OtpService(mockSmtpConfig, smtpClient);

    // Insert 3 exhausted challenges (attempts >= 5) in the last hour
    for (let i = 0; i < 3; i++) {
      await pool.query(`
        INSERT INTO otp_challenges (
          telegram_user_id, base_user_id, otp_hash, expires_at, attempts, max_attempts, invalidated_at, created_at
        ) VALUES (
          '88888', 101, '$2a$10$hash', NOW() + INTERVAL '10 minutes', 5, 5, NOW(), NOW() - INTERVAL '10 minutes'
        )
      `);
    }

    const res = await otpService.requestAndSendOtp({
      telegramUserId: 88888,
      baseUser: {
        id: 101,
        username: "Digital01",
        display_name: "Mai Thanh Tân",
        email: "tan@company.com",
        is_active: true,
      },
    });

    expect(res.success).toBe(false);
    expect(res.reason).toBe("lockout");
  });

  it("handles verification: validates format, increments failed attempts, and invalidates on 5th failure", async () => {
    const mockSendMail = vi.fn().mockResolvedValue(undefined);
    const mockTransporter: any = { sendMail: mockSendMail };
    const smtpClient = new SmtpEmailClient(mockSmtpConfig, mockTransporter);
    const otpService = new OtpService(mockSmtpConfig, smtpClient);

    const salt = await bcrypt.genSalt(10);
    const correctHash = await bcrypt.hash("654321", salt);

    await pool.query(
      `
      INSERT INTO otp_challenges (
        telegram_user_id, base_user_id, otp_hash, expires_at, attempts, max_attempts, created_at
      ) VALUES (
        '77777', 101, $1, NOW() + INTERVAL '10 minutes', 0, 5, NOW()
      )
      `,
      [correctHash]
    );

    // 1. Non-6-digit input
    const invalidFormat = await otpService.verifyOtpInput({
      telegramUserId: 77777,
      baseUserId: 101,
      rawInput: "1234",
    });
    expect(invalidFormat.success).toBe(false);
    expect(invalidFormat.error).toBe("invalid_format");

    // 2. Wrong OTP attempt 1
    const attempt1 = await otpService.verifyOtpInput({
      telegramUserId: 77777,
      baseUserId: 101,
      rawInput: "000000",
    });
    expect(attempt1.success).toBe(false);
    expect(attempt1.error).toBe("wrong_code");
    expect(attempt1.attemptsRemaining).toBe(4);

    // 3. Exhaust remaining attempts
    await otpService.verifyOtpInput({ telegramUserId: 77777, baseUserId: 101, rawInput: "000001" });
    await otpService.verifyOtpInput({ telegramUserId: 77777, baseUserId: 101, rawInput: "000002" });
    await otpService.verifyOtpInput({ telegramUserId: 77777, baseUserId: 101, rawInput: "000003" });

    const finalAttempt = await otpService.verifyOtpInput({
      telegramUserId: 77777,
      baseUserId: 101,
      rawInput: "000004",
    });
    expect(finalAttempt.success).toBe(false);
    expect(finalAttempt.isExhausted).toBe(true);
    expect(finalAttempt.attemptsRemaining).toBe(0);

    // Challenge should now be invalidated in DB
    const row = await pool.query("SELECT * FROM otp_challenges WHERE telegram_user_id = '77777'");
    expect(row.rows[0].invalidated_at).not.toBeNull();
  });

  it("handles verification: succeeds with correct 6-digit OTP", async () => {
    const mockSendMail = vi.fn().mockResolvedValue(undefined);
    const mockTransporter: any = { sendMail: mockSendMail };
    const smtpClient = new SmtpEmailClient(mockSmtpConfig, mockTransporter);
    const otpService = new OtpService(mockSmtpConfig, smtpClient);

    const salt = await bcrypt.genSalt(10);
    const correctHash = await bcrypt.hash("123456", salt);

    const insertRes = await pool.query(
      `
      INSERT INTO otp_challenges (
        telegram_user_id, base_user_id, otp_hash, expires_at, attempts, max_attempts, created_at
      ) VALUES (
        '66666', 101, $1, NOW() + INTERVAL '10 minutes', 0, 5, NOW()
      ) RETURNING id
      `,
      [correctHash]
    );

    const challengeId = insertRes.rows[0].id;

    const res = await otpService.verifyOtpInput({
      telegramUserId: 66666,
      baseUserId: 101,
      rawInput: "123456",
    });

    expect(res.success).toBe(true);
    expect(res.challengeId).toBe(challengeId);
    expect(res.baseUserId).toBe(101);
  });
});
