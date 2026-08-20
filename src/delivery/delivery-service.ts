/**
 * src/delivery/delivery-service.ts
 *
 * Telegram Digest Delivery Orchestrator.
 *
 * Implements:
 *  - Per-chunk state transitions (pending -> sending -> delivered | error | ambiguous).
 *  - Atomic recovery of stale sending chunks.
 *  - Fresh eligibility evaluation immediately before sending.
 *  - Multi-chunk isolation (never resend delivered chunks; stop on failure).
 *  - ZERO content persistence.
 */

import type { UserDigest } from "../digest/types.js";
import type { ActiveBaseUser } from "../db/queries/users.js";
import { getActiveTelegramLinkByBaseUserId } from "../db/queries/telegram-links.js";
import {
  getDeliveryByRunAndUser,
  updateDeliveryStatus,
  markStaleSendingDeliveries,
} from "../db/queries/deliveries.js";
import {
  createDeliveryChunks,
  updateChunkStatus,
  markStaleSendingChunks,
} from "../db/queries/chunks.js";
import { formatTelegramDigest } from "../telegram/formatter.js";
import { TelegramClient, type TelegramErrorCode } from "../telegram/telegram-client.js";
import { evaluateDeliveryEligibility } from "./eligibility.js";
import { logger } from "../logging/logger.js";

export interface UserDeliveryResult {
  baseUserId: number;
  status: "delivered" | "empty" | "skipped" | "error";
  chunksTotal: number;
  chunksSent: number;
  telegramErrorCode?: TelegramErrorCode | string;
  errorMessage?: string;
  durationMs: number;
}

export interface RunDeliverySummary {
  runId: number;
  totalUsers: number;
  delivered: number;
  empty: number;
  skipped: number;
  error: number;
  durationMs: number;
}

export class DeliveryService {
  private readonly telegramClient: TelegramClient;
  private readonly interUserDelayMs: number;

  constructor(telegramClient: TelegramClient, options: { interUserDelayMs?: number } = {}) {
    this.telegramClient = telegramClient;
    this.interUserDelayMs = options.interUserDelayMs ?? 50;
  }

  /**
   * Run startup crash recovery to mark any stale 'sending' deliveries/chunks as 'ambiguous'.
   */
  public async recoverStaleSending(staleMinutes = 5): Promise<{ staleDeliveries: number; staleChunks: number }> {
    const staleDeliveries = await markStaleSendingDeliveries(staleMinutes);
    const staleChunks = await markStaleSendingChunks(staleMinutes);

    if (staleDeliveries > 0 || staleChunks > 0) {
      logger.warn({
        msg: "recovered stale sending records on startup",
        stale_deliveries: staleDeliveries,
        stale_chunks: staleChunks,
      });
    }

    return { staleDeliveries, staleChunks };
  }

