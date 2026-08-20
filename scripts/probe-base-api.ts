/**
 * probe-base-api.ts
 *
 * Base API Probe — Milestone 0
 *
 * Architecture: Static Endpoint Adapters
 * ───────────────────────────────────────
 * Each module defines its endpoints statically in a MODULE_ADAPTER object.
 * Endpoints are derived from official Base Postman collections (research phase),
 * NOT fetched at runtime. Postman availability is NOT a runtime dependency.
 *
 * Collection research status:
 *   Account  T1Dv6u6m  — 503 at research time → adapter status: NOT_CONFIGURED
 *   Wework   SztA68Az  — 503 at research time → adapter status: NOT_CONFIGURED
 *   Workflow SWE84Hd1  — 200, fully read      → adapter status: CONFIGURED
 *   Request  SzzheyWQ  — 503 at research time → adapter status: NOT_CONFIGURED
 *
 * To add endpoints for Account / Wework / Request:
 *   1. Export collection JSON from Postman app (or receive from base.vn).
 *   2. Add endpoint objects to the corresponding MODULE_ADAPTER below.
 *   3. Change adapter status to "configured".
 *   No other changes needed.
 *
 * CLI usage:
 *   npm run probe -- --all
 *   npm run probe -- --module workflow
 *   npm run probe -- --module account
 *   npm run probe -- --module wework
 *   npm run probe -- --module request
 */

import * as fs from "fs";
import * as path from "path";
import axios, { AxiosError, AxiosResponse } from "axios";
import "dotenv/config";

// ============================================================================
// Types
// ============================================================================

type ModuleName = "account" | "wework" | "workflow" | "request";
type ProbeStatus = "PASS" | "FAIL" | "SKIP" | "NOT_CONFIGURED";

interface BaseEndpoint {
  /** Human-readable name matching Postman collection entry */
  name: string;
  /** Full URL — no template variables */
  url: string;
  /** HTTP method — Base public API always uses POST */
  method: "POST";
  /**
   * Static params to include in every call of this endpoint.
   * Dynamic params (username, id, etc.) are injected by the probe runner.
   */
  staticParams?: Record<string, string>;
  /**
   * Which dynamic params this endpoint accepts.
   * Probe runner will inject values from config when these keys are listed.
   */
  accepts?: Array<"username" | "id" | "page_id" | "status" | "limit">;
}

interface ModuleAdapter {
  /**
   * "configured"     — endpoints are populated from official collection.
   * "not_configured" — collection not yet available; module will NOT_CONFIGURED.
   */
  status: "configured" | "not_configured";
  /** Source collection ID for reference / audit trail */
  collectionId: string;
  /**
   * Auth key: always "access_token_v2" for all modules.
   *
   * Documentation discrepancy (preserved for audit):
   *   Account  collection T1Dv6u6m  → documents "access_token_v2"  (already v2)
   *   Wework   collection SztA68Az  → documents "access_token"     (legacy key in docs)
   *   Workflow collection SWE84Hd1  → documents "access_token"     (legacy key in docs)
   *   Request  collection SzzheyWQ  → documents "access_token"     (legacy key in docs)
   *
   * Runtime project policy: all modules send "access_token_v2" per Base Access Token v2
   * documentation, regardless of what the Postman collection examples show.
   * No fallback to legacy key. No v1 compatibility layer.
   * If Wework/Workflow/Request return 401/403, report as runtime blocker — do NOT retry.
   */
  blockerReason?: string;
  endpoints: BaseEndpoint[];
}

interface EndpointResult {
  module: ModuleName;
  endpointName: string;
  url: string;
  status: ProbeStatus;
  httpStatus?: number;
  notes: string[];
  rateLimitHeaders: Record<string, string>;
  sanitizedResponse?: unknown;
}

interface ProbeConfig {
  accountToken: string | undefined;
  weworkToken: string | undefined;
  workflowToken: string | undefined;
  requestToken: string | undefined;
  probeUsernames: string[];
  weworkTaskId: string | undefined;
  workflowJobId: string | undefined;
  requestId: string | undefined;
}

// ============================================================================
// Static Module Adapters
// ============================================================================
// Source: Official Base Postman collections read on 2026-08-20.
// Snapshot files: research/postman/*.postman_collection.json
//
// To add/update endpoints:
//   1. Edit the endpoints array below.
//   2. Change status to "configured" if switching from not_configured.
//   No other changes needed — the probe runner picks up automatically.
// ============================================================================

