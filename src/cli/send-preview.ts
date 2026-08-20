/**
 * src/cli/send-preview.ts
 *
 * Safe synthetic test fixture preview CLI for Telegram digest rendering.
 *
 * Usage:
 *   npm run reminder:send-preview -- --username Digital01 --fixture all --confirm-send
 *   npm run reminder:send-preview -- --username Digital01 --fixture workflow --confirm-send
 *   npm run reminder:send-preview -- --username Digital01 --fixture request --confirm-send
 *   npm run reminder:send-preview -- --username Digital01 --fixture partial --confirm-send
 *   npm run reminder:send-preview -- --username Digital01 --fixture mixed --confirm-send
 *
 * Safety Guarantees:
 *  - Requires explicit --username and --confirm-send flags.
 *  - Does NOT call Base API for task updates (purely synthetic in-memory digest).
 *  - Uses namespaced test run key (test:preview:<username>:<timestamp>), NEVER blocks scheduled runs.
 *  - Does not persist synthetic titles or message bodies to DB.
 */

import { Api } from "grammy";
import { loadConfig, loadTelegramConfig } from "../config/index.js";
import { initPool, closePool } from "../db/connection.js";
import { getBaseUserByUsername } from "../db/queries/users.js";
import { getActiveTelegramLinkByBaseUserId } from "../db/queries/telegram-links.js";
import { createReminderRun, updateReminderRun } from "../db/queries/runs.js";
import { batchInsertDeliveries } from "../db/queries/deliveries.js";
import { formatTzDate } from "../collectors/wework.js";
import { buildWeworkDeepLink, buildWorkflowDeepLink, buildRequestDeepLink } from "../base-api/deep-links.js";
import { TelegramClient } from "../telegram/telegram-client.js";
import { DeliveryService } from "../delivery/delivery-service.js";
import type { UserDigest, ActionableTask, ActionableJob, ActionableRequest } from "../digest/types.js";
import { logger } from "../logging/logger.js";

export type FixtureType = "all" | "workflow" | "request" | "partial" | "mixed";

