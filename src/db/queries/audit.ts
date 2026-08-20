/**
 * src/db/queries/audit.ts
 *
 * Persistent audit logging queries.
 *
 * Security rules:
 *  - NEVER pass plaintext OTP, OTP hash, tokens, passwords, raw emails, or Base task content.
 *  - Pass only event types, numeric/bigint actor IDs, and safe metadata codes.
 */

import { query } from "../connection.js";

export interface AuditLogEntry {
  id: number;
  event_type: string;
  actor_telegram_id: string | null;
  actor_base_user_id: number | null;
  metadata: Record<string, unknown>;
  created_at: Date;
}

export async function writeAuditLog(params: {
  eventType: string;
  actorTelegramId?: number | string | bigint | null;
  actorBaseUserId?: number | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const telegramIdStr = params.actorTelegramId != null ? String(params.actorTelegramId) : null;
  const baseUserId = params.actorBaseUserId != null ? Number(params.actorBaseUserId) : null;
  const metadata = params.metadata ?? {};

  await query(
    `
    INSERT INTO audit_log (event_type, actor_telegram_id, actor_base_user_id, metadata, created_at)
    VALUES ($1, $2, $3, $4, NOW())
    `,
    [params.eventType, telegramIdStr, baseUserId, JSON.stringify(metadata)]
  );
}