/**
 * Account adapter — CONFIGURED.
 * Source: Postman collection T1Dv6u6m (owner 1623302), "Base Account Public API".
 * Collection auth example: access_token_v2 (already v2 in docs).
 * Runtime: access_token_v2 — matches docs.
 * Reference: https://documenter.getpostman.com/view/1623302/T1Dv6u6m
 */
const ACCOUNT_ADAPTER: ModuleAdapter = {
  status: "configured",
  collectionId: "T1Dv6u6m",
  endpoints: [
    {
      // Source: "Get All Users" — returns all workspace members.
      // No pagination documented — assumed single page (suitable for ~30 users).
      // Response fields to discover: user id, username, fullname/first_name/last_name, email, active status.
      name: "Get All Users",
      url: "https://account.base.vn/extapi/v1/users",
      method: "POST",
      accepts: [],
    },
    {
      // Source: "Search user by username" — lookup single user.
      // Required param: username (without @ prefix per collection example).
      name: "Search user by username",
      url: "https://account.base.vn/extapi/v1/user/search.by.username",
      method: "POST",
      accepts: ["username"],
    },
  ],
};

/**
 * Wework adapter — CONFIGURED.
 * Source: Postman collection SztA68Az (owner 1345096), "Wework Public API (version 3)".
 * Collection auth example: access_token (legacy key in docs).
 * Runtime: access_token_v2 — per Base Access Token v2 documentation.
 * If probe returns 401/403, report as blocker — do NOT retry with access_token.
 * Reference: https://documenter.getpostman.com/view/1345096/SztA68Az
 *
 * API version: v3 (base URL: https://wework.base.vn/extapi/v3/)
 */
const WEWORK_ADAPTER: ModuleAdapter = {
  status: "configured",
  collectionId: "SztA68Az",
  endpoints: [
    {
      // Source: "List all tasks by user" (User group).
      // user param: supports @username, user_id, or email.
      // Pagination: page param, 100 records/page.
      // This is the primary endpoint for the reminder: tasks assigned to a specific user.
      name: "List all tasks by user",
      url: "https://wework.base.vn/extapi/v3/user/tasks",
      method: "POST",
      accepts: ["username"],
    },
    {
      // Source: "Get task info by ID" (Task group).
      // Required param: id (task id).
      // Use with PROBE_WEWORK_TASK_ID fixture to inspect field structure.
      name: "Get task info by ID",
      url: "https://wework.base.vn/extapi/v3/task/get",
      method: "POST",
      accepts: ["id"],
    },
  ],
};

/**
 * Workflow adapter — CONFIGURED.
 * Source: Postman collection SWE84Hd1 (owner 1345096), "Workflow Public API".
 * Collection auth example: access_token (legacy key in docs).
 * Runtime: access_token_v2 — per Base Access Token v2 documentation.
 * If probe returns 401/403, report as blocker — do NOT retry with access_token.
 * Reference: https://documenter.getpostman.com/view/1345096/SWE84Hd1
 *
 * API version: v1 (base URL: https://workflow.base.vn/extapi/v1/)
 */
const WORKFLOW_ADAPTER: ModuleAdapter = {
  status: "configured",
  collectionId: "SWE84Hd1",
  endpoints: [
    {
      // Source: "Get all jobs" (Jobs group).
      // Filter: username (@prefix), status (active/done/failed/overdue), page_id cursor.
      // Acceptance criterion: response must contain field identifying current stage assignee.
      name: "Get all jobs (filter by assignee + status=active)",
      url: "https://workflow.base.vn/extapi/v1/jobs/get",
      method: "POST",
      staticParams: { status: "active", limit: "5" },
      accepts: ["username", "page_id"],
    },
    {
      // Source: "Get all workflows" (Workflows group).
      // Baseline call to verify token works at all.
      name: "Get all workflows",
      url: "https://workflow.base.vn/extapi/v1/workflows/get",
      method: "POST",
      accepts: ["page_id"],
    },
    {
      // Source: "Get job" (Job group).
      // Returns job + workflow + todos + activities + files + stages.
      // Use with PROBE_WORKFLOW_JOB_ID to inspect current stage/assignee structure.
      name: "Get single job detail (stages, todos, activities)",
      url: "https://workflow.base.vn/extapi/v1/job/get",
      method: "POST",
      accepts: ["id"],
    },
  ],
};

/**
 * Request adapter — CONFIGURED.
 * Source: Postman collection SzzheyWQ (owner 1345096), "Request Public API".
 * Collection auth example: access_token (legacy key in docs).
 * Runtime: access_token_v2 — per Base Access Token v2 documentation.
 * If probe returns 401/403, report as blocker — do NOT retry with access_token.
 * Reference: https://documenter.getpostman.com/view/1345096/SzzheyWQ
 *
 * API version: v1 (base URL: https://request.base.vn/extapi/v1/)
 */
