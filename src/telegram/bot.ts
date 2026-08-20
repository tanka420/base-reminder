/**
 * src/telegram/bot.ts
 *
 * Telegram Bot lifecycle and route configuration using grammY.
 *
 * Invariants:
 *  - Single polling instance assumed for M2A.
 *  - Private-chat middleware runs first before any handler.
 *  - Commands (/start, /status, /unlink, /stop, /resume, /help) are registered before text dispatcher.
 *  - Errors are caught and logged safely without leaking secrets or tokens.
 */

import { Bot } from "grammy";
import type { TelegramConfig, SmtpConfig } from "../config/index.js";
import { AccountApiClient } from "../base-api/account.js";
import { OtpService } from "./services/otp-service.js";
import { LinkingService } from "./services/linking-service.js";
import { privateChatOnlyMiddleware } from "./middleware/private-chat.js";
import { createStartHandler } from "./handlers/start.js";
import { createStatusHandler } from "./handlers/status.js";
import { createUnlinkHandler } from "./handlers/unlink.js";
import { createStopHandler, createResumeHandler } from "./handlers/stop-resume.js";
import { createHelpHandler } from "./handlers/help.js";
import { createTextMessageDispatcher } from "./handlers/text-dispatcher.js";
import { logger } from "../logging/logger.js";

export interface BotServices {
  otpService: OtpService;
  linkingService: LinkingService;
  accountApiClient?: AccountApiClient;
}

export function createTelegramBot(
  telegramConfig: TelegramConfig,
  services: BotServices,
  customBot?: Bot
): Bot {
  const bot = customBot ?? new Bot(telegramConfig.botToken);

  // 1. Error boundary
  bot.catch((err) => {
    logger.error({
      msg: "unhandled error in telegram bot update",
      update_id: err.ctx?.update?.update_id,
      error: err.error instanceof Error ? err.error.message : String(err.error),
    });
  });

  // 2. Middleware: Enforce private chats only
  bot.use(privateChatOnlyMiddleware);

  // 3. Command Handlers
  bot.command("start", createStartHandler(services.linkingService));
  bot.command("status", createStatusHandler(services.linkingService));
  bot.command("unlink", createUnlinkHandler(services.linkingService, services.otpService));
  bot.command("stop", createStopHandler(services.linkingService));
  bot.command("resume", createResumeHandler(services.linkingService));
  bot.command("help", createHelpHandler());

  // 4. State-based Text Message Dispatcher
  bot.on(
    "message:text",
    createTextMessageDispatcher({
      accountApiClient: services.accountApiClient,
      otpService: services.otpService,
      linkingService: services.linkingService,
    })
  );

  return bot;
}

/**
 * Helper to initialize and start the bot with default services.
 */
export async function initTelegramBot(params: {
  telegramConfig: TelegramConfig;
  smtpConfig: SmtpConfig;
  baseAccountToken?: string;
}): Promise<{ bot: Bot; stop: () => Promise<void> }> {
  const { telegramConfig, smtpConfig, baseAccountToken } = params;

  let accountApiClient: AccountApiClient | undefined;
  if (baseAccountToken) {
    accountApiClient = new AccountApiClient(baseAccountToken);
  }

  const otpService = new OtpService(smtpConfig);

  let bot: Bot;

  const linkingService = new LinkingService(async (chatId, message) => {
    if (bot) {
      await bot.api.sendMessage(chatId, message, { parse_mode: "HTML" });
    }
  });

  bot = createTelegramBot(telegramConfig, {
    otpService,
    linkingService,
    accountApiClient,
  });

  // Register command menu in bottom-left corner
  try {
    await bot.api.setMyCommands([
      { command: "start", description: "Liên kết tài khoản Base" },
      { command: "status", description: "Xem thông tin liên kết" },
      { command: "stop", description: "Tạm dừng nhắc việc" },
      { command: "resume", description: "Bật lại nhắc việc" },
      { command: "unlink", description: "Hủy liên kết tài khoản" },
      { command: "help", description: "Xem hướng dẫn sử dụng" },
    ]);
    logger.info({ msg: "telegram bot menu commands registered successfully" });
  } catch (menuErr) {
    logger.warn({
      msg: "failed to register telegram bot menu commands",
      error: menuErr instanceof Error ? menuErr.message : String(menuErr),
    });
  }

  // Start polling in background
  bot.start({
    onStart(botInfo) {
      logger.info({
        msg: "telegram bot started successfully (long polling)",
        bot_username: botInfo.username,
        bot_id: botInfo.id,
      });
    },
  });

  return {
    bot,
    stop: async () => {
      logger.info({ msg: "stopping telegram bot" });
      await bot.stop();
    },
  };
}
