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
  status: string;
  wework_status: string;
  wework_count: number;
  workflow_status: string;
  workflow_count: number;
  request_status: string;
  request_count: number;
  is_partial: boolean;
  telegram_message_id: number | null;
  error_message: string | null;
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