const REQUEST_ADAPTER: ModuleAdapter = {
  status: "configured",
  collectionId: "SzzheyWQ",
  endpoints: [
    {
      // Source: "List all requests in system" (Request group).
      // Filter: users (comma-separated usernames), status (pending/approved/rejected/overdue).
      // Pagination: page param (0-based).
      // Acceptance criterion: response must contain field identifying current approver.
      // NOTE: "users" param may match any user in chain, not only current approver — verify at runtime.
      name: "List all requests in system",
      url: "https://request.base.vn/extapi/v1/request/list",
      method: "POST",
      staticParams: { status: "pending" },
      accepts: ["username"],
    },
    {
      // Source: "Get detail of request by ID" (Request group).
      // Required: id. Returns full request detail including approval chain.
      // Use with PROBE_REQUEST_ID fixture to inspect current approver field structure.
      name: "Get detail of request by ID",
      url: "https://request.base.vn/extapi/v1/request/get",
      method: "POST",
      accepts: ["id"],
    },
  ],
};

const ADAPTERS: Record<ModuleName, ModuleAdapter> = {
  account: ACCOUNT_ADAPTER,
  wework: WEWORK_ADAPTER,
  workflow: WORKFLOW_ADAPTER,
  request: REQUEST_ADAPTER,
};

// ============================================================================
// Sanitizer — deterministic, referential integrity across all files
// ============================================================================

class Sanitizer {
  private idMap = new Map<string | number, number>();
  private idCounter = 1000;

  private nameMap = new Map<string, string>();
  private nameCounter = 1;
  private emailCounter = 1;
  private usernameCounter = 1;

  anonymizeId(realId: string | number): number {
    if (!this.idMap.has(realId)) {
      this.idMap.set(realId, this.idCounter++);
    }
    return this.idMap.get(realId)!;
  }

  anonymizeUsername(value: string): string {
    if (!this.nameMap.has(`__u__${value}`)) {
      this.nameMap.set(`__u__${value}`, `[USERNAME_${this.usernameCounter++}]`);
    }
    return this.nameMap.get(`__u__${value}`)!;
  }

  anonymizeName(value: string): string {
    if (!value) return value;
    if (/^[\w.+-]+@[\w-]+\.[a-z]{2,}$/.test(value)) {
      if (!this.nameMap.has(`__e__${value}`)) {
        this.nameMap.set(`__e__${value}`, `[EMAIL_${this.emailCounter++}]`);
      }
      return this.nameMap.get(`__e__${value}`)!;
    }
    if (/^[A-ZÀ-Ỹa-zà-ỹ][\wÀ-ỹ]+([ ][A-ZÀ-Ỹa-zà-ỹ][\wÀ-ỹ]+)+$/.test(value)) {
      if (!this.nameMap.has(`__n__${value}`)) {
        this.nameMap.set(`__n__${value}`, `[NAME_${this.nameCounter++}]`);
      }
      return this.nameMap.get(`__n__${value}`)!;
    }
    return value;
  }

  sanitize(obj: unknown, depth = 0): unknown {
    if (depth > 15 || obj === null || obj === undefined) return obj;
    if (Array.isArray(obj)) return obj.map((x) => this.sanitize(x, depth + 1));
    if (typeof obj !== "object") return obj;

    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      out[k] = this.sanitizeField(k, v, depth + 1);
    }
    return out;
  }

  private sanitizeField(key: string, value: unknown, depth: number): unknown {
    if (value === null || value === undefined) return value;
    const lk = key.toLowerCase();

    const idKeys = ["id", "user_id", "task_id", "job_id", "request_id", "stage_id",
      "workflow_id", "owner_id", "creator_id", "assignee_id", "approver_id",
      "group_id", "team_id", "department_id", "step_id"];
    if (idKeys.some((k) => lk === k || lk.endsWith(`_${k}`))) {
      if (typeof value === "number" || typeof value === "string") {
        return this.anonymizeId(value);
      }
    }

    const usernameKeys = ["username", "assignee", "creator_username", "approver_username",
      "mover_username", "owner", "user"];
    if (usernameKeys.some((k) => lk === k)) {
      if (typeof value === "string") return this.anonymizeUsername(value);
      if (Array.isArray(value)) return value.map((v) =>
        typeof v === "string" ? this.anonymizeUsername(v) : this.sanitize(v, depth));
    }

    const nameKeys = ["name", "fullname", "full_name", "display_name", "title"];
    if (nameKeys.some((k) => lk === k) && typeof value === "string") {
      return this.anonymizeName(value);
    }

    if ((lk === "email" || lk.endsWith("_email")) && typeof value === "string") {
      return this.anonymizeName(value);
    }

    if (typeof value === "object") return this.sanitize(value, depth);
    return value;
  }
}

