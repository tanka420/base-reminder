/**
 * src/__tests__/preview-fixture.test.ts
 *
 * Tests for synthetic preview fixtures and preview CLI safety properties.
 */

import { describe, it, expect } from "vitest";
import { buildSyntheticDigest } from "../cli/send-preview.js";
import { formatTelegramDigest } from "../telegram/formatter.js";

describe("Synthetic Preview Fixtures & Formatting", () => {
  it("builds expanded fixture 'all' (18 items) with count-free module headers and restarting numbering", () => {
    const digest = buildSyntheticDigest(101, "Digital01", "Digital Specialist", "all", "2026-08-20");

    expect(digest.counts.wework).toBe(6);
    expect(digest.counts.workflow).toBe(6);
    expect(digest.counts.request).toBe(6);
    expect(digest.counts.total).toBe(18);

    const chunks = formatTelegramDigest(digest);
    expect(chunks.length).toBe(1);

    const message = chunks[0]!;

    // 1. Header with DD/MM/YYYY
    expect(message).toContain("☀️ <b>CÔNG VIỆC HÔM NAY 20/08/2026</b>");

    // 2. Wework (Count-free module header, 3 Quá hạn, 3 Hôm nay, numbering restarts at 1)
    expect(message).toContain("📋 <b>Wework</b>");
    expect(message).not.toContain("📋 <b>Wework · 6</b>");
    expect(message).toContain("🔴 <b>Quá hạn · 3</b>");
    expect(message).toContain('1. Minigame dự đoán Worldcup trên Facebook · <a href="https://wework.base.vn/tasks?task=1001">Link</a>');
    expect(message).toContain('2. Thiết lập Website / Landing Page · <a href="https://wework.base.vn/tasks?task=1002">Link</a>');
    expect(message).toContain('3. Cập nhật giao diện Shopee / TikTok Shop · <a href="https://wework.base.vn/tasks?task=1003">Link</a>');

    expect(message).toContain("🟡 <b>Hôm nay · 3</b>");
    expect(message).toContain('1. Hoàn thiện nội dung website VP Racing · <a href="https://wework.base.vn/tasks?task=1004">Link</a>');
    expect(message).toContain('2. Chuẩn bị báo cáo Digital Marketing · <a href="https://wework.base.vn/tasks?task=1005">Link</a>');
    expect(message).toContain('3. Kiểm tra nội dung Landing Page · <a href="https://wework.base.vn/tasks?task=1006">Link</a>');

    // 3. Workflow (Count-free module header, 3 Quá hạn, 3 Hôm nay, numbering restarts at 1)
    expect(message).toContain("⚙️ <b>Workflow</b>");
    expect(message).not.toContain("⚙️ <b>Workflow · 6</b>");
    expect(message).toContain("🔴 <b>Quá hạn · 3</b>");
    expect(message).toContain("1. Duyệt thiết kế Landing Page Voltronic\n   Giai đoạn: Manager Review · <a href=\"https://workflow.base.vn/job/2001\">Link</a>");
    expect(message).toContain("2. Xác nhận kế hoạch Media tháng 8\n   Giai đoạn: Approval · <a href=\"https://workflow.base.vn/job/2002\">Link</a>");
    expect(message).toContain("3. Kiểm tra nội dung chiến dịch VP Racing\n   Giai đoạn: Final Review · <a href=\"https://workflow.base.vn/job/2003\">Link</a>");

    expect(message).toContain("🟡 <b>Hôm nay · 3</b>");
    expect(message).toContain("1. Phê duyệt nội dung Facebook tháng 8\n   Giai đoạn: Manager Approval · <a href=\"https://workflow.base.vn/job/2004\">Link</a>");
    expect(message).toContain("2. Xác nhận kế hoạch quảng cáo\n   Giai đoạn: Director Review · <a href=\"https://workflow.base.vn/job/2005\">Link</a>");
    expect(message).toContain("3. Duyệt ngân sách Digital\n   Giai đoạn: Finance Approval · <a href=\"https://workflow.base.vn/job/2006\">Link</a>");

    // 4. Request (Count-free module header, 3 Quá hạn, 3 Hôm nay, numbering restarts at 1)
    expect(message).toContain("✅ <b>Request</b>");
    expect(message).not.toContain("✅ <b>Request · 6</b>");
    expect(message).toContain("🔴 <b>Quá hạn · 3</b>");
    expect(message).toContain('1. Đề nghị thanh toán ngân sách Facebook Ads · <a href="https://request.base.vn/home?request=3001">Link</a>');
    expect(message).toContain('2. Đề nghị mua thiết bị quay video · <a href="https://request.base.vn/home?request=3002">Link</a>');
    expect(message).toContain('3. Đề nghị duyệt chi phí sự kiện · <a href="https://request.base.vn/home?request=3003">Link</a>');

    expect(message).toContain("🟡 <b>Hôm nay · 3</b>");
    expect(message).toContain('1. Đề nghị duyệt ngân sách TikTok Ads · <a href="https://request.base.vn/home?request=3004">Link</a>');
    expect(message).toContain('2. Đề nghị mua vật tư Media · <a href="https://request.base.vn/home?request=3005">Link</a>');
    expect(message).toContain('3. Đề nghị thanh toán hosting · <a href="https://request.base.vn/home?request=3006">Link</a>');

    // 5. Verify forbidden words are absent
    expect(message).not.toContain("Mở trên Base");
    expect(message).not.toContain("Đến hạn hôm nay");
    expect(message).not.toContain("· Mở");
    expect(message).not.toContain("Quá hạn · 0");
    expect(message).not.toContain("Hôm nay · 0");
  });

  it("builds fixture 'workflow' with zero-state Wework & Request", () => {
    const digest = buildSyntheticDigest(101, "Digital01", "Digital Specialist", "workflow", "2026-08-20");

    expect(digest.counts.wework).toBe(0);
    expect(digest.counts.workflow).toBe(6);
    expect(digest.counts.request).toBe(0);

    const chunks = formatTelegramDigest(digest);
    expect(chunks.length).toBe(1);
    expect(chunks[0]).toContain("📋 <b>Wework</b>\nKhông có việc cần xử lý.");
    expect(chunks[0]).toContain("⚙️ <b>Workflow</b>");
    expect(chunks[0]).toContain("✅ <b>Request</b>\nKhông có việc cần xử lý.");
  });

  it("builds fixture 'request' with zero-state Wework & Workflow", () => {
    const digest = buildSyntheticDigest(101, "Digital01", "Digital Specialist", "request", "2026-08-20");

    expect(digest.counts.wework).toBe(0);
    expect(digest.counts.workflow).toBe(0);
    expect(digest.counts.request).toBe(6);

    const chunks = formatTelegramDigest(digest);
    expect(chunks.length).toBe(1);
    expect(chunks[0]).toContain("📋 <b>Wework</b>\nKhông có việc cần xử lý.");
    expect(chunks[0]).toContain("⚙️ <b>Workflow</b>\nKhông có việc cần xử lý.");
    expect(chunks[0]).toContain("✅ <b>Request</b>");
  });

  it("builds fixture 'mixed' (actions + zero-state + failure)", () => {
    const digest = buildSyntheticDigest(101, "Digital01", "Digital Specialist", "mixed", "2026-08-20");

    expect(digest.isPartial).toBe(true);
    expect(digest.wework.items.length).toBe(2);
    expect(digest.workflow.items.length).toBe(0);
    expect(digest.request.status).toBe("error");

    const chunks = formatTelegramDigest(digest);
    expect(chunks.length).toBe(1);
    const msg = chunks[0]!;

    // Wework has actions
    expect(msg).toContain("📋 <b>Wework</b>");
    expect(msg).toContain("🔴 <b>Quá hạn · 2</b>");

    // Workflow has 0 actions -> Không có việc cần xử lý.
    expect(msg).toContain("⚙️ <b>Workflow</b>\nKhông có việc cần xử lý.");

    // Request failed -> NOT rendered as zero-state, listed in warning footer
    expect(msg).not.toContain("✅ <b>Request</b>");
    expect(msg).not.toContain("✅ <b>Request</b>\nKhông có việc cần xử lý.");
    expect(msg).toContain("⚠️ <b>Dữ liệu có thể chưa đầy đủ</b>");
    expect(msg).toContain("Không thể tải dữ liệu: <b>Request</b>");
  });

  it("verifies exact verified URL formats for all 3 Base modules", () => {
    const digest = buildSyntheticDigest(101, "Digital01", "Digital Specialist", "all", "2026-08-20");

    // Wework URL
    expect(digest.wework.items[0]?.url).toBe("https://wework.base.vn/tasks?task=1001");
    // Workflow URL
    expect(digest.workflow.items[0]?.url).toBe("https://workflow.base.vn/job/2001");
    // Request URL
    expect(digest.request.items[0]?.url).toBe("https://request.base.vn/home?request=3001");
  });
});
