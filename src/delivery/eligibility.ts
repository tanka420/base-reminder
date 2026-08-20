/**
 * src/delivery/eligibility.ts
 *
 * Delivery eligibility evaluator for Telegram morning digests.
 *
 * Rules:
 *  - User must be active in Base (base_users.is_active = true).
 *  - User must have an active Telegram link (unlinked_at IS NULL).
 *  - Reminders must not be paused (reminders_enabled = true).
 *  - Digest status must be 'ready' or 'partial' (and not 'empty' or 'error').
 */

import type { UserDigest } from "../digest/types.js";
import type { TelegramLink } from "../db/queries/telegram-links.js";

export type IneligibleReason =
  | "no_telegram_link"
  | "reminders_paused"
  | "user_inactive"
  | "empty_digest"
  | "error_digest";

export interface EligibilityResult {
  isEligible: boolean;
  reason?: IneligibleReason;
  chatId?: string;
  telegramUserId?: string;
}

export function evaluateDeliveryEligibility(params: {
  isBaseUserActive: boolean;
  activeLink: TelegramLink | null;
  digest: UserDigest;
}): EligibilityResult {
  const { isBaseUserActive, activeLink, digest } = params;

  if (!isBaseUserActive) {
    return { isEligible: false, reason: "user_inactive" };
  }

  if (!activeLink) {
    return { isEligible: false, reason: "no_telegram_link" };
  }

  if (!activeLink.reminders_enabled) {
    return { isEligible: false, reason: "reminders_paused" };
  }

  if (digest.status === "empty") {
    return { isEligible: false, reason: "empty_digest" };
  }

  if (digest.status === "error") {
    return { isEligible: false, reason: "error_digest" };
  }

  return {
    isEligible: true,
    chatId: activeLink.telegram_chat_id,
    telegramUserId: activeLink.telegram_user_id,
  };
}