  /**
   * Deliver a single user's morning digest.
   */
  public async deliverUserDigest(params: {
    runId: number;
    user: ActiveBaseUser;
    digest: UserDigest;
  }): Promise<UserDeliveryResult> {
    const startTime = Date.now();
    const { runId, user, digest } = params;

    // 1. Fetch delivery record
    const delivery = await getDeliveryByRunAndUser(runId, user.id);
    if (!delivery) {
      logger.error({ msg: "delivery record not found for user", run_id: runId, base_user_id: user.id });
      return {
        baseUserId: user.id,
        status: "error",
        chunksTotal: 0,
        chunksSent: 0,
        errorMessage: "Delivery record not found in database",
        durationMs: Date.now() - startTime,
      };
    }

    // 2. Fetch fresh Telegram link right before delivery
    const activeLink = await getActiveTelegramLinkByBaseUserId(user.id);
    const eligibility = evaluateDeliveryEligibility({
      isBaseUserActive: user.is_active,
      activeLink,
      digest,
    });

    if (!eligibility.isEligible) {
      const newStatus = eligibility.reason === "empty_digest" ? "empty" : eligibility.reason === "error_digest" ? "error" : "skipped";
      await updateDeliveryStatus(delivery.id, {
        status: newStatus,
        chunksTotal: 0,
        chunksSent: 0,
        errorMessage: eligibility.reason ? `Ineligible: ${eligibility.reason}` : null,
      });

      return {
        baseUserId: user.id,
        status: newStatus,
        chunksTotal: 0,
        chunksSent: 0,
        errorMessage: eligibility.reason,
        durationMs: Date.now() - startTime,
      };
    }

    // 3. Format message chunks
    const chunks = formatTelegramDigest(digest);

    if (chunks.length === 0) {
      await updateDeliveryStatus(delivery.id, {
        status: "empty",
        chunksTotal: 0,
        chunksSent: 0,
      });

      return {
        baseUserId: user.id,
        status: "empty",
        chunksTotal: 0,
        chunksSent: 0,
        durationMs: Date.now() - startTime,
      };
    }

    // 4. Initialize chunk tracking and transition delivery to 'sending'
    const chatId = eligibility.chatId!;
    await updateDeliveryStatus(delivery.id, {
      status: "sending",
      chunksTotal: chunks.length,
      chunksSent: 0,
      deliveryStartedAt: new Date(),
    });

    await createDeliveryChunks(delivery.id, chunks.length);

    let chunksSent = 0;
    let firstMessageId: number | undefined;

    // 5. Send chunks sequentially
    for (let i = 0; i < chunks.length; i++) {
      const chunkText = chunks[i];
      if (!chunkText) continue;

      await updateChunkStatus(delivery.id, i, {
        status: "sending",
        incrementAttempt: true,
      });

      const sendResult = await this.telegramClient.sendMessage(chatId, chunkText);

      if (sendResult.success) {
        chunksSent++;
        if (i === 0) {
          firstMessageId = sendResult.messageId;
        }

        await updateChunkStatus(delivery.id, i, {
          status: "delivered",
          telegramMessageId: sendResult.messageId ?? null,
          sentAt: new Date(),
        });

        await updateDeliveryStatus(delivery.id, {
          status: "sending",
          chunksSent,
          telegramMessageId: firstMessageId ?? null,
        });
      } else {
        // Chunk failed permanently after retry
        await updateChunkStatus(delivery.id, i, {
          status: "error",
          errorCode: sendResult.errorCode ?? "CHUNK_SEND_FAILED",
        });

        await updateDeliveryStatus(delivery.id, {
          status: "error",
          telegramErrorCode: sendResult.errorCode ?? "CHUNK_SEND_FAILED",
          errorMessage: sendResult.errorMessage ?? `Failed on chunk ${i + 1}`,
          chunksSent,
        });

        logger.error({
          msg: "telegram digest chunk send failed",
          run_id: runId,
          base_user_id: user.id,
          chunk_index: i,
          chunks_total: chunks.length,
          chunks_sent: chunksSent,
          error_code: sendResult.errorCode,
        });

        return {
          baseUserId: user.id,
          status: "error",
          chunksTotal: chunks.length,
          chunksSent,
          telegramErrorCode: sendResult.errorCode,
          errorMessage: sendResult.errorMessage,
          durationMs: Date.now() - startTime,
        };
      }
    }

    // 6. All chunks delivered successfully
    await updateDeliveryStatus(delivery.id, {
      status: "delivered",
      chunksSent,
      deliveryCompletedAt: new Date(),
      telegramMessageId: firstMessageId ?? null,
    });

    logger.info({
      msg: "telegram digest delivered successfully",
      run_id: runId,
      base_user_id: user.id,
      chunks_total: chunks.length,
      duration_ms: Date.now() - startTime,
    });

    return {
      baseUserId: user.id,
      status: "delivered",
      chunksTotal: chunks.length,
      chunksSent,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Deliver all user digests for a given run.
   */
  public async deliverRun(params: {
    runId: number;
    users: ActiveBaseUser[];
    digests: UserDigest[];
  }): Promise<RunDeliverySummary> {
    const startMs = Date.now();
    const { runId, users, digests } = params;

    // 1. Crash recovery on startup
    await this.recoverStaleSending();

    let delivered = 0;
    let empty = 0;
    let skipped = 0;
    let error = 0;

    const digestMap = new Map<number, UserDigest>();
    for (const d of digests) {
      digestMap.set(d.baseUserId, d);
    }

    // 2. Deliver sequentially with pacing
    for (let uIdx = 0; uIdx < users.length; uIdx++) {
      const user = users[uIdx];
      if (!user) continue;

      const digest = digestMap.get(user.id);

      if (!digest) {
        skipped++;
        continue;
      }

      try {
        const result = await this.deliverUserDigest({
          runId,
          user,
          digest,
        });

        if (result.status === "delivered") delivered++;
        else if (result.status === "empty") empty++;
        else if (result.status === "skipped") skipped++;
        else if (result.status === "error") error++;
      } catch (err) {
        error++;
        logger.error({
          msg: "unexpected error delivering digest to user",
          run_id: runId,
          base_user_id: user.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Gentle pacing between users
      if (this.interUserDelayMs > 0 && uIdx < users.length - 1) {
        await new Promise((res) => setTimeout(res, this.interUserDelayMs));
      }
    }

    return {
      runId,
      totalUsers: users.length,
      delivered,
      empty,
      skipped,
      error,
      durationMs: Date.now() - startMs,
    };
  }
}
