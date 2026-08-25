/**
 * src/config/index.ts
 *
 * Production configuration loader with subsystem isolation.
 *
 * Security rules:
 *  - All secret fields (tokens, DB password inside DATABASE_URL, SMTP pass, bot token)
 *    are loaded once and held in memory. They are NEVER logged, never serialized to JSON for
 *    inspection, and never returned via health endpoints.
 *  - Config object uses readonly properties. No runtime mutation.
 *  - Fail fast: missing required fields throw at subsystem startup.
 *  - Subsystem isolation: core CLI commands (migrate, sync:users, digest:preview) do NOT
 *    require Telegram or SMTP secrets.
 */

import "dotenv/config";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CoreConfig {
  readonly nodeEnv: "production" | "development" | "test";
  readonly logLevel: string;

  // --- Database ---
  /** Full PostgreSQL connection string. Contains credentials — never log. */
  readonly databaseUrl: string;

  // --- Base API tokens (one per module, access_token_v2) ---
  /** Token for Base Account module. Never log. */
  readonly baseAccountToken: string;
  /** Token for Base Wework module. Never log. */
  readonly baseWeWorkToken: string;
  /** Token for Base Workflow module. Never log. */
  readonly baseWorkflowToken: string;
  /** Token for Base Request module. Never log. */
  readonly baseRequestToken: string;

  // --- Scheduler ---
  readonly reminderTimezone: string;
  readonly reminderCron: string;
  /** Whether the automatic cron scheduler runs in background (default: false) */
  readonly enableCronScheduler: boolean;
  /** Hour (0-23) after which missed morning runs are no longer automatically executed (default: 10) */
  readonly missedRunCutoffHour: number;

  // --- Health endpoint ---
  /** Bind address for internal health endpoint (default: 127.0.0.1) */
  readonly healthHost: string;
  /** Port for internal health endpoint (default: 3000) */
  readonly healthPort: number;

  // --- Base API client tuning ---
  readonly baseApiTimeoutMs: number;
  readonly baseApiConcurrency: number;

  // --- Telegram feature flag ---
  readonly enableTelegramBot: boolean;
}

export type Config = CoreConfig;

export interface TelegramConfig {
  /** Telegram Bot token from @BotFather. Never log. */
  readonly botToken: string;
  readonly enableTelegramBot: boolean;
}

export interface SmtpConfig {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly requireTls: boolean;
  /** SMTP username. Never log. */
  readonly user: string;
  /** SMTP password. Never log. */
  readonly pass: string;
  readonly from: string;

