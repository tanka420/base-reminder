/**
 * src/db/queries/users.ts
 *
 * Typed queries for `base_users` table.
 */

import { query } from "../connection.js";

export interface ActiveBaseUser {
  id: number;
  username: string;
  display_name: string;
  email: string;
  is_active: boolean;
}

/**
 * Fetch all active workspace members from `base_users`.
 */
export async function getActiveBaseUsers(): Promise<ActiveBaseUser[]> {
  const result = await query<ActiveBaseUser>(
    `
    SELECT id, username, display_name, email, is_active
    FROM base_users
    WHERE is_active = true
    ORDER BY id ASC
    `
  );
  return result.rows;
}

/**
 * Fetch a single user by username.
 */
export async function getBaseUserByUsername(
  username: string
): Promise<ActiveBaseUser | null> {
  const result = await query<ActiveBaseUser>(
    `
    SELECT id, username, display_name, email, is_active
    FROM base_users
    WHERE LOWER(username) = LOWER($1)
    LIMIT 1
    `,
    [username.trim()]
  );
  return result.rows[0] ?? null;
}
