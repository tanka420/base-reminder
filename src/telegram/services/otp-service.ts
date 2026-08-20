/**
 * src/telegram/services/otp-service.ts
 *
 * OTP lifecycle service orchestrating generation, hashing, atomic rate-limiting,
 * SMTP delivery with failure-safe invalidation, and verification.
 *
 * Security rules:
 *  - Plaintext OTP is generated via crypto.randomInt and held only in ephemeral memory.
 *  - Stored in DB exclusively as bcrypt hash (cost 10).
 *  - If SMTP delivery fails, the newly inserted OTP challenge is immediately invalidated
 *    and conversation state is NOT updated.
 *  - Verification uses bcrypt.compare and increments attempt counter under DB lock.
 */

import crypto from "crypto";
import bcrypt from "bcryptjs";
import type { SmtpConfig } from "../../config/index.js";
import { SmtpEmailClient, maskEmail } from "../../email/smtp-client.js";
import {
  createOtpChallengeAtomic,
  getActiveOtpChallenge,
  invalidateOtpChallenge,
  recordFailedOtpAttempt,
  type RateLimitRejectionReason,
} from "../../db/queries/otp.js";
import { setConversationState } from "../../db/queries/conversations.js";
import { writeAuditLog } from "../../db/queries/audit.js";
import { logger } from "../../logging/logger.js";

export interface GenerateOtpResult {
  success: boolean;
  reason?: RateLimitRejectionReason | "smtp_error" | "user_inactive";
  maskedEmail?: string;
  ttlMinutes?: number;
}

export interface VerifyOtpResult {
  success: boolean;
  error?: "invalid_format" | "no_active_challenge" | "wrong_code" | "expired";
  attemptsRemaining?: number;
  isExhausted?: boolean;
  challengeId?: number;
  baseUserId?: number;
}

export class OtpService {
  readonly #smtpClient: SmtpEmailClient;
  readonly #config: SmtpConfig;

  constructor(config: SmtpConfig, smtpClient?: SmtpEmailClient) {
    this.#config = config;
    this.#smtpClient = smtpClient ?? new SmtpEmailClient(config);
  }

