/**
 * src/__tests__/delivery-eligibility.test.ts
 *
 * Unit tests for Delivery Eligibility evaluation.
 */

import { describe, it, expect } from "vitest";
import { evaluateDeliveryEligibility } from "../delivery/eligibility.js";
import type { TelegramLink } from "../db/queries/telegram-links.js";
import type { UserDigest } from "../digest/types.js";

function createMockDigest(status: "ready" | "empty" | "partial" | "error"): UserDigest {
  return {
    baseUserId: 1,
    username: "user1",
    displayName: "User One",
    status,
    isPartial: status === "partial" || status === "error",
    wework: { status: status === "error" ? "error" : "ok", items: [] },
    workflow: { status: status === "error" ? "error" : "ok", items: [] },
    request: { status: status === "error" ? "error" : "ok", items: [] },
    counts: { wework: 0, workflow: 0, request: 0, total: status === "ready" ? 1 : 0 },
  };
}

function createMockLink(overrides: Partial<TelegramLink> = {}): TelegramLink {
  return {
    id: 10,
    base_user_id: 1,
    telegram_user_id: "12345678",
    telegram_chat_id: "12345678",
    reminders_enabled: true,
    linked_at: new Date(),
    unlinked_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

describe("Delivery Eligibility Service", () => {
  it("should be eligible when user is active, linked, reminders enabled, and digest is ready", () => {
    const result = evaluateDeliveryEligibility({
      isBaseUserActive: true,
      activeLink: createMockLink(),
      digest: createMockDigest("ready"),
    });

    expect(result.isEligible).toBe(true);
    expect(result.chatId).toBe("12345678");
  });

  it("should be eligible when digest is partial", () => {
    const result = evaluateDeliveryEligibility({
      isBaseUserActive: true,
      activeLink: createMockLink(),
      digest: createMockDigest("partial"),
    });

    expect(result.isEligible).toBe(true);
  });

  it("should be ineligible when Base user is inactive (is_active = false)", () => {
    const result = evaluateDeliveryEligibility({
      isBaseUserActive: false,
      activeLink: createMockLink(),
      digest: createMockDigest("ready"),
    });

    expect(result.isEligible).toBe(false);
    expect(result.reason).toBe("user_inactive");
  });

  it("should be ineligible when user has no Telegram link", () => {
    const result = evaluateDeliveryEligibility({
      isBaseUserActive: true,
      activeLink: null,
      digest: createMockDigest("ready"),
    });

    expect(result.isEligible).toBe(false);
    expect(result.reason).toBe("no_telegram_link");
  });

  it("should be ineligible when reminders are paused (reminders_enabled = false)", () => {
    const result = evaluateDeliveryEligibility({
      isBaseUserActive: true,
      activeLink: createMockLink({ reminders_enabled: false }),
      digest: createMockDigest("ready"),
    });

    expect(result.isEligible).toBe(false);
    expect(result.reason).toBe("reminders_paused");
  });

  it("should be ineligible when digest is empty (0 actionable items)", () => {
    const result = evaluateDeliveryEligibility({
      isBaseUserActive: true,
      activeLink: createMockLink(),
      digest: createMockDigest("empty"),
    });

    expect(result.isEligible).toBe(false);
    expect(result.reason).toBe("empty_digest");
  });

  it("should be ineligible when digest is error (all modules failed)", () => {
    const result = evaluateDeliveryEligibility({
      isBaseUserActive: true,
      activeLink: createMockLink(),
      digest: createMockDigest("error"),
    });

    expect(result.isEligible).toBe(false);
    expect(result.reason).toBe("error_digest");
  });
});
