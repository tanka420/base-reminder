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
      ? "✅ Đang bật (Nhận lúc 08:15 các ngày trong tuần)"
      : "⏸ Đang tạm dừng (Dùng /resume để bật lại)";

    const formattedDate = new Date(activeLink.linked_at).toLocaleString("vi-VN", {
      timeZone: "Asia/Ho_Chi_Minh",
    });

    await ctx.reply(
      `📊 <b>Thông tin tài khoản đã liên kết</b>\n\n` +
        `• <b>Họ tên:</b> ${escapeHtml(activeLink.display_name)}\n` +
        `• <b>Username Base:</b> <code>${escapeHtml(activeLink.username)}</code>\n` +
        `• <b>Email đăng ký:</b> ${escapeHtml(maskEmail(activeLink.email))}\n` +
        `• <b>Ngày liên kết:</b> ${formattedDate}\n` +
        `• <b>Trạng thái nhắc nhở:</b> ${reminderStatus}\n\n` +
        `<i>Dùng /unlink để hủy liên kết hoặc /help để xem các lệnh khác.</i>`,
      { parse_mode: "HTML" }
    );
  };
}
