/**
 * src/__tests__/telegram-formatter.test.ts
 *
 * Unit tests for Final Telegram Digest Formatter:
 *  - Module headers have NO total counts (e.g. `📋 <b>Wework</b>`, never `📋 <b>Wework · N</b>`)
 *  - Overdue=0, today>0 -> only Hôm nay group rendered
 *  - Overdue>0, today=0 -> only Quá hạn group rendered
 *  - Overdue>0, today>0 -> both Quá hạn and Hôm nay rendered
 *  - Successful module with 0 items -> renders `Không có việc cần xử lý.`
 *  - Failed module is NOT rendered as zero-state; reported in partial warning footer
 *  - All three modules success + 0 -> returns empty array (no message sent)
 *  - Mixed digest shows successful zero-state module
 *  - Partial digest distinguishes failure from success+zero
 *  - No "· 0" module header remains
 *  - No zero-count deadline group is rendered
 *  - Vietnamese localization with DD/MM/YYYY header
 *  - Inline CTA: `· <a href="...">Link</a>`
 *  - Exact canonical URL verification
 */

import { describe, it, expect } from "vitest";
import {
  formatTelegramDigest,
  formatWelcomeDigest,
  truncateText,
  formatHeaderDate,
  MAX_CHUNK_LENGTH,
} from "../telegram/formatter.js";
import type { UserDigest, ActionableTask, ActionableJob, ActionableRequest } from "../digest/types.js";

function createBaseDigest(overrides: Partial<UserDigest> = {}): UserDigest {
  return {
    baseUserId: 101,
    username: "testuser",
    displayName: "Test User",
    status: "ready",
    isPartial: false,
    runDate: "2026-08-20",
    wework: { status: "ok", items: [] },
    workflow: { status: "ok", items: [] },
    request: { status: "ok", items: [] },
    counts: { wework: 0, workflow: 0, request: 0, total: 0 },
    ...overrides,
  };
}

