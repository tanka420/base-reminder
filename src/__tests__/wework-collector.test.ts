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
 *  - Review-state exclusion (review="1" or review=1 excluded)
 *  - Realistic API payload -> collectWeworkTasks -> ActionItem pipeline
 */

import { describe, it, expect } from "vitest";
import {
  classifyWeworkTask,
  collectWeworkTasks,
  formatTzDate,
} from "../collectors/wework.js";
import type { BaseWeworkTask, WeworkApiClient } from "../base-api/wework.js";

describe("Wework Collector & Task Classification", () => {
  const TZ = "Asia/Ho_Chi_Minh";

  // Reference date: 2026-08-20 08:00:00 in Asia/Ho_Chi_Minh (UTC+7)
  // UTC time: 2026-08-20 01:00:00 UTC -> 1787187600 seconds
  const mockNow = new Date("2026-08-20T01:00:00.000Z");

  it("formats dates correctly in Asia/Ho_Chi_Minh", () => {
    expect(formatTzDate(mockNow, TZ)).toBe("2026-08-20");

    // Unix timestamp 1787187600 = 2026-08-20
    expect(formatTzDate(1787187600, TZ)).toBe("2026-08-20");
  });

  describe("deadline_has_time = 0 (date-only deadlines)", () => {
    it("marks task due today as isDueToday=true and isOverdue=false during morning run (08:00)", () => {
      // 2026-08-20 23:59:59 in Asia/Ho_Chi_Minh -> 2026-08-20 16:59:59 UTC = 1787245199
      const todayUnix = 1787245199;

      const task: BaseWeworkTask = {
        id: 101,
        name: "Date-only task due today",
        status: "0",
        review: "0",
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
        review: "0",
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
        review: "0",
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
        review: "0",
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

    it("marks time-specific task earlier today (07:00) as isDueToday=true AND isOverdue=true at 08:00", () => {
      // 2026-08-20 07:00:00 VN (00:00:00 UTC) = 1787184000
      const earlierTodayUnix = 1787184000;

      const task: BaseWeworkTask = {
        id: 202,
        name: "Task was due at 7 AM today",
        status: "0",
        review: "0",
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

  describe("Review state exclusion & status filtering", () => {
    it("excludes task currently under review (review='1') even if incomplete", () => {
      const task: BaseWeworkTask = {
        id: 401,
        name: "Task submitted for manager review",
        status: "0",
        review: "1",
        has_deadline: 1,
        deadline: 1787245199, // Today
        overdue: 0,
      };

      const result = classifyWeworkTask(task, TZ, mockNow);
      expect(result.actionable).toBe(false);
    });

    it("excludes task currently under review (numeric review=1) when overdue", () => {
      const task: BaseWeworkTask = {
        id: 402,
        name: "Overdue task waiting for review",
        status: "0",
        review: 1,
        has_deadline: 1,
        deadline: 1787158799, // Yesterday
        overdue: 1,
      };

      const result = classifyWeworkTask(task, TZ, mockNow);
      expect(result.actionable).toBe(false);
    });

    it("ignores completed tasks (status='1')", () => {
      const task: BaseWeworkTask = {
        id: 301,
        name: "Completed task",
        status: "1",
        review: "0",
        deadline: 1787245199,
        overdue: 1,
      };

      const result = classifyWeworkTask(task, TZ, mockNow);
      expect(result.actionable).toBe(false);
    });

    it("includes incomplete task with no deadline but overdue=1 when review='0'", () => {
      const task: BaseWeworkTask = {
        id: 302,
        name: "Overdue task without deadline timestamp",
        status: "0",
        review: "0",
        deadline: 0,
        overdue: 1,
      };

      const result = classifyWeworkTask(task, TZ, mockNow);
      expect(result.actionable).toBe(true);
      expect(result.isOverdue).toBe(true);
      expect(result.isDueToday).toBe(false);
    });
  });

  describe("Real-Data Shaped Regression Pipeline (API -> Collector -> ActionItem)", () => {
    it("correctly filters tasks A, B, C, D, E from realistic API payload", async () => {
      const mockPayload: BaseWeworkTask[] = [
        // A. Active overdue task -> INCLUDED
        {
          id: 10505978,
          name: "Minigame dự đoán Worldcup trên Facebook",
          status: "0",
          review: "0",
          overdue: 1,
          has_deadline: "1",
          deadline: "1785517199", // Overdue in 2026
          link: "base-wework://digital-210679?task=10505978",
        },
        // B. Active task due today -> INCLUDED
        {
          id: 10505979,
          name: "Hoàn thiện nội dung website VP Racing",
          status: "0",
          review: "0",
          overdue: 0,
          has_deadline: "1",
          deadline: "1787245199", // Today 2026-08-20
          link: "base-wework://digital-210679?task=10505979",
        },
        // C. Completed task -> EXCLUDED
        {
          id: 10505738,
          name: "Chuyển đổi các kênh YouTube",
          status: "1",
          review: "0",
          overdue: 0,
          has_deadline: "1",
          deadline: "1781715599",
        },
        // D. Task currently under review -> EXCLUDED
        {
          id: 9784217,
          name: "Tạo thư mục Google Drive tổng hợp tài liệu VP Racing",
          status: "0",
          review: "1",
          overdue: 0,
          has_deadline: "0",
          deadline: "0",
        },
        // E. Review-state task that is overdue -> still EXCLUDED
        {
          id: 9784138,
          name: "Master Plan 2026 - Digital",
          status: "0",
          review: "1",
          overdue: 1,
          has_deadline: "1",
          deadline: "1775408399",
        },
      ];

      const mockClient = {
        getAllUserTasks: async () => mockPayload,
      } as unknown as WeworkApiClient;

      const actionableTasks = await collectWeworkTasks(mockClient, "Digital01", TZ, mockNow);

      // Verify only A and B are returned
      expect(actionableTasks.length).toBe(2);

      // Task A (Overdue)
      expect(actionableTasks[0]?.id).toBe(10505978);
      expect(actionableTasks[0]?.name).toBe("Minigame dự đoán Worldcup trên Facebook");
      expect(actionableTasks[0]?.isOverdue).toBe(true);
      expect(actionableTasks[0]?.url).toBe("https://wework.base.vn/tasks?task=10505978");

      // Task B (Due Today)
      expect(actionableTasks[1]?.id).toBe(10505979);
      expect(actionableTasks[1]?.name).toBe("Hoàn thiện nội dung website VP Racing");
      expect(actionableTasks[1]?.isDueToday).toBe(true);
      expect(actionableTasks[1]?.url).toBe("https://wework.base.vn/tasks?task=10505979");

      // Excluded tasks verification
      const ids = actionableTasks.map((t) => t.id);
      expect(ids).not.toContain(10505738); // C: Completed
      expect(ids).not.toContain(9784217);  // D: Review
      expect(ids).not.toContain(9784138);  // E: Review + Overdue
    });
  });

  describe("In-progress tasks & Start time classification", () => {
    it("marks task starting today as isStartingToday=true, isInProgress=true, actionable=true even with future deadline", () => {
      // 2026-08-20 in VN -> 1787187600
      const todayUnix = 1787187600;
      // Deadline next week: 2026-08-27 -> 1787849999
      const futureDeadlineUnix = 1787849999;

      const task: BaseWeworkTask = {
        id: 501,
        name: "Task starting today with future deadline",
        status: "0",
        review: "0",
        start_time: todayUnix,
        has_deadline: 1,
        deadline: futureDeadlineUnix,
        overdue: 0,
      };

      const result = classifyWeworkTask(task, TZ, mockNow);

      expect(result.actionable).toBe(true);
      expect(result.isStartingToday).toBe(true);
      expect(result.isInProgress).toBe(true);
      expect(result.isDueToday).toBe(false);
      expect(result.isOverdue).toBe(false);
    });

    it("marks task past its start date as isInProgress=true, actionable=true even with future deadline", () => {
      // Started 3 days ago: 2026-08-17 -> 1786928400
      const pastStartUnix = 1786928400;
      // Deadline next week: 2026-08-27 -> 1787849999
      const futureDeadlineUnix = 1787849999;

      const task: BaseWeworkTask = {
        id: 502,
        name: "Task started 3 days ago, in progress",
        status: "0",
        review: "0",
        start_time: pastStartUnix,
        has_deadline: 1,
        deadline: futureDeadlineUnix,
        overdue: 0,
      };

      const result = classifyWeworkTask(task, TZ, mockNow);

      expect(result.actionable).toBe(true);
      expect(result.isStartingToday).toBe(false);
      expect(result.isInProgress).toBe(true);
      expect(result.isDueToday).toBe(false);
      expect(result.isOverdue).toBe(false);
    });

    it("marks task past start date with NO deadline as isInProgress=true, actionable=true", () => {
      const pastStartUnix = 1786928400;

      const task: BaseWeworkTask = {
        id: 503,
        name: "Task started in past without deadline",
        status: "0",
        review: "0",
        stime: pastStartUnix,
        has_deadline: 0,
        deadline: 0,
        overdue: 0,
      };

      const result = classifyWeworkTask(task, TZ, mockNow);

      expect(result.actionable).toBe(true);
      expect(result.isInProgress).toBe(true);
      expect(result.isDueToday).toBe(false);
      expect(result.isOverdue).toBe(false);
    });

    it("marks task with started=1 as isInProgress=true, actionable=true even without start_time", () => {
      const task: BaseWeworkTask = {
        id: 504,
        name: "Task explicitly started by user",
        status: "0",
        review: "0",
        started: 1,
        deadline: 1787849999, // Future deadline
        overdue: 0,
      };

      const result = classifyWeworkTask(task, TZ, mockNow);

      expect(result.actionable).toBe(true);
      expect(result.isInProgress).toBe(true);
      expect(result.isDueToday).toBe(false);
      expect(result.isOverdue).toBe(false);
    });

    it("marks task with progress logged (complete > 0%) as isInProgress=true, actionable=true", () => {
      const task: BaseWeworkTask = {
        id: 505,
        name: "Task with 45% progress",
        status: "0",
        review: "0",
        complete: "45.00",
        deadline: 1787849999, // Future deadline
        overdue: 0,
      };

      const result = classifyWeworkTask(task, TZ, mockNow);

      expect(result.actionable).toBe(true);
      expect(result.isInProgress).toBe(true);
    });

    it("excludes task with future start date (has not started yet)", () => {
      // Starts tomorrow: 2026-08-21 -> 1787331599
      const tomorrowStartUnix = 1787331599;

      const task: BaseWeworkTask = {
        id: 506,
        name: "Task scheduled to start tomorrow",
        status: "0",
        review: "0",
        start_time: tomorrowStartUnix,
        started: 0,
        deadline: 1787849999, // Future deadline
        overdue: 0,
      };

      const result = classifyWeworkTask(task, TZ, mockNow);

      expect(result.actionable).toBe(false);
      expect(result.isInProgress).toBe(false);
      expect(result.isStartingToday).toBe(false);
    });

    it("excludes unscheduled backlog task (no start_time, no deadline, not started)", () => {
      const task: BaseWeworkTask = {
        id: 507,
        name: "Backlog task with no dates",
        status: "0",
        review: "0",
        start_time: 0,
        stime: 0,
        deadline: 0,
        started: 0,
        complete: "0.00",
        overdue: 0,
      };

      const result = classifyWeworkTask(task, TZ, mockNow);

      expect(result.actionable).toBe(false);
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
