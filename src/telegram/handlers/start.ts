/**
 * src/telegram/handlers/start.ts
 *
 * Handler for the /start command.
 *
 * Behavior:
 *  - If already linked: displays current status and available management commands.
 *    Does NOT overwrite or unlink existing account.
 *  - If not linked: prompts user for their Base username and sets state to AWAIT_USERNAME.
 */

import type { Context } from "grammy";
import type { LinkingService } from "../services/linking-service.js";
import { setConversationState } from "../../db/queries/conversations.js";
import { escapeHtml } from "../utils/html.js";

export function createStartHandler(linkingService: LinkingService) {
  return async (ctx: Context): Promise<void> => {
    const tgUserId = ctx.from?.id;
    if (!tgUserId) return;

    const activeLink = await linkingService.getActiveLink(tgUserId);

    if (activeLink) {
      const statusText = activeLink.reminders_enabled ? "Đang bật" : "Đang tạm dừng";
      await ctx.reply(
        `👋 Chào <b>${escapeHtml(activeLink.display_name)}</b>!\n\n` +
          `Bạn đang liên kết với tài khoản Base: <code>${escapeHtml(activeLink.username)}</code>.\n` +
          `Trạng thái nhắc nhở: <b>${statusText}</b>.\n\n` +
          `Các lệnh bạn có thể sử dụng:\n` +
          `• /status — Xem chi tiết liên kết\n` +
          `• /stop — Tạm dừng nhận thông báo nhắc nhở\n` +
          `• /resume — Bật lại nhận thông báo nhắc nhở\n` +
          `• /unlink — Hủy liên kết tài khoản này\n` +
          `• /help — Xem hướng dẫn sử dụng\n\n` +
          `<i>Nếu muốn đổi tài khoản liên kết, bạn có thể thực hiện lệnh /unlink trước.</i>`,
        { parse_mode: "HTML" }
      );
      return;
    }

    // Not linked yet: transition to AWAIT_USERNAME
    await setConversationState(tgUserId, "AWAIT_USERNAME", {});

    await ctx.reply(
      `👋 Chào mừng bạn đến với <b>Base Reminder</b>!\n\n` +
        `Hệ thống sẽ gửi thông báo nhắc nhở công việc từ <b>Wework</b>, <b>Workflow</b> và <b>Request</b> mỗi sáng lúc 08:00.\n\n` +
        `Vui lòng nhập <b>username Base.vn</b> của bạn để bắt đầu (ví dụ: <code>Digital01</code>):`,
      { parse_mode: "HTML" }
    );
  };
}
