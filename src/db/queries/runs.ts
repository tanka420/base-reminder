/**
 * src/db/queries/runs.ts
 *
 * Typed database queries for `reminder_runs` table.
 * Scheduler idempotency and run-level status tracking.
 */

import { query } from "../connection.js";

export interface ReminderRunRecord {
  id: number;
  run_date: string;
  run_key: string;
  status: "started" | "collecting" | "delivering" | "completed" | "failed";
  users_total: number;
  users_delivered: number;
  users_empty: number;
  users_error: number;
  started_at: Date;
  completed_at: Date | null;
  error_message: string | null;
  created_at: Date;
}

/**
 * Attempt to insert a new reminder run for today's run_key.
 * Returns the run ID on success, or null if a run already exists (idempotency).
 */
export async function createReminderRun(
  runKey: string,
  runDate: string
): Promise<number | null> {
  const result = await query<{ id: number }>(
    `
    INSERT INTO reminder_runs (run_key, run_date, status, started_at)
    VALUES ($1, $2, 'started', NOW())
    ON CONFLICT (run_key) DO NOTHING
    RETURNING id
    `,
    [runKey, runDate]
  );

  return result.rows[0]?.id ?? null;
}

/**
 * Update reminder run status and operational summary fields.
 */
export async function updateReminderRun(
  id: number,
  fields: {
    status?: "started" | "collecting" | "delivering" | "completed" | "failed";
    users_total?: number;
    users_delivered?: number;
    users_empty?: number;
    users_error?: number;
    completed_at?: Date | null;
    error_message?: string | null;
  }
): Promise<void> {
  const setClauses: string[] = [];
  const values: unknown[] = [id];
  let paramIdx = 2;

  if (fields.status !== undefined) {
    setClauses.push(`status = $${paramIdx++}`);
    values.push(fields.status);
  }
  if (fields.users_total !== undefined) {
    setClauses.push(`users_total = $${paramIdx++}`);
    values.push(fields.users_total);
  }
  if (fields.users_delivered !== undefined) {
    setClauses.push(`users_delivered = $${paramIdx++}`);
    values.push(fields.users_delivered);
  }
  if (fields.users_empty !== undefined) {
    setClauses.push(`users_empty = $${paramIdx++}`);
    values.push(fields.users_empty);
  }
  if (fields.users_error !== undefined) {
    setClauses.push(`users_error = $${paramIdx++}`);
    values.push(fields.users_error);
  }
  if (fields.completed_at !== undefined) {
    setClauses.push(`completed_at = $${paramIdx++}`);
    values.push(fields.completed_at);
  }
  if (fields.error_message !== undefined) {
    setClauses.push(`error_message = $${paramIdx++}`);
    values.push(fields.error_message);
  }

  if (setClauses.length === 0) return;

  await query(
    `UPDATE reminder_runs SET ${setClauses.join(", ")} WHERE id = $1`,
    values
  );
}

/**
 * Fetch a reminder run by its unique run_key (e.g. "2026-08-20").
 */
export async function getReminderRunByKey(
  runKey: string
): Promise<ReminderRunRecord | null> {
  const result = await query<ReminderRunRecord>(
    `SELECT * FROM reminder_runs WHERE run_key = $1`,
    [runKey]
  );
  return result.rows[0] ?? null;
}

/**
 * Fetch the latest completed or in-progress run.
 */
export async function getLatestReminderRun(): Promise<ReminderRunRecord | null> {
  const result = await query<ReminderRunRecord>(
    `SELECT * FROM reminder_runs ORDER BY id DESC LIMIT 1`
  );
  return result.rows[0] ?? null;
}
