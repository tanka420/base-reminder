/**
 * src/base-api/wework.ts
 *
 * Base Wework (v3) API Adapter.
 *
 * Implements endpoints verified in M0:
 *   POST https://wework.base.vn/extapi/v3/user/tasks
 *
 * Single retry authority: BaseApiClient.
 * Pagination has deterministic termination conditions with max loop guards.
 */

import { BaseApiClient, type BaseApiResponse } from "./client.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BaseWeworkTask {
  id: number;
  name: string;
  display_name?: string;
  content_short?: string;
  link?: string;
  hid?: string;
  user_id?: number;
  username?: string;
  status: string;
  has_deadline?: string | number;
  deadline?: string | number;
  deadline_has_time?: number;
  overdue?: number | string;
  project_id?: number;
  [key: string]: unknown;
}

interface UserTasksResponse extends BaseApiResponse<unknown> {
  total?: number;
  tasks?: BaseWeworkTask[];
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class WeworkApiClient {
  readonly #client: BaseApiClient;
  static readonly MAX_PAGES = 20;
  static readonly PAGE_SIZE = 100;

  constructor(token: string, timeoutMs?: number, concurrency?: number) {
    this.#client = new BaseApiClient({
      module: "wework",
      baseUrl: "https://wework.base.vn",
      token,
      timeoutMs,
      concurrency,
    });
  }

  /**
   * Fetch a single page of tasks for a user.
   *
   * @param user  Username (with or without @ prefix, e.g. "Digital01")
   * @param page  0-based page index
   */
  async getUserTasks(
    user: string,
    page = 0
  ): Promise<{ tasks: BaseWeworkTask[]; total: number }> {
    const formattedUser = user.startsWith("@") ? user : `@${user}`;
    const response = await this.#client.post<UserTasksResponse>(
      "/extapi/v3/user/tasks",
      {
        user: formattedUser,
        page: String(page),
      }
    );

    const tasks = Array.isArray(response.tasks) ? response.tasks : [];
    const total = typeof response.total === "number" ? response.total : tasks.length;

    return { tasks, total };
  }

  /**
   * Fetch all tasks for a user across all pages with robust termination guards.
   *
   * Termination conditions:
   *  1. Page returned 0 tasks
   *  2. Page returned < 100 tasks (last page)
   *  3. Total fetched >= response.total
   *  4. Max iteration limit (MAX_PAGES = 20) reached
   *  5. Repeated task IDs detected (prevents infinite loop if API returns duplicate pages)
   */
  async getAllUserTasks(user: string): Promise<BaseWeworkTask[]> {
    const allTasks: BaseWeworkTask[] = [];
    const seenIds = new Set<number>();

    for (let page = 0; page < WeworkApiClient.MAX_PAGES; page++) {
      const { tasks, total } = await this.getUserTasks(user, page);

      if (tasks.length === 0) break;

      let newItemsInPage = 0;
      for (const t of tasks) {
        if (!seenIds.has(t.id)) {
          seenIds.add(t.id);
          allTasks.push(t);
          newItemsInPage++;
        }
      }

      // Termination conditions
      if (newItemsInPage === 0) break; // API repeating same items
      if (tasks.length < WeworkApiClient.PAGE_SIZE) break; // Reached last partial page
      if (allTasks.length >= total) break; // Reached total advertised by API
    }

    return allTasks;
  }
}
