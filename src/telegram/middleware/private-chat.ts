/**
 * src/telegram/middleware/private-chat.ts
 *
 * Middleware enforcing private-chat-only operation.
 *
 * Security rules:
 *  - Drops all updates originating from groups, supergroups, or channels.
 *  - Sends a direct redirect message to prevent OTP or identity leakage in shared chats.
 *  - Runs BEFORE any command or state dispatcher.
 */

import type { Context, NextFunction } from "grammy";
import { logger } from "../../logging/logger.js";

export async function privateChatOnlyMiddleware(
  ctx: Context,
  next: NextFunction
): Promise<void> {
  const chatType = ctx.chat?.type;

  // If chat is undefined or private, allow through
  if (!chatType || chatType === "private") {
    return next();
  }

  logger.warn({
    msg: "received message from non-private chat — dropping update",
    chat_type: chatType,
    chat_id: ctx.chat?.id,
  });

  // Only reply if there is an explicit message to avoid spamming on channel posts
  if (ctx.message) {
    try {
      await ctx.reply(
        "⚠️ <b>Base Reminder</b> chỉ hoạt động trong tin nhắn riêng tư để bảo vệ an toàn thông tin.\n\n" +
          "Vui lòng nhắn tin trực tiếp với bot để sử dụng các tính năng.",
        { parse_mode: "HTML" }
      );
    } catch {
      // Ignore reply errors in groups where bot might not have send permissions
    }
  }
}
