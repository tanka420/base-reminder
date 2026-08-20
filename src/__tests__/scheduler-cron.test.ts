/**
 * src/__tests__/scheduler-cron.test.ts
 *
 * Unit tests for cron scheduler helpers, timezone checks, and missed-run logic.
 */

import { describe, it, expect } from "vitest";
import {
  isWeekdayInTimezone,
  isAfterMorningTime,
  isPastCutoffTime,
} from "../scheduler/cron.js";

describe("Scheduler & Timezone Utilities", () => {
  const TZ = "Asia/Ho_Chi_Minh";

  describe("isWeekdayInTimezone", () => {
    it("returns true for Monday through Friday", () => {
      // 2026-08-20 (Thursday) 10:00:00 VN
      const thursday = new Date("2026-08-20T03:00:00.000Z");
      expect(isWeekdayInTimezone(thursday, TZ)).toBe(true);

      // 2026-08-21 (Friday) 10:00:00 VN
      const friday = new Date("2026-08-21T03:00:00.000Z");
      expect(isWeekdayInTimezone(friday, TZ)).toBe(true);

      // 2026-08-17 (Monday) 10:00:00 VN
      const monday = new Date("2026-08-17T03:00:00.000Z");
      expect(isWeekdayInTimezone(monday, TZ)).toBe(true);
    });

    it("returns false for Saturday and Sunday in Asia/Ho_Chi_Minh", () => {
      // 2026-08-22 (Saturday) in VN
      const saturday = new Date("2026-08-22T03:00:00.000Z");
      expect(isWeekdayInTimezone(saturday, TZ)).toBe(false);

      // 2026-08-23 (Sunday) in VN
      const sunday = new Date("2026-08-23T03:00:00.000Z");
      expect(isWeekdayInTimezone(sunday, TZ)).toBe(false);
    });
  });

  describe("isAfterMorningTime (08:15 VN time)", () => {
    it("returns false before 08:15 (e.g. 08:14)", () => {
      // 08:14 VN = 01:14 UTC
      const beforeTime = new Date("2026-08-20T01:14:00.000Z");
      expect(isAfterMorningTime(beforeTime, TZ, 8, 15)).toBe(false);
    });

    it("returns true at or after 08:15 (e.g. 08:15 and 09:00)", () => {
      // 08:15 VN = 01:15 UTC
      const exactTime = new Date("2026-08-20T01:15:00.000Z");
      expect(isAfterMorningTime(exactTime, TZ, 8, 15)).toBe(true);

      // 09:00 VN = 02:00 UTC
      const afterTime = new Date("2026-08-20T02:00:00.000Z");
      expect(isAfterMorningTime(afterTime, TZ, 8, 15)).toBe(true);
    });
  });

  describe("isPastCutoffTime (10:00 VN time)", () => {
    it("returns false before 10:00 (e.g. 08:30 and 09:59)", () => {
      // 08:30 VN = 01:30 UTC
      const time1 = new Date("2026-08-20T01:30:00.000Z");
      expect(isPastCutoffTime(time1, TZ, 10, 0)).toBe(false);

      // 09:59 VN = 02:59 UTC
      const time2 = new Date("2026-08-20T02:59:00.000Z");
      expect(isPastCutoffTime(time2, TZ, 10, 0)).toBe(false);
    });

    it("returns true at or after 10:00 (e.g. 10:00 and 11:30)", () => {
      // 10:00 VN = 03:00 UTC
      const exactCutoff = new Date("2026-08-20T03:00:00.000Z");
      expect(isPastCutoffTime(exactCutoff, TZ, 10, 0)).toBe(true);

      // 11:30 VN = 04:30 UTC
      const pastCutoff = new Date("2026-08-20T04:30:00.000Z");
      expect(isPastCutoffTime(pastCutoff, TZ, 10, 0)).toBe(true);
    });
  });
});
