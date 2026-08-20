/**
 * src/telegram/handlers/unlink.ts
 *
 * Handler for the /unlink command.
 *
 * Enforces OTP-verified unlinking:
 *  1. Checks if user has an active link.
 *  2. Sends a 6-digit OTP verification email to the user's linked Base corporate email.
 *  3. Transitions state to AWAIT_UNLINK_CONFIRM.
 */

import type { Context } from "grammy";
import type { LinkingService } from "../services/linking-service.js";
import type { OtpService } from "../services/otp-service.js";
import { setConversationState } from "../../db/queries/conversations.js";
import { escapeHtml } from "../utils/html.js";

export function createUnlinkHandler(
  linkingService: LinkingService,
  otpService: OtpService
) {
  return async (ctx: Context): Promise<void> => {
    const tgUserId = ctx.from?.id;
    if (!tgUserId) return;

    const activeLink = await linkingService.getActiveLink(tgUserId);

    if (!activeLink) {
      await ctx.reply(
        "ℹ️ Bạn chưa liên kết tài khoản nào để hủy.",
        { parse_mode: "HTML" }
      );
      return;
    }

    // Send OTP to the linked Base corporate email
    await ctx.reply(
      `🔍 Đang gửi mã OTP xác nhận hủy liên kết tới email của bạn...`,
      { parse_mode: "HTML" }
    );

    const otpRes = await otpService.requestAndSendOtp({
      telegramUserId: tgUserId,
      baseUser: {
        id: activeLink.base_user_id,
        username: activeLink.username,
        display_name: activeLink.display_name,
        email: activeLink.email,
        is_active: activeLink.is_active,
      },
    });

    if (!otpRes.success) {
      if (otpRes.reason === "lockout") {
        await ctx.reply(
          "⛔ <b>Yêu cầu bị tạm khóa!</b>\n\nBạn đã nhập sai OTP quá nhiều lần. Vui lòng thử lại sau 1 giờ.",
          { parse_mode: "HTML" }
        );
      } else if (otpRes.reason === "tg_limit") {
        await ctx.reply(
          "⏳ Bạn đã yêu cầu quá nhiều mã OTP (tối đa 5 lần/15 phút). Vui lòng đợi 15 phút rồi thử lại.",
          { parse_mode: "HTML" }
        );
      } else {
        await ctx.reply(
          "❌ Không thể gửi email chứa mã OTP lúc này. Vui lòng thử lại sau ít phút.",
          { parse_mode: "HTML" }
        );
      }
      return;
    }

    // Set state to AWAIT_UNLINK_CONFIRM
    await setConversationState(tgUserId, "AWAIT_UNLINK_CONFIRM", {
      pending_unlink_base_user_id: activeLink.base_user_id,
      pending_unlink_username: activeLink.username,
      pending_unlink_display_name: activeLink.display_name,
    });

    await ctx.reply(
      `⚠️ <b>Xác nhận hủy liên kết</b>\n\n` +
        `Bạn đang yêu cầu hủy liên kết tài khoản Base <b>${escapeHtml(activeLink.display_name)}</b> (<code>${escapeHtml(activeLink.username)}</code>).\n\n` +
        `📧 Mã OTP gồm 6 chữ số đã được gửi đến email:\n` +
        `👉 <b>${escapeHtml(otpRes.maskedEmail)}</b>\n\n` +
        `Vui lòng nhập mã <b>6 chữ số OTP</b> để xác nhận hủy liên kết (hoặc gõ /status để hủy bỏ yêu cầu):`,
      { parse_mode: "HTML" }
    );
  };
}
