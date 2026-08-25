/**
 * src/telegram/formatter.ts
 *
 * Compact Telegram HTML Digest Formatter with Vietnamese localization and safe chunking.
 *
 * Design & Layout Rules:
 *  - Header: `☀️ <b>CÔNG VIỆC HÔM NAY DD/MM/YYYY</b>`
 *  - Date uses Asia/Ho_Chi_Minh business date.
 *  - Module headers have NO total counts: `📋 <b>Wework</b>`, `⚙️ <b>Workflow</b>`, `✅ <b>Request</b>`.
 *  - Counts appear ONLY on actionable deadline groups: `🔴 <b>Quá hạn · N</b>`, `🟡 <b>Hôm nay · N</b>`.
 *  - Zero-count deadline groups are hidden (never render `🔴 Quá hạn · 0` or `🟡 Hôm nay · 0`).
 *  - Successful module with 0 items renders: `Không có việc cần xử lý.`.
 *  - Failed module does NOT render as zero-state; reported in partial warning footer.
 *  - All-zero successful digest produces NO message (returns []).
 *  - Titles are plain text (NOT hyperlinked).
 *  - Compact inline CTA: `· <a href="...">Link</a>`.
 *  - Workflow second line: `   Giai đoạn: {stage_name} · <a href="...">Link</a>`.
 *  - Layout consistency: Items inside each module list are separated by newline (\n) without extra blank lines.
 *  - Strict HTML escaping of all Base-originated strings.
 *  - Safe title truncation at 180 chars.
 *  - Multi-chunking respects MAX_CHUNK_LENGTH (~3500 chars) and never splits inside tags/entities.
 */

import type { UserDigest, ActionableTask, ActionableJob, ActionableRequest } from "../digest/types.js";
import { escapeHtml } from "./utils/html.js";

export const MAX_CHUNK_LENGTH = 3500;
export const MAX_TITLE_LENGTH = 180;

/**
 * Truncate string safely before HTML escaping.
 */
export function truncateText(text: string | null | undefined, maxLength = MAX_TITLE_LENGTH): string {
  if (!text) return "";
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return trimmed.substring(0, maxLength - 3).trimEnd() + "...";
}

/**
 * Format a YYYY-MM-DD or Date to DD/MM/YYYY in Asia/Ho_Chi_Minh.
 */
export function formatHeaderDate(runDate?: string | Date, timezone = "Asia/Ho_Chi_Minh"): string {
  if (typeof runDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(runDate.trim())) {
    const parts = runDate.trim().split("-");
    const yyyy = parts[0];
    const mm = parts[1];
    const dd = parts[2];
    if (dd && mm && yyyy) {
      return `${dd}/${mm}/${yyyy}`;
    }
  }

  const d = runDate instanceof Date ? runDate : new Date();
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).formatToParts(d);

  const day = parts.find((p) => p.type === "day")?.value || "01";
  const month = parts.find((p) => p.type === "month")?.value || "01";
  const year = parts.find((p) => p.type === "year")?.value || "2026";

  return `${day}/${month}/${year}`;
}

/**
 * Format module failure names in Vietnamese.
 */
function getFailedModuleNames(digest: UserDigest): string[] {
  const failed: string[] = [];
  if (digest.wework.status === "error") failed.push("Wework");
  if (digest.workflow.status === "error") failed.push("Workflow");
  if (digest.request.status === "error") failed.push("Request");
  return failed;
}

interface FormattedBlock {
  header: string; // e.g. "🔴 <b>Quá hạn · 2</b>" or "" for zero-item module
  items: string[];
}

interface FormattedCategory {
  title: string; // e.g. "📋 <b>Wework</b>"
  blocks: FormattedBlock[];
}

/**
 * Build blocks for Wework category.
 */
