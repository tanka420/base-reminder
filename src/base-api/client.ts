/**
 * src/base-api/client.ts
 *
 * Shared Base API HTTP client.
 *
 * Design (per architecture-review.md v1.1 §3.4):
 *  - One instance per Base module (Account, Wework, Workflow, Request)
 *  - Token injected into POST body as access_token_v2
 *  - POST application/x-www-form-urlencoded only
 *  - Single unified retry policy (no layered retries):
 *      · Transient (5xx, network, timeout) → exponential backoff with ±25% jitter
 *      · HTTP 429 → honor Retry-After header if present, else backoff
 *      · Permanent 4xx (except 429) → throw immediately, no retry
 *  - Bounded concurrency via p-limit (default: 3 per instance)
 *  - 15s timeout per request
 *
 * Security:
 *  - Token stored as private class field (#token)
 *  - Request body (which contains token) is NEVER logged
 *  - Only operational metadata is logged: module, endpoint, status, duration_ms
 */

import axios, {
  type AxiosInstance,
  type AxiosResponse,
  isAxiosError,
} from "axios";
import { URLSearchParams } from "url";
import pLimit from "p-limit";
import { logger } from "../logging/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BaseApiClientOptions {
  /** Module label for logging only */
  module: string;
  /** Base URL e.g. "https://account.base.vn" */
  baseUrl: string;
  /** access_token_v2 value. Stored private, never logged. */
  token: string;
  /** Request timeout in milliseconds (default: 15000) */
  timeoutMs?: number;
  /** Max parallel in-flight requests (default: 3) */
  concurrency?: number;
}

export interface BaseApiResponse<T = unknown> {
  code: number;
  message: string;
  data: T;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Retry configuration
// ---------------------------------------------------------------------------

const RETRY_CONFIG = {
  maxAttempts: 3,
  initialDelayMs: 1_000,
  factor: 2,
  maxDelayMs: 8_000,
  /** ±25% jitter factor */
  jitterFactor: 0.25,
} as const;

/** Compute delay for attempt N (1-indexed) with ±jitter */
function computeDelay(attempt: number): number {
  const base = Math.min(
    RETRY_CONFIG.initialDelayMs * RETRY_CONFIG.factor ** (attempt - 1),
    RETRY_CONFIG.maxDelayMs
  );
  const jitter = base * RETRY_CONFIG.jitterFactor * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(base + jitter));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Classify an error into retry strategy.
 * Returns:
 *   { retryable: true, waitMs: N }   — wait N ms then retry
 *   { retryable: false }             — throw immediately, no retry
 */
function classifyError(err: unknown): { retryable: boolean; waitMs?: number } {
  if (!isAxiosError(err)) {
    // Non-Axios error (programming error, etc.) — do not retry
    return { retryable: false };
  }

  // Network error or timeout — no response
  if (!err.response) {
    return { retryable: true };
  }

  const status = err.response.status;

  // HTTP 429 — Rate limited
  if (status === 429) {
    const retryAfterHeader = err.response.headers["retry-after"] as
      | string
      | undefined;
    let waitMs: number;
    if (retryAfterHeader !== undefined && retryAfterHeader !== "") {
      const seconds = parseFloat(retryAfterHeader);
      waitMs = Number.isFinite(seconds) ? seconds * 1_000 : 5_000;
    } else {
      waitMs = 5_000; // Conservative default when header absent
    }
    return { retryable: true, waitMs };
  }

  // HTTP 5xx — Server error, transient
  if (status >= 500) {
    return { retryable: true };
  }

  // HTTP 4xx (excluding 429) — Permanent client error
  return { retryable: false };
}

// ---------------------------------------------------------------------------
// Client class
// ---------------------------------------------------------------------------

export class BaseApiClient {
  readonly #token: string;
  readonly #module: string;
  readonly #axios: AxiosInstance;
  readonly #limit: ReturnType<typeof pLimit>;

  constructor(opts: BaseApiClientOptions) {
    this.#token = opts.token;
    this.#module = opts.module;
    this.#limit = pLimit(opts.concurrency ?? 3);

    this.#axios = axios.create({
      baseURL: opts.baseUrl,
      timeout: opts.timeoutMs ?? 15_000,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
    });
  }

  /**
   * POST to a Base API endpoint.
   *
   * @param path    URL path e.g. "/extapi/v1/users"
   * @param params  Additional form parameters (access_token_v2 is injected automatically)
   * @returns       Parsed response body as T
   *
   * Security: The request body (containing access_token_v2) is NEVER logged.
   * Only path, status code, and duration are logged.
   */
  async post<T extends BaseApiResponse<unknown>>(
    path: string,
    params: Record<string, string> = {}
  ): Promise<T> {
    return this.#limit(() => this.#executeWithRetry<T>(path, params));
  }

  async #executeWithRetry<T extends BaseApiResponse<unknown>>(
    path: string,
    params: Record<string, string>
  ): Promise<T> {
    // Build form body with token — never pass this to logger
    const body = new URLSearchParams({
      access_token_v2: this.#token,
      ...params,
    });

    let lastError: unknown;

    for (let attempt = 1; attempt <= RETRY_CONFIG.maxAttempts; attempt++) {
      const startMs = Date.now();
      let response: AxiosResponse<T> | undefined;

      try {
        response = await this.#axios.post<T>(path, body.toString());
        const durationMs = Date.now() - startMs;

        logger.debug({
          msg: "base api request",
          module: this.#module,
          endpoint: path,
          status: response.status,
          duration_ms: durationMs,
        });

        return response.data;
      } catch (err) {
        const durationMs = Date.now() - startMs;
        const classification = classifyError(err);
        const httpStatus = isAxiosError(err) ? err.response?.status : undefined;

        if (!classification.retryable || attempt >= RETRY_CONFIG.maxAttempts) {
          logger.error({
            msg: "base api request failed",
            module: this.#module,
            endpoint: path,
            http_status: httpStatus,
            error_class: isAxiosError(err)
              ? err.response
                ? "http_error"
                : "network_error"
              : "unknown",
            attempt,
            duration_ms: durationMs,
          });
          throw err;
        }

        // Transient / rate-limited — compute wait and retry
        const waitMs =
          classification.waitMs !== undefined
            ? classification.waitMs
            : computeDelay(attempt);

        logger.warn({
          msg: "base api request retrying",
          module: this.#module,
          endpoint: path,
          http_status: httpStatus,
          attempt,
          wait_ms: waitMs,
          duration_ms: durationMs,
        });

        await sleep(waitMs);
        lastError = err;
      }
    }

    throw lastError;
  }
}
