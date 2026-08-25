/**
 * src/telegram/handlers/text-dispatcher.ts
 *
 * State-specific text message dispatcher for Telegram bot.
 *
 * Enforces:
 *  - Commands (starting with /) are skipped here (handled by GrammY command router).
 *  - AWAIT_USERNAME: Only interprets text as Base username candidate.
 *  - AWAIT_OTP: Strictly validates 6-digit regex before processing.
 *  - AWAIT_UNLINK_CONFIRM: Only accepts explicit confirmation string.
 */

import type { Context } from "grammy";
import type { AccountApiClient } from "../../base-api/account.js";
import type { OtpService } from "../services/otp-service.js";
import type { LinkingService } from "../services/linking-service.js";
import type { WelcomeDigestService } from "../services/welcome-digest-service.js";
import { getConversationState, setConversationState } from "../../db/queries/conversations.js";
import { getBaseUserByUsername } from "../../db/queries/users.js";
import { query } from "../../db/connection.js";
import { escapeHtml } from "../utils/html.js";
import { logger } from "../../logging/logger.js";

/**
 * Upsert a Base user into local base_users table from Account API response.
 */
async function upsertBaseUser(user: {
  id: number;
  username: string;
  name: string;
  email: string;
  status: string;
}): Promise<{ id: number; username: string; display_name: string; email: string; is_active: boolean }> {
  const isActive = user.status === "0";
  await query(
    `
    INSERT INTO base_users (id, username, display_name, email, is_active, synced_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
    ON CONFLICT (id)
    DO UPDATE SET
      username = EXCLUDED.username,
      display_name = EXCLUDED.display_name,
      email = EXCLUDED.email,
      is_active = EXCLUDED.is_active,
      synced_at = NOW(),
      updated_at = NOW()
    `,
    [user.id, user.username, user.name, user.email, isActive]
  );

  return {
    id: user.id,
    username: user.username,
    display_name: user.name,
    email: user.email,
    is_active: isActive,
  };
}

