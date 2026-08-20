/**
 * src/__tests__/m2a-schema-persistence.test.ts
 *
 * Tests Migration 003 schema, tables, unique constraints, and foreign keys in pg-mem.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { newDb } from "pg-mem";
import { readFile } from "fs/promises";
import { join } from "path";

describe("M2A Schema Persistence & Constraints (pg-mem)", () => {
  let db: ReturnType<typeof newDb>;
  let pool: any;

  beforeEach(async () => {
    db = newDb();
    const { Pool } = db.adapters.createPg();
    pool = new Pool();

    // 1. Run migration 001
    const mig1Sql = await readFile(
      join(process.cwd(), "src/db/migrations/001_base_users.sql"),
      "utf-8"
    );
    await pool.query(mig1Sql);

    // 2. Run migration 002
    const mig2Sql = await readFile(
      join(process.cwd(), "src/db/migrations/002_m1b_pipeline.sql"),
      "utf-8"
    );
    await pool.query(mig2Sql);

    // 3. Run migration 003
    const mig3Sql = await readFile(
      join(process.cwd(), "src/db/migrations/003_m2a_telegram_auth.sql"),
      "utf-8"
    );
    await pool.query(mig3Sql);

    // Seed test users
    await pool.query(`
      INSERT INTO base_users (id, username, display_name, email, is_active)
      VALUES (101, 'Digital01', 'Mai Thanh Tân', 'tan@example.com', true),
             (102, 'Executive01', 'Executive User', 'exec@example.com', true),
             (103, 'Inactive01', 'Inactive User', 'inactive@example.com', false)
    `);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("enforces unique active link constraint per Telegram user", async () => {
    // 1. First insert succeeds
    await pool.query(`
      INSERT INTO telegram_links (base_user_id, telegram_user_id, telegram_chat_id, reminders_enabled)
      VALUES (101, '99999', '99999', true)
    `);

    const beforeCount = await pool.query(
      `SELECT COUNT(*) FROM telegram_links WHERE telegram_user_id = '99999'`
    );
    expect(Number(beforeCount.rows[0].count)).toBe(1);

    // 2. Attempting duplicate active link for SAME telegram_user_id throws unique violation
    await expect(
      pool.query(`
        INSERT INTO telegram_links (base_user_id, telegram_user_id, telegram_chat_id, reminders_enabled)
        VALUES (102, '99999', '99999', true)
      `)
    ).rejects.toThrow();
  });

  it("enforces unique active link constraint per Base user", async () => {
    // Link Base user 102 to TG user 77777
    await pool.query(`
      INSERT INTO telegram_links (base_user_id, telegram_user_id, telegram_chat_id, reminders_enabled)
      VALUES (102, '77777', '77777', true)
    `);

    // Attempting to link Base user 102 to another TG user 88888 while active must fail
    await expect(
      pool.query(`
        INSERT INTO telegram_links (base_user_id, telegram_user_id, telegram_chat_id, reminders_enabled)
        VALUES (102, '88888', '88888', true)
      `)
    ).rejects.toThrow();
  });

  it("supports soft deletion of active link via unlinked_at column", async () => {
    const insertRes = await pool.query(`
      INSERT INTO telegram_links (base_user_id, telegram_user_id, telegram_chat_id, reminders_enabled)
      VALUES (101, '66666', '66666', true)
      RETURNING id
    `);

    const linkId = insertRes.rows[0].id;

    await pool.query(
      `UPDATE telegram_links SET unlinked_at = NOW() WHERE id = $1`,
      [linkId]
    );

    const row = await pool.query(
      `SELECT * FROM telegram_links WHERE id = $1`,
      [linkId]
    );
    expect(row.rows[0].unlinked_at).not.toBeNull();
  });

  it("persists otp_challenges and enforces foreign key to base_users", async () => {
    // Insert challenge for valid user
    await pool.query(`
      INSERT INTO otp_challenges (telegram_user_id, base_user_id, otp_hash, expires_at, attempts, max_attempts)
      VALUES ('77777', 101, '$2a$10$hashedstringhere', NOW() + INTERVAL '10 minutes', 0, 5)
    `);

    const challenges = await pool.query(
      `SELECT * FROM otp_challenges WHERE telegram_user_id = '77777'`
    );
    expect(challenges.rows.length).toBe(1);
    expect(challenges.rows[0].attempts).toBe(0);

    // Foreign key violation for non-existent base_user_id
    await expect(
      pool.query(`
        INSERT INTO otp_challenges (telegram_user_id, base_user_id, otp_hash, expires_at)
        VALUES ('77777', 999999, '$2a$10$hash', NOW() + INTERVAL '10 minutes')
      `)
    ).rejects.toThrow();
  });

  it("persists telegram_conversations and handles upsert", async () => {
    await pool.query(`
      INSERT INTO telegram_conversations (telegram_user_id, state, context_data)
      VALUES ('55555', 'AWAIT_USERNAME', '{"step": 1}'::jsonb)
    `);

    let conv = await pool.query(
      `SELECT * FROM telegram_conversations WHERE telegram_user_id = '55555'`
    );
    expect(conv.rows[0].state).toBe("AWAIT_USERNAME");

    // Upsert
    await pool.query(`
      INSERT INTO telegram_conversations (telegram_user_id, state, context_data, updated_at)
      VALUES ('55555', 'AWAIT_OTP', '{"pending_base_user_id": 101}'::jsonb, NOW())
      ON CONFLICT (telegram_user_id)
      DO UPDATE SET state = EXCLUDED.state, context_data = EXCLUDED.context_data, updated_at = NOW()
    `);

    conv = await pool.query(
      `SELECT * FROM telegram_conversations WHERE telegram_user_id = '55555'`
    );
    expect(conv.rows[0].state).toBe("AWAIT_OTP");
    expect(conv.rows[0].context_data.pending_base_user_id).toBe(101);
  });

  it("persists audit_log entries without secrets", async () => {
    await pool.query(`
      INSERT INTO audit_log (event_type, actor_telegram_id, actor_base_user_id, metadata)
      VALUES ('OTP_SENT', '55555', 101, '{"masked_email": "t***@example.com"}'::jsonb)
    `);

    const logs = await pool.query(
      `SELECT * FROM audit_log WHERE actor_telegram_id = '55555'`
    );
    expect(logs.rows.length).toBe(1);
    expect(logs.rows[0].event_type).toBe("OTP_SENT");
    expect(logs.rows[0].metadata.masked_email).toBe("t***@example.com");
  });
});
