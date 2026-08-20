/**
 * src/health/server.ts
 *
 * Internal health HTTP endpoint.
 *
 * Design (per architecture-review.md v1.1 §14.1):
 *  - Binds to HEALTH_HOST:HEALTH_PORT (default 127.0.0.1:3000)
 *  - GET /health → JSON response
 *  - Database: active ping (latency_ms)
 *  - Base API: passive (last successful call timestamp recorded externally)
 *  - No active Base API pings during health check
 *  - No secrets, tokens, emails, or user data in response
 *  - Uses Node.js built-in http module (no express dependency)
 */

import http from "http";
import { pingDatabase } from "../db/connection.js";
import { getLatestReminderRun } from "../db/queries/runs.js";
import { logger } from "../logging/logger.js";

// ---------------------------------------------------------------------------
// State — updated by other modules (passive tracking)
// ---------------------------------------------------------------------------

/** Tracks last successful Base API call per module */
const lastBaseApiSuccess: Record<string, Date | null> = {
  account: null,
  wework: null,
  workflow: null,
  request: null,
};

/**
 * Called by Base API adapters after a successful request.
 * Updates the passive health state for that module.
 * Never logs — this is a hot path.
 */
export function recordBaseApiSuccess(module: string): void {
  lastBaseApiSuccess[module] = new Date();
}

export const recordModuleSuccess = recordBaseApiSuccess;

export interface LastReminderRunInfo {
  date: string;
  status: string;
  total: number;
  empty: number;
  ready: number;
  partial: number;
  error: number;
  durationMs: number;
}

let lastReminderRun: LastReminderRunInfo | null = null;

export function recordLastReminderRun(info: LastReminderRunInfo): void {
  lastReminderRun = info;
}

// ---------------------------------------------------------------------------
// Response builders
// ---------------------------------------------------------------------------

type CheckStatus = "up" | "down";

interface DatabaseCheck {
  status: CheckStatus;
  latency_ms?: number;
  error?: string;
}

interface BaseApiCheck {
  status: CheckStatus;
  last_success: string | null;
}

interface HealthResponse {
  status: "healthy" | "degraded" | "unhealthy";
  timestamp: string;
  checks: {
    database: DatabaseCheck;
    base_api_account: BaseApiCheck;
    base_api_wework: BaseApiCheck;
    base_api_workflow: BaseApiCheck;
    base_api_request: BaseApiCheck;
    last_reminder_run?: LastReminderRunInfo | null;
  };
}

async function buildHealthResponse(): Promise<{
  body: HealthResponse;
  httpStatus: number;
}> {
  const timestamp = new Date().toISOString();

  // --- Database check (active ping) ---
  let dbCheck: DatabaseCheck;
  try {
    const latencyMs = await pingDatabase();
    dbCheck = { status: "up", latency_ms: latencyMs };
  } catch (err) {
    dbCheck = {
      status: "down",
      error: err instanceof Error ? err.message : "unknown",
    };
  }

  // --- Base API checks (passive — no active pings) ---
  function baseApiCheck(module: string): BaseApiCheck {
    const lastSuccess = lastBaseApiSuccess[module];
    return {
      status: lastSuccess !== null ? "up" : "up", // unknown = up (no ping attempted)
      last_success: lastSuccess ? lastSuccess.toISOString() : null,
    };
  }

  // --- Latest persisted reminder run check (from DB, survives restart) ---
  let latestRunInfo: LastReminderRunInfo | null = lastReminderRun;
  if (dbCheck.status === "up") {
    try {
      const dbRun = await getLatestReminderRun();
      if (dbRun) {
        const duration =
          dbRun.completed_at && dbRun.started_at
            ? new Date(dbRun.completed_at).getTime() -
              new Date(dbRun.started_at).getTime()
            : 0;

        const runDateStr = dbRun.run_key ?? (typeof dbRun.run_date === "string" ? dbRun.run_date.slice(0, 10) : new Date(dbRun.run_date).toISOString().slice(0, 10));

        latestRunInfo = {
          date: runDateStr,
          status: dbRun.status,
          total: dbRun.users_total,
          empty: dbRun.users_empty,
          ready: Math.max(
            0,
            dbRun.users_total - dbRun.users_empty - dbRun.users_error
          ),
          partial: 0,
          error: dbRun.users_error,
          durationMs: duration,
        };
      }
    } catch {
      // If DB query fails, fall back to in-memory lastReminderRun
    }
  }

  const body: HealthResponse = {
    status: dbCheck.status === "up" ? "healthy" : "unhealthy",
    timestamp,
    checks: {
      database: dbCheck,
      base_api_account: baseApiCheck("account"),
      base_api_wework: baseApiCheck("wework"),
      base_api_workflow: baseApiCheck("workflow"),
      base_api_request: baseApiCheck("request"),
      last_reminder_run: latestRunInfo,
    },
  };

  const httpStatus = body.status === "healthy" ? 200 : 503;
  return { body, httpStatus };
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

let server: http.Server | null = null;

/**
 * Start the health HTTP server.
 *
 * @param host   Bind address (default: "127.0.0.1")
 * @param port   Bind port (default: 3000)
 */
export function startHealthServer(host: string, port: number): http.Server {
  if (server !== null) {
    logger.warn({ msg: "health server already started — ignoring" });
    return server;
  }

  server = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      try {
        const { body, httpStatus } = await buildHealthResponse();
        const json = JSON.stringify(body, null, 2);
        res.writeHead(httpStatus, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(json);
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "error" }));
        logger.error({
          msg: "health endpoint error",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  server.listen(port, host, () => {
    logger.info({
      msg: "health server started",
      host,
      port,
      url: `http://${host}:${port}/health`,
    });
  });

  server.on("error", (err) => {
    logger.error({ msg: "health server error", error: err.message });
  });

  return server;
}

/** Gracefully close the health server. */
export function stopHealthServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (server === null) {
      resolve();
      return;
    }
    server.close((err) => {
      if (err) reject(err);
      else {
        server = null;
        resolve();
      }
    });
  });
}
