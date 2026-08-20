/**
 * src/db/queries/deliveries.ts
 *
 * Typed database queries for `reminder_deliveries` table.
 * Per-user delivery state and per-module count tracking.
 *
 * Persistence rule:
 *  - Only metadata, status, counts, and errors are saved.
 *  - NEVER save task/job/request title, description, or raw content.
 */

import { query, getClient } from "../connection.js";

export interface DeliveryInsertItem {
  baseUserId: number;
  status: "pending" | "sending" | "delivered" | "empty" | "error" | "skipped";
  weworkStatus: "ok" | "error" | "pending";
  weworkCount: number;
  workflowStatus: "ok" | "error" | "pending";
  workflowCount: number;
  requestStatus: "ok" | "error" | "pending";
  requestCount: number;
  isPartial: boolean;
  errorMessage?: string | null;
}

export interface ReminderDeliveryRecord {
  id: number;
  run_id: number;
  base_user_id: number;
  status: "pending" | "sending" | "delivered" | "empty" | "error" | "skipped";
  wework_status: string;
  wework_count: number;
  workflow_status: string;
  workflow_count: number;
  request_status: string;
  request_count: number;
  is_partial: boolean;
  telegram_message_id: number | null;
  error_message: string | null;
  delivery_channel: string;
  telegram_error_code: string | null;
  chunks_total: number;
  chunks_sent: number;
  delivery_started_at: Date | null;
  delivery_completed_at: Date | null;
  delivered_at: Date | null;
  created_at: Date;
}

/**
 * Batch insert reminder delivery records for a given run_id.
 * Uses a single SQL statement for efficiency.
 */
export async function batchInsertDeliveries(
  runId: number,
  items: DeliveryInsertItem[]
): Promise<void> {
  if (items.length === 0) return;

  const client = await getClient();
  try {
    await client.query("BEGIN");

    for (const item of items) {
      await client.query(
        `
        INSERT INTO reminder_deliveries (
          run_id,
          base_user_id,
          status,
          wework_status,
          wework_count,
          workflow_status,
          workflow_count,
          request_status,
          request_count,
          is_partial,
          error_message
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT (run_id, base_user_id) DO UPDATE
          SET status = EXCLUDED.status,
              wework_status = EXCLUDED.wework_status,
              wework_count = EXCLUDED.wework_count,
              workflow_status = EXCLUDED.workflow_status,
              workflow_count = EXCLUDED.workflow_count,
              request_status = EXCLUDED.request_status,
              request_count = EXCLUDED.request_count,
              is_partial = EXCLUDED.is_partial,
              error_message = EXCLUDED.error_message
        `,
        [
          runId,
          item.baseUserId,
          item.status,
          item.weworkStatus,
          item.weworkCount,
          item.workflowStatus,
          item.workflowCount,
          item.requestStatus,
          item.requestCount,
          item.isPartial,
          item.errorMessage ?? null,
        ]
      );
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Update delivery status and M2B operational metadata.
 */
export async function updateDeliveryStatus(
  deliveryId: number,
  fields: {
    status: "pending" | "sending" | "delivered" | "empty" | "error" | "skipped";
    telegramErrorCode?: string | null;
    errorMessage?: string | null;
    chunksTotal?: number;
    chunksSent?: number;
    deliveryStartedAt?: Date | null;
    deliveryCompletedAt?: Date | null;
    telegramMessageId?: number | null;
  }
): Promise<void> {
  const setClauses: string[] = [];
  const values: unknown[] = [deliveryId];
  let paramIdx = 2;

  setClauses.push(`status = $${paramIdx++}`);
  values.push(fields.status);

  if (fields.telegramErrorCode !== undefined) {
    setClauses.push(`telegram_error_code = $${paramIdx++}`);
    values.push(fields.telegramErrorCode);
  }

  if (fields.errorMessage !== undefined) {
    setClauses.push(`error_message = $${paramIdx++}`);
    values.push(fields.errorMessage);
  }

  if (fields.chunksTotal !== undefined) {
    setClauses.push(`chunks_total = $${paramIdx++}`);
    values.push(fields.chunksTotal);
  }

  if (fields.chunksSent !== undefined) {
    setClauses.push(`chunks_sent = $${paramIdx++}`);
    values.push(fields.chunksSent);
  }

  if (fields.deliveryStartedAt !== undefined) {
    setClauses.push(`delivery_started_at = $${paramIdx++}`);
    values.push(fields.deliveryStartedAt);
  }

  if (fields.deliveryCompletedAt !== undefined) {
    setClauses.push(`delivery_completed_at = $${paramIdx++}`);
    values.push(fields.deliveryCompletedAt);
    setClauses.push(`delivered_at = $${paramIdx++}`);
    values.push(fields.deliveryCompletedAt);
  }

  if (fields.telegramMessageId !== undefined) {
    setClauses.push(`telegram_message_id = $${paramIdx++}`);
    values.push(fields.telegramMessageId);
  }

  await query(
    `
    UPDATE reminder_deliveries
    SET ${setClauses.join(", ")}
    WHERE id = $1
    `,
    values
  );
}

/**
 * Fetch a single delivery record by run ID and Base user ID.
 */
export async function getDeliveryByRunAndUser(
  runId: number,
  baseUserId: number
): Promise<ReminderDeliveryRecord | null> {
  const result = await query<ReminderDeliveryRecord>(
    `SELECT * FROM reminder_deliveries WHERE run_id = $1 AND base_user_id = $2 LIMIT 1`,
    [runId, baseUserId]
  );
  return result.rows[0] ?? null;
}

/**
 * Fetch all delivery records for a specific run.
 */
export async function getDeliveriesByRunId(
  runId: number
): Promise<ReminderDeliveryRecord[]> {
  const result = await query<ReminderDeliveryRecord>(
    `SELECT * FROM reminder_deliveries WHERE run_id = $1 ORDER BY base_user_id ASC`,
    [runId]
  );
  return result.rows;
}

/**
 * Crash recovery: Mark stale deliveries stuck in 'sending' as 'error' with 'AMBIGUOUS_AFTER_CRASH'.
 */
export async function markStaleSendingDeliveries(
  staleMinutes: number = 5
): Promise<number> {
  const result = await query<{ count: string }>(
    `
    WITH updated AS (
      UPDATE reminder_deliveries
      SET status = 'error',
          telegram_error_code = 'AMBIGUOUS_AFTER_CRASH',
          error_message = 'server restarted while sending was in progress'
      WHERE status = 'sending'
        AND delivery_started_at < NOW() - ($1 || ' minutes')::INTERVAL
      RETURNING id
    )
    SELECT count(*)::text as count FROM updated
    `,
    [staleMinutes]
  );

  return parseInt(result.rows[0]?.count ?? "0", 10);
}
