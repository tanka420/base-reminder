/**
 * src/__tests__/config.test.ts
 *
 * Tests for configuration loading and validation.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig } from "../config/index.js";

// Save and restore process.env around tests
const ORIGINAL_ENV = { ...process.env };

function setEnv(vars: Record<string, string>): void {
  for (const [k, v] of Object.entries(vars)) {
    process.env[k] = v;
  }
}

function clearRequired(): void {
  delete process.env["DATABASE_URL"];
  delete process.env["BASE_ACCOUNT_TOKEN"];
  delete process.env["BASE_WEWORK_TOKEN"];
  delete process.env["BASE_WORKFLOW_TOKEN"];
  delete process.env["BASE_REQUEST_TOKEN"];
}

const VALID_ENV: Record<string, string> = {
  DATABASE_URL: "postgresql://test:test@localhost:5432/test",
  BASE_ACCOUNT_TOKEN: "token-account-test",
  BASE_WEWORK_TOKEN: "token-wework-test",
  BASE_WORKFLOW_TOKEN: "token-workflow-test",
  BASE_REQUEST_TOKEN: "token-request-test",
};

beforeEach(() => {
  // Start with a clean environment for each test
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
});

afterEach(() => {
  // Restore original environment
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
});

describe("loadConfig()", () => {
  describe("required variables", () => {
    it("succeeds when all required vars are set", () => {
      setEnv(VALID_ENV);
      expect(() => loadConfig()).not.toThrow();
    });

    it("throws when DATABASE_URL is missing", () => {
      setEnv(VALID_ENV);
      delete process.env["DATABASE_URL"];
      expect(() => loadConfig()).toThrow("DATABASE_URL");
    });

    it("throws when BASE_ACCOUNT_TOKEN is missing", () => {
      setEnv(VALID_ENV);
      delete process.env["BASE_ACCOUNT_TOKEN"];
      expect(() => loadConfig()).toThrow("BASE_ACCOUNT_TOKEN");
    });

    it("throws when BASE_WEWORK_TOKEN is missing", () => {
      setEnv(VALID_ENV);
      delete process.env["BASE_WEWORK_TOKEN"];
      expect(() => loadConfig()).toThrow("BASE_WEWORK_TOKEN");
    });

    it("throws when BASE_WORKFLOW_TOKEN is missing", () => {
      setEnv(VALID_ENV);
      delete process.env["BASE_WORKFLOW_TOKEN"];
      expect(() => loadConfig()).toThrow("BASE_WORKFLOW_TOKEN");
    });

    it("throws when BASE_REQUEST_TOKEN is missing", () => {
      setEnv(VALID_ENV);
      delete process.env["BASE_REQUEST_TOKEN"];
      expect(() => loadConfig()).toThrow("BASE_REQUEST_TOKEN");
    });

    it("lists ALL missing variables in a single error (not just the first)", () => {
      clearRequired(); // remove all required vars
      let error: Error | undefined;
      try {
        loadConfig();
      } catch (err) {
        error = err as Error;
      }
      expect(error).toBeDefined();
      const msg = error!.message;
      expect(msg).toContain("DATABASE_URL");
      expect(msg).toContain("BASE_ACCOUNT_TOKEN");
      expect(msg).toContain("BASE_WEWORK_TOKEN");
      expect(msg).toContain("BASE_WORKFLOW_TOKEN");
      expect(msg).toContain("BASE_REQUEST_TOKEN");
    });

    it("treats an empty string as missing", () => {
      setEnv({ ...VALID_ENV, DATABASE_URL: "" });
      expect(() => loadConfig()).toThrow("DATABASE_URL");
    });

    it("treats a whitespace-only value as missing", () => {
      setEnv({ ...VALID_ENV, BASE_ACCOUNT_TOKEN: "   " });
      expect(() => loadConfig()).toThrow("BASE_ACCOUNT_TOKEN");
    });
  });

  describe("defaults", () => {
    it("defaults nodeEnv to production", () => {
      setEnv(VALID_ENV);
      const config = loadConfig();
      expect(config.nodeEnv).toBe("production");
    });

    it("defaults healthHost to 127.0.0.1", () => {
      setEnv(VALID_ENV);
      const config = loadConfig();
      expect(config.healthHost).toBe("127.0.0.1");
    });

    it("defaults healthPort to 3000", () => {
      setEnv(VALID_ENV);
      const config = loadConfig();
      expect(config.healthPort).toBe(3000);
    });

    it("defaults reminderTimezone to Asia/Ho_Chi_Minh", () => {
      setEnv(VALID_ENV);
      const config = loadConfig();
      expect(config.reminderTimezone).toBe("Asia/Ho_Chi_Minh");
    });

    it("defaults logLevel to info", () => {
      setEnv(VALID_ENV);
      const config = loadConfig();
      expect(config.logLevel).toBe("info");
    });

    it("defaults baseApiTimeoutMs to 15000", () => {
      setEnv(VALID_ENV);
      const config = loadConfig();
      expect(config.baseApiTimeoutMs).toBe(15_000);
    });

    it("defaults reminderCron to 15 8 * * 1-5", () => {
      setEnv(VALID_ENV);
      const config = loadConfig();
      expect(config.reminderCron).toBe("15 8 * * 1-5");
    });

    it("defaults enableCronScheduler to false (M1B requirement)", () => {
      setEnv(VALID_ENV);
      const config = loadConfig();
      expect(config.enableCronScheduler).toBe(false);
    });

    it("defaults baseApiConcurrency to 3", () => {
      setEnv(VALID_ENV);
      const config = loadConfig();
      expect(config.baseApiConcurrency).toBe(3);
    });
  });

  describe("optional overrides", () => {
    it("accepts NODE_ENV=development", () => {
      setEnv({ ...VALID_ENV, NODE_ENV: "development" });
      const config = loadConfig();
      expect(config.nodeEnv).toBe("development");
    });

    it("accepts NODE_ENV=test", () => {
      setEnv({ ...VALID_ENV, NODE_ENV: "test" });
      const config = loadConfig();
      expect(config.nodeEnv).toBe("test");
    });

    it("maps unknown NODE_ENV to production", () => {
      setEnv({ ...VALID_ENV, NODE_ENV: "staging" });
      const config = loadConfig();
      expect(config.nodeEnv).toBe("production");
    });

    it("parses HEALTH_PORT as integer", () => {
      setEnv({ ...VALID_ENV, HEALTH_PORT: "8080" });
      const config = loadConfig();
      expect(config.healthPort).toBe(8080);
    });

    it("accepts custom HEALTH_HOST", () => {
      setEnv({ ...VALID_ENV, HEALTH_HOST: "0.0.0.0" });
      const config = loadConfig();
      expect(config.healthHost).toBe("0.0.0.0");
    });
  });

  describe("security — token fields", () => {
    it("tokens are accessible via config object (needed for injection)", () => {
      setEnv(VALID_ENV);
      const config = loadConfig();
      // These fields must be accessible for passing to clients
      expect(typeof config.baseAccountToken).toBe("string");
      expect(config.baseAccountToken.length).toBeGreaterThan(0);
    });

    it("config object is frozen (no mutation)", () => {
      setEnv(VALID_ENV);
      const config = loadConfig();
      expect(Object.isFrozen(config)).toBe(true);
    });

    it("modifying a frozen config field throws in strict mode", () => {
      setEnv(VALID_ENV);
      const config = loadConfig();
      expect(() => {
        // @ts-expect-error — testing runtime immutability
        config.baseAccountToken = "hacked";
      }).toThrow();
    });
  });
});