describe("Telegram Digest Formatter", () => {
  it("formats header date correctly as DD/MM/YYYY in Asia/Ho_Chi_Minh", () => {
    expect(formatHeaderDate("2026-08-20")).toBe("20/08/2026");
    expect(formatHeaderDate(new Date("2026-08-20T01:15:00.000Z"), "Asia/Ho_Chi_Minh")).toBe("20/08/2026");
  });

  it("should return empty array for all-successful zero-count digest (status = 'empty')", () => {
    const digest = createBaseDigest({
      status: "empty",
      isPartial: false,
      wework: { status: "ok", items: [] },
      workflow: { status: "ok", items: [] },
      request: { status: "ok", items: [] },
      counts: { wework: 0, workflow: 0, request: 0, total: 0 },
    });
    const chunks = formatTelegramDigest(digest);
    expect(chunks).toEqual([]);
  });

  it("should return empty array for all-failed error digest (status = 'error')", () => {
    const digest = createBaseDigest({
      status: "error",
      isPartial: true,
      wework: { status: "error", items: [], error: "Fail" },
      workflow: { status: "error", items: [], error: "Fail" },
      request: { status: "error", items: [], error: "Fail" },
    });
    const chunks = formatTelegramDigest(digest);
    expect(chunks).toEqual([]);
  });

  it("renders module header WITHOUT total count and renders only overdue when overdue>0, today=0", () => {
    const task: ActionableTask = {
      id: 1234,
      name: "Báo cáo tiến độ dự án Alpha",
      isOverdue: true,
      isDueToday: false,
      url: "https://wework.base.vn/tasks?task=1234",
    };

    const digest = createBaseDigest({
      status: "ready",
      runDate: "2026-08-20",
      wework: { status: "ok", items: [task] },
      workflow: { status: "ok", items: [] },
      request: { status: "ok", items: [] },
      counts: { wework: 1, workflow: 0, request: 0, total: 1 },
    });

    const chunks = formatTelegramDigest(digest);
    expect(chunks.length).toBe(1);
    const msg = chunks[0]!;

    // Header without count
    expect(msg).toContain("📋 <b>Wework</b>");
    expect(msg).not.toContain("📋 <b>Wework · 1</b>");
    expect(msg).not.toContain("📋 Wework ·");

    // Only overdue rendered
    expect(msg).toContain("🔴 <b>Quá hạn · 1</b>");
    expect(msg).toContain('1. Báo cáo tiến độ dự án Alpha · <a href="https://wework.base.vn/tasks?task=1234">Link</a>');

    // Zero-count Hôm nay is HIDDEN
    expect(msg).not.toContain("Hôm nay · 0");
    expect(msg).not.toContain("🟡 <b>Hôm nay");

    // Successful modules with 0 items render zero-state text
    expect(msg).toContain("⚙️ <b>Workflow</b>\nKhông có việc cần xử lý.");
    expect(msg).toContain("✅ <b>Request</b>\nKhông có việc cần xử lý.");
  });

  it("renders only Hôm nay when overdue=0, today>0", () => {
    const task: ActionableTask = {
      id: 5678,
      name: "Gửi kế hoạch Beta",
      isOverdue: false,
      isDueToday: true,
      url: "https://wework.base.vn/tasks?task=5678",
    };

    const digest = createBaseDigest({
      status: "ready",
      runDate: "2026-08-20",
      wework: { status: "ok", items: [task] },
      workflow: { status: "ok", items: [] },
      request: { status: "ok", items: [] },
      counts: { wework: 1, workflow: 0, request: 0, total: 1 },
    });

    const chunks = formatTelegramDigest(digest);
    expect(chunks.length).toBe(1);
    const msg = chunks[0]!;

    expect(msg).toContain("📋 <b>Wework</b>");
    expect(msg).toContain("🟡 <b>Hạn chót hôm nay · 1</b>");
    expect(msg).toContain('1. Gửi kế hoạch Beta · <a href="https://wework.base.vn/tasks?task=5678">Link</a>');

    // Quá hạn · 0 is HIDDEN
    expect(msg).not.toContain("Quá hạn · 0");
    expect(msg).not.toContain("🔴 <b>Quá hạn");
  });

  it("renders both Quá hạn and Hạn chót hôm nay when overdue>0, today>0 without module total counts", () => {
    const overdueTask: ActionableTask = {
      id: 1234,
      name: "Báo cáo tiến độ Alpha",
      isOverdue: true,
      isDueToday: false,
      url: "https://wework.base.vn/tasks?task=1234",
    };

    const dueTodayTask: ActionableTask = {
      id: 5678,
      name: "Gửi kế hoạch Beta",
      isOverdue: false,
      isDueToday: true,
      url: "https://wework.base.vn/tasks?task=5678",
    };

    const digest = createBaseDigest({
      status: "ready",
      runDate: "2026-08-20",
      wework: { status: "ok", items: [overdueTask, dueTodayTask] },
      workflow: { status: "ok", items: [] },
      request: { status: "ok", items: [] },
      counts: { wework: 2, workflow: 0, request: 0, total: 2 },
    });

    const chunks = formatTelegramDigest(digest);
    expect(chunks.length).toBe(1);
    const msg = chunks[0]!;

    expect(msg).toContain("📋 <b>Wework</b>");
    expect(msg).not.toContain("📋 <b>Wework · 2</b>");
    expect(msg).toContain("🔴 <b>Quá hạn · 1</b>");
    expect(msg).toContain('1. Báo cáo tiến độ Alpha · <a href="https://wework.base.vn/tasks?task=1234">Link</a>');
    expect(msg).toContain("🟡 <b>Hạn chót hôm nay · 1</b>");
    expect(msg).toContain('1. Gửi kế hoạch Beta · <a href="https://wework.base.vn/tasks?task=5678">Link</a>');
  });

  it("formats mixed digest with successful zero-state modules as expected in user spec", () => {
    const w1: ActionableTask = {
      id: 101,
      name: "Công việc A",
      isOverdue: true,
      isDueToday: false,
      url: "https://wework.base.vn/tasks?task=101",
    };
    const w2: ActionableTask = {
      id: 102,
      name: "Công việc B",
      isOverdue: true,
      isDueToday: false,
      url: "https://wework.base.vn/tasks?task=102",
    };
    const w3: ActionableTask = {
      id: 103,
      name: "Công việc C",
      isOverdue: true,
      isDueToday: false,
      url: "https://wework.base.vn/tasks?task=103",
    };
    const w4: ActionableTask = {
      id: 104,
      name: "Công việc D",
      isOverdue: false,
      isDueToday: true,
      url: "https://wework.base.vn/tasks?task=104",
    };

    const wf1: ActionableJob = {
      id: 201,
      name: "Duyệt nội dung Landing Page",
      stageName: "Manager Review",
      isOverdue: false,
      isDueToday: true,
      url: "https://workflow.base.vn/job/201",
    };
    const wf2: ActionableJob = {
      id: 202,
      name: "Xác nhận kế hoạch Media",
      stageName: "Approval",
      isOverdue: false,
      isDueToday: true,
      url: "https://workflow.base.vn/job/202",
    };

    const digest = createBaseDigest({
      status: "ready",
      runDate: "2026-08-20",
      wework: { status: "ok", items: [w1, w2, w3, w4] },
      workflow: { status: "ok", items: [wf1, wf2] },
      request: { status: "ok", items: [] }, // 0 items
      counts: { wework: 4, workflow: 2, request: 0, total: 6 },
    });

    const chunks = formatTelegramDigest(digest);
    expect(chunks.length).toBe(1);
    const msg = chunks[0]!;

    expect(msg).toContain("☀️ <b>CÔNG VIỆC HÔM NAY 20/08/2026</b>");

    // Wework: 3 overdue, 1 today
    expect(msg).toContain("📋 <b>Wework</b>");
    expect(msg).toContain("🔴 <b>Quá hạn · 3</b>");
    expect(msg).toContain("🟡 <b>Hạn chót hôm nay · 1</b>");

    // Workflow: 0 overdue (hidden), 2 today
    expect(msg).toContain("⚙️ <b>Workflow</b>");
    expect(msg).not.toContain("⚙️ <b>Workflow</b>\n\n🔴 <b>Quá hạn");
    expect(msg).toContain("🟡 <b>Hôm nay · 2</b>");
    expect(msg).toContain("1. Duyệt nội dung Landing Page\n   Giai đoạn: Manager Review · <a href=\"https://workflow.base.vn/job/201\">Link</a>");
    expect(msg).toContain("2. Xác nhận kế hoạch Media\n   Giai đoạn: Approval · <a href=\"https://workflow.base.vn/job/202\">Link</a>");

    // Request: 0 items -> Không có việc cần xử lý.
    expect(msg).toContain("✅ <b>Request</b>\nKhông có việc cần xử lý.");

    // No zero-counts in any headers
    expect(msg).not.toContain("Quá hạn · 0");
    expect(msg).not.toContain("Hôm nay · 0");
    expect(msg).not.toContain("· 0");
  });

  it("renders Quá hạn, Hạn chót hôm nay, and Đang thực hiện for Wework", () => {
    const overdueTask: ActionableTask = {
      id: 1,
      name: "Việc quá hạn A",
      isOverdue: true,
      isDueToday: false,
      url: "https://wework.base.vn/tasks?task=1",
    };
    const dueTodayTask: ActionableTask = {
      id: 2,
      name: "Việc hạn chót hôm nay B",
      isOverdue: false,
      isDueToday: true,
      url: "https://wework.base.vn/tasks?task=2",
    };
    const inProgressTask: ActionableTask = {
      id: 3,
      name: "Việc đang làm dở dang C",
      isOverdue: false,
      isDueToday: false,
      isInProgress: true,
      url: "https://wework.base.vn/tasks?task=3",
    };

    const digest = createBaseDigest({
      status: "ready",
      runDate: "2026-08-20",
      wework: { status: "ok", items: [overdueTask, dueTodayTask, inProgressTask] },
      workflow: { status: "ok", items: [] },
      request: { status: "ok", items: [] },
      counts: { wework: 3, workflow: 0, request: 0, total: 3 },
    });

    const chunks = formatTelegramDigest(digest);
    expect(chunks.length).toBe(1);
    const msg = chunks[0]!;

    expect(msg).toContain("📋 <b>Wework</b>");
    expect(msg).toContain("🔴 <b>Quá hạn · 1</b>");
    expect(msg).toContain('1. Việc quá hạn A · <a href="https://wework.base.vn/tasks?task=1">Link</a>');
    expect(msg).toContain("🟡 <b>Hạn chót hôm nay · 1</b>");
    expect(msg).toContain('1. Việc hạn chót hôm nay B · <a href="https://wework.base.vn/tasks?task=2">Link</a>');
    expect(msg).toContain("🔵 <b>Đang thực hiện · 1</b>");
    expect(msg).toContain('1. Việc đang làm dở dang C · <a href="https://wework.base.vn/tasks?task=3">Link</a>');
  });

  it("distinguishes failed module from successful zero-state module in partial digest", () => {
    const w1: ActionableTask = {
      id: 101,
      name: "Công việc A",
      isOverdue: true,
      isDueToday: false,
      url: "https://wework.base.vn/tasks?task=101",
    };
    const w2: ActionableTask = {
      id: 102,
      name: "Công việc B",
      isOverdue: true,
      isDueToday: false,
      url: "https://wework.base.vn/tasks?task=102",
    };

    const digest = createBaseDigest({
      status: "partial",
      isPartial: true,
      runDate: "2026-08-20",
      wework: { status: "ok", items: [w1, w2] },
      workflow: { status: "ok", items: [] }, // Success + 0
      request: { status: "error", items: [], error: "500 Timeout" }, // Failed
      counts: { wework: 2, workflow: 0, request: 0, total: 2 },
    });

    const chunks = formatTelegramDigest(digest);
    expect(chunks.length).toBe(1);
    const msg = chunks[0]!;

    // Wework rendered
    expect(msg).toContain("📋 <b>Wework</b>");
    expect(msg).toContain("🔴 <b>Quá hạn · 2</b>");

    // Workflow (Success + 0) rendered as zero-state
    expect(msg).toContain("⚙️ <b>Workflow</b>\nKhông có việc cần xử lý.");

    // Request (Failed) is NOT rendered as zero-state
    expect(msg).not.toContain("✅ <b>Request</b>");
    expect(msg).not.toContain("✅ <b>Request</b>\nKhông có việc cần xử lý.");

    // Request is reported in partial warning footer
    expect(msg).toContain("⚠️ <b>Dữ liệu có thể chưa đầy đủ</b>");
    expect(msg).toContain("Không thể tải dữ liệu: <b>Request</b>");
  });

  it("should properly HTML escape dangerous characters in titles and stage names", () => {
    const task: ActionableTask = {
      id: 999,
      name: '<script>alert("hack")</script> & Task <Test>',
      isOverdue: true,
      isDueToday: false,
      url: "https://wework.base.vn/tasks?task=999",
    };

    const job: ActionableJob = {
      id: 888,
      name: 'Job with & "Quotes"',
      stageName: "Stage <Dangerous> & More",
      isOverdue: false,
      isDueToday: true,
      url: "https://workflow.base.vn/job/888",
    };

    const digest = createBaseDigest({
      status: "ready",
      wework: { status: "ok", items: [task] },
      workflow: { status: "ok", items: [job] },
      request: { status: "ok", items: [] },
      counts: { wework: 1, workflow: 1, request: 0, total: 2 },
    });

    const chunks = formatTelegramDigest(digest);
    expect(chunks[0]).not.toContain("<script>");
    expect(chunks[0]).toContain("&lt;script&gt;alert(&quot;hack&quot;)&lt;/script&gt; &amp; Task &lt;Test&gt;");
    expect(chunks[0]).toContain("Job with &amp; &quot;Quotes&quot;");
    expect(chunks[0]).toContain("Giai đoạn: Stage &lt;Dangerous&gt; &amp; More");
  });

  it("should safely truncate very long titles at 180 characters", () => {
    const longTitle = "A".repeat(250);
    const truncated = truncateText(longTitle, 180);
    expect(truncated.length).toBe(180);
    expect(truncated.endsWith("...")).toBe(true);
  });

  it("should split large digest into multiple chunks respecting MAX_CHUNK_LENGTH", () => {
    const tasks: ActionableTask[] = [];
    for (let i = 1; i <= 60; i++) {
      tasks.push({
        id: i,
        name: `Công việc số ${i}: ${"Mô tả chi tiết nhiệm vụ quan trọng cần thực hiện trước hạn ".repeat(2)}`,
        isOverdue: i % 2 === 0,
        isDueToday: i % 2 !== 0,
        url: `https://wework.base.vn/tasks?task=${i}`,
      });
    }

    const digest = createBaseDigest({
      status: "ready",
      wework: { status: "ok", items: tasks },
      workflow: { status: "ok", items: [] },
      request: { status: "ok", items: [] },
      counts: { wework: tasks.length, workflow: 0, request: 0, total: tasks.length },
    });

    const chunks = formatTelegramDigest(digest);
    expect(chunks.length).toBeGreaterThan(1);

    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(MAX_CHUNK_LENGTH);
      const openTags = (chunk.match(/<a /g) || []).length;
      const closeTags = (chunk.match(/<\/a>/g) || []).length;
      expect(openTags).toBe(closeTags);
      expect(chunk).toContain('href="https://wework.base.vn/tasks?task=');
    }
  });

  describe("formatWelcomeDigest (Onboarding Preview)", () => {
    it("renders welcome header, categories, and schedule footer for user with tasks", () => {
      const task: ActionableTask = {
        id: 101,
        name: "Hoàn thiện kế hoạch quý 3",
        isOverdue: false,
        isDueToday: true,
        url: "https://wework.base.vn/tasks?task=101",
      };

      const digest = createBaseDigest({
        status: "ready",
        runDate: "2026-08-25",
        wework: { status: "ok", items: [task] },
        workflow: { status: "ok", items: [] },
        request: { status: "ok", items: [] },
        counts: { wework: 1, workflow: 0, request: 0, total: 1 },
      });

      const chunks = formatWelcomeDigest(digest);
      expect(chunks.length).toBe(1);
      const msg = chunks[0]!;

      // Welcome header
      expect(msg).toContain("👋 <b>CHÀO MỪNG BẠN ĐẾN VỚI BASE REMINDER</b>");
      expect(msg).toContain("Dưới đây là ví dụ cách hệ thống hoạt động:");
      expect(msg).toContain("☀️ <b>CÔNG VIỆC HÔM NAY 25/08/2026</b>");

      // Wework item
      expect(msg).toContain("📋 <b>Wework</b>");
      expect(msg).toContain("🟡 <b>Hạn chót hôm nay · 1</b>");
      expect(msg).toContain("1. Hoàn thiện kế hoạch quý 3 · <a href=\"https://wework.base.vn/tasks?task=101\">Link</a>");

      // Zero-state for empty modules
      expect(msg).toContain("⚙️ <b>Workflow</b>\nKhông có việc cần xử lý.");
      expect(msg).toContain("✅ <b>Request</b>\nKhông có việc cần xử lý.");

      // Schedule footer
      expect(msg).toContain("⏰ <b>Lịch nhắc việc:</b>\nThứ 2 - Thứ 6 lúc 08:00");
      expect(msg).not.toContain("Múi giờ");
      expect(msg).toContain("Bạn có thể xem các chức năng hỗ trợ tại Menu của bot.");
    });

    it("renders complete onboarding preview when user has zero tasks across all modules", () => {
      const digest = createBaseDigest({
        status: "empty",
        runDate: "2026-08-25",
        wework: { status: "ok", items: [] },
        workflow: { status: "ok", items: [] },
        request: { status: "ok", items: [] },
        counts: { wework: 0, workflow: 0, request: 0, total: 0 },
      });

      const chunks = formatWelcomeDigest(digest);
      expect(chunks.length).toBe(1);
      const msg = chunks[0]!;

      expect(msg).toContain("👋 <b>CHÀO MỪNG BẠN ĐẾN VỚI BASE REMINDER</b>");
      expect(msg).toContain("📋 <b>Wework</b>\nKhông có việc cần xử lý.");
      expect(msg).toContain("⚙️ <b>Workflow</b>\nKhông có việc cần xử lý.");
      expect(msg).toContain("✅ <b>Request</b>\nKhông có việc cần xử lý.");
      expect(msg).toContain("⏰ <b>Lịch nhắc việc:</b>\nThứ 2 - Thứ 6 lúc 08:00");
    });
  });
});
