/**
 * src/config/index.ts
 *
 * Production configuration loader.
 *
 * Security rules:
 *  - All secret fields (tokens, DB password inside DATABASE_URL) are loaded once
 *    and held in memory. They are NEVER logged, never serialized to JSON for
 *    inspection, and never returned via health endpoints.
 *  - Config object uses readonly properties. No runtime mutation.
 *  - Fail fast: any missing required field throws at process startup.
 */

import "dotenv/config";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Config {
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
  /** Whether the automatic cron scheduler runs in background (default: false in M1B) */
  readonly enableCronScheduler: boolean;

  // --- Health endpoint ---
  /** Bind address for internal health endpoint (default: 127.0.0.1) */
  readonly healthHost: string;
  /** Port for internal health endpoint (default: 3000) */
  readonly healthPort: number;

  // --- Base API client tuning ---
  readonly baseApiTimeoutMs: number;
  readonly baseApiConcurrency: number;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Load and validate all required configuration from environment variables.
 * Throws a descriptive Error (listing ALL missing variables) if any required
 * variable is absent or empty.
 *
 * Call once at process startup. Pass the result through dependency injection;
 * do not call `process.env` in application code.
 */
export function loadConfig(): Config {
  const missing: string[] = [];

  function require(key: string): string {
    const value = process.env[key];
    if (value === undefined || value.trim() === "") {
      missing.push(key);
      return "";
    }
    return value.trim();
  }

  function optional(key: string, defaultValue: string): string {
    const value = process.env[key];
    if (value === undefined || value.trim() === "") return defaultValue;
    return value.trim();
  }

  function optionalInt(key: string, defaultValue: number): number {
    const raw = process.env[key];
    if (raw === undefined || raw.trim() === "") return defaultValue;
    const parsed = parseInt(raw.trim(), 10);
    if (Number.isNaN(parsed)) {
      missing.push(`${key} (must be an integer, got: "${raw}")`);
      return defaultValue;
    }
    return parsed;
  }

  // Required fields
  const databaseUrl = require("DATABASE_URL");
  const baseAccountToken = require("BASE_ACCOUNT_TOKEN");
  const baseWeWorkToken = require("BASE_WEWORK_TOKEN");
  const baseWorkflowToken = require("BASE_WORKFLOW_TOKEN");
  const baseRequestToken = require("BASE_REQUEST_TOKEN");

  // Optional with defaults
  const nodeEnvRaw = optional("NODE_ENV", "production");
  const logLevel = optional("LOG_LEVEL", "info");
  const reminderTimezone = optional("REMINDER_TIMEZONE", "Asia/Ho_Chi_Minh");
  const reminderCron = optional("REMINDER_CRON", "15 8 * * 1-5");
  const enableCronScheduler = optional("ENABLE_CRON_SCHEDULER", "false").toLowerCase() === "true";
  const healthHost = optional("HEALTH_HOST", "127.0.0.1");
  const healthPort = optionalInt("HEALTH_PORT", 3000);
  const baseApiTimeoutMs = optionalInt("BASE_API_TIMEOUT_MS", 15_000);
  const baseApiConcurrency = optionalInt("BASE_API_CONCURRENCY", 3);

  // Fail fast — collect ALL missing before throwing
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
  ) as Config["nodeEnv"];

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
    healthHost,
    healthPort,
    baseApiTimeoutMs,
    baseApiConcurrency,
  });
}