  /**
   * Execute the failure-safe OTP generation and delivery sequence.
   */
  async requestAndSendOtp(params: {
    telegramUserId: number | string | bigint;
    baseUser: {
      id: number;
      username: string;
      display_name: string;
      email: string;
      is_active: boolean;
    };
  }): Promise<GenerateOtpResult> {
    const { telegramUserId, baseUser } = params;

    // 1. Verify user active status
    if (!baseUser.is_active) {
      return { success: false, reason: "user_inactive" };
    }

    // 2. Generate 6-digit cryptographically random numeric code
    const otpCode = crypto.randomInt(100_000, 1_000_000).toString();

    // 3. Hash with bcrypt (cost 10)
    const salt = await bcrypt.genSalt(10);
    const otpHash = await bcrypt.hash(otpCode, salt);

    // 4. Atomically check rate limits and persist challenge with advisory lock
    const challengeRes = await createOtpChallengeAtomic({
      telegramUserId,
      baseUserId: baseUser.id,
      otpHash,
      ttlMinutes: this.#config.otpTtlMinutes,
      maxAttempts: this.#config.otpMaxAttempts,
      rateLimitWindowMinutes: this.#config.otpRateLimitWindowMinutes,
      rateLimitMaxRequests: this.#config.otpRateLimitMaxRequests,
    });

    if (!challengeRes.success || !challengeRes.challengeId) {
      await writeAuditLog({
        eventType: challengeRes.reason === "lockout" ? "OTP_EXHAUSTED" : "OTP_RATE_LIMITED",
        actorTelegramId: telegramUserId,
        actorBaseUserId: baseUser.id,
        metadata: { reason: challengeRes.reason },
      });
      return { success: false, reason: challengeRes.reason };
    }

    const challengeId = challengeRes.challengeId;

    // 5. Attempt SMTP delivery
    try {
      await this.#smtpClient.sendOtpEmail({
        toEmail: baseUser.email,
        otpCode,
        displayName: baseUser.display_name,
        ttlMinutes: this.#config.otpTtlMinutes,
      });
    } catch (smtpErr) {
      // SMTP FAILED: immediately invalidate newly created challenge
      logger.error({
        msg: "smtp delivery failed — invalidating otp challenge",
        challenge_id: challengeId,
        actor_telegram_id: String(telegramUserId),
        error: smtpErr instanceof Error ? smtpErr.message : String(smtpErr),
      });

      await invalidateOtpChallenge(challengeId);

      await writeAuditLog({
        eventType: "OTP_DELIVERY_FAIL",
        actorTelegramId: telegramUserId,
        actorBaseUserId: baseUser.id,
        metadata: { challenge_id: challengeId },
      });

      return { success: false, reason: "smtp_error" };
    }

    // 6. SMTP succeeded: advance conversation state to AWAIT_OTP
    await setConversationState(telegramUserId, "AWAIT_OTP", {
      pending_base_user_id: baseUser.id,
      pending_username: baseUser.username,
      pending_display_name: baseUser.display_name,
      challenge_id: challengeId,
    });

    const maskedEmail = maskEmail(baseUser.email);

    await writeAuditLog({
      eventType: "OTP_SENT",
      actorTelegramId: telegramUserId,
      actorBaseUserId: baseUser.id,
      metadata: { masked_email: maskedEmail },
    });

    return {
      success: true,
      maskedEmail,
      ttlMinutes: this.#config.otpTtlMinutes,
    };
  }

  /**
   * Verify user-entered OTP string against the active challenge.
   */
  async verifyOtpInput(params: {
    telegramUserId: number | string | bigint;
    baseUserId: number;
    rawInput: string;
  }): Promise<VerifyOtpResult> {
    const { telegramUserId, baseUserId, rawInput } = params;
    const trimmed = rawInput.trim();

    // 1. Strict regex validation: exactly 6 numeric digits
    if (!/^\d{6}$/.test(trimmed)) {
      return { success: false, error: "invalid_format" };
    }

    // 2. Lookup active challenge
    const challenge = await getActiveOtpChallenge(telegramUserId, baseUserId);
    if (!challenge) {
      return { success: false, error: "no_active_challenge" };
    }

    // 3. Check expiration
    if (new Date() > new Date(challenge.expires_at)) {
      await invalidateOtpChallenge(challenge.id);
      await writeAuditLog({
        eventType: "OTP_EXPIRED",
        actorTelegramId: telegramUserId,
        actorBaseUserId: baseUserId,
        metadata: { challenge_id: challenge.id },
      });
      return { success: false, error: "expired" };
    }

    // 4. Compare OTP with bcrypt hash
    const isMatch = await bcrypt.compare(trimmed, challenge.otp_hash);

    if (!isMatch) {
      // Record failed attempt
      const attemptRes = await recordFailedOtpAttempt(challenge.id);
      const attemptsRemaining = Math.max(0, attemptRes.maxAttempts - attemptRes.attempts);

      await writeAuditLog({
        eventType: "OTP_VERIFY_FAIL",
        actorTelegramId: telegramUserId,
        actorBaseUserId: baseUserId,
        metadata: {
          challenge_id: challenge.id,
          attempts_remaining: attemptsRemaining,
          is_exhausted: attemptRes.isExhausted,
        },
      });

      if (attemptRes.isExhausted) {
        await writeAuditLog({
          eventType: "OTP_EXHAUSTED",
          actorTelegramId: telegramUserId,
          actorBaseUserId: baseUserId,
          metadata: { challenge_id: challenge.id },
        });
      }

      return {
        success: false,
        error: "wrong_code",
        attemptsRemaining,
        isExhausted: attemptRes.isExhausted,
      };
    }

    // 5. Success
    await writeAuditLog({
      eventType: "OTP_VERIFY_SUCCESS",
      actorTelegramId: telegramUserId,
      actorBaseUserId: baseUserId,
      metadata: { challenge_id: challenge.id },
    });

    return {
      success: true,
      challengeId: challenge.id,
      baseUserId: challenge.base_user_id,
    };
  }
}
