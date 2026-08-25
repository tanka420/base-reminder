/**
 * src/telegram/services/welcome-digest-service.ts
 *
 * One-time Onboarding Welcome Digest Preview Service (M3.1).
 *
 * Responsibilities:
 *  - Triggered immediately after successful Base ↔ Telegram account linking.
 *  - Collects current live actionable tasks across Wework, Workflow, and Request.
 *  - Reuses channel-agnostic digest builder and compact Telegram HTML formatter.
 *  - Delivers onboarding preview with welcome header, current tasks / zero-state, and schedule.
 *  - Strictly error-isolated: failures log warnings and never break or rollback account linking.
 *  - Never creates reminder_runs, reminder_deliveries, or affects scheduler idempotency.
 */

import { WeworkApiClient } from "../../base-api/wework.js";
import { WorkflowApiClient } from "../../base-api/workflow.js";
import { RequestApiClient } from "../../base-api/request.js";
import { collectWeworkTasks, formatTzDate } from "../../collectors/wework.js";
import { collectWorkflowJobs } from "../../collectors/workflow.js";
import { collectActionableRequests } from "../../collectors/request.js";
import { buildUserDigest } from "../../digest/builder.js";
import { formatWelcomeDigest } from "../formatter.js";
import type {
  ModuleResult,
  ActionableTask,
  ActionableJob,
  ActionableRequest,
  UserDigest,
} from "../../digest/types.js";
import type { TelegramClient } from "../telegram-client.js";
import { logger } from "../../logging/logger.js";

export type TelegramSender =
  | ((chatId: string | number | bigint, message: string) => Promise<void>)
  | TelegramClient
  | { sendMessage: (chatId: string | number | bigint, text: string, options?: any) => Promise<any> };

export interface WelcomeDigestServiceOptions {
  weworkClient?: WeworkApiClient;
  workflowClient?: WorkflowApiClient;
  requestClient?: RequestApiClient;
  telegramSender?: TelegramSender;
  timezone?: string;
}

export interface SendWelcomeDigestParams {
  telegramUserId: number | string | bigint;
  telegramChatId: number | string | bigint;
  baseUserId: number;
  baseUsername: string;
  baseDisplayName: string;
  now?: Date;
}

export interface WelcomeDigestResult {
  success: boolean;
  chunksCount?: number;
  error?: string;
}

export class WelcomeDigestService {
  readonly #weworkClient?: WeworkApiClient;
  readonly #workflowClient?: WorkflowApiClient;
  readonly #requestClient?: RequestApiClient;
  readonly #telegramSender?: TelegramSender;
  readonly #timezone: string;

  constructor(options: WelcomeDigestServiceOptions = {}) {
    this.#weworkClient = options.weworkClient;
    this.#workflowClient = options.workflowClient;
    this.#requestClient = options.requestClient;
    this.#telegramSender = options.telegramSender;
    this.#timezone = options.timezone ?? "Asia/Ho_Chi_Minh";
  }

  /**
   * Helper to dispatch a single chunk via the configured Telegram sender.
   */
  async #sendChunk(chatId: string | number | bigint, text: string): Promise<void> {
    if (!this.#telegramSender) {
      throw new Error("No Telegram sender configured for WelcomeDigestService");
    }

    if (typeof this.#telegramSender === "function") {
      await this.#telegramSender(chatId, text);
      return;
    }

    if ("sendMessage" in this.#telegramSender && typeof this.#telegramSender.sendMessage === "function") {
      const res = await this.#telegramSender.sendMessage(chatId, text);
      if (res && typeof res === "object" && "success" in res && !res.success) {
        throw new Error(`Telegram client delivery failed: ${(res as any).errorCode ?? "UNKNOWN"}`);
      }
      return;
    }