// Single instance — referential integrity across the entire probe session
const sanitizer = new Sanitizer();

// ============================================================================
// HTTP — never logs tokens
// ============================================================================

async function postForm(
  endpointUrl: string,
  token: string,
  params: Record<string, string | number | undefined>
): Promise<{ status: number; data: unknown; rlHeaders: Record<string, string> }> {
  const body = new URLSearchParams();
  // Always use access_token_v2 — this project is v2-only.
  // Postman collection examples for Wework/Workflow/Request still show the legacy
  // "access_token" key, but Base Access Token v2 documentation requires "access_token_v2".
  // No fallback. If a module returns 401/403, it is reported as a runtime blocker.
  body.append("access_token_v2", token);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") body.append(k, String(v));
  }

  let response: AxiosResponse;
  try {
    response = await axios.post(endpointUrl, body.toString(), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 30_000,
      validateStatus: () => true,
    });
  } catch (err) {
    throw err; // caller handles
  }

  const rlHeaders: Record<string, string> = {};
  for (const hk of Object.keys(response.headers)) {
    const lhk = hk.toLowerCase();
    if (lhk.includes("ratelimit") || lhk.includes("rate-limit") ||
        lhk === "retry-after" || lhk === "x-total-count") {
      rlHeaders[hk] = String(response.headers[hk]);
    }
  }

  return { status: response.status, data: response.data, rlHeaders };
}

// ============================================================================
// Output helpers
// ============================================================================

const SAMPLE_DIR = path.join("docs", "sample-responses");
const FINDINGS_FILE = path.join("docs", "base-api-findings.md");

function ensureDirs(): void {
  fs.mkdirSync(SAMPLE_DIR, { recursive: true });
}

function tag(status: ProbeStatus): string {
  return `[${status.padEnd(14)}]`;
}

function logLine(status: ProbeStatus, msg: string): void {
  console.log(`${tag(status)} ${msg}`);
}

function saveSanitized(filename: string, data: unknown): void {
  const out = sanitizer.sanitize(data);
  const fp = path.join(SAMPLE_DIR, filename);
  fs.writeFileSync(fp, JSON.stringify(out, null, 2), "utf-8");
  console.log(`               → saved ${fp}`);
}

function sanitizeError(err: unknown): Record<string, unknown> {
  // Redact both v1 and v2 auth keys from error messages
  const redact = (s: string) =>
    s
      .replace(/access_token_v2=[^&\s]*/gi, "access_token_v2=[REDACTED]")
      .replace(/access_token=[^&\s]*/gi, "access_token=[REDACTED]");

  if (err instanceof AxiosError) {
    return {
      type: "AxiosError",
      code: err.code,
      message: redact(err.message),
      httpStatus: err.response?.status,
      responseData:
        err.response?.data && typeof err.response.data === "object"
          ? sanitizer.sanitize(err.response.data)
          : typeof err.response?.data === "string"
          ? err.response.data.substring(0, 200)
          : undefined,
    };
  }
  if (err instanceof Error) {
    return { type: "Error", message: redact(err.message) };
  }
  return { type: "unknown" };
}

// ============================================================================
// Utility — field inspection
// ============================================================================

function flattenKeys(obj: unknown, prefix = ""): string[] {
  if (!obj || typeof obj !== "object") return [];
  const keys: string[] = [];
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const fk = prefix ? `${prefix}.${k}` : k;
    keys.push(fk);
    if (v && typeof v === "object" && !Array.isArray(v)) {
      keys.push(...flattenKeys(v, fk));
    } else if (Array.isArray(v) && v.length > 0 && v[0] && typeof v[0] === "object") {
      keys.push(...flattenKeys(v[0], `${fk}[]`));
    }
  }
  return keys;
}

function detectDeadlineFormat(obj: unknown): string {
  const str = JSON.stringify(obj);
  const m = str.match(/"(?:deadline|due_date|due_at|expired_at|end_date)"\s*:\s*([^,}\]]+)/i);
  if (!m) return "not found";
  const v = (m[1] ?? "").trim().replace(/"/g, "");
  if (!v || v === "null") return "null";
  if (/^\d{10}$/.test(v)) return `Unix timestamp 10-digit (seconds): ${v}`;
  if (/^\d{13}$/.test(v)) return `Unix timestamp 13-digit (ms): ${v}`;
  if (/^\d{4}-\d{2}-\d{2}T/.test(v)) return `ISO 8601: ${v}`;
  if (/^\d{2}\/\d{2}\/\d{4}/.test(v)) return `dd/mm/YYYY: ${v}`;
  return `unknown format: ${v}`;
}