export function buildSyntheticDigest(
  baseUserId: number,
  username: string,
  displayName: string,
  fixture: FixtureType,
  runDate = "2026-08-20"
): UserDigest {
  const weworkTasks: ActionableTask[] = [
    // 3 Overdue
    {
      id: 1001,
      name: "Minigame dự đoán Worldcup trên Facebook",
      isOverdue: true,
      isDueToday: false,
      url: buildWeworkDeepLink(1001),
    },
    {
      id: 1002,
      name: "Thiết lập Website / Landing Page",
      isOverdue: true,
      isDueToday: false,
      url: buildWeworkDeepLink(1002),
    },
    {
      id: 1003,
      name: "Cập nhật giao diện Shopee / TikTok Shop",
      isOverdue: true,
      isDueToday: false,
      url: buildWeworkDeepLink(1003),
    },
    // 3 Due Today
    {
      id: 1004,
      name: "Hoàn thiện nội dung website VP Racing",
      isOverdue: false,
      isDueToday: true,
      url: buildWeworkDeepLink(1004),
    },
    {
      id: 1005,
      name: "Chuẩn bị báo cáo Digital Marketing",
      isOverdue: false,
      isDueToday: true,
      url: buildWeworkDeepLink(1005),
    },
    {
      id: 1006,
      name: "Kiểm tra nội dung Landing Page",
      isOverdue: false,
      isDueToday: true,
      url: buildWeworkDeepLink(1006),
    },
  ];

  const workflowJobs: ActionableJob[] = [
    // 3 Overdue
    {
      id: 2001,
      name: "Duyệt thiết kế Landing Page Voltronic",
      stageName: "Manager Review",
      workflowName: "Quy trình Landing Page",
      isOverdue: true,
      isDueToday: false,
      url: buildWorkflowDeepLink(2001),
    },
    {
      id: 2002,
      name: "Xác nhận kế hoạch Media tháng 8",
      stageName: "Approval",
      workflowName: "Quy trình Media",
      isOverdue: true,
      isDueToday: false,
      url: buildWorkflowDeepLink(2002),
    },
    {
      id: 2003,
      name: "Kiểm tra nội dung chiến dịch VP Racing",
      stageName: "Final Review",
      workflowName: "Quy trình Chiến dịch",
      isOverdue: true,
      isDueToday: false,
      url: buildWorkflowDeepLink(2003),
    },
    // 3 Due Today
    {
      id: 2004,
      name: "Phê duyệt nội dung Facebook tháng 8",
      stageName: "Manager Approval",
      workflowName: "Quy trình Social",
      isOverdue: false,
      isDueToday: true,
      url: buildWorkflowDeepLink(2004),
    },
    {
      id: 2005,
      name: "Xác nhận kế hoạch quảng cáo",
      stageName: "Director Review",
      workflowName: "Quy trình Quảng cáo",
      isOverdue: false,
      isDueToday: true,
      url: buildWorkflowDeepLink(2005),
    },
    {
      id: 2006,
      name: "Duyệt ngân sách Digital",
      stageName: "Finance Approval",
      workflowName: "Quy trình Ngân sách",
      isOverdue: false,
      isDueToday: true,
      url: buildWorkflowDeepLink(2006),
    },
  ];

  const requestItems: ActionableRequest[] = [
    // 3 Overdue
    {
      id: 3001,
      name: "Đề nghị thanh toán ngân sách Facebook Ads",
      creatorUsername: "hoa.nt",
      workflow: "sequential",
      isOverdue: true,
      isDueToday: false,
      url: buildRequestDeepLink(3001),
    },
    {
      id: 3002,
      name: "Đề nghị mua thiết bị quay video",
      creatorUsername: "nam.pv",
      workflow: "parallel",
      isOverdue: true,
      isDueToday: false,
      url: buildRequestDeepLink(3002),
    },
    {
      id: 3003,
      name: "Đề nghị duyệt chi phí sự kiện",
      creatorUsername: "lan.tp",
      workflow: "sequential",
      isOverdue: true,
      isDueToday: false,
      url: buildRequestDeepLink(3003),
    },
    // 3 Due Today
    {
      id: 3004,
      name: "Đề nghị duyệt ngân sách TikTok Ads",
      creatorUsername: "hoa.nt",
      workflow: "sequential",
      isOverdue: false,
      isDueToday: true,
      url: buildRequestDeepLink(3004),
    },
    {
      id: 3005,
      name: "Đề nghị mua vật tư Media",
      creatorUsername: "nam.pv",
      workflow: "parallel",
      isOverdue: false,
      isDueToday: true,
      url: buildRequestDeepLink(3005),
    },
    {
      id: 3006,
      name: "Đề nghị thanh toán hosting",
      creatorUsername: "digital.lead",
      workflow: "sequential",
      isOverdue: false,
      isDueToday: true,
      url: buildRequestDeepLink(3006),
    },
  ];

  if (fixture === "workflow") {
    return {
      baseUserId,
      username,
      displayName,
      status: "ready",
      isPartial: false,
      runDate,
      wework: { status: "ok", items: [] },
      workflow: { status: "ok", items: workflowJobs },
      request: { status: "ok", items: [] },
      counts: { wework: 0, workflow: workflowJobs.length, request: 0, total: workflowJobs.length },
    };
  }

  if (fixture === "request") {
    return {
      baseUserId,
      username,
      displayName,
      status: "ready",
      isPartial: false,
      runDate,
      wework: { status: "ok", items: [] },
      workflow: { status: "ok", items: [] },
      request: { status: "ok", items: requestItems },
      counts: { wework: 0, workflow: 0, request: requestItems.length, total: requestItems.length },
    };
  }

  if (fixture === "partial") {
    return {
      baseUserId,
      username,
      displayName,
      status: "partial",
      isPartial: true,
      runDate,
      wework: { status: "ok", items: [weworkTasks[0]!] },
      workflow: { status: "ok", items: [workflowJobs[0]!] },
      request: { status: "error", items: [], error: "500 Internal Server Error (Simulated)" },
      counts: { wework: 1, workflow: 1, request: 0, total: 2 },
    };
  }

  if (fixture === "mixed") {
    // 1 module with actions (Wework: 2 overdue), 1 module success with 0 actions (Workflow: ok, 0), 1 module failed (Request: error)
    return {
      baseUserId,
      username,
      displayName,
      status: "partial",
      isPartial: true,
      runDate,
      wework: { status: "ok", items: [weworkTasks[0]!, weworkTasks[1]!] },
      workflow: { status: "ok", items: [] },
      request: { status: "error", items: [], error: "500 Base Request Connection Timeout" },
      counts: { wework: 2, workflow: 0, request: 0, total: 2 },
    };
  }

  // fixture === "all" (18 items)
  return {
    baseUserId,
    username,
    displayName,
    status: "ready",
    isPartial: false,
    runDate,
    wework: { status: "ok", items: weworkTasks },
    workflow: { status: "ok", items: workflowJobs },
    request: { status: "ok", items: requestItems },
    counts: {
      wework: weworkTasks.length,
      workflow: workflowJobs.length,
      request: requestItems.length,
      total: weworkTasks.length + workflowJobs.length + requestItems.length,
    },
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let username = "";
  let fixture: FixtureType = "all";
  let confirmSend = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const nextArg = args[i + 1];

    if (arg === "--username" && nextArg) {
      username = nextArg.trim();
      i++;
    } else if (arg && arg.startsWith("--username=")) {
      username = arg.split("=")[1]?.trim() ?? "";
    } else if (arg === "--fixture" && nextArg) {
      const f = nextArg.toLowerCase().trim();
      if (f === "all" || f === "workflow" || f === "request" || f === "partial" || f === "mixed") {
        fixture = f;
      }
      i++;
    } else if (arg && arg.startsWith("--fixture=")) {
      const f = arg.split("=")[1]?.toLowerCase().trim();
      if (f === "all" || f === "workflow" || f === "request" || f === "partial" || f === "mixed") {
        fixture = f;
      }
    } else if (arg === "--confirm-send") {
      confirmSend = true;
    }
  }

  if (!username) {
    console.error("\n❌ Error: --username <username> is required.");
    console.error("Usage: npm run reminder:send-preview -- --username <username> --fixture all --confirm-send\n");
    process.exit(1);
  }

  if (!confirmSend) {
    console.error("\n⚠️ Safety guard: --confirm-send flag is required to send real Telegram preview messages.");
    console.error(`Example: npm run reminder:send-preview -- --username ${username} --fixture ${fixture} --confirm-send\n`);
    process.exit(1);
  }

  const cleanUsername = username.toLowerCase().replace(/^@/, "").trim();
  const config = loadConfig();
  const tgConfig = loadTelegramConfig();

  initPool(config.databaseUrl);

  try {
    console.log(`\n======================================================`);
    console.log(`🧪 [TEST PREVIEW] Checking Target Telegram Link: @${cleanUsername}`);
    console.log(`======================================================`);

    const baseUser = await getBaseUserByUsername(cleanUsername);
    if (!baseUser) {
      console.error(`❌ User @${cleanUsername} not found in base_users table. Run 'npm run sync:users' first.`);
      process.exit(1);
    }

    const activeLink = await getActiveTelegramLinkByBaseUserId(baseUser.id);
    if (!activeLink) {
      console.error(`❌ Base user @${cleanUsername} does not have an active Telegram link.`);
      process.exit(1);
    }

    if (!activeLink.reminders_enabled) {
      console.error(`⚠️ Telegram reminders are paused (/stop) for user @${cleanUsername}.`);
      process.exit(1);
    }

    console.log(`✅ Base User: ${baseUser.display_name} (@${baseUser.username}) [ID: ${baseUser.id}]`);
    console.log(`✅ Telegram Link: Chat ID ${activeLink.telegram_chat_id} (Reminders: Active)`);
    console.log(`📋 Selected Fixture: '${fixture}'`);

    const now = new Date();
    const runDate = formatTzDate(now, config.reminderTimezone);
    const previewRunKey = `test:preview:${cleanUsername}:${Date.now()}`;

    const syntheticDigest = buildSyntheticDigest(
      baseUser.id,
      baseUser.username,
      baseUser.display_name,
      fixture,
      runDate
    );

    // Create ad-hoc run
    const runId = await createReminderRun(previewRunKey, runDate);
    if (!runId) {
      throw new Error(`Failed to create test preview run with key ${previewRunKey}`);
    }

    // Insert delivery record
    await batchInsertDeliveries(runId, [{
      baseUserId: baseUser.id,
      status: "pending",
      weworkStatus: syntheticDigest.wework.status,
      weworkCount: syntheticDigest.counts.wework,
      workflowStatus: syntheticDigest.workflow.status,
      workflowCount: syntheticDigest.counts.workflow,
      requestStatus: syntheticDigest.request.status,
      requestCount: syntheticDigest.counts.request,
      isPartial: syntheticDigest.isPartial,
    }]);

    console.log(`\n🚀 Delivering Synthetic Preview to Telegram (Chat ${activeLink.telegram_chat_id})...`);

    const tgClient = new TelegramClient(new Api(tgConfig.botToken));
    const deliveryService = new DeliveryService(tgClient);

    const deliveryResult = await deliveryService.deliverUserDigest({
      runId,
      user: baseUser,
      digest: syntheticDigest,
    });

    await updateReminderRun(runId, {
      status: "completed",
      users_total: 1,
      users_delivered: deliveryResult.status === "delivered" ? 1 : 0,
      users_error: deliveryResult.status === "error" ? 1 : 0,
      completed_at: new Date(),
    });

    console.log(`\n======================================================`);
    console.log(`📊 [TEST PREVIEW] Execution Result`);
    console.log(`======================================================`);
    console.log(`Status:           ${deliveryResult.status.toUpperCase()}`);
    console.log(`Run Key:          ${previewRunKey}`);
    console.log(`Chunks Sent:      ${deliveryResult.chunksSent} / ${deliveryResult.chunksTotal}`);
    console.log(`Duration:         ${deliveryResult.durationMs}ms`);

    if (deliveryResult.errorMessage) {
      console.log(`Error:            ${deliveryResult.errorMessage}`);
    }

    console.log(`\nDigest Summary:`);
    console.log(`  Wework:         ${syntheticDigest.counts.wework} items (status: ${syntheticDigest.wework.status})`);
    console.log(`  Workflow:       ${syntheticDigest.counts.workflow} items (status: ${syntheticDigest.workflow.status})`);
    console.log(`  Request:        ${syntheticDigest.counts.request} items (status: ${syntheticDigest.request.status})`);
    console.log(`  Total Actions:  ${syntheticDigest.counts.total}`);

    console.log(`\n✅ Preview completed! Check your Telegram app for the formatted message.\n`);
  } catch (err) {
    logger.error({
      msg: "failed to send test preview reminder",
      error: err instanceof Error ? err.message : String(err),
    });
    console.error(`\n❌ Error:`, err instanceof Error ? err.message : String(err));
    process.exit(1);
  } finally {
    await closePool();
  }
}

if (process.argv[1]?.includes("send-preview")) {
  main();
}
