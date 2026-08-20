/**
 * src/scheduler/reminder-job.ts
 *
 * Pipeline Orchestrator — executes the complete reminder collection & delivery pipeline.
 *
 * Flow:
 *  1. (Optional) User Sync (Account API → PostgreSQL base_users)
 *  2. Check/create idempotent run record in `reminder_runs` (namespaced run_key)
 *  3. Fetch active workspace members
 *  4. Bounded concurrent collection (Wework, Workflow, Request) per user
 *  5. Build structured UserDigests (channel-agnostic)
 *  6. (If not dry-run) Batch store delivery records in `reminder_deliveries`
 *  7. (If deliverTelegram !== false) Deliver formatted Telegram digests with per-chunk tracking
 *  8. Finalize run and update passive health status
 *
 * Run Key Idempotency:
 *  - Scheduled: `scheduled:YYYY-MM-DD` (enforces daily uniqueness)
 *  - Manual: `manual:<timestamp>:<rand>`
 *  - Test: `test:<username>:<timestamp>`
 *  - Dryrun: `dryrun:<timestamp>`
 */

import pLimit from "p-limit";
import { Api, Bot } from "grammy";
import { loadConfig, loadTelegramConfig } from "../config/index.js";
import { AccountApiClient } from "../base-api/account.js";
import { WeworkApiClient } from "../base-api/wework.js";
import { WorkflowApiClient } from "../base-api/workflow.js";
import { RequestApiClient } from "../base-api/request.js";
import { syncUsers } from "../sync/user-sync.js";
import { getActiveBaseUsers, type ActiveBaseUser } from "../db/queries/users.js";
import {
  createReminderRun,
  updateReminderRun,
  getReminderRunByKey,
  formatScheduledRunKey,
  formatManualRunKey,
  formatTestRunKey,
  formatDryRunKey,
} from "../db/queries/runs.js";
import {
  batchInsertDeliveries,
  type DeliveryInsertItem,
} from "../db/queries/deliveries.js";
import { collectWeworkTasks, formatTzDate } from "../collectors/wework.js";
import { collectWorkflowJobs } from "../collectors/workflow.js";
import { collectActionableRequests } from "../collectors/request.js";
import { buildUserDigest } from "../digest/builder.js";
import type {
  UserDigest,
  ModuleResult,
  ActionableTask,
  ActionableJob,
  ActionableRequest,
} from "../digest/types.js";
import { TelegramClient } from "../telegram/telegram-client.js";
import { DeliveryService, type RunDeliverySummary } from "../delivery/delivery-service.js";
import { logger } from "../logging/logger.js";
import { recordModuleSuccess, recordLastReminderRun } from "../health/server.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RunType = "scheduled" | "manual" | "test" | "dryrun";

export interface PipelineOptions {
  /** Explicit run type (defaults to 'scheduled' if not dry-run and no targetUsername) */
  runType?: RunType;
  /** Custom run key override */
  customRunKey?: string;
  /** If true, ignore existing run_key conflict and create/overwrite */
  force?: boolean;
  /** Reference date (defaults to new Date()) */
  now?: Date;
  /** If true, do not write runs/deliveries to database (dry-run mode) */
  dryRun?: boolean;
  /** If false, skip Account API user sync step */
  syncFirst?: boolean;
  /** If specified, only run for this single username */
  targetUsername?: string;
  /** If false, skip Telegram delivery phase (collection & storage only) */
  deliverTelegram?: boolean;
  /** Custom TelegramClient instance for testing / mocking */
  telegramClient?: TelegramClient;
}

