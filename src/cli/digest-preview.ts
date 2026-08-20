/**
 * src/cli/digest-preview.ts
 *
 * CLI Acceptance Command:
 *   npm run digest:preview -- --username <username>
 *
 * Features:
 *  - Explicit local developer command.
 *  - Collects and renders full detailed digest for a single user.
 *  - Read-only: does not mutate Base data, does not write delivery records to DB.
 */

import { loadConfig } from "../config/index.js";
import { initPool, closePool } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { AccountApiClient } from "../base-api/account.js";
import { WeworkApiClient } from "../base-api/wework.js";
import { WorkflowApiClient } from "../base-api/workflow.js";
import { RequestApiClient } from "../base-api/request.js";
import { getBaseUserByUsername } from "../db/queries/users.js";
import { collectWeworkTasks, formatTzDate } from "../collectors/wework.js";
import { collectWorkflowJobs } from "../collectors/workflow.js";
import { collectActionableRequests } from "../collectors/request.js";
import { buildUserDigest } from "../digest/builder.js";
import type { ModuleResult, ActionableTask, ActionableJob, ActionableRequest } from "../digest/types.js";

function parseUsernameArg(): string | null {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const current = args[i];
    if (current === "--username" || current === "-u") {
      return args[i + 1] ?? null;
    }
    if (current?.startsWith("--username=")) {
      return current.split("=")[1] ?? null;
    }
  }
  return null;
}