function extractStatusValues(obj: unknown): string[] {
  const out: string[] = [];
  function walk(o: unknown): void {
    if (!o || typeof o !== "object") return;
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (k === "status" && typeof v === "string") out.push(v);
      else walk(v);
    }
  }
  walk(obj);
  return [...new Set(out)];
}

// ============================================================================
// Generic module runner
// ============================================================================

async function runModule(
  module: ModuleName,
  adapter: ModuleAdapter,
  token: string | undefined,
  config: ProbeConfig
): Promise<EndpointResult[]> {
  const results: EndpointResult[] = [];

  // ── Missing token ──────────────────────────────────────────────────────────
  if (!token) {
    logLine("SKIP", `${module} — token not set (BASE_${module.toUpperCase()}_TOKEN)`);
    results.push({
      module, endpointName: "all", url: "",
      status: "SKIP", notes: [`BASE_${module.toUpperCase()}_TOKEN not configured`],
      rateLimitHeaders: {},
    });
    return results;
  }

  // ── Adapter not configured ─────────────────────────────────────────────────
  if (adapter.status === "not_configured") {
    const reason = adapter.blockerReason ?? "Endpoints not yet populated in adapter.";
    logLine("NOT_CONFIGURED",
      `${module} — documented endpoint not yet available [collection: ${adapter.collectionId}]`);
    console.log(`               Reason: ${reason}`);
    console.log(`               Action: Add endpoint objects to ${module.toUpperCase()}_ADAPTER in probe-base-api.ts.`);
    results.push({
      module, endpointName: "all", url: "",
      status: "NOT_CONFIGURED",
      notes: [reason, `Collection: ${adapter.collectionId}`],
      rateLimitHeaders: {},
    });
    return results;
  }

  // ── Run each configured endpoint ───────────────────────────────────────────
  for (const ep of adapter.endpoints) {
    await runEndpoint(module, ep, token, config, results);
  }

  return results;
}

async function runEndpoint(
  module: ModuleName,
  ep: BaseEndpoint,
  token: string,
  config: ProbeConfig,
  results: EndpointResult[]
): Promise<void> {
  const accepts = ep.accepts ?? [];

  // Build param sets — one call per username if endpoint accepts username
  const usernameSets: Array<string | undefined> = accepts.includes("username")
    ? config.probeUsernames
    : [undefined];

  // Detail endpoint (accepts only "id"): use fixture ID
  if (accepts.includes("id") && accepts.length === 1) {
    const fixtureId = getFixtureId(module, config);
    if (!fixtureId) {
      logLine("SKIP", `${module} › ${ep.name} — no fixture ID set (PROBE_${module.toUpperCase()}_*_ID)`);
      results.push({
        module, endpointName: ep.name, url: ep.url,
        status: "SKIP",
        notes: ["No fixture ID configured — set PROBE_WEWORK_TASK_ID / PROBE_WORKFLOW_JOB_ID / PROBE_REQUEST_ID"],
        rateLimitHeaders: {},
      });
      return;
    }
    await callEndpoint(module, ep, token, { id: fixtureId, ...ep.staticParams }, results, ep.name);
    return;
  }

  for (const username of usernameSets) {
    const params: Record<string, string | number | undefined> = { ...ep.staticParams };

    if (username && accepts.includes("username")) {
      // Per-module param key mapping:
      //   Workflow  → "username" with @ prefix (documented in collection)
      //   Wework    → "user"     with @ prefix (collection: "support get user by username|user_id|email")
      //   Request   → "users"    plain          (collection: "query on assigned users (list usernames)")
      //   Account   → "username" plain
      if (module === "workflow") {
        params["username"] = `@${username}`;
      } else if (module === "wework") {
        params["user"] = `@${username}`;
      } else if (module === "request") {
        params["users"] = username;
      } else {
        params["username"] = username;
      }
    }

    const label = username ? `${ep.name} [user=${username}]` : ep.name;
    await callEndpoint(module, ep, token, params, results, label);
  }
}

function getFixtureId(module: ModuleName, config: ProbeConfig): string | undefined {
  if (module === "wework") return config.weworkTaskId;
  if (module === "workflow") return config.workflowJobId;
  if (module === "request") return config.requestId;
  return undefined;
}