    throw new Error("Unsupported Telegram sender interface");
  }

  /**
   * Collect actionable items, format, and send the onboarding welcome preview message.
   *
   * Invariant: Never throws unhandled errors to the caller so account linking is never broken.
   */
  async sendWelcomeDigest(params: SendWelcomeDigestParams): Promise<WelcomeDigestResult> {
    const { telegramUserId, telegramChatId, baseUserId, baseUsername, baseDisplayName } = params;
    const now = params.now ?? new Date();
    const runDate = formatTzDate(now, this.#timezone);

    try {
      logger.info({
        msg: "generating onboarding welcome digest preview",
        telegram_user_id: String(telegramUserId),
        base_user_id: baseUserId,
        username: baseUsername,
      });

      // 1. Collect Wework tasks (error-isolated)
      let weworkResult: ModuleResult<ActionableTask>;
      if (this.#weworkClient) {
        try {
          const tasks = await collectWeworkTasks(this.#weworkClient, baseUsername, this.#timezone, now);
          weworkResult = { status: "ok", items: tasks };
        } catch (err) {
          logger.warn({
            msg: "welcome digest: wework collector failed, continuing with partial digest",
            username: baseUsername,
            error: err instanceof Error ? err.message : String(err),
          });
          weworkResult = {
            status: "error",
            items: [],
            error: err instanceof Error ? err.message : String(err),
          };
        }
      } else {
        weworkResult = { status: "ok", items: [] };
      }

      // 2. Collect Workflow jobs (error-isolated)
      let workflowResult: ModuleResult<ActionableJob>;
      if (this.#workflowClient) {
        try {
          const jobs = await collectWorkflowJobs(this.#workflowClient, baseUsername, this.#timezone, now);
          workflowResult = { status: "ok", items: jobs };
        } catch (err) {
          logger.warn({
            msg: "welcome digest: workflow collector failed, continuing with partial digest",
            username: baseUsername,
            error: err instanceof Error ? err.message : String(err),
          });
          workflowResult = {
            status: "error",
            items: [],
            error: err instanceof Error ? err.message : String(err),
          };
        }
      } else {
        workflowResult = { status: "ok", items: [] };
      }

      // 3. Collect Request approvals (error-isolated)
      let requestResult: ModuleResult<ActionableRequest>;
      if (this.#requestClient) {
        try {
          const requests = await collectActionableRequests(this.#requestClient, baseUsername, this.#timezone, now);
          requestResult = { status: "ok", items: requests };
        } catch (err) {
          logger.warn({
            msg: "welcome digest: request collector failed, continuing with partial digest",
            username: baseUsername,
            error: err instanceof Error ? err.message : String(err),
          });
          requestResult = {
            status: "error",
            items: [],
            error: err instanceof Error ? err.message : String(err),
          };
        }
      } else {
        requestResult = { status: "ok", items: [] };
      }

      // 4. Assemble UserDigest
      const digest: UserDigest = buildUserDigest({
        baseUserId,
        username: baseUsername,
        displayName: baseDisplayName,
        runDate,
        wework: weworkResult,
        workflow: workflowResult,
        request: requestResult,
      });

      // 5. Format onboarding digest chunks
      const chunks = formatWelcomeDigest(digest, { timezone: this.#timezone });

      if (chunks.length === 0) {
        logger.warn({
          msg: "welcome digest produced 0 chunks",
          username: baseUsername,
        });
        return { success: true, chunksCount: 0 };
      }

      // 6. Deliver chunks via Telegram
      for (const chunk of chunks) {
        await this.#sendChunk(telegramChatId, chunk);
      }

      logger.info({
        msg: "onboarding welcome digest delivered successfully",
        telegram_user_id: String(telegramUserId),
        base_user_id: baseUserId,
        username: baseUsername,
        chunks_count: chunks.length,
      });

      return {
        success: true,
        chunksCount: chunks.length,
      };
    } catch (err) {
      logger.warn({
        msg: "failed to deliver onboarding welcome digest (account remains linked)",
        telegram_user_id: String(telegramUserId),
        base_user_id: baseUserId,
        username: baseUsername,
        error: err instanceof Error ? err.message : String(err),
      });

      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
