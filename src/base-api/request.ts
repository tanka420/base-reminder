/**
 * src/base-api/request.ts
 *
 * Base Request (v1) API Adapter.
 *
 * Implements endpoints verified in M0/M0.1:
 *   POST https://request.base.vn/extapi/v1/request/list
 *
 * Single retry authority: BaseApiClient.
 * Pagination has deterministic termination conditions with max loop guards.
 */

import { BaseApiClient, type BaseApiResponse } from "./client.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BaseRequestOwner {
  username: string;
  approved: number;
  [key: string]: unknown;
}

export interface BaseRequestItem {
  id: number;
  name: string;
  hid?: string;
  user_id?: number;
  username?: string; // Creator username
  status: string; // "0" = pending
  state?: string; // "active"
  workflow?: string; // "sequential" | "parallel"
  owners?: BaseRequestOwner[];
  approvals?: string[];
  rejecters?: string[];
  deadline?: string | number;
  since?: string | number;
  last_update?: string | number;
  [key: string]: unknown;
}

interface RequestListResponse extends BaseApiResponse<unknown> {
  page?: number;
  items_per_page?: number;
  total_items?: string | number;
  requests?: BaseRequestItem[];
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class RequestApiClient {
  readonly #client: BaseApiClient;
  static readonly MAX_PAGES = 20;
  static readonly PAGE_SIZE = 20;

  constructor(token: string, timeoutMs?: number, concurrency?: number) {
    this.#client = new BaseApiClient({
      module: "request",
      baseUrl: "https://request.base.vn",
      token,
      timeoutMs,
      concurrency,
    });
  }

  /**
   * List pending requests associated with a user.
   *
   * Note: The `users` query param returns requests where user is involved
   * (creator, follower, approver). Actionable filtering must be applied
   * at application level via `isRequestActionableForUser`.
   *
   * @param username  Username without @ prefix (e.g. "Digital01")
   * @param page      0-based page index
   */
  async listPendingRequests(
    username: string,
    page = 0
  ): Promise<{ requests: BaseRequestItem[]; totalItems?: number }> {
    const cleanUser = username.startsWith("@") ? username.slice(1) : username;
    const response = await this.#client.post<RequestListResponse>(
      "/extapi/v1/request/list",
      {
        users: cleanUser,
        status: "pending",
        page: String(page),
      }
    );

    const requests = Array.isArray(response.requests) ? response.requests : [];
    const totalItems =
      response.total_items !== undefined ? Number(response.total_items) : undefined;

    return { requests, totalItems };
  }

  /**
   * Fetch all pending requests across all pages with termination guards.
   */
  async getAllPendingRequests(username: string): Promise<BaseRequestItem[]> {
    const allRequests: BaseRequestItem[] = [];
    const seenIds = new Set<number>();

    for (let page = 0; page < RequestApiClient.MAX_PAGES; page++) {
      const { requests, totalItems } = await this.listPendingRequests(username, page);

      if (requests.length === 0) break;

      let newItemsInPage = 0;
      for (const r of requests) {
        if (!seenIds.has(r.id)) {
          seenIds.add(r.id);
          allRequests.push(r);
          newItemsInPage++;
        }
      }

      // Termination conditions
      if (newItemsInPage === 0) break; // Repeat guard
      if (requests.length < RequestApiClient.PAGE_SIZE) break; // Last partial page
      if (totalItems !== undefined && allRequests.length >= totalItems) break;
    }

    return allRequests;
  }
}