function buildWeworkCategory(items: ActionableTask[]): FormattedCategory {
  const title = `📋 <b>Wework</b>`;

  if (items.length === 0) {
    return {
      title,
      blocks: [
        {
          header: "",
          items: ["Không có việc cần xử lý."],
        },
      ],
    };
  }

  const overdue = items.filter((t) => t.isOverdue);
  const dueToday = items.filter((t) => !t.isOverdue && t.isDueToday);
  const others = items.filter((t) => !t.isOverdue && !t.isDueToday);

  const blocks: FormattedBlock[] = [];

  if (overdue.length > 0) {
    blocks.push({
      header: `🔴 <b>Quá hạn · ${overdue.length}</b>`,
      items: overdue.map((item, idx) => {
        const itemTitle = escapeHtml(truncateText(item.name));
        const safeUrl = escapeHtml(item.url);
        return `${idx + 1}. ${itemTitle} · <a href="${safeUrl}">Link</a>`;
      }),
    });
  }

  if (dueToday.length > 0) {
    blocks.push({
      header: `🟡 <b>Hôm nay · ${dueToday.length}</b>`,
      items: dueToday.map((item, idx) => {
        const itemTitle = escapeHtml(truncateText(item.name));
        const safeUrl = escapeHtml(item.url);
        return `${idx + 1}. ${itemTitle} · <a href="${safeUrl}">Link</a>`;
      }),
    });
  }

  if (others.length > 0) {
    blocks.push({
      header: `📋 <b>Việc khác · ${others.length}</b>`,
      items: others.map((item, idx) => {
        const itemTitle = escapeHtml(truncateText(item.name));
        const safeUrl = escapeHtml(item.url);
        return `${idx + 1}. ${itemTitle} · <a href="${safeUrl}">Link</a>`;
      }),
    });
  }

  return { title, blocks };
}

/**
 * Build blocks for Workflow category.
 */
function buildWorkflowCategory(items: ActionableJob[]): FormattedCategory {
  const title = `⚙️ <b>Workflow</b>`;

  if (items.length === 0) {
    return {
      title,
      blocks: [
        {
          header: "",
          items: ["Không có việc cần xử lý."],
        },
      ],
    };
  }

  const overdue = items.filter((j) => j.isOverdue);
  const dueToday = items.filter((j) => !j.isOverdue && j.isDueToday);
  const others = items.filter((j) => !j.isOverdue && !j.isDueToday);

  const formatJobItem = (item: ActionableJob, idx: number) => {
    const itemTitle = escapeHtml(truncateText(item.name));
    const safeUrl = escapeHtml(item.url);
    const stage = item.stageName ? escapeHtml(truncateText(item.stageName, 60)) : "";
    const secondLine = stage
      ? `\n   Giai đoạn: ${stage} · <a href="${safeUrl}">Link</a>`
      : `\n   <a href="${safeUrl}">Link</a>`;
    return `${idx + 1}. ${itemTitle}${secondLine}`;
  };

  const blocks: FormattedBlock[] = [];

  if (overdue.length > 0) {
    blocks.push({
      header: `🔴 <b>Quá hạn · ${overdue.length}</b>`,
      items: overdue.map((item, idx) => formatJobItem(item, idx)),
    });
  }

  if (dueToday.length > 0) {
    blocks.push({
      header: `🟡 <b>Hôm nay · ${dueToday.length}</b>`,
      items: dueToday.map((item, idx) => formatJobItem(item, idx)),
    });
  }

  if (others.length > 0) {
    blocks.push({
      header: `⚙️ <b>Việc khác · ${others.length}</b>`,
      items: others.map((item, idx) => formatJobItem(item, idx)),
    });
  }

  return { title, blocks };
}

/**
 * Build blocks for Request category.
 */
function buildRequestCategory(items: ActionableRequest[]): FormattedCategory {
  const title = `✅ <b>Request</b>`;

  if (items.length === 0) {
    return {
      title,
      blocks: [
        {
          header: "",
          items: ["Không có việc cần xử lý."],
        },
      ],
    };
  }

  const overdue = items.filter((r) => r.isOverdue);
  const dueToday = items.filter((r) => !r.isOverdue && r.isDueToday);
  const others = items.filter((r) => !r.isOverdue && !r.isDueToday);

  const formatReqItem = (item: ActionableRequest, idx: number) => {
    const itemTitle = escapeHtml(truncateText(item.name));
    const safeUrl = escapeHtml(item.url);
    return `${idx + 1}. ${itemTitle} · <a href="${safeUrl}">Link</a>`;
  };

  const blocks: FormattedBlock[] = [];

  if (overdue.length > 0) {
    blocks.push({
      header: `🔴 <b>Quá hạn · ${overdue.length}</b>`,
      items: overdue.map((item, idx) => formatReqItem(item, idx)),
    });
  }

  if (dueToday.length > 0) {
    blocks.push({
      header: `🟡 <b>Hôm nay · ${dueToday.length}</b>`,
      items: dueToday.map((item, idx) => formatReqItem(item, idx)),
    });
  }

  if (others.length > 0) {
    blocks.push({
      header: `✅ <b>Việc khác · ${others.length}</b>`,
      items: others.map((item, idx) => formatReqItem(item, idx)),
    });
  }

  return { title, blocks };
}

