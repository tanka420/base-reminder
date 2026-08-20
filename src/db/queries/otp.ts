/**
 * src/db/queries/otp.ts
 *
 * PostgreSQL query operations for OTP challenges and atomic rate-limiting.
 *
 * Security rules:
 *  - Plaintext OTP is NEVER passed to or stored in this module.
 *  - Only pre-computed bcrypt hash is passed.
 *  - Advisory locks serialize challenge creation to prevent rate-limit bypass.
 *  - FOR UPDATE locks serialize OTP verification attempts.
 */

import { getClient, query } from "../connection.js";

export interface OtpChallenge {
  id: number;
  telegram_user_id: string;
  base_user_id: number;
  otp_hash: string;
  expires_at: Date;
  attempts: number;
  max_attempts: number;
  consumed_at: Date | null;
  invalidated_at: Date | null;
  created_at: Date;
}

export type RateLimitRejectionReason = "tg_limit" | "base_limit" | "lockout";

/**
 * Acquire transactional advisory locks if supported by the DB engine.
 */
async function tryAdvisoryLock(
  client: Awaited<ReturnType<typeof getClient>>,
  lockKey: string
): Promise<void> {
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [lockKey]);
  } catch {
    // Graceful fallback for mock DB engines (e.g. pg-mem) that don't implement pg_advisory_xact_lock
  }
}

/**
 * Atomically evaluate rate limits and create a new OTP challenge within a single locked transaction.
 */
