/**
 * src/db/queries/chunks.ts
 *
 * Typed database queries for `reminder_delivery_chunks` table.
 * Granular per-chunk state tracking (pending/sending/delivered/error/ambiguous).
 *
 * Invariant:
 *  - ZERO message/chunk body persisted.
 *  - UNIQUE(delivery_id, chunk_index) enforced.
 */

import { query, getClient } from "../connection.js";

export type ChunkStatus = "pending" | "sending" | "delivered" | "error" | "ambiguous";

export interface DeliveryChunkRecord {
  id: number;
  delivery_id: number;
  chunk_index: number;
  status: ChunkStatus;
  telegram_message_id: number | null;
  attempt_count: number;
  error_code: string | null;
  sent_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Initialize chunk records for a given delivery.
 */
export async function createDeliveryChunks(
  deliveryId: number,
  totalChunks: number
): Promise<DeliveryChunkRecord[]> {
  if (totalChunks <= 0) return [];

  const client = await getClient();
  try {
    await client.query("BEGIN");
    const records: DeliveryChunkRecord[] = [];

    for (let i = 0; i < totalChunks; i++) {
      const res = await client.query<DeliveryChunkRecord>(
        `
        INSERT INTO reminder_delivery_chunks (
          delivery_id,
          chunk_index,
          status,
          attempt_count,
          created_at,
          updated_at
        ) VALUES ($1, $2, 'pending', 0, NOW(), NOW())
        ON CONFLICT (delivery_id, chunk_index) DO UPDATE
          SET status = 'pending',
              error_code = NULL,
              updated_at = NOW()
        RETURNING *
        `,
        [deliveryId, i]
      );
      if (res.rows[0]) {
        records.push(res.rows[0]);
      }
    }

    await client.query("COMMIT");
    return records;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Update the state of a specific chunk.
 */
export async function updateChunkStatus(
  deliveryId: number,
  chunkIndex: number,
  fields: {
    status: ChunkStatus;
    telegramMessageId?: number | null;
    errorCode?: string | null;
    sentAt?: Date | null;
    incrementAttempt?: boolean;
  }
): Promise<void> {
  const setClauses: string[] = ["updated_at = NOW()"];
  const values: unknown[] = [deliveryId, chunkIndex];
  let paramIdx = 3;

  setClauses.push(`status = $${paramIdx++}`);
  values.push(fields.status);

  if (fields.incrementAttempt) {
    setClauses.push(`attempt_count = attempt_count + 1`);
  }

  if (fields.telegramMessageId !== undefined) {
    setClauses.push(`telegram_message_id = $${paramIdx++}`);
    values.push(fields.telegramMessageId);
  }

  if (fields.errorCode !== undefined) {
    setClauses.push(`error_code = $${paramIdx++}`);
    values.push(fields.errorCode);
  }

  if (fields.sentAt !== undefined) {
    setClauses.push(`sent_at = $${paramIdx++}`);
    values.push(fields.sentAt);
  }

  await query(
    `
    UPDATE reminder_delivery_chunks
    SET ${setClauses.join(", ")}
    WHERE delivery_id = $1 AND chunk_index = $2
    `,
    values
  );
}

/**
 * Fetch all chunks for a delivery ordered by chunk_index.
 */
export async function getChunksByDeliveryId(
  deliveryId: number
): Promise<DeliveryChunkRecord[]> {
  const result = await query<DeliveryChunkRecord>(
    `
    SELECT * FROM reminder_delivery_chunks
    WHERE delivery_id = $1
    ORDER BY chunk_index ASC
    `,
    [deliveryId]
  );
  return result.rows;
}

/**
 * Crash recovery: Mark stale chunks stuck in 'sending' as 'ambiguous'.
 */
export async function markStaleSendingChunks(
  staleMinutes: number = 5
): Promise<number> {
  const result = await query<{ count: string }>(
    `
    WITH updated AS (
      UPDATE reminder_delivery_chunks
      SET status = 'ambiguous',
          error_code = 'AMBIGUOUS_AFTER_CRASH',
          updated_at = NOW()
      WHERE status = 'sending'
        AND updated_at < NOW() - ($1 || ' minutes')::INTERVAL
      RETURNING id
    )
    SELECT count(*)::text as count FROM updated
    `,
    [staleMinutes]
  );

  return parseInt(result.rows[0]?.count ?? "0", 10);
}