async function callEndpoint(
  module: ModuleName,
  ep: BaseEndpoint,
  token: string,
  params: Record<string, string | number | undefined>,
  results: EndpointResult[],
  label: string
): Promise<void> {
  logLine("PASS", `${module} › ${label} ...`);

  let httpStatus: number | undefined;
  let rlHeaders: Record<string, string> = {};

  try {
    const res = await postForm(ep.url, token, params);
    httpStatus = res.status;
    rlHeaders = res.rlHeaders;

    const passed = res.status === 200;
    const result: EndpointResult = {
      module, endpointName: label, url: ep.url,
      status: passed ? "PASS" : "FAIL",
      httpStatus,
      notes: [],
      rateLimitHeaders: rlHeaders,
    };

    if (passed) {
      result.sanitizedResponse = sanitizer.sanitize(res.data);

      // Module-specific inspections
      const inspectionNotes = inspectResponse(module, label, res.data);
      result.notes.push(...inspectionNotes);

      if (Object.keys(rlHeaders).length === 0) {
        result.notes.push("Rate limit: not observed in response headers");
      } else {
        result.notes.push(`Rate limit headers observed: ${JSON.stringify(rlHeaders)}`);
      }

      const sampleFile = sampleFilename(module, label);
      saveSanitized(sampleFile, res.data);
      logLine("PASS", `${module} › ${label} → HTTP ${res.status}`);
    } else {
      const safeData = sanitizer.sanitize(res.data);
      result.notes.push(`HTTP ${res.status} — ${JSON.stringify(safeData).substring(0, 300)}`);
      logLine("FAIL", `${module} › ${label} → HTTP ${res.status}`);
    }

    results.push(result);
  } catch (err) {
    results.push({
      module, endpointName: label, url: ep.url,
      status: "FAIL",
      httpStatus,
      notes: [JSON.stringify(sanitizeError(err))],
      rateLimitHeaders: rlHeaders,
    });
    logLine("FAIL", `${module} › ${label} → exception: ${(err as Error).message.substring(0, 120)}`);
  }
}

function inspectResponse(module: ModuleName, label: string, data: unknown): string[] {
  const notes: string[] = [];
  const keys = flattenKeys(data);

  if (module === "workflow") {
    if (label.includes("job/get") || label.includes("detail")) {
      // Acceptance criterion: find current stage / assignee fields
      const stageFields = keys.filter((k) =>
        k.toLowerCase().includes("current") ||
        k.toLowerCase().includes("stage") ||
        (k.toLowerCase().includes("assign") && !k.toLowerCase().includes("[]")) ||
        k.toLowerCase().includes("active") ||
        k.toLowerCase().includes("step")
      );
      notes.push(
        stageFields.length > 0
          ? `Current-stage candidate fields: ${stageFields.join(", ")}`
          : "WARNING: No current-stage / assignee fields detected — manual inspection required"
      );
    }
    if (label.includes("jobs/get") || label.includes("jobs (filter")) {
      const raw = data as Record<string, unknown>;
      if ("page_id" in raw) notes.push(`Pagination cursor: page_id = ${raw["page_id"]}`);
      if (Array.isArray(raw["data"])) notes.push(`Items returned: ${(raw["data"] as unknown[]).length}`);
    }
  }

  if (module === "wework") {
    notes.push(`Deadline format: ${detectDeadlineFormat(data)}`);
    const statuses = extractStatusValues(data);
    if (statuses.length > 0) notes.push(`Status values observed: ${statuses.join(", ")}`);
  }

  if (module === "request") {
    const approverFields = keys.filter((k) =>
      k.toLowerCase().includes("approv") ||
      k.toLowerCase().includes("current") ||
      k.toLowerCase().includes("step") ||
      k.toLowerCase().includes("pending")
    );
    notes.push(
      approverFields.length > 0
        ? `Current-approver candidate fields: ${approverFields.join(", ")}`
        : "WARNING: No current-approver fields detected — manual inspection required"
    );
  }

  if (module === "account") {
    const idFields = keys.filter((k) =>
      k.toLowerCase().includes("user_id") ||
      k.toLowerCase().includes("username") ||
      k.toLowerCase().includes("email") ||
      k.toLowerCase().includes("fullname") ||
      k.toLowerCase().includes("full_name")
    );
    if (idFields.length > 0) notes.push(`Identity fields found: ${idFields.join(", ")}`);
  }

  return notes;
}

function sampleFilename(module: string, label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .substring(0, 50);
  return `${module}-${slug}.sanitized.json`;
}

// ============================================================================
// Findings writer
// ============================================================================