function formatDeadline(unixSeconds?: number, timezone = "Asia/Ho_Chi_Minh"): string {
  if (!unixSeconds) return "None";
  const d = new Date(unixSeconds * 1000);
  return new Intl.DateTimeFormat("vi-VN", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

async function main(): Promise<void> {
  const username = parseUsernameArg();
  if (!username) {
    console.error("Usage: npm run digest:preview -- --username <username>");
    console.error("Example: npm run digest:preview -- --username Digital01");
    process.exit(1);
  }

  const cleanUser = username.replace(/^@/, "").trim();
  const config = loadConfig();
  try {
    let dbUser: { id: number; username: string; display_name: string; email: string; is_active: boolean } | null = null;

    try {
      await runMigrations();
      dbUser = await getBaseUserByUsername(cleanUser);
    } catch {
      // DB offline / not reachable — fallback to direct Account API lookup
    }

    if (!dbUser) {
      // Direct Base Account API lookup
      const accountClient = new AccountApiClient(config.baseAccountToken);
      const apiUser = await accountClient.searchByUsername(cleanUser);
      if (!apiUser) {
        console.error(`User "${cleanUser}" was not found in Base workspace.`);
        process.exit(1);
      }
      dbUser = {
        id: apiUser.id,
        username: apiUser.username,
        display_name: apiUser.name,
        email: apiUser.email,
        is_active: apiUser.status === "0",
      };
    }

    const now = new Date();
    const tz = config.reminderTimezone;

    console.log(`\n======================================================`);
    console.log(` BASE REMINDER — DIGEST PREVIEW (M1B)`);
    console.log(` Date: ${formatTzDate(now, tz)} | Timezone: ${tz}`);
    console.log(` User: ${dbUser.display_name} (@${dbUser.username}) [ID: ${dbUser.id}]`);
    console.log(`======================================================\n`);

    const weworkClient = new WeworkApiClient(config.baseWeWorkToken);
    const workflowClient = new WorkflowApiClient(config.baseWorkflowToken);
    const requestClient = new RequestApiClient(config.baseRequestToken);

    // 1. Collect Wework
    let weworkRes: ModuleResult<ActionableTask>;
    try {
      const tasks = await collectWeworkTasks(weworkClient, dbUser.username, tz, now);
      weworkRes = { status: "ok", items: tasks };
    } catch (err) {
      weworkRes = { status: "error", items: [], error: err instanceof Error ? err.message : String(err) };
    }

    // 2. Collect Workflow
    let workflowRes: ModuleResult<ActionableJob>;
    try {
      const jobs = await collectWorkflowJobs(workflowClient, dbUser.username);
      workflowRes = { status: "ok", items: jobs };
    } catch (err) {
      workflowRes = { status: "error", items: [], error: err instanceof Error ? err.message : String(err) };
    }

    // 3. Collect Request
    let requestRes: ModuleResult<ActionableRequest>;
    try {
      const requests = await collectActionableRequests(requestClient, dbUser.username);
      requestRes = { status: "ok", items: requests };
    } catch (err) {
      requestRes = { status: "error", items: [], error: err instanceof Error ? err.message : String(err) };
    }

    // Build digest
    const digest = buildUserDigest({
      baseUserId: dbUser.id,
      username: dbUser.username,
      displayName: dbUser.display_name,
      wework: weworkRes,
      workflow: workflowRes,
      request: requestRes,
    });

    console.log(`Digest Status: [${digest.status.toUpperCase()}] ${digest.isPartial ? "(PARTIAL FAILURE DETECTED)" : ""}`);
    console.log(`Counts: Wework=${digest.counts.wework}, Workflow=${digest.counts.workflow}, Request=${digest.counts.request}, Total=${digest.counts.total}\n`);

    // --- Section 1: Wework Tasks ---
    console.log(`--- [WEWORK TASKS] (Status: ${weworkRes.status.toUpperCase()}) ---`);
    if (weworkRes.status === "error") {
      console.log(`  ⚠️ Module Error: ${weworkRes.error}`);
    } else if (weworkRes.items.length === 0) {
      console.log(`  (No overdue or due-today tasks)`);
    } else {
      weworkRes.items.forEach((t, i) => {
        const flags: string[] = [];
        if (t.isOverdue) flags.push("OVERDUE");
        if (t.isDueToday) flags.push("DUE_TODAY");
        console.log(`  ${i + 1}. [${flags.join(", ")}] ${t.name}`);
        console.log(`     Deadline: ${formatDeadline(t.deadline, tz)}`);
        console.log(`     Link: ${t.url}`);
      });
    }
    console.log();

    // --- Section 2: Workflow Jobs ---
    console.log(`--- [WORKFLOW JOBS] (Status: ${workflowRes.status.toUpperCase()}) ---`);
    if (workflowRes.status === "error") {
      console.log(`  ⚠️ Module Error: ${workflowRes.error}`);
    } else if (workflowRes.items.length === 0) {
      console.log(`  (No active stage jobs assigned to this user)`);
    } else {
      workflowRes.items.forEach((j, i) => {
        console.log(`  ${i + 1}. ${j.name}`);
        if (j.workflowName) console.log(`     Workflow: ${j.workflowName}`);
        if (j.stageName) console.log(`     Stage: ${j.stageName}`);
        if (j.stageDeadline) console.log(`     Stage Deadline: ${formatDeadline(j.stageDeadline, tz)}`);
        console.log(`     Link: ${j.url}`);
      });
    }
    console.log();

    // --- Section 3: Request Approvals ---
    console.log(`--- [REQUEST APPROVALS] (Status: ${requestRes.status.toUpperCase()}) ---`);
    if (requestRes.status === "error") {
      console.log(`  ⚠️ Module Error: ${requestRes.error}`);
    } else if (requestRes.items.length === 0) {
      console.log(`  (No actionable pending requests waiting for your approval)`);
    } else {
      requestRes.items.forEach((r, i) => {
        console.log(`  ${i + 1}. [${r.workflow.toUpperCase()}] ${r.name}`);
        console.log(`     Creator: @${r.creatorUsername}`);
        if (r.deadline) console.log(`     Deadline: ${formatDeadline(r.deadline, tz)}`);
        console.log(`     Link: ${r.url}`);
      });
    }
    console.log(`\n======================================================\n`);
  } catch (err) {
    console.error("Preview error:", err instanceof Error ? err.message : err);
    process.exit(1);
  } finally {
    await closePool();
  }
}

main();
