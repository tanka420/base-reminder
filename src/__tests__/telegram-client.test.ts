/**
 * src/__tests__/telegram-client.test.ts
 *
 * Unit tests for TelegramClient error classification and retry policy.
 */

import { describe, it, expect, vi } from "vitest";
import { Api, GrammyError, HttpError } from "grammy";
import { TelegramClient } from "../telegram/telegram-client.js";

describe("TelegramClient", () => {
  it("should classify 403 Forbidden / bot blocked as permanent TELEGRAM_BLOCKED", () => {
    const api = new Api("fake-token");
    const client = new TelegramClient(api);

    const err = new GrammyError("Call failed: bot was blocked by the user", {
      ok: false,
      error_code: 403,
      description: "Forbidden: bot was blocked by the user",
    }, "sendMessage", {});

    const classification = client.classifyError(err);
    expect(classification.code).toBe("TELEGRAM_BLOCKED");
    expect(classification.isTransient).toBe(false);
  });

  it("should classify 400 chat not found as permanent CHAT_NOT_FOUND", () => {
    const api = new Api("fake-token");
    const client = new TelegramClient(api);

    const err = new GrammyError("Call failed: chat not found", {
      ok: false,
      error_code: 400,
      description: "Bad Request: chat not found",
    }, "sendMessage", {});

    const classification = client.classifyError(err);
    expect(classification.code).toBe("CHAT_NOT_FOUND");
    expect(classification.isTransient).toBe(false);
  });

  it("should classify 429 rate limit as transient RATE_LIMITED and extract retry_after", () => {
    const api = new Api("fake-token");
    const client = new TelegramClient(api);

    const err = new GrammyError("Call failed: Too Many Requests", {
      ok: false,
      error_code: 429,
      description: "Too Many Requests: retry after 5",
      parameters: { retry_after: 5 },
    }, "sendMessage", {});

    const classification = client.classifyError(err);
    expect(classification.code).toBe("RATE_LIMITED");
    expect(classification.isTransient).toBe(true);
    expect(classification.retryAfterSeconds).toBe(5);
  });

  it("should classify 500/502 server error as transient TELEGRAM_5XX", () => {
    const api = new Api("fake-token");
    const client = new TelegramClient(api);

    const err = new GrammyError("Call failed: Bad Gateway", {
      ok: false,
      error_code: 502,
      description: "Bad Gateway",
    }, "sendMessage", {});

    const classification = client.classifyError(err);
    expect(classification.code).toBe("TELEGRAM_5XX");
    expect(classification.isTransient).toBe(true);
  });

  it("should classify network timeout as transient NETWORK_ERROR", () => {
    const api = new Api("fake-token");
    const client = new TelegramClient(api);

    const err = new Error("connect ETIMEDOUT 149.154.167.220:443");
    const classification = client.classifyError(err);
    expect(classification.code).toBe("NETWORK_ERROR");
    expect(classification.isTransient).toBe(true);
  });

  it("should not retry permanent 403 error and fail on first attempt", async () => {
    const mockApi = {
      sendMessage: vi.fn().mockRejectedValue(
        new GrammyError("Forbidden: bot was blocked by the user", {
          ok: false,
          error_code: 403,
          description: "Forbidden: bot was blocked by the user",
        }, "sendMessage", {})
      ),
    } as unknown as Api;

    const client = new TelegramClient(mockApi, { maxAttempts: 3, initialDelayMs: 10 });
    const result = await client.sendMessage("123456", "<b>Test</b>");

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("TELEGRAM_BLOCKED");
    expect(result.attempts).toBe(1);
    expect(mockApi.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("should retry transient error and succeed if subsequent attempt passes", async () => {
    const mockApi = {
      sendMessage: vi.fn()
        .mockRejectedValueOnce(new Error("connect ECONNRESET"))
        .mockResolvedValueOnce({ message_id: 8888 }),
    } as unknown as Api;

    const client = new TelegramClient(mockApi, { maxAttempts: 3, initialDelayMs: 10 });
    const result = await client.sendMessage("123456", "<b>Test</b>");

    expect(result.success).toBe(true);
    expect(result.messageId).toBe(8888);
    expect(result.attempts).toBe(2);
    expect(mockApi.sendMessage).toHaveBeenCalledTimes(2);
  });
});