/**
 * Format a complete UserDigest into an array of Telegram HTML message chunks.
 */
export function formatTelegramDigest(digest: UserDigest): string[] {
  // 1. True EMPTY digest (0 items across all OK modules) -> no message sent
  if (digest.status === "empty" || (!digest.isPartial && digest.counts.total === 0)) {
    return [];
  }

  // 2. All modules failed -> do not send standard task message
  if (digest.status === "error") {
    return [];
  }

  const failedModules = getFailedModuleNames(digest);

  // 3. Build categories only for OK modules (failed modules are reported in warning footer)
  const categories: FormattedCategory[] = [];

  if (digest.wework.status === "ok") {
    categories.push(buildWeworkCategory(digest.wework.items));
  }

  if (digest.workflow.status === "ok") {
    categories.push(buildWorkflowCategory(digest.workflow.items));
  }

  if (digest.request.status === "ok") {
    categories.push(buildRequestCategory(digest.request.items));
  }

  // Partial warning footer (if partial)
  let partialWarning = "";
  if (digest.isPartial && failedModules.length > 0) {
    const failedNames = failedModules.join(", ");
    partialWarning = `\n\n⚠️ <b>Dữ liệu có thể chưa đầy đủ</b>\nKhông thể tải dữ liệu: <b>${escapeHtml(failedNames)}</b>.`;
  }

  // 4. Assemble chunks sequentially
  const dateStr = formatHeaderDate(digest.runDate);
  const header = `☀️ <b>CÔNG VIỆC HÔM NAY ${dateStr}</b>\n`;
  const chunks: string[] = [];
  let currentChunk = header;

  for (const category of categories) {
    // Add category title
    const categoryHeader = `\n${category.title}\n`;
    if (currentChunk === header) {
      currentChunk += categoryHeader;
    } else {
      if ((currentChunk + "\n" + categoryHeader).length > MAX_CHUNK_LENGTH) {
        chunks.push(currentChunk.trim());
        currentChunk = `${header}\n${category.title} <i>(tiếp theo)</i>\n`;
      } else {
        currentChunk += `\n${categoryHeader}`;
      }
    }

    for (const block of category.blocks) {
      if (block.header) {
        if ((currentChunk + "\n" + block.header + "\n").length > MAX_CHUNK_LENGTH) {
          chunks.push(currentChunk.trim());
          currentChunk = `${header}\n${category.title} <i>(tiếp theo)</i>\n\n${block.header}\n`;
        } else {
          currentChunk += `\n${block.header}\n`;
        }
      }

      for (let i = 0; i < block.items.length; i++) {
        const item = block.items[i]!;
        const itemStr = `${item}\n`;

        if ((currentChunk + itemStr).length > MAX_CHUNK_LENGTH) {
          chunks.push(currentChunk.trim());
          const continuationHeader = block.header
            ? `${header}\n${category.title} <i>(tiếp theo)</i>\n\n${block.header} <i>(tiếp theo)</i>\n`
            : `${header}\n${category.title} <i>(tiếp theo)</i>\n`;
          currentChunk = continuationHeader + itemStr;
        } else {
          currentChunk += itemStr;
        }
      }
    }
  }

  // Handle partial warning
  if (partialWarning) {
    if ((currentChunk + partialWarning).length <= MAX_CHUNK_LENGTH) {
      currentChunk += partialWarning;
      chunks.push(currentChunk.trim());
    } else {
      chunks.push(currentChunk.trim());
      chunks.push(partialWarning.trim());
    }
  } else if (currentChunk.trim().length > 0 && currentChunk !== header) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}

export interface FormatWelcomeDigestOptions {
  timezone?: string;
}

/**
 * Format a UserDigest as a one-time onboarding welcome preview message.
 *
 * Distinct from standard daily digest:
 *  - Includes welcome introduction explaining system behavior.
 *  - Always renders even when user has zero tasks ("Không có việc cần xử lý.").
 *  - Appends reminder schedule and menu guidance footer.
 */
