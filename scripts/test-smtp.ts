/**
 * scripts/test-smtp.ts
 *
 * SMTP Connection test & OTP email delivery test.
 *
 * Usage:
 *   npx tsx scripts/test-smtp.ts [--to <email>] [--name <displayName>]
 */

import "dotenv/config";
import crypto from "crypto";
import nodemailer from "nodemailer";
import { loadSmtpConfig } from "../src/config/index.js";
import { SmtpEmailClient, maskEmail } from "../src/email/smtp-client.js";

async function main() {
  console.log("================================================================");
  console.log("BASE REMINDER — SMTP CONNECTION & OTP DELIVERY TEST");
  console.log("================================================================");

  let smtpConfig;
  try {
    smtpConfig = loadSmtpConfig();
  } catch (err: any) {
    console.error("❌ Failed to load SMTP config:", err.message);
    process.exit(1);
  }

  console.log(`SMTP Host   : ${smtpConfig.host}`);
  console.log(`SMTP Port   : ${smtpConfig.port}`);
  console.log(`SMTP Secure : ${smtpConfig.secure}`);
  console.log(`Require TLS : ${smtpConfig.requireTls}`);
  console.log(`SMTP User   : ${smtpConfig.user}`);
  console.log(`SMTP From   : ${smtpConfig.from}`);

  // Step 1: Verify SMTP Connection
  console.log("\n[1/2] Verifying SMTP Connection & Authentication...");
  const transporter = nodemailer.createTransport({
    host: smtpConfig.host,
    port: smtpConfig.port,
    secure: smtpConfig.secure,
    requireTLS: smtpConfig.requireTls,
    auth: {
      user: smtpConfig.user,
      pass: smtpConfig.pass,
    },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });

  try {
    await transporter.verify();
    console.log("✅ SMTP connection and authentication verified successfully!");
  } catch (err: any) {
    console.error("❌ SMTP Connection verification failed:", err.message);
    process.exit(1);
  }

  // Step 2: Determine target email
  const args = process.argv.slice(2);
  let targetEmail = smtpConfig.user; // default to SMTP_USER (Boss / admin email)
  let displayName = "Boss / Quản trị viên";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--to" && args[i + 1]) {
      targetEmail = args[i + 1]!;
      i++;
    } else if (args[i] === "--name" && args[i + 1]) {
      displayName = args[i + 1]!;
      i++;
    }
  }

  console.log(`\n[2/2] Sending test OTP email to: ${maskEmail(targetEmail)} (${targetEmail})...`);
  const testOtp = crypto.randomInt(100_000, 1_000_000).toString();

  const client = new SmtpEmailClient(smtpConfig, transporter);

  try {
    await client.sendOtpEmail({
      toEmail: targetEmail,
      otpCode: testOtp,
      displayName,
      ttlMinutes: 10,
    });
    console.log(`✅ Test OTP email sent successfully to ${targetEmail}!`);
    console.log(`   (Mã OTP test được tạo: ${testOtp})`);
  } catch (err: any) {
    console.error("❌ Failed to send OTP email:", err.message);
    process.exit(1);
  }

  console.log("\n================================================================");
  console.log("SMTP TEST COMPLETED SUCCESSFULLY!");
  console.log("================================================================");
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
