/**
 * src/telegram/telegram-client.ts
 *
 * Dedicated Telegram delivery client with bounded retries and normalized error classification.
 * Independent of BaseApiClient.
 *
 * Retry policy:
 *  - Network errors / timeouts -> Retry (exponential backoff + jitter)
 *  - 5xx Server errors -> Retry
 *  - 429 Rate limited -> Retry (honor retry_after parameter)
 *  - 403 Bot blocked / forbidden -> NO retry (permanent)
 *  - 400 Chat not found -> NO retry (permanent)
 *  - Other 4xx -> NO retry
 */

import { Api, GrammyError, HttpError } from "grammy";
import { logger } from "../logging/logger.js";

export type TelegramErrorCode =
  | "TELEGRAM_BLOCKED"
  | "CHAT_NOT_FOUND"
  | "RATE_LIMITED"
  | "TELEGRAM_5XX"
  | "NETWORK_ERROR"
  | "PERMANENT_4XX"
  | "UNKNOWN_ERROR";

export interface TelegramSendResult {
  success: boolean;
  messageId?: number;
  errorCode?: TelegramErrorCode;
  errorMessage?: string;
  attempts: number;
}

export interface TelegramClientOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
}

export class TelegramClient {
  private readonly api: Api;
  private readonly maxAttempts: number;
  private readonly initialDelayMs: number;
  private readonly maxDelayMs: number;

  constructor(api: Api, options: TelegramClientOptions = {}) {
    this.api = api;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.initialDelayMs = options.initialDelayMs ?? 1000;
    this.maxDelayMs = options.maxDelayMs ?? 8000;
  }

  /**
   * Classify error to determine if it is transient or permanent.
   */
  public classifyError(err: unknown): { code: TelegramErrorCode; isTransient: boolean; retryAfterSeconds?: number } {
    if (err instanceof GrammyError) {
      const status = err.error_code;
      const desc = (err.description || "").toLowerCase();

      if (status === 403 || desc.includes("bot was blocked") || desc.includes("user is deactivated") || desc.includes("forbidden")) {
        return { code: "TELEGRAM_BLOCKED", isTransient: false };
      }

      if (status === 400 && (desc.includes("chat not found") || desc.includes("chat_id is empty"))) {
        return { code: "CHAT_NOT_FOUND", isTransient: false };
      }

      if (status === 429) {
        const retryAfter = err.parameters?.retry_after ?? 1;
        return { code: "RATE_LIMITED", isTransient: true, retryAfterSeconds: retryAfter };
      }

      if (status >= 500 && status < 600) {
        return { code: "TELEGRAM_5XX", isTransient: true };
      }

      if (status >= 400 && status < 500) {
        return { code: "PERMANENT_4XX", isTransient: false };
      }
    }

    if (err instanceof HttpError) {
      return { code: "NETWORK_ERROR", isTransient: true };
    }

    const errStr = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
    if (
      errStr.includes("econnreset") ||
      errStr.includes("etimedout") ||
      errStr.includes("econnrefused") ||
      errStr.includes("fetch failed") ||
      errStr.includes("timeout") ||
      errStr.includes("socket hang up")
    ) {
      return { code: "NETWORK_ERROR", isTransient: true };
    }

    return { code: "UNKNOWN_ERROR", isTransient: false };
  }

  /**
   * Send a single HTML message with bounded retry.
   */
  public async sendMessage(
    chatId: number | string | bigint,
    htmlText: string
  ): Promise<TelegramSendResult> {
    const targetChatId = typeof chatId === "bigint" ? String(chatId) : chatId;
    let attempt = 0;

    while (attempt < this.maxAttempts) {
      attempt++;
      try {
        const res = await this.api.sendMessage(targetChatId, htmlText, {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        });

        return {
          success: true,
          messageId: res.message_id,
          attempts: attempt,
        };
      } catch (err) {
        const classification = this.classifyError(err);

        logger.warn({
          msg: "telegram message send attempt failed",
          chat_id: String(targetChatId),
          attempt,
          max_attempts: this.maxAttempts,
          error_code: classification.code,
          is_transient: classification.isTransient,
        });

        // If permanent or max attempts reached, return failure immediately
        if (!classification.isTransient || attempt >= this.maxAttempts) {
          return {
            success: false,
            errorCode: classification.code,
            errorMessage: err instanceof Error ? err.message : String(err),
            attempts: attempt,
          };
        }

        // Calculate backoff delay
        let delayMs = Math.min(
          this.initialDelayMs * Math.pow(2, attempt - 1),
          this.maxDelayMs
        );

        if (classification.retryAfterSeconds) {
          delayMs = classification.retryAfterSeconds * 1000;
        } else {
          // Apply ±20% jitter
          const jitter = delayMs * 0.2 * (Math.random() * 2 - 1);
          delayMs = Math.max(100, Math.round(delayMs + jitter));
        }

        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    return {
      success: false,
      errorCode: "UNKNOWN_ERROR",
      errorMessage: "Max retry attempts exhausted",
      attempts: attempt,
    };
  }
}
