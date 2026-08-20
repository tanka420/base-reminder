/**
 * src/db/queries/conversations.ts
 *
 * PostgreSQL-persisted conversation state for Telegram bot.
 *
 * Ensures onboarding/linking state survives process restarts.
 */

import { query } from "../connection.js";

export type ConversationState =
  | "IDLE"
  | "AWAIT_USERNAME"
  | "AWAIT_OTP"
  | "LINKED"
  | "AWAIT_UNLINK_CONFIRM";

export interface TelegramConversation {
  telegram_user_id: string;
  state: ConversationState;
  context_data: Record<string, unknown>;
  updated_at: Date;
}

/**
 * Get current conversation state for a Telegram user.
 * Defaults to IDLE if no record exists.
 */
export async function getConversationState(
  telegramUserId: number | string | bigint
): Promise<TelegramConversation> {
  const tgIdStr = String(telegramUserId);
  const result = await query<{
    telegram_user_id: string;
    state: ConversationState;
    context_data: Record<string, unknown>;
    updated_at: Date;
  }>(
    `
    SELECT telegram_user_id, state, context_data, updated_at
    FROM telegram_conversations
    WHERE telegram_user_id = $1
    LIMIT 1
    `,
    [tgIdStr]
  );

  const row = result.rows[0];
  if (!row) {
    return {
      telegram_user_id: tgIdStr,
      state: "IDLE",
      context_data: {},
      updated_at: new Date(),
    };
  }

  return row;
}

/**
 * Set conversation state and optional context data.
 */
export async function setConversationState(
  telegramUserId: number | string | bigint,
  state: ConversationState,
  contextData: Record<string, unknown> = {}
): Promise<void> {
  const tgIdStr = String(telegramUserId);
  await query(
    `
    INSERT INTO telegram_conversations (telegram_user_id, state, context_data, updated_at)
    VALUES ($1, $2, $3, NOW())
    ON CONFLICT (telegram_user_id)
    DO UPDATE SET
      state = EXCLUDED.state,
      context_data = EXCLUDED.context_data,
      updated_at = NOW()
    `,
    [tgIdStr, state, JSON.stringify(contextData)]
  );
}

/**
 * Reset conversation state to IDLE with empty context.
 */
export async function resetConversationState(
  telegramUserId: number | string | bigint
): Promise<void> {
  await setConversationState(telegramUserId, "IDLE", {});
}
