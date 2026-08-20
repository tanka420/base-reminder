/**
 * src/telegram/services/linking-service.ts
 *
 * Coordinates atomic account linking, verify-before-switch relinking,
 * post-commit security alerts, unlinking, and reminder toggles.
 *
 * Security rules:
 *  - Relink transaction deactivates old link and inserts new link inside ONE DB transaction.
 *  - Security notification to the previous Telegram account happens strictly AFTER commit.
 *  - Failure of the notification must NEVER roll back or invalidate the new link.
 */

import {
  atomicCompleteLinkingTransaction,
  getActiveTelegramLinkByTelegramId,
  unlinkTelegramAccount,
  setRemindersEnabled,
  type ActiveTelegramLinkWithUser,
} from "../../db/queries/telegram-links.js";
import { writeAuditLog } from "../../db/queries/audit.js";
import { logger } from "../../logging/logger.js";

export type TelegramNotifier = (chatId: string | number, message: string) => Promise<void>;

export class LinkingService {
  readonly #notifier?: TelegramNotifier;

  constructor(notifier?: TelegramNotifier) {
    this.#notifier = notifier;
  }

  /**
   * Fetch currently active Base link for a Telegram user.
   */
  async getActiveLink(
    telegramUserId: number | string | bigint
  ): Promise<ActiveTelegramLinkWithUser | null> {
    return getActiveTelegramLinkByTelegramId(telegramUserId);
  }

  /**
   * Finalize account linking or relinking after successful OTP verification.
   */
  async finalizeLink(params: {
    otpChallengeId: number;
    telegramUserId: number | string | bigint;
    telegramChatId: number | string | bigint;
    baseUserId: number;
    baseUsername?: string;
  }): Promise<{ success: boolean; isRelink: boolean }> {
    const result = await atomicCompleteLinkingTransaction({
      otpChallengeId: params.otpChallengeId,
      telegramUserId: params.telegramUserId,
      telegramChatId: params.telegramChatId,
      baseUserId: params.baseUserId,
    });

    if (!result.success) {
      return { success: false, isRelink: false };
    }

    // Best-effort post-commit notification to previous Telegram account
    if (result.isRelink && result.previousTelegramChatId && this.#notifier) {
      const oldChatId = result.previousTelegramChatId;
      const oldTgId = result.previousTelegramUserId;
      const usernameLabel = params.baseUsername ? ` (${params.baseUsername})` : "";

      const alertMessage =
        `⚠️ <b>Cảnh báo bảo mật</b>\n\n` +
        `Tài khoản Base của bạn${usernameLabel} vừa được liên kết với một tài khoản Telegram khác.\n` +
        `Nếu bạn không thực hiện hành động này, vui lòng liên hệ quản trị viên ngay lập tức.`;

      try {
        await this.#notifier(oldChatId, alertMessage);
        logger.info({
          msg: "relink notification sent to previous telegram user",
          previous_telegram_id: oldTgId,
        });
      } catch (notifyErr) {
        // Log error and audit, but DO NOT roll back or throw
        logger.warn({
          msg: "failed to send relink alert to previous telegram user",
          previous_telegram_id: oldTgId,
          error: notifyErr instanceof Error ? notifyErr.message : String(notifyErr),
        });

        await writeAuditLog({
          eventType: "PREVIOUS_NOTIFICATION_FAILED",
          actorTelegramId: params.telegramUserId,
          actorBaseUserId: params.baseUserId,
          metadata: {
            previous_telegram_id: oldTgId,
            error: notifyErr instanceof Error ? notifyErr.message : String(notifyErr),
          },
        });
      }
    }

    return {
      success: true,
      isRelink: result.isRelink,
    };
  }

  /**
   * Unlink active Telegram account.
   */
  async unlink(telegramUserId: number | string | bigint): Promise<boolean> {
    return unlinkTelegramAccount(telegramUserId);
  }

  /**
   * Pause or resume daily reminder notifications.
   */
  async toggleReminders(
    telegramUserId: number | string | bigint,
    enabled: boolean
  ): Promise<boolean> {
    return setRemindersEnabled(telegramUserId, enabled);
  }
}
