/**
 * src/__tests__/wework-collector.test.ts
 *
 * Unit tests for Wework task classification and collection.
 * Specifically tests:
 *  - Unix seconds timestamps
 *  - deadline_has_time = 0 (date-only)
 *  - deadline_has_time = 1 (time-specific)
 *  - Asia/Ho_Chi_Minh day boundary
 *  - Morning hour date-only task not marked overdue falsely
 *  - Status filtering (incomplete status="0" only)
 */

import { describe, it, expect } from "vitest";
import {
  classifyWeworkTask,
  formatTzDate,
} from "../collectors/wework.js";
import type { BaseWeworkTask } from "../base-api/wework.js";

describe("Wework Collector & Task Classification", () => {
  const TZ = "Asia/Ho_Chi_Minh";

  // Reference date: 2026-08-20 08:15:00 in Asia/Ho_Chi_Minh (UTC+7)
  // UTC time: 2026-08-20 01:15:00 UTC -> 1787188500 seconds
  const mockNow = new Date("2026-08-20T01:15:00.000Z");

  it("formats dates correctly in Asia/Ho_Chi_Minh", () => {
    expect(formatTzDate(mockNow, TZ)).toBe("2026-08-20");

    // Unix timestamp 1787188500 = 2026-08-20
    expect(formatTzDate(1787188500, TZ)).toBe("2026-08-20");
  });

  describe("deadline_has_time = 0 (date-only deadlines)", () => {
    it("marks task due today as isDueToday=true and isOverdue=false during morning run (08:15)", () => {
      // 2026-08-20 23:59:59 in Asia/Ho_Chi_Minh -> 2026-08-20 16:59:59 UTC = 1787245199
      const todayUnix = 1787245199;

      const task: BaseWeworkTask = {
        id: 101,
        name: "Date-only task due today",
        status: "0",
        has_deadline: 1,
        deadline: todayUnix,
        deadline_has_time: 0,
        overdue: 0,
      };

      const result = classifyWeworkTask(task, TZ, mockNow);

      expect(result.actionable).toBe(true);
      expect(result.isDueToday).toBe(true);
      expect(result.isOverdue).toBe(false); // MUST NOT be overdue in morning
    });

    it("marks date-only task from yesterday as isOverdue=true and isDueToday=false", () => {
      // 2026-08-19 23:59:59 in VN -> 1787158799
      const yesterdayUnix = 1787158799;

      const task: BaseWeworkTask = {
        id: 102,
        name: "Date-only task from yesterday",
        status: "0",
        has_deadline: 1,
        deadline: yesterdayUnix,
        deadline_has_time: 0,
        overdue: 0,
      };

      const result = classifyWeworkTask(task, TZ, mockNow);

      expect(result.actionable).toBe(true);
      expect(result.isDueToday).toBe(false);
      expect(result.isOverdue).toBe(true);
    });

    it("excludes future date-only task (tomorrow)", () => {
      // 2026-08-21 in VN -> 1787331599
      const tomorrowUnix = 1787331599;

      const task: BaseWeworkTask = {
        id: 103,
        name: "Date-only task for tomorrow",
        status: "0",
        has_deadline: 1,
        deadline: tomorrowUnix,
        deadline_has_time: 0,
        overdue: 0,
      };

      const result = classifyWeworkTask(task, TZ, mockNow);

      expect(result.actionable).toBe(false);
      expect(result.isDueToday).toBe(false);
      expect(result.isOverdue).toBe(false);
    });
  });

  describe("deadline_has_time = 1 (time-specific deadlines)", () => {
    it("marks time-specific task later today (17:00) as isDueToday=true and isOverdue=false", () => {
      // 2026-08-20 17:00:00 VN (10:00:00 UTC) = 1787220000
      const laterTodayUnix = 1787220000;

      const task: BaseWeworkTask = {
        id: 201,
        name: "Task due at 5 PM today",
        status: "0",
        has_deadline: 1,
        deadline: laterTodayUnix,
        deadline_has_time: 1,
        overdue: 0,
      };

      const result = classifyWeworkTask(task, TZ, mockNow);

      expect(result.actionable).toBe(true);
      expect(result.isDueToday).toBe(true);
      expect(result.isOverdue).toBe(false);
    });

    it("marks time-specific task earlier today (07:00) as isDueToday=true AND isOverdue=true at 08:15", () => {
      // 2026-08-20 07:00:00 VN (00:00:00 UTC) = 1787184000
      const earlierTodayUnix = 1787184000;

      const task: BaseWeworkTask = {
        id: 202,
        name: "Task was due at 7 AM today",
        status: "0",
        has_deadline: 1,
        deadline: earlierTodayUnix,
        deadline_has_time: 1,
        overdue: 0,
      };

      const result = classifyWeworkTask(task, TZ, mockNow);

      expect(result.actionable).toBe(true);
      expect(result.isDueToday).toBe(true);
      expect(result.isOverdue).toBe(true);
    });
  });

  describe("Status filtering and API overdue flags", () => {
    it("ignores completed tasks (status='1')", () => {
      const task: BaseWeworkTask = {
        id: 301,
        name: "Completed task",
        status: "1",
        deadline: 1787245199,
        overdue: 1,
      };

      const result = classifyWeworkTask(task, TZ, mockNow);
      expect(result.actionable).toBe(false);
    });

    it("includes incomplete task with no deadline but overdue=1", () => {
      const task: BaseWeworkTask = {
        id: 302,
        name: "Overdue task without deadline timestamp",
        status: "0",
        deadline: 0,
        overdue: 1,
      };

      const result = classifyWeworkTask(task, TZ, mockNow);
      expect(result.actionable).toBe(true);
      expect(result.isOverdue).toBe(true);
      expect(result.isDueToday).toBe(false);
    });
  });

  describe("Timezone day boundary edge cases", () => {
    it("handles midnight boundaries in Asia/Ho_Chi_Minh correctly", () => {
      // 2026-08-20 00:00:01 in VN -> 2026-08-19 17:00:01 UTC
      const startOfDayUnix = Math.floor(new Date("2026-08-19T17:00:01.000Z").getTime() / 1000);
      expect(formatTzDate(startOfDayUnix, TZ)).toBe("2026-08-20");

      // 2026-08-20 23:59:59 in VN -> 2026-08-20 16:59:59 UTC
      const endOfDayUnix = Math.floor(new Date("2026-08-20T16:59:59.000Z").getTime() / 1000);
      expect(formatTzDate(endOfDayUnix, TZ)).toBe("2026-08-20");

      // 1 second before midnight VN (2026-08-19 23:59:59 VN = 2026-08-19 16:59:59 UTC)
      const prevDayUnix = Math.floor(new Date("2026-08-19T16:59:59.000Z").getTime() / 1000);
      expect(formatTzDate(prevDayUnix, TZ)).toBe("2026-08-19");
    });
  });
});