export function createTextMessageDispatcher(params: {
  accountApiClient?: AccountApiClient;
  otpService: OtpService;
  linkingService: LinkingService;
  welcomeDigestService?: WelcomeDigestService;
}) {
  const { accountApiClient, otpService, linkingService, welcomeDigestService } = params;

  return async (ctx: Context): Promise<void> => {
    const text = ctx.message?.text?.trim();
    const tgUserId = ctx.from?.id;
    const chatId = ctx.chat?.id;

    if (!text || !tgUserId || !chatId) return;

    // Commands starting with '/' are handled by command handlers; ignore here
    if (text.startsWith("/")) return;

    const conversation = await getConversationState(tgUserId);

    switch (conversation.state) {
      case "AWAIT_USERNAME": {
        const candidateUsername = text.replace(/^@/, "").trim();

        if (!candidateUsername) {
          await ctx.reply("Vui lòng nhập username Base hợp lệ (ví dụ: <code>Digital01</code>):", {
            parse_mode: "HTML",
          });
          return;
        }

        // 1. Search via Base Account API if client provided, otherwise check local DB
        let baseUser: {
          id: number;
          username: string;
          display_name: string;
          email: string;
          is_active: boolean;
        } | null = null;

        if (accountApiClient) {
          try {
            const apiUser = await accountApiClient.searchByUsername(candidateUsername);
            if (apiUser) {
              baseUser = await upsertBaseUser(apiUser);
            }
          } catch (err) {
            logger.warn({
              msg: "base account api lookup failed — checking local cache",
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        // Fallback to local DB if API was unreachable or not provided
        if (!baseUser) {
          const localUser = await getBaseUserByUsername(candidateUsername);
          if (localUser) {
            baseUser = localUser;
          }
        }

        if (!baseUser) {
          await ctx.reply(
            `❌ Không tìm thấy tài khoản Base với username '<code>${escapeHtml(candidateUsername)}</code>'.\n\n` +
              "Vui lòng kiểm tra lại chính xác username trên Base.vn và nhập lại:",
            { parse_mode: "HTML" }
          );
          return;
        }

        if (!baseUser.is_active) {
          await ctx.reply(
            `❌ Tài khoản <b>${escapeHtml(baseUser.display_name)}</b> (<code>${escapeHtml(baseUser.username)}</code>) đã bị vô hiệu hóa trên hệ thống Base.vn.`,
            { parse_mode: "HTML" }
          );
          return;
        }

        // Check if already linked to THIS Telegram user
        const existingLink = await linkingService.getActiveLink(tgUserId);
        if (existingLink && existingLink.base_user_id === baseUser.id) {
          await setConversationState(tgUserId, "LINKED", {});
          await ctx.reply(
            `ℹ️ Bạn đã liên kết với tài khoản <b>${escapeHtml(baseUser.display_name)}</b> (<code>${escapeHtml(baseUser.username)}</code>) từ trước.\n\nDùng /status để xem chi tiết.`,
            { parse_mode: "HTML" }
          );
          return;
        }

        // Send OTP
        await ctx.reply(
          `🔍 Đã tìm thấy tài khoản: <b>${escapeHtml(baseUser.display_name)}</b> (<code>${escapeHtml(baseUser.username)}</code>).\nĐang gửi mã OTP đến email...`,
          { parse_mode: "HTML" }
        );

        const otpRes = await otpService.requestAndSendOtp({
          telegramUserId: tgUserId,
          baseUser,
        });

        if (!otpRes.success) {
          if (otpRes.reason === "lockout") {
            await setConversationState(tgUserId, "IDLE", {});
            await ctx.reply(
              "⛔ <b>Yêu cầu bị tạm khóa!</b>\n\nBạn đã nhập sai OTP quá nhiều lần. Vui lòng thử lại sau 1 giờ.",
              { parse_mode: "HTML" }
            );
          } else if (otpRes.reason === "tg_limit") {
            await ctx.reply(
              "⏳ Bạn đã yêu cầu quá nhiều mã OTP (tối đa 5 lần/15 phút). Vui lòng đợi 15 phút rồi thử lại.",
              { parse_mode: "HTML" }
            );
          } else if (otpRes.reason === "base_limit") {
            await ctx.reply(
              "⏳ Tài khoản Base này đã nhận quá nhiều yêu cầu OTP trong thời gian ngắn. Vui lòng thử lại sau.",
              { parse_mode: "HTML" }
            );
          } else {
            await ctx.reply(
              "❌ Không thể gửi email chứa mã OTP lúc này. Vui lòng kiểm tra lại email công ty hoặc thử lại sau ít phút.",
              { parse_mode: "HTML" }
            );
          }
          return;
        }

        await ctx.reply(
          `📧 Mã OTP gồm 6 chữ số đã được gửi đến email đăng ký trên Base:\n` +
            `👉 <b>${escapeHtml(otpRes.maskedEmail)}</b>\n\n` +
            `Vui lòng nhập mã OTP để hoàn tất liên kết (mã có hiệu lực trong ${otpRes.ttlMinutes} phút):`,
          { parse_mode: "HTML" }
        );
        return;
      }

      case "AWAIT_OTP": {
        const trimmed = text.trim();

        // Strict 6 numeric digits validation
        if (!/^\d{6}$/.test(trimmed)) {
          await ctx.reply(
            "⚠️ Mã OTP không hợp lệ. Vui lòng nhập đúng <b>6 chữ số</b> (hoặc gõ /start để yêu cầu mã mới):",
            { parse_mode: "HTML" }
          );
          return;
        }

        const pendingBaseUserId = Number(conversation.context_data["pending_base_user_id"]);
        const pendingUsername = String(conversation.context_data["pending_username"] ?? "");
        const pendingDisplayName = String(conversation.context_data["pending_display_name"] ?? "");

        if (!pendingBaseUserId) {
          await setConversationState(tgUserId, "IDLE", {});
          await ctx.reply("❌ Phiên xác thực không hợp lệ. Vui lòng gõ /start để bắt đầu lại.", {
            parse_mode: "HTML",
          });
          return;
        }

        const verifyRes = await otpService.verifyOtpInput({
          telegramUserId: tgUserId,
          baseUserId: pendingBaseUserId,
          rawInput: trimmed,
        });

        if (!verifyRes.success || !verifyRes.challengeId) {
          if (verifyRes.error === "expired" || verifyRes.error === "no_active_challenge") {
            await setConversationState(tgUserId, "IDLE", {});
            await ctx.reply(
              "❌ Mã OTP đã hết hạn (quá 10 phút) hoặc không còn hiệu lực. Vui lòng gõ /start để nhận mã mới.",
              { parse_mode: "HTML" }
            );
          } else if (verifyRes.isExhausted) {
            await setConversationState(tgUserId, "IDLE", {});
            await ctx.reply(
              "⛔ Bạn đã nhập sai OTP quá 5 lần. Mã đã bị hủy. Vui lòng gõ /start để yêu cầu mã mới.",
              { parse_mode: "HTML" }
            );
          } else {
            const remaining = verifyRes.attemptsRemaining ?? 0;
            await ctx.reply(
              `❌ Mã OTP không chính xác. Bạn còn <b>${remaining}</b> lần thử. Vui lòng nhập lại:`,
              { parse_mode: "HTML" }
            );
          }
          return;
        }

        // Finalize linking transaction
        const linkRes = await linkingService.finalizeLink({
          otpChallengeId: verifyRes.challengeId,
          telegramUserId: tgUserId,
          telegramChatId: chatId,
          baseUserId: pendingBaseUserId,
          baseUsername: pendingUsername,
        });

        if (!linkRes.success) {
          await setConversationState(tgUserId, "IDLE", {});
          await ctx.reply(
            "❌ Đã xảy ra lỗi khi lưu liên kết tài khoản. Vui lòng gõ /start để thử lại.",
            { parse_mode: "HTML" }
          );
          return;
        }

        await ctx.reply(
          `✅ <b>Liên kết tài khoản thành công!</b>\n\n` +
            `• <b>Họ tên:</b> ${escapeHtml(pendingDisplayName)}\n` +
            `• <b>Username:</b> <code>${escapeHtml(pendingUsername)}</code>\n\n` +
            `Từ bây giờ bạn sẽ nhận được thông báo nhắc nhở công việc mỗi sáng vào lúc 08:00.\n` +
            `Dùng /status để xem thông tin hoặc /help để xem hướng dẫn.`,
          { parse_mode: "HTML" }
        );

        // Attempt onboarding welcome digest preview (best-effort, failure never breaks linking)
        if (welcomeDigestService) {
          try {
            await welcomeDigestService.sendWelcomeDigest({
              telegramUserId: tgUserId,
              telegramChatId: chatId,
              baseUserId: pendingBaseUserId,
              baseUsername: pendingUsername,
              baseDisplayName: pendingDisplayName,
            });
          } catch (welcomeErr) {
            logger.warn({
              msg: "welcome digest preview failed after linking",
              error: welcomeErr instanceof Error ? welcomeErr.message : String(welcomeErr),
              telegram_user_id: String(tgUserId),
              base_user_id: pendingBaseUserId,
            });
          }
        }

        return;
      }

      case "AWAIT_UNLINK_CONFIRM": {
        const trimmed = text.trim();

        // Strict 6 numeric digits validation
        if (!/^\d{6}$/.test(trimmed)) {
          await ctx.reply(
            "⚠️ Mã OTP không hợp lệ. Vui lòng nhập đúng <b>6 chữ số</b> để xác nhận hủy liên kết (hoặc gõ /status để hủy bỏ yêu cầu):",
            { parse_mode: "HTML" }
          );
          return;
        }

        const pendingBaseUserId = Number(conversation.context_data["pending_unlink_base_user_id"]);

        if (!pendingBaseUserId) {
          await setConversationState(tgUserId, "LINKED", {});
          await ctx.reply("❌ Phiên xác thực không hợp lệ. Yêu cầu hủy liên kết đã bị hủy bỏ.", {
            parse_mode: "HTML",
          });
          return;
        }

        const verifyRes = await otpService.verifyOtpInput({
          telegramUserId: tgUserId,
          baseUserId: pendingBaseUserId,
          rawInput: trimmed,
        });

        if (!verifyRes.success) {
          if (verifyRes.error === "expired" || verifyRes.error === "no_active_challenge") {
            await setConversationState(tgUserId, "LINKED", {});
            await ctx.reply(
              "❌ Mã OTP đã hết hạn (quá 10 phút) hoặc không còn hiệu lực. Yêu cầu hủy liên kết đã bị hủy bỏ. Tài khoản Base của bạn vẫn được giữ nguyên.",
              { parse_mode: "HTML" }
            );
          } else if (verifyRes.isExhausted) {
            await setConversationState(tgUserId, "LINKED", {});
            await ctx.reply(
              "⛔ Bạn đã nhập sai OTP quá 5 lần. Yêu cầu hủy liên kết đã bị hủy bỏ để bảo vệ tài khoản.",
              { parse_mode: "HTML" }
            );
          } else {
            const remaining = verifyRes.attemptsRemaining ?? 0;
            await ctx.reply(
              `❌ Mã OTP không chính xác. Bạn còn <b>${remaining}</b> lần thử. Vui lòng nhập lại mã OTP:`,
              { parse_mode: "HTML" }
            );
          }
          return;
        }

        // OTP verified successfully -> perform unlinking
        await linkingService.unlink(tgUserId);
        await ctx.reply(
          "✅ <b>Đã hủy liên kết tài khoản thành công!</b>\n\nBạn sẽ không còn nhận được các thông báo nhắc việc buổi sáng.\nBạn có thể dùng lệnh /start để liên kết lại bất cứ lúc nào.",
          { parse_mode: "HTML" }
        );
        return;
      }

      default: {
        const active = await linkingService.getActiveLink(tgUserId);
        if (active) {
          await ctx.reply(
            `Bạn đang liên kết với tài khoản Base <b>${escapeHtml(active.display_name)}</b>.\n\nGõ /help để xem danh sách lệnh hỗ trợ.`,
            { parse_mode: "HTML" }
          );
        } else {
          await ctx.reply(
            "Vui lòng dùng lệnh /start để bắt đầu liên kết tài khoản Base.vn của bạn.",
            { parse_mode: "HTML" }
          );
        }
        break;
      }
    }
  };
}
