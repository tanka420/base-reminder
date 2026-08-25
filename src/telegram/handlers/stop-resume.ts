/**
 * src/telegram/handlers/stop-resume.ts
 *
 * Handlers for /stop and /resume commands to pause or resume reminders.
 */

import type { Context } from "grammy";
import type { LinkingService } from "../services/linking-service.js";

export function createStopHandler(linkingService: LinkingService) {
  return async (ctx: Context): Promise<void> => {
    const tgUserId = ctx.from?.id;
    if (!tgUserId) return;

    const activeLink = await linkingService.getActiveLink(tgUserId);

    if (!activeLink) {
      await ctx.reply(
        "ℹ️ Bạn chưa liên kết tài khoản Base. Gõ /start để liên kết.",
        { parse_mode: "HTML" }
      );
      return;
    }

    if (!activeLink.reminders_enabled) {
      await ctx.reply(
        "⏸ Nhắc nhở của bạn hiện đã ở trạng thái tạm dừng từ trước.\n\nDùng /resume để bật lại bất kỳ lúc nào.",
        { parse_mode: "HTML" }
      );
      return;
    }

    await linkingService.toggleReminders(tgUserId, false);

    await ctx.reply(
      "⏸ <b>Đã tạm dừng nhận nhắc nhở.</b>\n\n" +
        "Bạn sẽ không nhận thông báo lúc 08:00 hàng ngày nữa.\n" +
        "Dùng /resume để kích hoạt lại bất kỳ lúc nào.",
      { parse_mode: "HTML" }
    );
  };
}

export function createResumeHandler(linkingService: LinkingService) {
  return async (ctx: Context): Promise<void> => {
    const tgUserId = ctx.from?.id;
    if (!tgUserId) return;

    const activeLink = await linkingService.getActiveLink(tgUserId);

    if (!activeLink) {
      await ctx.reply(
        "ℹ️ Bạn chưa liên kết tài khoản Base. Gõ /start để liên kết.",
        { parse_mode: "HTML" }
      );
      return;
    }

    if (activeLink.reminders_enabled) {
      await ctx.reply(
        "✅ Nhắc nhở của bạn hiện đang hoạt động bình thường (08:00 các ngày trong tuần).\n\nDùng /stop nếu muốn tạm dừng.",
        { parse_mode: "HTML" }
      );
      return;
    }

    await linkingService.toggleReminders(tgUserId, true);

    await ctx.reply(
      "▶️ <b>Đã bật lại nhận nhắc nhở!</b>\n\n" +
        "Bạn sẽ nhận thông báo tổng hợp công việc mỗi sáng vào lúc 08:00.",
      { parse_mode: "HTML" }
    );
  };
}
