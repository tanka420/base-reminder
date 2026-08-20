/**
 * src/telegram/handlers/help.ts
 *
 * Handler for the /help command.
 */

import type { Context } from "grammy";

export function createHelpHandler() {
  return async (ctx: Context): Promise<void> => {
    await ctx.reply(
      `🤖 <b>Hướng dẫn sử dụng Base Reminder Bot</b>\n\n` +
        `Bot giúp bạn theo dõi và nhận thông báo công việc quá hạn / đến hạn từ Base.vn mỗi sáng lúc 08:15.\n\n` +
        `<b>Danh sách các lệnh:</b>\n` +
        `• /start — Bắt đầu liên kết tài khoản Base hoặc xem trạng thái\n` +
        `• /status — Xem thông tin tài khoản Base đang liên kết\n` +
        `• /stop — Tạm dừng nhận thông báo nhắc nhở hàng ngày\n` +
        `• /resume — Bật lại nhận thông báo nhắc nhở hàng ngày\n` +
        `• /unlink — Hủy liên kết tài khoản Base khỏi Telegram này\n` +
        `• /help — Xem lại hướng dẫn này\n\n` +
        `<i>Lưu ý: Mọi thao tác xác thực OTP được gửi trực tiếp đến email doanh nghiệp của bạn trên Base.vn.</i>`,
      { parse_mode: "HTML" }
    );
  };
}
