/**
 * src/base-api/account.ts
 *
 * Account API adapter.
 *
 * Implements only the two endpoints verified in M0:
 *   POST https://account.base.vn/extapi/v1/users
 *   POST https://account.base.vn/extapi/v1/user/search.by.username
 *
 * Field mappings are derived exclusively from docs/base-api-findings.md.
 * No fields are invented or assumed beyond what was confirmed in M0 probes.
 *
 * Security: token is injected by BaseApiClient; never exposed or logged here.
 */

import { BaseApiClient } from "./client.js";

// ---------------------------------------------------------------------------
// Types — verified field structure from docs/base-api-findings.md §1
// ---------------------------------------------------------------------------

/**
 * A single workspace member as returned by the Account API.
 * All fields confirmed via M0 probe (4/4 PASS).
 */
export interface BaseAccountUser {
  /** Unique Base user ID (integer). This is the canonical identity. */
  id: number;
  /** Base username (e.g. "Digital01"). May change over time. */
  username: string;
  /** Full display name (API field: name, e.g. "Mai Thanh Tân") */
  name: string;
  /** First name portion */
  first_name: string;
  /** Last name portion */
  last_name: string;
  /** Corporate/registered email */
  email: string;
  /**
   * Account status.
   * "0" = Active
   * "1" or other = Deactivated
   */
  status: string;
  /** Job title / position */
  title: string;
  /** Array of manager usernames */
  manager: string[];
  /** Array of direct report usernames */
  direct_reports: string[];
}

/** Response shape for POST /extapi/v1/users */
interface GetAllUsersResponse {
  code: number;
  message: string;
  data: unknown;
  users: BaseAccountUser[];
  [key: string]: unknown;
}

/** Response shape for POST /extapi/v1/user/search.by.username */
interface SearchByUsernameResponse {
  code: number;
  message: string;
  data: unknown;
  /** The found user, or undefined / null when not found */
  user?: BaseAccountUser | null;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class AccountApiClient {
  readonly #client: BaseApiClient;

  constructor(token: string, timeoutMs?: number, concurrency?: number) {
    this.#client = new BaseApiClient({
      module: "account",
      baseUrl: "https://account.base.vn",
      token,
      timeoutMs,
      concurrency,
    });
  }

  /**
   * Fetch all workspace members.
   *
   * Endpoint: POST /extapi/v1/users
   * Verified: 4/4 PASS in M0. Returns ~30 users in a single payload (no pagination).
   *
   * @returns Array of all workspace users
   */
  async getAllUsers(): Promise<BaseAccountUser[]> {
    const response = await this.#client.post<GetAllUsersResponse>(
      "/extapi/v1/users"
    );

    if (!Array.isArray(response.users)) {
      throw new Error(
        `[account] getAllUsers: unexpected response shape — ` +
          `code=${response.code} message="${response.message}"`
      );
    }

    return response.users;
  }

  /**
   * Search for a single user by their Base username.
   *
   * Endpoint: POST /extapi/v1/user/search.by.username
   * Verified: PASS for BaseAssistance, Digital01, Executive01 in M0.
   *
   * @param username  Plain username string (e.g. "Digital01", NOT "@Digital01")
   * @returns         The matching user, or null if not found
   */
  async searchByUsername(username: string): Promise<BaseAccountUser | null> {
    const response = await this.#client.post<SearchByUsernameResponse>(
      "/extapi/v1/user/search.by.username",
      { username }
    );

    // API returns code: 1 and user: null/undefined when not found
    if (!response.user) {
      return null;
    }

    return response.user;
  }
}
