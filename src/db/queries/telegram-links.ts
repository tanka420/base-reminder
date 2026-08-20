/**
 * src/db/queries/telegram-links.ts
 *
 * PostgreSQL query operations for Telegram account links.
 *
 * Enforces:
 *  - 1 active Base account ↔ 1 active Telegram account.
 *  - Verify-before-switch atomic linking transactions.
 *  - Soft-deactivation (unlinked_at) for history preservation.
 */

import { getClient, query } from "../connection.js";

export interface TelegramLink {
  id: number;
  base_user_id: number;
  telegram_user_id: string;
  telegram_chat_id: string;
  reminders_enabled: boolean;
  linked_at: Date;
  unlinked_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface ActiveTelegramLinkWithUser extends TelegramLink {
  username: string;
  display_name: string;
  email: string;
  is_active: boolean;
}

/**
 * Fetch the active link for a given Telegram user ID, joined with Base user details.
 */
export async function getActiveTelegramLinkByTelegramId(
  telegramUserId: number | string | bigint
): Promise<ActiveTelegramLinkWithUser | null> {
  const tgIdStr = String(telegramUserId);
  const result = await query<ActiveTelegramLinkWithUser>(
    `
    SELECT
      tl.id,
      tl.base_user_id,
      tl.telegram_user_id,
      tl.telegram_chat_id,
      tl.reminders_enabled,
      tl.linked_at,
      tl.unlinked_at,
      tl.created_at,
      tl.updated_at,
      bu.username,
      bu.display_name,
      bu.email,
      bu.is_active
    FROM telegram_links tl
    INNER JOIN base_users bu ON bu.id = tl.base_user_id
    WHERE tl.telegram_user_id = $1
      AND tl.unlinked_at IS NULL
    LIMIT 1
    `,
    [tgIdStr]
  );

  return result.rows[0] ?? null;
}

/**
 * Fetch the active link for a given Base user ID.
 */
export async function getActiveTelegramLinkByBaseUserId(
  baseUserId: number
): Promise<TelegramLink | null> {
  const result = await query<TelegramLink>(
    `
    SELECT id, base_user_id, telegram_user_id, telegram_chat_id, reminders_enabled, linked_at, unlinked_at, created_at, updated_at
    FROM telegram_links
    WHERE base_user_id = $1
      AND unlinked_at IS NULL
    LIMIT 1
    `,
    [baseUserId]
  );

  return result.rows[0] ?? null;
}

/**
 * Unlink an active Telegram link (soft delete).
 */
export async function unlinkTelegramAccount(
  telegramUserId: number | string | bigint
): Promise<boolean> {
  const tgIdStr = String(telegramUserId);
  const client = await getClient();
  try {
    await client.query("BEGIN");

    const linkRes = await client.query<{ id: number; base_user_id: number }>(
      `
      SELECT id, base_user_id
      FROM telegram_links
      WHERE telegram_user_id = $1 AND unlinked_at IS NULL
      FOR UPDATE
      `,
      [tgIdStr]
    );

    const linkRow = linkRes.rows[0];
    if (!linkRow) {
      await client.query("COMMIT");
      return false;
    }

    const { id, base_user_id } = linkRow;

    // Soft delete link
    await client.query(
      `
      UPDATE telegram_links
      SET unlinked_at = NOW(), updated_at = NOW()
      WHERE id = $1
      `,
      [id]
    );

    // Reset conversation state
    await client.query(
      `
      INSERT INTO telegram_conversations (telegram_user_id, state, context_data, updated_at)
      VALUES ($1, 'IDLE', '{}'::jsonb, NOW())
      ON CONFLICT (telegram_user_id)
      DO UPDATE SET state = 'IDLE', context_data = '{}'::jsonb, updated_at = NOW()
      `,
      [tgIdStr]
    );

    // Audit log
    await client.query(
      `
      INSERT INTO audit_log (event_type, actor_telegram_id, actor_base_user_id, metadata, created_at)
      VALUES ('UNLINK', $1, $2, '{}'::jsonb, NOW())
      `,
      [tgIdStr, base_user_id]
    );

    await client.query("COMMIT");
    return true;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Toggle reminder enabled state for an active link.
 */
export async function setRemindersEnabled(
  telegramUserId: number | string | bigint,
  enabled: boolean
): Promise<boolean> {
  const tgIdStr = String(telegramUserId);
  const eventType = enabled ? "REMINDERS_RESUMED" : "REMINDERS_PAUSED";

  const client = await getClient();
  try {
    await client.query("BEGIN");

    const result = await client.query<{ id: number; base_user_id: number }>(
      `
      UPDATE telegram_links
      SET reminders_enabled = $1, updated_at = NOW()
      WHERE telegram_user_id = $2 AND unlinked_at IS NULL
      RETURNING id, base_user_id
      `,
      [enabled, tgIdStr]
    );

    const updatedRow = result.rows[0];
    if (!updatedRow) {
      await client.query("COMMIT");
      return false;
    }

    await client.query(
      `
      INSERT INTO audit_log (event_type, actor_telegram_id, actor_base_user_id, metadata, created_at)
      VALUES ($1, $2, $3, '{}'::jsonb, NOW())
      `,
      [eventType, tgIdStr, updatedRow.base_user_id]
    );

    await client.query("COMMIT");
    return true;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Execute atomic link/relink transaction upon successful OTP verification.
 */
export async function atomicCompleteLinkingTransaction(params: {
  otpChallengeId: number;
  telegramUserId: number | string | bigint;
  telegramChatId: number | string | bigint;
  baseUserId: number;
}): Promise<{
  success: boolean;
  isRelink: boolean;
  previousTelegramUserId: string | null;
  previousTelegramChatId: string | null;
}> {
  const tgIdStr = String(params.telegramUserId);
  const chatIdStr = String(params.telegramChatId);
  const baseUserId = Number(params.baseUserId);

  const client = await getClient();
  try {
    await client.query("BEGIN");

    // 1. Lock and verify active OTP challenge
    const otpRes = await client.query<{ id: number; base_user_id: number }>(
      `
      SELECT id, base_user_id
      FROM otp_challenges
      WHERE id = $1
        AND telegram_user_id = $2
        AND base_user_id = $3
        AND consumed_at IS NULL
        AND invalidated_at IS NULL
        AND expires_at > NOW()
      FOR UPDATE
      `,
      [params.otpChallengeId, tgIdStr, baseUserId]
    );

    if (otpRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return {
        success: false,
        isRelink: false,
        previousTelegramUserId: null,
        previousTelegramChatId: null,
      };
    }

    // 2. Re-verify Base user active status
    const userRes = await client.query<{ id: number; is_active: boolean }>(
      `SELECT id, is_active FROM base_users WHERE id = $1`,
      [baseUserId]
    );
    const targetUser = userRes.rows[0];
    if (!targetUser || !targetUser.is_active) {
      await client.query("ROLLBACK");
      return {
        success: false,
        isRelink: false,
        previousTelegramUserId: null,
        previousTelegramChatId: null,
      };
    }

    // 3. Find any conflicting active link on this Base user (Relink Case B)
    const existingBaseLinkRes = await client.query<{
      id: number;
      telegram_user_id: string;
      telegram_chat_id: string;
    }>(
      `
      SELECT id, telegram_user_id, telegram_chat_id
      FROM telegram_links
      WHERE base_user_id = $1 AND unlinked_at IS NULL
      FOR UPDATE
      `,
      [baseUserId]
    );

    let previousTelegramUserId: string | null = null;
    let previousTelegramChatId: string | null = null;
    let isRelink = false;

    const prev = existingBaseLinkRes.rows[0];
    if (prev && String(prev.telegram_user_id) !== tgIdStr) {
      isRelink = true;
      previousTelegramUserId = String(prev.telegram_user_id);
      previousTelegramChatId = String(prev.telegram_chat_id);
    }

    // 4. Deactivate conflicting active links (for this Base user OR this Telegram user)
    await client.query(
      `
      UPDATE telegram_links
      SET unlinked_at = NOW(), updated_at = NOW()
      WHERE (base_user_id = $1 OR telegram_user_id = $2)
        AND unlinked_at IS NULL
      `,
      [baseUserId, tgIdStr]
    );

    // 5. Create new active link
    await client.query(
      `
      INSERT INTO telegram_links (
        base_user_id,
        telegram_user_id,
        telegram_chat_id,
        reminders_enabled,
        linked_at,
        created_at,
        updated_at
      ) VALUES (
        $1, $2, $3, true, NOW(), NOW(), NOW()
      )
      `,
      [baseUserId, tgIdStr, chatIdStr]
    );

    // 6. Mark OTP consumed
    await client.query(
      `
      UPDATE otp_challenges
      SET consumed_at = NOW()
      WHERE id = $1
      `,
      [params.otpChallengeId]
    );

    // 7. Update conversation state to LINKED
    await client.query(
      `
      INSERT INTO telegram_conversations (telegram_user_id, state, context_data, updated_at)
      VALUES ($1, 'LINKED', '{}'::jsonb, NOW())
      ON CONFLICT (telegram_user_id)
      DO UPDATE SET state = 'LINKED', context_data = '{}'::jsonb, updated_at = NOW()
      `,
      [tgIdStr]
    );

    // 8. Write audit log
    const eventType = isRelink ? "RELINK" : "LINK_SUCCESS";
    const auditMetadata: Record<string, unknown> = {
      is_relink: isRelink,
    };
    if (isRelink && previousTelegramUserId) {
      auditMetadata["previous_telegram_id"] = previousTelegramUserId;
    }

    await client.query(
      `
      INSERT INTO audit_log (event_type, actor_telegram_id, actor_base_user_id, metadata, created_at)
      VALUES ($1, $2, $3, $4, NOW())
      `,
      [eventType, tgIdStr, baseUserId, JSON.stringify(auditMetadata)]
    );

    await client.query("COMMIT");

    return {
      success: true,
      isRelink,
      previousTelegramUserId,
      previousTelegramChatId,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