function writeFindings(allResults: EndpointResult[]): void {
  const now = new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
  const byModule = new Map<ModuleName, EndpointResult[]>();
  for (const r of allResults) {
    if (!byModule.has(r.module)) byModule.set(r.module, []);
    byModule.get(r.module)!.push(r);
  }

  const counts = (mod: ModuleName) => {
    const rows = byModule.get(mod) ?? [];
    return {
      total: rows.length,
      pass: rows.filter((r) => r.status === "PASS").length,
      fail: rows.filter((r) => r.status === "FAIL").length,
      skip: rows.filter((r) => r.status === "SKIP").length,
      nc: rows.filter((r) => r.status === "NOT_CONFIGURED").length,
    };
  };

  const lines: string[] = [
    `# Base API Findings`,
    ``,
    `> Generated: ${now} (Asia/Ho_Chi_Minh)`,
    ``,
    `## Summary`,
    ``,
    `| Module | Collection | Adapter | Probed | PASS | FAIL | SKIP | NOT_CONFIGURED |`,
    `|---|---|---|---|---|---|---|---|`,
  ];

  const modules: ModuleName[] = ["account", "wework", "workflow", "request"];
  for (const mod of modules) {
    const c = counts(mod);
    const a = ADAPTERS[mod];
    lines.push(`| ${mod} | ${a.collectionId} | ${a.status} | ${c.total} | ${c.pass} | ${c.fail} | ${c.skip} | ${c.nc} |`);
  }

  lines.push(``, `---`, ``);

  for (const mod of modules) {
    const adapter = ADAPTERS[mod];
    const results = byModule.get(mod) ?? [];

    lines.push(`## ${mod.charAt(0).toUpperCase() + mod.slice(1)}`);
    lines.push(``, `- **Host**: \`https://${mod}.base.vn\``);
    lines.push(`- **Collection**: \`${adapter.collectionId}\``);
    lines.push(`- **Adapter status**: \`${adapter.status}\``);
    if (adapter.blockerReason) lines.push(`- **Blocker**: ${adapter.blockerReason}`);
    lines.push(``);

    if (results.length === 0) {
      lines.push(`_(not probed)_`, ``);
    } else {
      for (const r of results) {
        lines.push(`### \`${r.endpointName}\``);
        lines.push(``, `- **Status**: ${r.status}`);
        if (r.httpStatus) lines.push(`- **HTTP**: ${r.httpStatus}`);
        if (r.url) lines.push(`- **URL**: \`${r.url}\``);
        for (const n of r.notes) lines.push(`- ${n}`);
        lines.push(``);
      }
    }

    lines.push(`---`, ``);
  }

  lines.push(
    `## Open Questions`,
    ``,
    `_(Fill in after reviewing sanitized responses)_`,
    ``,
    `### Workflow`,
    `- [ ] Field name for current stage assignee: \`___\``,
    `- [ ] Full field path in job object: \`job.___\``,
    `- [ ] Cross-user visibility (1 token sees jobs for multiple users): yes / no`,
    ``,
    `### Wework`,
    `- [ ] Task list endpoint: \`___\``,
    `- [ ] Deadline field name: \`___\``,
    `- [ ] Deadline format: \`___\``,
    `- [ ] Deadline timezone: \`___\``,
    `- [ ] Status value for "incomplete": \`___\``,
    `- [ ] Status value for "overdue": \`___\``,
    ``,
    `### Request`,
    `- [ ] Request list endpoint: \`___\``,
    `- [ ] Current approver field: \`___\``,
    `- [ ] Field path: \`request.___\``,
    ``,
    `### Account`,
    `- [ ] User list endpoint: \`___\``,
    `- [ ] user_id field: \`___\``,
    `- [ ] username field: \`___\``,
    `- [ ] fullname field: \`___\``,
    `- [ ] email field: \`___\``,
    ``,
    `## Proposed Data Mapping`,
    ``,
    `_(Fill in after probe)_`,
    ``,
    `| System field | Base API field | Module | Notes |`,
    `|---|---|---|---|`,
    `| user_id | \`___\` | Account | |`,
    `| username | \`___\` | Account | |`,
    `| task_id | \`___\` | Wework | |`,
    `| task assignee | \`___\` | Wework | |`,
    `| task deadline | \`___\` | Wework | format: ___ |`,
    `| task status (incomplete) | \`___\` | Wework | value: ___ |`,
    `| task status (overdue) | \`___\` | Wework | value: ___ |`,
    `| job_id | \`___\` | Workflow | |`,
    `| job current stage assignee | \`___\` | Workflow | |`,
    `| request_id | \`___\` | Request | |`,
    `| request current approver | \`___\` | Request | |`,
  );

  fs.writeFileSync(FINDINGS_FILE, lines.join("\n"), "utf-8");
  console.log(`\nFindings written → ${FINDINGS_FILE}`);
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  ensureDirs();

  const args = process.argv.slice(2);
  const runAll = args.includes("--all");
  const moduleIdx = args.indexOf("--module");
  const selectedModule: string | null = moduleIdx !== -1 ? (args[moduleIdx + 1] ?? null) : null;

  if (!runAll && !selectedModule) {
    console.error("Usage:  npm run probe -- --all");
    console.error("        npm run probe -- --module <account|wework|workflow|request>");
    process.exit(1);
  }

  const valid: ModuleName[] = ["account", "wework", "workflow", "request"];
  if (selectedModule && !valid.includes(selectedModule as ModuleName)) {
    console.error(`Unknown module: ${selectedModule}. Valid: ${valid.join(", ")}`);
    process.exit(1);
  }

  const modulesToRun: ModuleName[] = runAll ? valid : [selectedModule as ModuleName];

  // Validate usernames
  const rawUsernames = (process.env["BASE_PROBE_USERNAMES"] ?? "").trim();
  const probeUsernames = rawUsernames.split(",").map((u) => u.trim()).filter(Boolean);
  if (probeUsernames.length === 0) {
    console.error("BASE_PROBE_USERNAMES is required. Set at least 1 username in .env");
    process.exit(1);
  }
  if (probeUsernames.length < 2) {
    console.warn("[WARN] Only 1 username set. Cross-user visibility test requires ≥ 2 usernames.");
  }

  const config: ProbeConfig = {
    accountToken: process.env["BASE_ACCOUNT_TOKEN"] || undefined,
    weworkToken:  process.env["BASE_WEWORK_TOKEN"]  || undefined,
    workflowToken: process.env["BASE_WORKFLOW_TOKEN"] || undefined,
    requestToken:  process.env["BASE_REQUEST_TOKEN"]  || undefined,
    probeUsernames,
    weworkTaskId:   process.env["PROBE_WEWORK_TASK_ID"]   || undefined,
    workflowJobId:  process.env["PROBE_WORKFLOW_JOB_ID"]  || undefined,
    requestId:      process.env["PROBE_REQUEST_ID"]       || undefined,
  };

  console.log("=".repeat(60));
  console.log("Base API Probe — Milestone 0");
  console.log(`Modules : ${modulesToRun.join(", ")}`);
  console.log(`Users   : ${probeUsernames.join(", ")}`);
  console.log("=".repeat(60));

  const allResults: EndpointResult[] = [];

  for (const mod of modulesToRun) {
    console.log(`\n${"─".repeat(50)}`);
    console.log(`MODULE: ${mod.toUpperCase()}`);
    console.log("─".repeat(50));

    try {
      const token = config[`${mod}Token` as keyof ProbeConfig] as string | undefined;
      const results = await runModule(mod, ADAPTERS[mod], token, config);
      allResults.push(...results);
    } catch (err) {
      console.error(`[ERROR] Unhandled in module ${mod}:`, sanitizeError(err));
      allResults.push({
        module: mod, endpointName: "module runner", url: "",
        status: "FAIL",
        notes: [JSON.stringify(sanitizeError(err))],
        rateLimitHeaders: {},
      });
    }
  }

  // Summary
  console.log(`\n${"=".repeat(60)}`);
  console.log("SUMMARY");
  console.log("=".repeat(60));
  for (const r of allResults) {
    const httpPart = r.httpStatus ? ` (HTTP ${r.httpStatus})` : "";
    console.log(`${tag(r.status)} [${r.module}] ${r.endpointName}${httpPart}`);
    for (const n of r.notes) console.log(`               • ${n}`);
  }

  writeFindings(allResults);

  const hasNotConfigured = allResults.some((r) => r.status === "NOT_CONFIGURED");
  const hasFails = allResults.some((r) => r.status === "FAIL");

  if (hasNotConfigured) {
    console.log(`\n⚠  Some modules are NOT_CONFIGURED — add endpoint definitions to their adapters in probe-base-api.ts.`);
  }
  if (hasFails) {
    console.log(`✗  Some probes FAILED — check notes above or sanitized responses.`);
  }
  if (!hasNotConfigured && !hasFails) {
    console.log(`\n✓  All probed endpoints passed.`);
  }
}

main().catch((err) => {
  console.error("Fatal:", sanitizeError(err));
  process.exit(1);
});