  // --- OTP settings ---
  readonly otpTtlMinutes: number;
  readonly otpMaxAttempts: number;
  readonly otpRateLimitWindowMinutes: number;
  readonly otpRateLimitMaxRequests: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireEnv(key: string, missing: string[]): string {
  const value = process.env[key];
  if (value === undefined || value.trim() === "") {
    missing.push(key);
    return "";
  }
  return value.trim();
}

function optionalEnv(key: string, defaultValue: string): string {
  const value = process.env[key];
  if (value === undefined || value.trim() === "") return defaultValue;
  return value.trim();
}

function optionalIntEnv(key: string, defaultValue: number, missing: string[]): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === "") return defaultValue;
  const parsed = parseInt(raw.trim(), 10);
  if (Number.isNaN(parsed)) {
    missing.push(`${key} (must be an integer, got: "${raw}")`);
    return defaultValue;
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Core Config Loader
// ---------------------------------------------------------------------------

/**
 * Load and validate core configuration required for all operations.
 * Does NOT require Telegram or SMTP variables.
 */
export function loadCoreConfig(): CoreConfig {
  const missing: string[] = [];

  // Required core fields
  const databaseUrl = requireEnv("DATABASE_URL", missing);
  const baseAccountToken = requireEnv("BASE_ACCOUNT_TOKEN", missing);
  const baseWeWorkToken = requireEnv("BASE_WEWORK_TOKEN", missing);
  const baseWorkflowToken = requireEnv("BASE_WORKFLOW_TOKEN", missing);
  const baseRequestToken = requireEnv("BASE_REQUEST_TOKEN", missing);

  // Optional with defaults
  const nodeEnvRaw = optionalEnv("NODE_ENV", "production");
  const logLevel = optionalEnv("LOG_LEVEL", "info");
  const reminderTimezone = optionalEnv("REMINDER_TIMEZONE", "Asia/Ho_Chi_Minh");
  const reminderCron = optionalEnv("REMINDER_CRON", "0 8 * * 1-5");
  const enableCronScheduler = optionalEnv("ENABLE_CRON_SCHEDULER", "false").toLowerCase() === "true";
  const missedRunCutoffHour = optionalIntEnv("MISSED_RUN_CUTOFF_HOUR", 10, missing);
  const healthHost = optionalEnv("HEALTH_HOST", "127.0.0.1");
  const healthPort = optionalIntEnv("HEALTH_PORT", 3000, missing);
  const baseApiTimeoutMs = optionalIntEnv("BASE_API_TIMEOUT_MS", 15_000, missing);
  const baseApiConcurrency = optionalIntEnv("BASE_API_CONCURRENCY", 3, missing);
  const enableTelegramBot = optionalEnv("ENABLE_TELEGRAM_BOT", "false").toLowerCase() === "true";

  // Fail fast on core missing variables
  if (missing.length > 0) {
    throw new Error(
      `[config] Missing required environment variables:\n  ${missing.join("\n  ")}\n` +
        "Set them in .env or the process environment before starting."
    );
  }

  const nodeEnv = (
    nodeEnvRaw === "development" || nodeEnvRaw === "test"
      ? nodeEnvRaw
      : "production"
  ) as CoreConfig["nodeEnv"];

  return Object.freeze({
    nodeEnv,
    logLevel,
    databaseUrl,
    baseAccountToken,
    baseWeWorkToken,
    baseWorkflowToken,
    baseRequestToken,
    reminderTimezone,
    reminderCron,
    enableCronScheduler,
    missedRunCutoffHour,
    healthHost,
    healthPort,
    baseApiTimeoutMs,
    baseApiConcurrency,
    enableTelegramBot,
  });
}

/**
 * Default config loader (alias for loadCoreConfig for backward compatibility).
 */
export function loadConfig(): Config {
  return loadCoreConfig();
}

// ---------------------------------------------------------------------------
// Telegram Config Loader
// ---------------------------------------------------------------------------

/**
 * Load and validate Telegram bot configuration.
 * Call only when Telegram bot service is enabled.
 */
export function loadTelegramConfig(): TelegramConfig {
  const missing: string[] = [];

  const botToken = requireEnv("TELEGRAM_BOT_TOKEN", missing);
  const enableTelegramBot = optionalEnv("ENABLE_TELEGRAM_BOT", "false").toLowerCase() === "true";

  if (missing.length > 0) {
    throw new Error(
      `[config:telegram] Missing required Telegram environment variables:\n  ${missing.join("\n  ")}\n` +
        "Provide TELEGRAM_BOT_TOKEN to start the Telegram bot."
    );
  }

  return Object.freeze({
    botToken,
    enableTelegramBot,
  });
}

// ---------------------------------------------------------------------------
// SMTP / OTP Config Loader
// ---------------------------------------------------------------------------

/**
 * Load and validate SMTP & OTP configuration.
 * Call only when OTP delivery / verification service is started.
 */
export function loadSmtpConfig(): SmtpConfig {
  const missing: string[] = [];

  const host = requireEnv("SMTP_HOST", missing);
  const port = optionalIntEnv("SMTP_PORT", 587, missing);
  const secure = optionalEnv("SMTP_SECURE", "false").toLowerCase() === "true";
  const requireTls = optionalEnv("SMTP_REQUIRE_TLS", "true").toLowerCase() === "true";
  const user = requireEnv("SMTP_USER", missing);
  const pass = requireEnv("SMTP_PASS", missing);
  const from = optionalEnv("SMTP_FROM", `"Base Reminder" <${user}>`);

  const otpTtlMinutes = optionalIntEnv("OTP_TTL_MINUTES", 10, missing);
  const otpMaxAttempts = optionalIntEnv("OTP_MAX_ATTEMPTS", 5, missing);
  const otpRateLimitWindowMinutes = optionalIntEnv("OTP_RATE_LIMIT_WINDOW_MINUTES", 15, missing);
  const otpRateLimitMaxRequests = optionalIntEnv("OTP_RATE_LIMIT_MAX_REQUESTS", 5, missing);

  if (missing.length > 0) {
    throw new Error(
      `[config:smtp] Missing required SMTP environment variables:\n  ${missing.join("\n  ")}\n` +
        "Provide SMTP_HOST, SMTP_USER, SMTP_PASS to enable email OTP delivery."
    );
  }

  return Object.freeze({
    host,
    port,
    secure,
    requireTls,
    user,
    pass,
    from,
    otpTtlMinutes,
    otpMaxAttempts,
    otpRateLimitWindowMinutes,
    otpRateLimitMaxRequests,
  });
}
