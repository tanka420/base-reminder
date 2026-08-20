/**
 * src/base-api/workflow.ts
 *
 * Base Workflow (v1) API Adapter.
 *
 * Implements endpoints verified in M0:
 *   POST https://workflow.base.vn/extapi/v1/jobs/get
 *
 * Single retry authority: BaseApiClient.
 * Pagination has deterministic termination conditions with max loop guards.
 */

import { BaseApiClient, type BaseApiResponse } from "./client.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BaseWorkflowStageExport {
  id: number;
  name: string;
  metatype?: string;
  workflow_id?: number;
  [key: string]: unknown;
}

export interface BaseWorkflowExport {
  id: number;
  name: string;
  [key: string]: unknown;
}

export interface BaseWorkflowJob {
  id: number;
  name: string;
  title?: string;
  content_short?: string;
  hid?: string;
  status: string;
  state?: string;
  username: string; // Confirmed as current stage assignee
  user_id?: number;
  creator_id?: number;
  creator_username?: string;
  stage_id?: number;
  stage_export?: BaseWorkflowStageExport;
  workflow_id?: number;
  workflow_export?: BaseWorkflowExport;
  deadline?: string | number;
  stage_deadline?: string | number;
  stage_start?: string | number;
  [key: string]: unknown;
}

interface WorkflowJobsResponse extends BaseApiResponse<unknown> {
  page?: number;
  page_id?: string;
  items_per_page?: string | number;
  total_items?: string | number;
  jobs?: BaseWorkflowJob[];
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class WorkflowApiClient {
  readonly #client: BaseApiClient;
  static readonly MAX_ITERATIONS = 20;

  constructor(token: string, timeoutMs?: number, concurrency?: number) {
    this.#client = new BaseApiClient({
      module: "workflow",
      baseUrl: "https://workflow.base.vn",
      token,
      timeoutMs,
      concurrency,
    });
  }

  /**
   * Fetch active jobs for a specific user.
   *
   * @param username  Username (e.g. "Digital01" or "@Digital01")
   * @param pageId    Optional cursor for pagination
   */
  async getActiveJobs(
    username: string,
    pageId?: string
  ): Promise<{ jobs: BaseWorkflowJob[]; nextPageId?: string; totalItems?: number }> {
    const formattedUser = username.startsWith("@") ? username : `@${username}`;
    const params: Record<string, string> = {
      username: formattedUser,
      status: "active",
    };
    if (pageId) {
      params["page_id"] = pageId;
    }

    const response = await this.#client.post<WorkflowJobsResponse>(
      "/extapi/v1/jobs/get",
      params
    );

    const jobs = Array.isArray(response.jobs) ? response.jobs : [];
    const nextPageId = response.page_id && response.page_id !== pageId ? response.page_id : undefined;
    const totalItems = response.total_items !== undefined ? Number(response.total_items) : undefined;

    return { jobs, nextPageId, totalItems };
  }

  /**
   * Fetch all active jobs across all pages with termination guards.
   */
  async getAllActiveJobs(username: string): Promise<BaseWorkflowJob[]> {
    const allJobs: BaseWorkflowJob[] = [];
    const seenIds = new Set<number>();
    let currentCursor: string | undefined = undefined;

    for (let iter = 0; iter < WorkflowApiClient.MAX_ITERATIONS; iter++) {
      const { jobs, nextPageId } = await this.getActiveJobs(username, currentCursor);

      if (jobs.length === 0) break;

      let newItemsInPage = 0;
      for (const j of jobs) {
        if (!seenIds.has(j.id)) {
          seenIds.add(j.id);
          allJobs.push(j);
          newItemsInPage++;
        }
      }

      // Termination conditions
      if (newItemsInPage === 0) break; // Infinite loop guard
      if (!nextPageId || nextPageId === currentCursor) break; // No next page cursor

      currentCursor = nextPageId;
    }

    return allJobs;
  }
}
