/**
 * src/logging/logger.ts
 *
 * Structured logger (pino).
 *
 * Security rules enforced here:
 *  - Tokens, passwords, OTP values, secrets, and authorization headers
 *    are redacted at the serializer level — they never appear in log output
 *    at ANY level, including debug.
 *  - Task titles, job names, request names, email addresses, and raw API
 *    response bodies must NEVER be passed to the logger. Callers are
 *    responsible for passing only operational metadata (IDs, counts, status).
 */

import pino from "pino";
import { env } from "process";

/** Fields whose values are always replaced with "[REDACTED]" */
const REDACTED_PATHS = [
  "token",
  "access_token",
  "access_token_v2",
  "password",
  "pass",
  "smtp_pass",
  "bot_token",
  "otp",
  "otp_hash",
  "otpCode",
  "secret",
  "authorization",
  "Authorization",
  "cookie",
  "Cookie",
  "session",
  "session_id",
  "secureData",
  "view_token",
  "email",
  "toEmail",
  "BASE_ACCOUNT_TOKEN",
  "BASE_WEWORK_TOKEN",
  "BASE_WORKFLOW_TOKEN",
  "BASE_REQUEST_TOKEN",
  "BASE_SIGN_TOKEN",
  "TELEGRAM_BOT_TOKEN",
  "SMTP_PASS",
  "DB_PASSWORD",
  "*.token",
  "*.access_token",
  "*.access_token_v2",
  "*.password",
  "*.pass",
  "*.smtp_pass",
  "*.bot_token",
  "*.otp",
  "*.otp_hash",
  "*.otpCode",
  "*.secret",
  "*.authorization",
  "*.Authorization",
  "*.cookie",
  "*.Cookie",
  "*.session",
  "*.session_id",
  "*.secureData",
  "*.view_token",
  "*.email",
  "*.toEmail",
  "*.BASE_ACCOUNT_TOKEN",
  "*.BASE_WEWORK_TOKEN",
  "*.BASE_WORKFLOW_TOKEN",
  "*.BASE_REQUEST_TOKEN",
  "*.BASE_SIGN_TOKEN",
  "*.TELEGRAM_BOT_TOKEN",
  "*.SMTP_PASS",
  "*.DB_PASSWORD",
];

const level = (env["LOG_LEVEL"] ?? "info").toLowerCase();

export const logger = pino({
  level,
  redact: {
    paths: REDACTED_PATHS,
    censor: "[REDACTED]",
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level(label) {
      return { level: label };
    },
  },
});

export type Logger = typeof logger;
