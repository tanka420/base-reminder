/**
 * src/sync/user-sync.ts
 *
 * Base Account API → PostgreSQL synchronization.
 *
 * Algorithm (per architecture-review.md v1.1 §6):
 *  1. Fetch all users from Account API (single call, ~30 users)
 *  2. UPSERT each user into base_users matching on Base user ID
 *     - Update: username, display_name, email, is_active, synced_at, updated_at
 *     - is_active = (status === "0")
 *  3. Any user present in local DB but absent from API response → is_active = false
 *  4. Use a single transaction for atomicity
 *
 * Rules:
 *  - Base user ID is canonical identity (never match on username)
 *  - Username may change — always update it
 *  - Never delete users (soft-deactivation only)
 *  - Idempotent: safe to run multiple times
 *  - Email is stored but NEVER logged (PII)
 */

import { getClient } from "../db/connection.js";
import { AccountApiClient } from "../base-api/account.js";
import { logger } from "../logging/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SyncResult {
  total: number;
  created: number;
  updated: number;
  deactivated: number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Synchronize Base workspace users into the local base_users table.
 *
 * @param accountClient  Initialized AccountApiClient
 * @returns              Summary of the sync operation
 */
export async function syncUsers(
  accountClient: AccountApiClient
): Promise<SyncResult> {
  logger.info({ msg: "user sync starting" });

  // --- Step 1: Fetch all users from Account API ---
  const apiUsers = await accountClient.getAllUsers();
  logger.info({ msg: "fetched users from Account API", count: apiUsers.length });

  const apiUserIds = new Set(apiUsers.map((u) => u.id));

  // --- Step 2 & 3: Upsert + deactivate in a single transaction ---
  const client = await getClient();

  let created = 0;
  let updated = 0;
  let deactivated = 0;

  try {
    await client.query("BEGIN");

    // --- Step 2: UPSERT each user from API response ---
    for (const user of apiUsers) {
      const isActive = user.status === "0";

      const result = await client.query<{ created: boolean }>(
        `
        INSERT INTO base_users (id, username, display_name, email, is_active, synced_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
        ON CONFLICT (id) DO UPDATE
          SET username     = EXCLUDED.username,
              display_name = EXCLUDED.display_name,
              email        = EXCLUDED.email,
              is_active    = EXCLUDED.is_active,
              synced_at    = NOW(),
              updated_at   = NOW()
        RETURNING
          (xmax = 0) AS created
        `,
        [user.id, user.username, user.name, user.email, isActive]
      );

      const row = result.rows[0];
      if (row?.created === true) {
        created++;
      } else {
        updated++;
      }
    }

    // --- Step 3: Deactivate users no longer in API response ---
    let deactivateResult;
    if (apiUserIds.size > 0) {
      // Convert Set to array for parameterization
      const apiIdArray = Array.from(apiUserIds);

      deactivateResult = await client.query<{ id: number }>(
        `
        UPDATE base_users
        SET is_active  = false,
            updated_at = NOW()
        WHERE is_active = true
          AND NOT (id = ANY($1::int[]))
        RETURNING id
        `,
        [apiIdArray]
      );
    } else {
      deactivateResult = await client.query<{ id: number }>(
        `
        UPDATE base_users
        SET is_active  = false,
            updated_at = NOW()
        WHERE is_active = true
        RETURNING id
        `
      );
    }

    deactivated = deactivateResult.rowCount ?? 0;

      if (deactivated > 0) {
        // Log IDs only — never log usernames or emails
        const deactivatedIds = deactivateResult.rows.map((r) => r.id);
        logger.info({
          msg: "users deactivated (no longer in workspace)",
          base_user_ids: deactivatedIds,
          count: deactivated,
        });
      }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    logger.error({
      msg: "user sync failed — transaction rolled back",
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    client.release();
  }

  const result: SyncResult = {
    total: apiUsers.length,
    created,
    updated,
    deactivated,
  };

  logger.info({
    msg: "user sync complete",
    total: result.total,
    created: result.created,
    updated: result.updated,
    deactivated: result.deactivated,
  });

  return result;
}
