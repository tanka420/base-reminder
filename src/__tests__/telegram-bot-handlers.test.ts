/**
 * src/__tests__/telegram-bot-handlers.test.ts
 *
 * Unit tests for Telegram Bot handlers, private chat middleware, command routing,
 * input validation, and conversation state transitions.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { privateChatOnlyMiddleware } from "../telegram/middleware/private-chat.js";
import { createStartHandler } from "../telegram/handlers/start.js";
import { createStatusHandler } from "../telegram/handlers/status.js";
import { createUnlinkHandler } from "../telegram/handlers/unlink.js";
import { createTextMessageDispatcher } from "../telegram/handlers/text-dispatcher.js";
import type { LinkingService } from "../telegram/services/linking-service.js";
import type { OtpService } from "../telegram/services/otp-service.js";
import * as convQueries from "../db/queries/conversations.js";
import * as userQueries from "../db/queries/users.js";

describe("Telegram Bot Handlers & Middlewares", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("Private-chat middleware", () => {
    it("drops updates from group chats with warning message and halts pipeline", async () => {
      const next = vi.fn();
      const reply = vi.fn().mockResolvedValue(undefined);
      const ctx: any = {
        chat: { id: -100123456, type: "group" },
        message: { text: "/start" },
        reply,
      };

      await privateChatOnlyMiddleware(ctx, next);

      expect(next).not.toHaveBeenCalled();
      expect(reply).toHaveBeenCalledWith(
        expect.stringContaining("chỉ hoạt động trong tin nhắn riêng tư"),
        expect.objectContaining({ parse_mode: "HTML" })
      );
    });

    it("allows private chat updates to pass through to next middleware/handler", async () => {
      const next = vi.fn();
      const ctx: any = {
        chat: { id: 12345, type: "private" },
        message: { text: "/start" },
      };

      await privateChatOnlyMiddleware(ctx, next);

      expect(next).toHaveBeenCalledTimes(1);
    });
  });

  describe("/start handler", () => {
    it("when not linked: transitions state to AWAIT_USERNAME and prompts for username", async () => {
      const setConvSpy = vi.spyOn(convQueries, "setConversationState").mockResolvedValue(undefined);
      const reply = vi.fn().mockResolvedValue(undefined);

      const mockLinkingService = {
        getActiveLink: vi.fn().mockResolvedValue(null),
      } as unknown as LinkingService;

      const handler = createStartHandler(mockLinkingService);
      const ctx: any = {
        from: { id: 12345 },
        reply,
      };

      await handler(ctx);

      expect(setConvSpy).toHaveBeenCalledWith(12345, "AWAIT_USERNAME", {});
      expect(reply).toHaveBeenCalledWith(
        expect.stringContaining("Vui lòng nhập <b>username Base.vn</b>"),
        expect.objectContaining({ parse_mode: "HTML" })
      );
    });

    it("when already linked: shows current status without unlinking or overwriting", async () => {
      const setConvSpy = vi.spyOn(convQueries, "setConversationState").mockResolvedValue(undefined);
      const reply = vi.fn().mockResolvedValue(undefined);

      const mockLinkingService = {
        getActiveLink: vi.fn().mockResolvedValue({
          id: 1,
          base_user_id: 101,
          telegram_user_id: "12345",
          telegram_chat_id: "12345",
          reminders_enabled: true,
          username: "Digital01",
          display_name: "Mai Thanh Tân",
          email: "tan@company.com",
          linked_at: new Date(),
        }),
      } as unknown as LinkingService;

      const handler = createStartHandler(mockLinkingService);
      const ctx: any = {
        from: { id: 12345 },
        reply,
      };

      await handler(ctx);

      expect(setConvSpy).not.toHaveBeenCalled();
      expect(reply).toHaveBeenCalledWith(
        expect.stringContaining("Bạn đang liên kết với tài khoản Base: <code>Digital01</code>"),
        expect.objectContaining({ parse_mode: "HTML" })
      );
    });
  });

  describe("Text Message Dispatcher", () => {
    it("ignores messages starting with / (commands handled by command router)", async () => {
      const getConvSpy = vi.spyOn(convQueries, "getConversationState");

      const dispatcher = createTextMessageDispatcher({
        otpService: {} as OtpService,
        linkingService: {} as LinkingService,
      });

      const ctx: any = {
        from: { id: 12345 },
        chat: { id: 12345 },
        message: { text: "/help" },
        reply: vi.fn(),
      };

      await dispatcher(ctx);

      expect(getConvSpy).not.toHaveBeenCalled();
      expect(ctx.reply).not.toHaveBeenCalled();
    });

    it("in AWAIT_OTP state: strictly rejects non-6-digit input immediately without DB check", async () => {
      vi.spyOn(convQueries, "getConversationState").mockResolvedValue({
        telegram_user_id: "12345",
        state: "AWAIT_OTP",
        context_data: { pending_base_user_id: 101 },
        updated_at: new Date(),
      });

      const mockOtpService = {
        verifyOtpInput: vi.fn(),
      } as unknown as OtpService;

      const dispatcher = createTextMessageDispatcher({
        otpService: mockOtpService,
        linkingService: {} as LinkingService,
      });

      const reply = vi.fn().mockResolvedValue(undefined);
      const ctx: any = {
        from: { id: 12345 },
        chat: { id: 12345 },
        message: { text: "12345" }, // only 5 digits
        reply,
      };

      await dispatcher(ctx);

      expect(mockOtpService.verifyOtpInput).not.toHaveBeenCalled();
      expect(reply).toHaveBeenCalledWith(
        expect.stringContaining("Vui lòng nhập đúng <b>6 chữ số</b>"),
        expect.objectContaining({ parse_mode: "HTML" })
      );
    });

    it("in AWAIT_OTP state: accepts exact 6 numeric digits and finalizes link upon success", async () => {
      vi.spyOn(convQueries, "getConversationState").mockResolvedValue({
        telegram_user_id: "12345",
        state: "AWAIT_OTP",
        context_data: {
          pending_base_user_id: 101,
          pending_username: "Digital01",
          pending_display_name: "Mai Thanh Tân",
        },
        updated_at: new Date(),
      });

      const mockOtpService = {
        verifyOtpInput: vi.fn().mockResolvedValue({
          success: true,
          challengeId: 88,
          baseUserId: 101,
        }),
      } as unknown as OtpService;

      const mockLinkingService = {
        finalizeLink: vi.fn().mockResolvedValue({ success: true, isRelink: false }),
      } as unknown as LinkingService;

      const dispatcher = createTextMessageDispatcher({
        otpService: mockOtpService,
        linkingService: mockLinkingService,
      });

      const reply = vi.fn().mockResolvedValue(undefined);
      const ctx: any = {
        from: { id: 12345 },
        chat: { id: 12345 },
        message: { text: "998877" },
        reply,
      };

      await dispatcher(ctx);

      expect(mockOtpService.verifyOtpInput).toHaveBeenCalledWith({
        telegramUserId: 12345,
        baseUserId: 101,
        rawInput: "998877",
      });

      expect(mockLinkingService.finalizeLink).toHaveBeenCalledWith({
        otpChallengeId: 88,
        telegramUserId: 12345,
        telegramChatId: 12345,
        baseUserId: 101,
        baseUsername: "Digital01",
      });

      expect(reply).toHaveBeenCalledWith(
        expect.stringContaining("Liên kết tài khoản thành công"),
        expect.objectContaining({ parse_mode: "HTML" })
      );
    });

    describe("/unlink command handler", () => {
      it("when linked: sends OTP to linked Base email and sets state to AWAIT_UNLINK_CONFIRM", async () => {
        const setConvSpy = vi.spyOn(convQueries, "setConversationState").mockResolvedValue(undefined);
        const reply = vi.fn().mockResolvedValue(undefined);

        const mockLinkingService = {
          getActiveLink: vi.fn().mockResolvedValue({
            id: 1,
            base_user_id: 101,
            telegram_user_id: "12345",
            telegram_chat_id: "12345",
            reminders_enabled: true,
            username: "Digital01",
            display_name: "Mai Thanh Tân",
            email: "tan@company.com",
            is_active: true,
            linked_at: new Date(),
          }),
        } as unknown as LinkingService;

        const mockOtpService = {
          requestAndSendOtp: vi.fn().mockResolvedValue({
            success: true,
            maskedEmail: "t***n@company.com",
            ttlMinutes: 10,
          }),
        } as unknown as OtpService;

        const handler = createUnlinkHandler(mockLinkingService, mockOtpService);
        const ctx: any = {
          from: { id: 12345 },
          reply,
        };

        await handler(ctx);

        expect(mockOtpService.requestAndSendOtp).toHaveBeenCalledWith({
          telegramUserId: 12345,
          baseUser: expect.objectContaining({
            id: 101,
            username: "Digital01",
            email: "tan@company.com",
          }),
        });

        expect(setConvSpy).toHaveBeenCalledWith(12345, "AWAIT_UNLINK_CONFIRM", {
          pending_unlink_base_user_id: 101,
          pending_unlink_username: "Digital01",
          pending_unlink_display_name: "Mai Thanh Tân",
        });

        expect(reply).toHaveBeenCalledWith(
          expect.stringContaining("Mã OTP gồm 6 chữ số đã được gửi đến email"),
          expect.objectContaining({ parse_mode: "HTML" })
        );
      });
    });

    it("in AWAIT_UNLINK_CONFIRM state: verifies OTP and unlinks account upon success", async () => {
      vi.spyOn(convQueries, "getConversationState").mockResolvedValue({
        telegram_user_id: "12345",
        state: "AWAIT_UNLINK_CONFIRM",
        context_data: { pending_unlink_base_user_id: 101 },
        updated_at: new Date(),
      });

      const mockOtpService = {
        verifyOtpInput: vi.fn().mockResolvedValue({
          success: true,
          challengeId: 99,
          baseUserId: 101,
        }),
      } as unknown as OtpService;

      const mockLinkingService = {
        unlink: vi.fn().mockResolvedValue(true),
      } as unknown as LinkingService;

      const dispatcher = createTextMessageDispatcher({
        otpService: mockOtpService,
        linkingService: mockLinkingService,
      });

      // 1. Invalid OTP format (non-6-digits)
      const reply1 = vi.fn().mockResolvedValue(undefined);
      await dispatcher({
        from: { id: 12345 },
        chat: { id: 12345 },
        message: { text: "abc" },
        reply: reply1,
      } as any);

      expect(reply1).toHaveBeenCalledWith(
        expect.stringContaining("Vui lòng nhập đúng <b>6 chữ số</b>"),
        expect.objectContaining({ parse_mode: "HTML" })
      );
      expect(mockLinkingService.unlink).not.toHaveBeenCalled();

      // 2. Valid 6-digit OTP
      const reply2 = vi.fn().mockResolvedValue(undefined);
      await dispatcher({
        from: { id: 12345 },
        chat: { id: 12345 },
        message: { text: "654321" },
        reply: reply2,
      } as any);

      expect(mockOtpService.verifyOtpInput).toHaveBeenCalledWith({
        telegramUserId: 12345,
        baseUserId: 101,
        rawInput: "654321",
      });
      expect(mockLinkingService.unlink).toHaveBeenCalledWith(12345);
      expect(reply2).toHaveBeenCalledWith(
        expect.stringContaining("Đã hủy liên kết tài khoản thành công"),
        expect.objectContaining({ parse_mode: "HTML" })
      );
    });
  });
});
