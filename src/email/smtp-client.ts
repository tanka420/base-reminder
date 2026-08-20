/**
 * src/email/smtp-client.ts
 *
 * SMTP email transport wrapper with strict STARTTLS enforcement.
 *
 * Security rules:
 *  - Port 587 enforces STARTTLS (requireTLS: true).
 *  - Plaintext OTP is received as parameter for mail payload only; NEVER logged.
 *  - Recipient email address is never passed to logger (use maskEmail for logs/chat).
 */

import nodemailer, { type Transporter } from "nodemailer";
import type { SmtpConfig } from "../config/index.js";
import { logger } from "../logging/logger.js";

/**
 * Mask an email address for safe display in Telegram chat or operational logs.
 * Example: "mai.tan@company.com" -> "m***n@company.com"
 * Example: "a@b.com" -> "a***@b.com"
 */
export function maskEmail(email: string): string {
  if (!email || !email.includes("@")) return "***@***";
  const parts = email.split("@");
  const local = parts[0] ?? "";
  const domain = parts[1] ?? "";
  if (local.length <= 2) {
    return `${local[0] ?? "*"}***@${domain}`;
  }
  const first = local[0] ?? "*";
  const last = local[local.length - 1] ?? "*";
  return `${first}***${last}@${domain}`;
}

export class SmtpEmailClient {
  readonly #transporter: Transporter;
  readonly #from: string;

  constructor(config: SmtpConfig, customTransporter?: Transporter) {
    this.#from = config.from;

    if (customTransporter) {
      this.#transporter = customTransporter;
    } else {
      this.#transporter = nodemailer.createTransport({
        host: config.host,
        port: config.port,
        secure: config.secure,
        requireTLS: config.requireTls,
        auth: {
          user: config.user,
          pass: config.pass,
        },
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 15_000,
      });
    }
  }

  /**
   * Send a 6-digit OTP verification email.
   *
   * @param toEmail   Recipient corporate email
   * @param otpCode   6-digit numeric string (held in memory only)
   * @param displayName Recipient display name
   * @param ttlMinutes Validity duration in minutes
   */
  async sendOtpEmail(params: {
    toEmail: string;
    otpCode: string;
    displayName: string;
    ttlMinutes?: number;
  }): Promise<void> {
    const ttl = params.ttlMinutes ?? 10;

    const htmlContent = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px; border: 1px solid #e5e7eb; border-radius: 8px; background-color: #ffffff;">
        <h2 style="color: #111827; margin-top: 0; font-size: 20px; font-weight: 600;">Xác thực liên kết Telegram — Base Reminder</h2>
        <p style="color: #374151; font-size: 15px; line-height: 1.5;">Xin chào <strong>${params.displayName}</strong>,</p>
        <p style="color: #374151; font-size: 15px; line-height: 1.5;">Bạn đang thực hiện liên kết tài khoản Base.vn với Telegram Bot của Base Reminder. Dưới đây là mã xác thực (OTP) của bạn:</p>
        <div style="background-color: #f3f4f6; border-radius: 6px; padding: 16px; text-align: center; margin: 24px 0;">
          <span style="font-family: monospace; font-size: 32px; font-weight: 700; letter-spacing: 6px; color: #1f2937;">${params.otpCode}</span>
        </div>
        <p style="color: #6b7280; font-size: 14px; line-height: 1.5;">Mã này có hiệu lực trong vòng <strong>${ttl} phút</strong>. Tuyệt đối không chia sẻ mã xác thực này với bất kỳ ai.</p>
        <p style="color: #9ca3af; font-size: 12px; margin-top: 24px; border-top: 1px solid #f3f4f6; padding-top: 12px;">Nếu bạn không yêu cầu liên kết này, vui lòng bỏ qua email hoặc thông báo cho bộ phận IT.</p>
      </div>
    `;

    const textContent = `
Xác thực liên kết Telegram — Base Reminder

Xin chào ${params.displayName},

Mã xác thực (OTP) của bạn là: ${params.otpCode}
Mã có hiệu lực trong vòng ${ttl} phút. Không chia sẻ mã này với bất kỳ ai.

Nếu bạn không yêu cầu liên kết này, vui lòng bỏ qua email này.
    `.trim();

    try {
      await this.#transporter.sendMail({
        from: this.#from,
        to: params.toEmail,
        subject: "[Base Reminder] Mã xác thực liên kết tài khoản",
        text: textContent,
        html: htmlContent,
      });

      logger.info({
        msg: "otp email sent successfully",
        masked_email: maskEmail(params.toEmail),
      });
    } catch (err) {
      logger.error({
        msg: "failed to send otp email",
        masked_email: maskEmail(params.toEmail),
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }
}
