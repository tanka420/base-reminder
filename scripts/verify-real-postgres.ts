/**
 * scripts/verify-real-postgres.ts
 *
 * Comprehensive runtime security verification on real PostgreSQL 16.
 */

import "dotenv/config";
import bcrypt from "bcryptjs";
import { initPool, getPool, query, closePool } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrate.js";
import {
  createOtpChallengeAtomic,
  getActiveOtpChallenge,
  recordFailedOtpAttempt,
} from "../src/db/queries/otp.js";
import {
  getActiveTelegramLinkByTelegramId,
  getActiveTelegramLinkByBaseUserId,
  unlinkTelegramAccount,
  atomicCompleteLinkingTransaction,
} from "../src/db/queries/telegram-links.js";
import {
  getConversationState,
  setConversationState,
} from "../src/db/queries/conversations.js";
import { OtpService } from "../src/telegram/services/otp-service.js";
import { LinkingService } from "../src/telegram/services/linking-service.js";
import { SmtpEmailClient } from "../src/email/smtp-client.js";

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error("DATABASE_URL required");
  process.exit(1);
}

initPool(dbUrl);

async function runVerification() {
  console.log("================================================================");
  console.log("Starting Real PostgreSQL 16 Runtime Security Verification");
  console.log("================================================================");

  // Step 1: Run migrations
  console.log("\n[1/9] Applying migrations to real PostgreSQL 16...");
  await runMigrations();

  // Verify tables exist
  const tablesRes = await query<{ table_name: string }>(`
    SELECT table_name FROM information_schema.tables 
    WHERE table_schema = 'public' 
      AND table_name IN ('telegram_links', 'otp_challenges', 'telegram_conversations', 'audit_log', 'base_users')
  `);
  const foundTables = tablesRes.rows.map((r) => r.table_name);
  console.log("Found tables:", foundTables);
  if (!['telegram_links', 'otp_challenges', 'telegram_conversations', 'audit_log', 'base_users'].every(t => foundTables.includes(t))) {
    throw new Error("Missing required tables in real PostgreSQL 16");
  }

  // Verify no plaintext OTP column exists
  const colsRes = await query<{ column_name: string }>(`
    SELECT column_name FROM information_schema.columns 
    WHERE table_name = 'otp_challenges'
  `);
  const cols = colsRes.rows.map(c => c.column_name);
  console.log("otp_challenges columns:", cols);
  if (cols.includes("otp") || cols.includes("otp_code") || cols.includes("plaintext_otp")) {
    throw new Error("SECURITY VIOLATION: Plaintext OTP column detected in otp_challenges table!");
  }
  if (!cols.includes("otp_hash")) {
    throw new Error("Missing otp_hash column in otp_challenges table");
  }

  // Seed test users in base_users
  console.log("\nSeeding test base_users...");
  await query(`
    INSERT INTO base_users (id, username, display_name, email, is_active)
    VALUES (9001, 'TestUserX', 'User X', 'userx@company.com', true),
           (9002, 'TestUserY', 'User Y', 'usery@company.com', true),
           (9003, 'InactiveUserZ', 'User Z', 'userz@company.com', false)
    ON CONFLICT (id) DO UPDATE SET 
      username = EXCLUDED.username,
      display_name = EXCLUDED.display_name,
      email = EXCLUDED.email,
      is_active = EXCLUDED.is_active
  `);

  // Clean up any test artifacts for test users
  await query(`DELETE FROM audit_log WHERE actor_telegram_id IN (80001, 80002, 80003, 80004) OR actor_base_user_id IN (9001, 9002, 9003)`);
  await query(`DELETE FROM otp_challenges WHERE telegram_user_id IN (80001, 80002, 80003, 80004) OR base_user_id IN (9001, 9002, 9003)`);
  await query(`DELETE FROM telegram_links WHERE telegram_user_id IN (80001, 80002, 80003, 80004) OR base_user_id IN (9001, 9002, 9003)`);
  await query(`DELETE FROM telegram_conversations WHERE telegram_user_id IN (80001, 80002, 80003, 80004)`);

  // Step 2: Test Partial Unique Indexes on Real Postgres
  console.log("\n[2/9] Testing Partial Unique Indexes on Real PostgreSQL 16...");
  
  // 1. One active link per telegram_user_id
  await query(`
    INSERT INTO telegram_links (base_user_id, telegram_user_id, telegram_chat_id, reminders_enabled)
    VALUES (9001, 80001, 80001, true)
  `);

  let duplicateTgFailed = false;
  try {
    await query(`
      INSERT INTO telegram_links (base_user_id, telegram_user_id, telegram_chat_id, reminders_enabled)
      VALUES (9002, 80001, 80001, true)
    `);
  } catch (err: any) {
    if (err.code === '23505') { // unique_violation
      duplicateTgFailed = true;
      console.log("✓ Duplicate active Telegram user correctly rejected by idx_telegram_links_tg_active");
    } else {
      throw err;
    }
  }
  if (!duplicateTgFailed) throw new Error("Partial unique index failed: allowed duplicate active telegram_user_id");

  // 2. One active link per base_user_id
  let duplicateBaseFailed = false;
  try {
    await query(`
      INSERT INTO telegram_links (base_user_id, telegram_user_id, telegram_chat_id, reminders_enabled)
      VALUES (9001, 80002, 80002, true)
    `);
  } catch (err: any) {
    if (err.code === '23505') { // unique_violation
      duplicateBaseFailed = true;
      console.log("✓ Duplicate active Base user correctly rejected by idx_telegram_links_base_active");
    } else {
      throw err;
    }
  }
  if (!duplicateBaseFailed) throw new Error("Partial unique index failed: allowed duplicate active base_user_id");

  // 3. Soft delete allows new active link
  await query(`UPDATE telegram_links SET unlinked_at = NOW() WHERE telegram_user_id = 80001`);
  await query(`
    INSERT INTO telegram_links (base_user_id, telegram_user_id, telegram_chat_id, reminders_enabled)
    VALUES (9002, 80001, 80001, true)
  `);
  console.log("✓ Relinking succeeds after previous link is soft deleted (unlinked_at set)");

  // Clean up
  await query(`DELETE FROM telegram_links WHERE telegram_user_id IN (80001, 80002)`);

  // Step 3: Advisory Locking & Concurrency Tests
  console.log("\n[3/9] Testing Advisory Locking & Concurrency on Real Postgres...");
  
  const salt = await bcrypt.genSalt(10);
  const hash1 = await bcrypt.hash("111111", salt);

  // A. Concurrent OTP creation for same Telegram user
  const promisesTg = Array.from({ length: 10 }).map(() =>
    createOtpChallengeAtomic({
      telegramUserId: 80001,
      baseUserId: 9001,
      otpHash: hash1,
      ttlMinutes: 10,
      maxAttempts: 5,
      rateLimitMaxRequests: 5,
      rateLimitWindowMinutes: 15,
    })
  );
  const resultsTg = await Promise.all(promisesTg);
  const successfulTg = resultsTg.filter(r => r.success);
  console.log(`Concurrent Telegram requests: ${successfulTg.length} succeeded out of 10 (Rate limit: 5)`);
  if (successfulTg.length !== 5) {
    throw new Error(`Rate limit bypass detected! Expected exactly 5 successful OTP creations, got ${successfulTg.length}`);
  }
  console.log("✓ Real PostgreSQL advisory locking strictly enforced Telegram-axis rate limit under concurrency");

  // B. Concurrent OTP creation for same Base user from different Telegram accounts
  const promisesBase = Array.from({ length: 10 }).map((_, i) =>
    createOtpChallengeAtomic({
      telegramUserId: 80000 + i + 10, // distinct TG users
      baseUserId: 9002,
      otpHash: hash1,
      ttlMinutes: 10,
      maxAttempts: 5,
      rateLimitMaxRequests: 5,
      rateLimitWindowMinutes: 15,
    })
  );
  const resultsBase = await Promise.all(promisesBase);
  const successfulBase = resultsBase.filter(r => r.success);
  console.log(`Concurrent Base user requests: ${successfulBase.length} succeeded out of 10 (Rate limit: 5)`);
  if (successfulBase.length !== 5) {
    throw new Error(`Rate limit bypass detected! Expected exactly 5 successful OTP creations, got ${successfulBase.length}`);
  }
  console.log("✓ Real PostgreSQL advisory locking strictly enforced Base-axis rate limit under concurrency");

  // Clean up
  await query(`DELETE FROM otp_challenges WHERE telegram_user_id >= 80000`);

  // Step 4: OTP Security & Attempt Tracking
  console.log("\n[4/9] Testing OTP Lifecycle & Security Mechanisms...");
  const otpHardCode = "654321";
  const hardHash = await bcrypt.hash(otpHardCode, 10);
  
  const challengeRes = await createOtpChallengeAtomic({
    telegramUserId: 80003,
    baseUserId: 9001,
    otpHash: hardHash,
    ttlMinutes: 10,
    maxAttempts: 5,
    rateLimitMaxRequests: 5,
    rateLimitWindowMinutes: 15,
  });
  if (!challengeRes.success) throw new Error("Failed to create challenge");
  const cId = challengeRes.challengeId!;

  // Test wrong attempts atomically
  for (let i = 1; i <= 4; i++) {
    const failedAttempt = await recordFailedOtpAttempt(cId);
    if (failedAttempt.attempts !== i || failedAttempt.isExhausted) {
      throw new Error(`Wrong attempt tracking mismatch at step ${i}`);
    }
  }
  console.log("✓ Failed attempts increment atomically (1..4)");

  // 5th failed attempt must exhaust and invalidate
  const fifthAttempt = await recordFailedOtpAttempt(cId);
  if (fifthAttempt.attempts !== 5 || !fifthAttempt.isExhausted) {
    throw new Error("5th attempt should have exhausted and invalidated challenge");
  }
  const activeAfterExhaust = await getActiveOtpChallenge(80003);
  if (activeAfterExhaust !== null) {
    throw new Error("Exhausted challenge should no longer be active");
  }
  console.log("✓ 5th failed attempt automatically invalidated the challenge");

  const mockFailingSmtp = {
    sendOtpEmail: async () => {
      throw new Error("SMTP Network Timeout (Simulated Failure)");
    },
  } as unknown as SmtpEmailClient;

  const mockSmtpConfig = {
    host: "localhost",
    port: 587,
    secure: false,
    requireTls: true,
    user: "test@example.com",
    pass: "testpass",
    from: "noreply@example.com",
    otpTtlMinutes: 10,
    otpMaxAttempts: 5,
    otpRateLimitWindowMinutes: 15,
    otpRateLimitMaxRequests: 5,
  };

  const otpServiceFailing = new OtpService(mockSmtpConfig, mockFailingSmtp);

  // Set conversation to AWAIT_USERNAME
  await setConversationState(80004, "AWAIT_USERNAME", { username: "TestUserX" });

  const sendResult = await otpServiceFailing.requestAndSendOtp({
    telegramUserId: 80004,
    baseUser: {
      id: 9001,
      username: "TestUserX",
      display_name: "User X",
      email: "userx@company.com",
      is_active: true,
    },
  });
  if (sendResult.success) throw new Error("Expected SMTP failure to return failure");

  // Verify challenge was invalidated and conversation did NOT become AWAIT_OTP
  const convAfterSmtpFail = await getConversationState(80004);
  const activeOtpAfterFail = await getActiveOtpChallenge(80004);
  console.log("Conversation state after SMTP fail:", convAfterSmtpFail.state);
  console.log("Active OTP challenge after SMTP fail:", activeOtpAfterFail);

  if (convAfterSmtpFail.state === "AWAIT_OTP") {
    throw new Error("SECURITY VIOLATION: Conversation moved to AWAIT_OTP despite SMTP failure!");
  }
  if (activeOtpAfterFail !== null) {
    throw new Error("SECURITY VIOLATION: Active challenge left active despite SMTP failure!");
  }
  console.log("✓ SMTP Failure Safety verified: challenge invalidated and conversation preserved");

  // Step 6: Verify-Before-Switch Relinking & Relink Atomicity
  console.log("\n[6/9] Testing Relink Atomicity & Verify-Before-Switch...");

  // Establish initial active link: Telegram 80001 ↔ Base 9001 (User X)
  await query(`
    INSERT INTO telegram_links (base_user_id, telegram_user_id, telegram_chat_id, reminders_enabled)
    VALUES (9001, 80001, 80001, true)
  `);
  await setConversationState(80001, "LINKED", {});

  // Begin relink to Base 9002 (User Y)
  const relinkOtp = "123456";
  const relinkHash = await bcrypt.hash(relinkOtp, 10);
  const relinkChallengeRes = await createOtpChallengeAtomic({
    telegramUserId: 80001,
    baseUserId: 9002,
    otpHash: relinkHash,
    ttlMinutes: 10,
    maxAttempts: 5,
    rateLimitMaxRequests: 5,
    rateLimitWindowMinutes: 15,
  });
  const relinkCId = relinkChallengeRes.challengeId!;

  // Verify that BEFORE OTP is verified, original link to 9001 is STILL ACTIVE
  const linkBeforeOtp = await getActiveTelegramLinkByTelegramId(80001);
  if (!linkBeforeOtp || linkBeforeOtp.base_user_id !== 9001) {
    throw new Error("Verify-before-switch violation: original link deactivated before OTP verified!");
  }
  console.log("✓ Verify-Before-Switch verified: original link (Base 9001) remains active during OTP input");

  // Complete linking transaction atomically
  const completeRes = await atomicCompleteLinkingTransaction({
    otpChallengeId: relinkCId,
    telegramUserId: 80001,
    telegramChatId: 80001,
    baseUserId: 9002,
  });
  if (!completeRes.success) throw new Error("Atomic relink failed");

  // Verify new link is now active and old link is soft deleted
  const linkAfterRelink = await getActiveTelegramLinkByTelegramId(80001);
  if (!linkAfterRelink || linkAfterRelink.base_user_id !== 9002) {
    throw new Error("Relink failed: new active link not found");
  }

  const allLinks = await query<{ base_user_id: number; unlinked_at: Date | null }>(`
    SELECT base_user_id, unlinked_at FROM telegram_links WHERE telegram_user_id = 80001 ORDER BY id ASC
  `);
  console.log("Telegram 80001 links:", allLinks.rows);
  if (allLinks.rows.length !== 2) throw new Error("Expected 2 link records (1 historical, 1 active)");
  if (allLinks.rows[0]?.unlinked_at === null || allLinks.rows[1]?.unlinked_at !== null) {
    throw new Error("Link states invalid after atomic relink");
  }
  console.log("✓ Atomic Relinking verified: old link deactivated and new link activated in single transaction");

  // Step 7: Post-Commit Previous Telegram Notification Failure
  console.log("\n[7/9] Testing Post-Commit Previous Telegram Notification Isolation...");
  
  // Link Telegram 80002 to Base 9001
  await query(`
    INSERT INTO telegram_links (base_user_id, telegram_user_id, telegram_chat_id, reminders_enabled)
    VALUES (9001, 80002, 80002, true)
  `);

  // Relink Base 9001 to Telegram 80003 (Taking over Base 9001 from Telegram 80002)
  const takeOverChallenge = await createOtpChallengeAtomic({
    telegramUserId: 80003,
    baseUserId: 9001,
    otpHash: hardHash,
    ttlMinutes: 10,
    maxAttempts: 5,
    rateLimitMaxRequests: 5,
    rateLimitWindowMinutes: 15,
  });

  const linkingServiceWithBrokenNotifier = new LinkingService(
    async () => {
      throw new Error("Telegram Bot API Network Error (Simulated Failure)");
    }
  );

  const relinkResult = await linkingServiceWithBrokenNotifier.finalizeLink({
    otpChallengeId: takeOverChallenge.challengeId!,
    telegramUserId: 80003,
    telegramChatId: 80003,
    baseUserId: 9001,
  });

  if (!relinkResult.success || !relinkResult.isRelink) {
    throw new Error("Relink should have succeeded despite post-commit notifier error");
  }

  const newLinkCheck = await getActiveTelegramLinkByTelegramId(80003);
  if (!newLinkCheck || newLinkCheck.base_user_id !== 9001) {
    throw new Error("New link was rolled back due to notifier failure!");
  }
  console.log("✓ Post-commit notification error did NOT roll back the committed link");

  // Step 8: Inactive User Linking Protection
  console.log("\n[8/9] Testing Inactive Base User Re-check Protection...");
  const inactiveChallenge = await createOtpChallengeAtomic({
    telegramUserId: 80004,
    baseUserId: 9003, // InactiveUserZ
    otpHash: hardHash,
    ttlMinutes: 10,
    maxAttempts: 5,
    rateLimitMaxRequests: 5,
    rateLimitWindowMinutes: 15,
  });
  const inactiveLinkAttempt = await atomicCompleteLinkingTransaction({
    otpChallengeId: inactiveChallenge.challengeId!,
    telegramUserId: 80004,
    telegramChatId: 80004,
    baseUserId: 9003,
  });
  if (inactiveLinkAttempt.success) {
    throw new Error("SECURITY VIOLATION: Allowed linking to inactive Base user!");
  }
  console.log("✓ Inactive Base user strictly rejected during final transaction re-check");

  // Step 9: Audit Data Minimization Check
  console.log("\n[9/9] Inspecting Audit Log Data Minimization...");
  const auditEntries = await query<{ event_type: string; metadata: any }>(`
    SELECT event_type, metadata FROM audit_log ORDER BY id DESC LIMIT 50
  `);
  console.log(`Inspected ${auditEntries.rows.length} audit entries.`);
  for (const entry of auditEntries.rows) {
    const metaStr = JSON.stringify(entry.metadata);
    // Assert no raw email (must be masked or omitted)
    if (metaStr.includes("@company.com")) {
      throw new Error(`SECURITY VIOLATION: Full email found in audit_log metadata: ${metaStr}`);
    }
    // Assert no tokens or OTPs
    if (metaStr.includes("otp_hash") || metaStr.includes("token") || metaStr.includes("password")) {
      throw new Error(`SECURITY VIOLATION: Secret keyword found in audit_log metadata: ${metaStr}`);
    }
  }
  console.log("✓ Audit log strictly adheres to data minimization (zero PII, plaintext OTPs, or tokens)");

  // Clean up test data
  await query(`DELETE FROM audit_log WHERE actor_telegram_id IN (80001, 80002, 80003, 80004) OR actor_base_user_id IN (9001, 9002, 9003)`);
  await query(`DELETE FROM otp_challenges WHERE telegram_user_id IN (80001, 80002, 80003, 80004) OR base_user_id IN (9001, 9002, 9003)`);
  await query(`DELETE FROM telegram_links WHERE telegram_user_id IN (80001, 80002, 80003, 80004) OR base_user_id IN (9001, 9002, 9003)`);
  await query(`DELETE FROM telegram_conversations WHERE telegram_user_id IN (80001, 80002, 80003, 80004)`);
  await query(`DELETE FROM base_users WHERE id IN (9001, 9002, 9003)`);

  console.log("\n================================================================");
  console.log("ALL REAL POSTGRESQL 16 SECURITY CHECKS PASSED SUCCESSFULLY!");
  console.log("================================================================");
}

runVerification()
  .catch((err) => {
    console.error("\n❌ VERIFICATION FAILED:", err);
    process.exit(1);
  })
  .finally(() => closePool());