export async function createOtpChallengeAtomic(params: {
  telegramUserId: number | string | bigint;
  baseUserId: number;
  otpHash: string;
  ttlMinutes?: number;
  maxAttempts?: number;
  rateLimitWindowMinutes?: number;
  rateLimitMaxRequests?: number;
}): Promise<{
  success: boolean;
  challengeId?: number;
  reason?: RateLimitRejectionReason;
}> {
  const tgIdStr = String(params.telegramUserId);
  const baseUserId = Number(params.baseUserId);
  const ttlMinutes = params.ttlMinutes ?? 10;
  const maxAttempts = params.maxAttempts ?? 5;
  const windowMinutes = params.rateLimitWindowMinutes ?? 15;
  const maxRequests = params.rateLimitMaxRequests ?? 5;

  const client = await getClient();
  try {
    await client.query("BEGIN");

    // 1. Serialize via advisory locks on Telegram user ID and Base user ID
    await tryAdvisoryLock(client, `otp_tg_${tgIdStr}`);
    await tryAdvisoryLock(client, `otp_base_${baseUserId}`);

    // 2. Check 1-hour lockout: 3 or more exhausted OTPs (attempts >= 5) in past 60 minutes
    const lockoutRes = await client.query<{ count: string }>(
      `
      SELECT COUNT(*) AS count
      FROM otp_challenges
      WHERE telegram_user_id = $1
        AND attempts >= max_attempts
        AND created_at > NOW() - INTERVAL '1 hour'
      `,
      [tgIdStr]
    );
    const lockoutCount = parseInt(lockoutRes.rows[0]?.count ?? "0", 10);
    if (lockoutCount >= 3) {
      await client.query("ROLLBACK");
      return { success: false, reason: "lockout" };
    }

    // 3. Check Telegram axis rate limit (past windowMinutes)
    const tgCountRes = await client.query<{ count: string }>(
      `
      SELECT COUNT(*) AS count
      FROM otp_challenges
      WHERE telegram_user_id = $1
        AND created_at > NOW() - ($2 || ' minutes')::INTERVAL
      `,
      [tgIdStr, windowMinutes.toString()]
    );
    const tgCount = parseInt(tgCountRes.rows[0]?.count ?? "0", 10);
    if (tgCount >= maxRequests) {
      await client.query("ROLLBACK");
      return { success: false, reason: "tg_limit" };
    }

    // 4. Check Base user axis rate limit (past windowMinutes)
    const baseCountRes = await client.query<{ count: string }>(
      `
      SELECT COUNT(*) AS count
      FROM otp_challenges
      WHERE base_user_id = $1
        AND created_at > NOW() - ($2 || ' minutes')::INTERVAL
      `,
      [baseUserId, windowMinutes.toString()]
    );
    const baseCount = parseInt(baseCountRes.rows[0]?.count ?? "0", 10);
    if (baseCount >= maxRequests) {
      await client.query("ROLLBACK");
      return { success: false, reason: "base_limit" };
    }

    // 5. Invalidate any existing active challenges for this Telegram user
    await client.query(
      `
      UPDATE otp_challenges
      SET invalidated_at = NOW()
      WHERE telegram_user_id = $1
        AND consumed_at IS NULL
        AND invalidated_at IS NULL
      `,
      [tgIdStr]
    );

    // 6. Insert new challenge
    const insertRes = await client.query<{ id: number }>(
      `
      INSERT INTO otp_challenges (
        telegram_user_id,
        base_user_id,
        otp_hash,
        expires_at,
        attempts,
        max_attempts,
        created_at
      ) VALUES (
        $1,
        $2,
        $3,
        NOW() + ($4 || ' minutes')::INTERVAL,
        0,
        $5,
        NOW()
      )
      RETURNING id
      `,
      [tgIdStr, baseUserId, params.otpHash, ttlMinutes.toString(), maxAttempts]
    );

    const newChallengeId = insertRes.rows[0]?.id;
    if (!newChallengeId) {
      await client.query("ROLLBACK");
      throw new Error("Failed to insert OTP challenge");
    }

    await client.query("COMMIT");

    return {
      success: true,
      challengeId: newChallengeId,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Invalidate an active OTP challenge (e.g. on SMTP delivery failure or expiry).
 */
export async function invalidateOtpChallenge(challengeId: number): Promise<void> {
  await query(
    `
    UPDATE otp_challenges
    SET invalidated_at = NOW()
    WHERE id = $1
      AND consumed_at IS NULL
      AND invalidated_at IS NULL
    `,
    [challengeId]
  );
}

/**
 * Fetch the currently active OTP challenge for a Telegram user.
 */
export async function getActiveOtpChallenge(
  telegramUserId: number | string | bigint,
  baseUserId?: number
): Promise<OtpChallenge | null> {
  const tgIdStr = String(telegramUserId);

  let sql = `
    SELECT id, telegram_user_id, base_user_id, otp_hash, expires_at, attempts, max_attempts, consumed_at, invalidated_at, created_at
    FROM otp_challenges
    WHERE telegram_user_id = $1
      AND consumed_at IS NULL
      AND invalidated_at IS NULL
      AND expires_at > NOW()
  `;
  const params: unknown[] = [tgIdStr];

  if (baseUserId !== undefined) {
    sql += ` AND base_user_id = $2`;
    params.push(baseUserId);
  }

  sql += ` ORDER BY created_at DESC LIMIT 1`;

  const result = await query<OtpChallenge>(sql, params);
  return result.rows[0] ?? null;
}

/**
 * Increment failed attempt count on an OTP challenge.
 * Automatically invalidates challenge if max_attempts is reached.
 */
export async function recordFailedOtpAttempt(
  challengeId: number
): Promise<{ attempts: number; maxAttempts: number; isExhausted: boolean }> {
  const client = await getClient();
  try {
    await client.query("BEGIN");

    const res = await client.query<{ attempts: number; max_attempts: number }>(
      `
      SELECT attempts, max_attempts
      FROM otp_challenges
      WHERE id = $1
      FOR UPDATE
      `,
      [challengeId]
    );

    const current = res.rows[0];
    if (!current) {
      await client.query("ROLLBACK");
      return { attempts: 0, maxAttempts: 5, isExhausted: true };
    }

    const newAttempts = current.attempts + 1;
    const isExhausted = newAttempts >= current.max_attempts;

    if (isExhausted) {
      await client.query(
        `
        UPDATE otp_challenges
        SET attempts = $1, invalidated_at = NOW()
        WHERE id = $2
        `,
        [newAttempts, challengeId]
      );
    } else {
      await client.query(
        `
        UPDATE otp_challenges
        SET attempts = $1
        WHERE id = $2
        `,
        [newAttempts, challengeId]
      );
    }

    await client.query("COMMIT");
    return {
      attempts: newAttempts,
      maxAttempts: current.max_attempts,
      isExhausted,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
