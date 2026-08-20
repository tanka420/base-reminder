/**
 * src/__tests__/config-isolation.test.ts
 *
 * Tests configuration isolation ensuring M0/M1 CLI commands do not require
 * Telegram or SMTP environment variables.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  loadConfig,
  loadCoreConfig,
  loadTelegramConfig,
  loadSmtpConfig,
} from "../config/index.js";

const ORIGINAL_ENV = { ...process.env };

const MINIMAL_CORE_ENV: Record<string, string> = {
  DATABASE_URL: "postgresql://test:test@localhost:5432/test",
  BASE_ACCOUNT_TOKEN: "token-account",
  BASE_WEWORK_TOKEN: "token-wework",
  BASE_WORKFLOW_TOKEN: "token-workflow",
  BASE_REQUEST_TOKEN: "token-request",
};

beforeEach(() => {
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
});

describe("Configuration Subsystem Isolation", () => {
  it("loadCoreConfig() succeeds without any Telegram or SMTP variables set", () => {
    Object.assign(process.env, MINIMAL_CORE_ENV);

    const config = loadCoreConfig();
    expect(config.databaseUrl).toBe("postgresql://test:test@localhost:5432/test");
    expect(config.enableTelegramBot).toBe(false);
  });

  it("loadConfig() alias succeeds for CLI tools without Telegram/SMTP variables", () => {
    Object.assign(process.env, MINIMAL_CORE_ENV);

    const config = loadConfig();
    expect(config.baseAccountToken).toBe("token-account");
  });

  it("loadTelegramConfig() fails fast if TELEGRAM_BOT_TOKEN is missing", () => {
    Object.assign(process.env, MINIMAL_CORE_ENV);

    expect(() => loadTelegramConfig()).toThrow("TELEGRAM_BOT_TOKEN");
  });

  it("loadTelegramConfig() succeeds when TELEGRAM_BOT_TOKEN is provided", () => {
    Object.assign(process.env, {
      ...MINIMAL_CORE_ENV,
      TELEGRAM_BOT_TOKEN: "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11",
      ENABLE_TELEGRAM_BOT: "true",
    });

    const tgConfig = loadTelegramConfig();
    expect(tgConfig.botToken).toBe("123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11");
    expect(tgConfig.enableTelegramBot).toBe(true);
  });

  it("loadSmtpConfig() fails fast if SMTP credentials are missing", () => {
    Object.assign(process.env, MINIMAL_CORE_ENV);

    expect(() => loadSmtpConfig()).toThrow("SMTP_HOST");
  });

  it("loadSmtpConfig() succeeds when all required SMTP variables are provided", () => {
    Object.assign(process.env, {
      ...MINIMAL_CORE_ENV,
      SMTP_HOST: "smtp.example.com",
      SMTP_USER: "user@example.com",
      SMTP_PASS: "secretpass",
    });

    const smtpConfig = loadSmtpConfig();
    expect(smtpConfig.host).toBe("smtp.example.com");
    expect(smtpConfig.port).toBe(587);
    expect(smtpConfig.requireTls).toBe(true);
    expect(smtpConfig.otpTtlMinutes).toBe(10);
    expect(smtpConfig.otpMaxAttempts).toBe(5);
  });
});