export interface PipelineResult {
  runId?: number;
  runKey: string;
  runDate: string;
  totalUsers: number;
  usersEmpty: number;
  usersReady: number;
  usersPartial: number;
  usersError: number;
  usersDelivered?: number;
  usersSkipped?: number;
  deliverySummary?: RunDeliverySummary;
  digests: UserDigest[];
  durationMs: number;
  skipped?: boolean;
  skipReason?: string;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Execute the complete reminder collection and delivery pipeline.
 */
export async function executeReminderPipeline(
  options: PipelineOptions = {}
): Promise<PipelineResult> {
  const startMs = Date.now();
  const config = loadConfig();
  const now = options.now ?? new Date();
  const timezone = config.reminderTimezone;
  const runDate = formatTzDate(now, timezone);

  // Derive run key based on run type
  let runKey: string;
  if (options.customRunKey) {
    runKey = options.customRunKey;
  } else if (options.dryRun) {
    runKey = formatDryRunKey();
  } else if (options.targetUsername) {
    runKey = formatTestRunKey(options.targetUsername);
  } else if (options.runType === "manual") {
    runKey = formatManualRunKey();
  } else {
    // Default: scheduled run for today
    runKey = formatScheduledRunKey(runDate);
  }

  logger.info({
    msg: "reminder pipeline starting",
    run_key: runKey,
    run_date: runDate,
    dry_run: options.dryRun ?? false,
    deliver_telegram: options.deliverTelegram ?? true,
  });

  // Initialize Base API clients
  const accountClient = new AccountApiClient(
    config.baseAccountToken,
    config.baseApiTimeoutMs,
    config.baseApiConcurrency
  );
  const weworkClient = new WeworkApiClient(
    config.baseWeWorkToken,
    config.baseApiTimeoutMs,
    config.baseApiConcurrency
  );
  const workflowClient = new WorkflowApiClient(
    config.baseWorkflowToken,
    config.baseApiTimeoutMs,
    config.baseApiConcurrency
  );
  const requestClient = new RequestApiClient(
    config.baseRequestToken,
    config.baseApiTimeoutMs,
    config.baseApiConcurrency
  );

  // --- Step 1: User Sync (unless disabled) ---
  if (options.syncFirst !== false && !options.dryRun) {
    try {
      await syncUsers(accountClient);
      recordModuleSuccess("account");
    } catch (err) {
      logger.warn({
        msg: "user sync step failed during reminder run, proceeding with existing base_users",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // --- Step 2: Idempotency Check & Run Creation (unless dry-run) ---
  let runId: number | undefined;

  if (!options.dryRun) {
    const createdId = await createReminderRun(runKey, runDate);
    if (createdId === null) {
      if (!options.force) {
        logger.info({
          msg: "reminder run already exists for run_key, skipping",
          run_key: runKey,
        });
        const existingRun = await getReminderRunByKey(runKey);
        return {
          runId: existingRun?.id,
          runKey,
          runDate,
          totalUsers: existingRun?.users_total ?? 0,
          usersEmpty: existingRun?.users_empty ?? 0,
          usersReady: 0,
          usersPartial: 0,
          usersError: existingRun?.users_error ?? 0,
          usersDelivered: existingRun?.users_delivered ?? 0,
          digests: [],
          durationMs: Date.now() - startMs,
          skipped: true,
          skipReason: `Run already exists for ${runKey}`,
        };
      }
      // Force mode: fetch existing ID to update
      const existing = await getReminderRunByKey(runKey);
      runId = existing?.id;
    } else {
      runId = createdId;
    }
  }

  // --- Step 3: Fetch active users ---
  let activeUsers: ActiveBaseUser[];
  try {
    activeUsers = await getActiveBaseUsers();
  } catch (err) {
    if (options.dryRun) {
      logger.info({ msg: "fetching active users directly from Account API for dry-run" });
      const apiUsers = await accountClient.getAllUsers();
      activeUsers = apiUsers
        .filter((u) => u.status === "0")
        .map((u) => ({
          id: u.id,
          username: u.username,
          display_name: u.name,
          email: u.email,
          is_active: true,
        }));
    } else {
      throw err;
    }
  }

  if (options.targetUsername) {
    const cleanTarget = options.targetUsername.toLowerCase().replace(/^@/, "").trim();
    activeUsers = activeUsers.filter(
      (u) => u.username.toLowerCase() === cleanTarget
    );
    if (activeUsers.length === 0) {
      logger.warn({ msg: "target username not found in active base_users", username: options.targetUsername });
    }
  }

  if (runId) {
    await updateReminderRun(runId, {
      status: "collecting",
      users_total: activeUsers.length,
    });
  }

  // --- Step 4 & 5: Bounded Concurrent Collection per User ---
  const limit = pLimit(config.baseApiConcurrency);
  const digests: UserDigest[] = [];

  const collectionTasks = activeUsers.map((user) =>
    limit(async () => {
      // 1. Wework Collector
      let weworkResult: ModuleResult<ActionableTask>;
      try {
        const tasks = await collectWeworkTasks(weworkClient, user.username, timezone, now);
        weworkResult = { status: "ok", items: tasks };
        recordModuleSuccess("wework");
      } catch (err) {
        logger.error({
          msg: "wework collection failed for user",
          base_user_id: user.id,
          error: err instanceof Error ? err.message : String(err),
        });
        weworkResult = {
          status: "error",
          items: [],
          error: err instanceof Error ? err.message : String(err),
        };
      }

      // 2. Workflow Collector
      let workflowResult: ModuleResult<ActionableJob>;
      try {
        const jobs = await collectWorkflowJobs(workflowClient, user.username, timezone, now);
        workflowResult = { status: "ok", items: jobs };
        recordModuleSuccess("workflow");
      } catch (err) {
        logger.error({
          msg: "workflow collection failed for user",
          base_user_id: user.id,
          error: err instanceof Error ? err.message : String(err),
        });
        workflowResult = {
          status: "error",
          items: [],
          error: err instanceof Error ? err.message : String(err),
        };
      }

      // 3. Request Collector
      let requestResult: ModuleResult<ActionableRequest>;
      try {
        const requests = await collectActionableRequests(requestClient, user.username, timezone, now);
        requestResult = { status: "ok", items: requests };
        recordModuleSuccess("request");
      } catch (err) {
        logger.error({
          msg: "request collection failed for user",
          base_user_id: user.id,
          error: err instanceof Error ? err.message : String(err),
        });
        requestResult = {
          status: "error",
          items: [],
          error: err instanceof Error ? err.message : String(err),
        };
      }

      // 4. Assemble User Digest
      const digest = buildUserDigest({
        baseUserId: user.id,
        username: user.username,
        displayName: user.display_name,
        runDate,
        wework: weworkResult,
        workflow: workflowResult,
        request: requestResult,
      });

      return digest;
    })
  );

  const results = await Promise.all(collectionTasks);
  digests.push(...results);

  // Calculate summary counts
  const usersEmpty = digests.filter((d) => d.status === "empty").length;
  const usersReady = digests.filter((d) => d.status === "ready").length;
  const usersPartial = digests.filter((d) => d.status === "partial").length;
  const usersError = digests.filter((d) => d.status === "error").length;

  // --- Step 6: Store Initial Delivery Records (if not dry-run) ---
  if (!options.dryRun && runId) {
    const deliveryItems: DeliveryInsertItem[] = digests.map((d) => {
      let deliveryStatus: DeliveryInsertItem["status"];
      if (d.status === "empty") {
        deliveryStatus = "empty";
      } else if (d.status === "error") {
        deliveryStatus = "error";
      } else {
        deliveryStatus = "pending";
      }

      return {
        baseUserId: d.baseUserId,
        status: deliveryStatus,
        weworkStatus: d.wework.status,
        weworkCount: d.counts.wework,
        workflowStatus: d.workflow.status,
        workflowCount: d.counts.workflow,
        requestStatus: d.request.status,
        requestCount: d.counts.request,
        isPartial: d.isPartial,
        errorMessage:
          d.wework.error || d.workflow.error || d.request.error || null,
      };
    });

    await batchInsertDeliveries(runId, deliveryItems);
  }

  // --- Step 7: Telegram Delivery Phase ---
  let deliverySummary: RunDeliverySummary | undefined;
  const shouldDeliver = options.deliverTelegram !== false && !options.dryRun && !!runId;

  if (shouldDeliver && runId) {
    await updateReminderRun(runId, {
      status: "delivering",
    });

    let tgClient = options.telegramClient;
    if (!tgClient) {
      try {
        const tgConfig = loadTelegramConfig();
        tgClient = new TelegramClient(new Api(tgConfig.botToken));
      } catch (err) {
        logger.error({
          msg: "failed to initialize telegram client for delivery",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (tgClient) {
      const deliveryService = new DeliveryService(tgClient);
      deliverySummary = await deliveryService.deliverRun({
        runId,
        users: activeUsers,
        digests,
      });

      await updateReminderRun(runId, {
        status: "completed",
        users_total: activeUsers.length,
        users_delivered: deliverySummary.delivered,
        users_empty: deliverySummary.empty,
        users_error: deliverySummary.error,
        completed_at: new Date(),
      });
    } else {
      logger.warn({ msg: "skipping telegram delivery because TelegramClient is not configured" });
      await updateReminderRun(runId, {
        status: "completed",
        users_total: activeUsers.length,
        users_empty: usersEmpty,
        users_error: usersError,
        completed_at: new Date(),
      });
    }
  } else if (!options.dryRun && runId) {
    await updateReminderRun(runId, {
      status: "completed",
      users_total: activeUsers.length,
      users_empty: usersEmpty,
      users_error: usersError,
      completed_at: new Date(),
    });
  }

  const durationMs = Date.now() - startMs;

  // --- Step 8: Update Passive Health Status ---
  recordLastReminderRun({
    date: runDate,
    status: "completed",
    total: activeUsers.length,
    empty: deliverySummary?.empty ?? usersEmpty,
    ready: usersReady,
    partial: usersPartial,
    error: deliverySummary?.error ?? usersError,
    durationMs,
  });

  logger.info({
    msg: "reminder pipeline completed",
    run_key: runKey,
    total_users: activeUsers.length,
    users_ready: usersReady,
    users_empty: deliverySummary?.empty ?? usersEmpty,
    users_partial: usersPartial,
    users_error: deliverySummary?.error ?? usersError,
    users_delivered: deliverySummary?.delivered ?? 0,
    duration_ms: durationMs,
  });

  return {
    runId,
    runKey,
    runDate,
    totalUsers: activeUsers.length,
    usersEmpty: deliverySummary?.empty ?? usersEmpty,
    usersReady,
    usersPartial,
    usersError: deliverySummary?.error ?? usersError,
    usersDelivered: deliverySummary?.delivered ?? 0,
    usersSkipped: deliverySummary?.skipped ?? 0,
    deliverySummary,
    digests,
    durationMs,
  };
}
