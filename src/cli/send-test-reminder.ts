/**
 * src/cli/send-test-reminder.ts
 *
 * Controlled single-user live acceptance CLI command.
 *
 * Usage:
 *   npm run reminder:send-test -- --username <username> --confirm-send
 *
 * Safety Guarantees:
 *  - Explicit target username required.
 *  - Explicit --confirm-send flag required.
 *  - Checks active Telegram link and reminders_enabled.
 *  - Uses namespaced run key (test:<username>:<timestamp>), NEVER blocks scheduled runs.
 *  - Isolated execution for one employee only.
 */

import { loadConfig, loadTelegramConfig } from "../config/index.js";
import { initPool, closePool } from "../db/connection.js";
import { getBaseUserByUsername } from "../db/queries/users.js";
import { getActiveTelegramLinkByBaseUserId } from "../db/queries/telegram-links.js";
import { executeReminderPipeline } from "../scheduler/reminder-job.js";
import { logger } from "../logging/logger.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let username = "";
  let confirmSend = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const nextArg = args[i + 1];
    if (arg === "--username" && nextArg) {
      username = nextArg.trim();
      i++;
    } else if (arg && arg.startsWith("--username=")) {
      username = arg.split("=")[1]?.trim() ?? "";
    } else if (arg === "--confirm-send") {
      confirmSend = true;
    }
  }

  if (!username) {
    console.error("\n❌ Error: --username <username> is required.");
    console.error("Usage: npm run reminder:send-test -- --username <username> --confirm-send\n");
    process.exit(1);
  }

  if (!confirmSend) {
    console.error("\n⚠️ Safety guard: --confirm-send flag is required to send real Telegram messages.");
    console.error(`Example: npm run reminder:send-test -- --username ${username} --confirm-send\n`);
    process.exit(1);
  }

  const cleanUsername = username.toLowerCase().replace(/^@/, "").trim();
  const config = loadConfig();
  loadTelegramConfig(); // Ensure Telegram credentials are set

  initPool(config.databaseUrl);

  try {
    console.log(`\n======================================================`);
    console.log(`🔍 Checking Base User & Telegram Link: @${cleanUsername}`);
    console.log(`======================================================`);

    const baseUser = await getBaseUserByUsername(cleanUsername);
    if (!baseUser) {
      console.error(`❌ User @${cleanUsername} not found in base_users table. Run 'npm run sync:users' first.`);
      process.exit(1);
    }

    if (!baseUser.is_active) {
      console.error(`❌ Base user @${cleanUsername} is marked as INACTIVE (is_active = false).`);
      process.exit(1);
    }

    const activeLink = await getActiveTelegramLinkByBaseUserId(baseUser.id);
    if (!activeLink) {
      console.error(`❌ Base user @${cleanUsername} does NOT have an active Telegram link.`);
      console.error(`   The user must start the bot and complete OTP linking first.`);
      process.exit(1);
    }

    if (!activeLink.reminders_enabled) {
      console.error(`⚠️ Telegram reminders are PAUSED (/stop) for user @${cleanUsername}.`);
      console.error(`   The user must send /resume to the bot before receiving reminders.`);
      process.exit(1);
    }

    console.log(`✅ Base User: ${baseUser.display_name} (@${baseUser.username}) [ID: ${baseUser.id}]`);
    console.log(`✅ Telegram Link: Chat ID ${activeLink.telegram_chat_id} (Reminders: ON)`);
    console.log(`\n🚀 Executing Action Collection & Telegram Delivery Pipeline...`);

    const result = await executeReminderPipeline({
      targetUsername: cleanUsername,
      runType: "test",
      syncFirst: false, // Fast execution
      deliverTelegram: true,
    });

    console.log(`\n======================================================`);
    console.log(`📊 Delivery Summary`);
    console.log(`======================================================`);
    console.log(`Run Key:          ${result.runKey}`);
    console.log(`Run Date:         ${result.runDate}`);
    console.log(`Total Users:      ${result.totalUsers}`);
    console.log(`Delivered:        ${result.usersDelivered ?? 0}`);
    console.log(`Empty (0 items):  ${result.usersEmpty}`);
    console.log(`Skipped:          ${result.usersSkipped ?? 0}`);
    console.log(`Error:            ${result.usersError}`);
    console.log(`Duration:         ${result.durationMs}ms`);

    const digest = result.digests[0];
    if (digest) {
      console.log(`\nDigest Details:`);
      console.log(`  Status:   ${digest.status}`);
      console.log(`  Wework:   ${digest.counts.wework} items (status: ${digest.wework.status})`);
      console.log(`  Workflow: ${digest.counts.workflow} items (status: ${digest.workflow.status})`);
      console.log(`  Request:  ${digest.counts.request} items (status: ${digest.request.status})`);
      console.log(`  Total:    ${digest.counts.total} items`);
    }

    console.log(`\n✅ Completed! Check Telegram app for delivered message.\n`);
  } catch (err) {
    logger.error({
      msg: "failed to execute manual test reminder",
      error: err instanceof Error ? err.message : String(err),
    });
    console.error(`\n❌ Execution error:`, err instanceof Error ? err.message : String(err));
    process.exit(1);
  } finally {
    await closePool();
  }
}

main();
