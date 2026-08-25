/**
 * src/telegram/handlers/status.ts
 *
 * Handler for the /status command.
 */

import type { Context } from "grammy";
import type { LinkingService } from "../services/linking-service.js";
import { maskEmail } from "../../email/smtp-client.js";
import { escapeHtml } from "../utils/html.js";

export function createStatusHandler(linkingService: LinkingService) {
  return async (ctx: Context): Promise<void> => {
    const tgUserId = ctx.from?.id;
    if (!tgUserId) return;

    const activeLink = await linkingService.getActiveLink(tgUserId);

    if (!activeLink) {
      await ctx.reply(
        "ℹ️ Bạn chưa liên kết với tài khoản Base.vn nào.\n\n" +
          "Hãy gõ lệnh /start để bắt đầu liên kết tài khoản.",
        { parse_mode: "HTML" }
      );
      return;
    }

    const reminderStatus = activeLink.reminders_enabled
      ? "Đang bật"
      : "Đang tạm dừng";

    const formattedDate = new Date(activeLink.linked_at).toLocaleString("vi-VN", {
      timeZone: "Asia/Ho_Chi_Minh",
    });

    await ctx.reply(
      `📊 <b>Thông tin tài khoản</b>\n\n` +
        `🧑 <b>Tài khoản Base:</b>\n` +
        `• <b>Họ tên:</b> ${escapeHtml(activeLink.display_name)}\n` +
        `• <b>Username:</b> <code>${escapeHtml(activeLink.username)}</code>\n\n` +
        `🔔 <b>Nhắc việc:</b>\n` +
        `• ${reminderStatus}\n` +
        `• Thứ 2 - Thứ 6 lúc 08:00\n\n` +
        `🔗 <b>Thông tin liên kết:</b>\n` +
        `• <b>Email:</b> ${escapeHtml(maskEmail(activeLink.email))}\n` +
        `• <b>Ngày liên kết:</b> ${formattedDate}\n\n` +
        `<i>Dùng /stop để tạm dừng, /resume để bật lại, hoặc /unlink để hủy liên kết.</i>`,
      { parse_mode: "HTML" }
    );
  };
}