export function formatWelcomeDigest(
  digest: UserDigest,
  options: FormatWelcomeDigestOptions = {}
): string[] {
  const timezone = options.timezone ?? "Asia/Ho_Chi_Minh";
  const dateStr = formatHeaderDate(digest.runDate, timezone);

  const welcomeIntro =
    `👋 <b>CHÀO MỪNG BẠN ĐẾN VỚI BASE REMINDER</b>\n\n` +
    `Base Reminder sẽ tự động tổng hợp các công việc cần xử lý\n` +
    `và gửi nhắc việc cho bạn mỗi ngày.\n\n` +
    `Dưới đây là ví dụ cách hệ thống hoạt động:\n\n` +
    `☀️ <b>CÔNG VIỆC HÔM NAY ${dateStr}</b>\n`;

  const welcomeFooter =
    `\n\n---\n\n` +
    `⏰ <b>Lịch nhắc việc:</b>\n` +
    `Thứ 2 - Thứ 6 lúc 08:00\n\n` +
    `Bạn có thể xem các chức năng hỗ trợ tại Menu của bot.`;

  const failedModules = getFailedModuleNames(digest);

  // Build categories for OK modules
  const categories: FormattedCategory[] = [];

  if (digest.wework.status === "ok") {
    categories.push(buildWeworkCategory(digest.wework.items));
  }
  if (digest.workflow.status === "ok") {
    categories.push(buildWorkflowCategory(digest.workflow.items));
  }
  if (digest.request.status === "ok") {
    categories.push(buildRequestCategory(digest.request.items));
  }

  // Partial warning footer if any module failed
  let partialWarning = "";
  if (digest.isPartial && failedModules.length > 0) {
    const failedNames = failedModules.join(", ");
    partialWarning = `\n\n⚠️ <b>Dữ liệu có thể chưa đầy đủ</b>\nKhông thể tải dữ liệu: <b>${escapeHtml(failedNames)}</b>.`;
  }

  const chunks: string[] = [];
  let currentChunk = welcomeIntro;
  const continuationHeaderPrefix = `☀️ <b>CÔNG VIỆC HÔM NAY ${dateStr}</b> <i>(tiếp theo)</i>\n`;

  for (const category of categories) {
    const categoryHeader = `\n${category.title}\n`;
    if (currentChunk === welcomeIntro) {
      currentChunk += categoryHeader;
    } else {
      if ((currentChunk + "\n" + categoryHeader).length > MAX_CHUNK_LENGTH) {
        chunks.push(currentChunk.trim());
        currentChunk = `${continuationHeaderPrefix}\n${category.title} <i>(tiếp theo)</i>\n`;
      } else {
        currentChunk += `\n${categoryHeader}`;
      }
    }

    for (const block of category.blocks) {
      if (block.header) {
        if ((currentChunk + "\n" + block.header + "\n").length > MAX_CHUNK_LENGTH) {
          chunks.push(currentChunk.trim());
          currentChunk = `${continuationHeaderPrefix}\n${category.title} <i>(tiếp theo)</i>\n\n${block.header}\n`;
        } else {
          currentChunk += `\n${block.header}\n`;
        }
      }

      for (let i = 0; i < block.items.length; i++) {
        const item = block.items[i]!;
        const itemStr = `${item}\n`;

        if ((currentChunk + itemStr).length > MAX_CHUNK_LENGTH) {
          chunks.push(currentChunk.trim());
          const contBlockHeader = block.header
            ? `${continuationHeaderPrefix}\n${category.title} <i>(tiếp theo)</i>\n\n${block.header} <i>(tiếp theo)</i>\n`
            : `${continuationHeaderPrefix}\n${category.title} <i>(tiếp theo)</i>\n`;
          currentChunk = contBlockHeader + itemStr;
        } else {
          currentChunk += itemStr;
        }
      }
    }
  }

  if (partialWarning) {
    currentChunk += partialWarning;
  }

  // Append footer
  if ((currentChunk + welcomeFooter).length <= MAX_CHUNK_LENGTH) {
    currentChunk += welcomeFooter;
    chunks.push(currentChunk.trim());
  } else {
    chunks.push(currentChunk.trim());
    chunks.push(welcomeFooter.trim());
  }

  return chunks;
}

