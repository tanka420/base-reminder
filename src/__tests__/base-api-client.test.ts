/**
 * src/__tests__/base-api-client.test.ts
 *
 * Tests for BaseApiClient:
 *  - Form body encoding
 *  - access_token_v2 injected
 *  - Retry on 5xx
 *  - No retry on 4xx (except 429)
 *  - 429 with Retry-After header
 *  - Network errors trigger retry
 *  - Token private class field not accessible as public property
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BaseApiClient } from "../base-api/client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type MockResponse =
  | { data: unknown; status: number }
  | {
      error: {
        response?: { status: number; headers?: Record<string, string> };
        code?: string;
        isAxiosError?: boolean;
      };
    };

/** Creates a post() function that replays mock responses sequentially */
function makeMockPost(responses: MockResponse[]): ReturnType<typeof vi.fn> {
  let callIndex = 0;
  return vi.fn(async () => {
    const resp = responses[callIndex++];
    if (resp === undefined) throw new Error("No more mock responses configured");
    if ("error" in resp) {
      const err = Object.assign(new Error("mock axios error"), {
        isAxiosError: true,
        response: resp.error.response,
        code: resp.error.code,
      });
      throw err;
    }
    return resp;
  });
}

// Mock axios module so .create() returns a controllable instance
vi.mock("axios", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("axios");
  const mockCreate = vi.fn();
  return {
    ...actual,
    default: {
      ...actual.default,
      create: mockCreate,
      isAxiosError: actual.isAxiosError,
    },
    isAxiosError: actual.isAxiosError,
    create: mockCreate,
  };
});

import axios from "axios";

function setupMockAxios(responses: MockResponse[]) {
  const postMock = makeMockPost(responses);
  const mockInstance = { post: postMock };
  vi.mocked(axios.create).mockReturnValue(mockInstance as never);
  return { postMock };
}

function makeClient(opts?: { timeoutMs?: number; concurrency?: number }) {
  return new BaseApiClient({
    module: "account",
    baseUrl: "https://account.base.vn",
    token: "test-token-xyz",
    timeoutMs: opts?.timeoutMs ?? 5_000,
    concurrency: opts?.concurrency ?? 5,
  });
}

const OK_RESPONSE: MockResponse = {
  data: { code: 1, message: "", data: null },
  status: 200,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BaseApiClient", () => {
  describe("request encoding", () => {
    it("creates axios with application/x-www-form-urlencoded content type", () => {
      setupMockAxios([]);
      makeClient();
      expect(vi.mocked(axios.create)).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: expect.objectContaining({
            "Content-Type": "application/x-www-form-urlencoded",
          }),
        })
      );
    });

    it("injects access_token_v2 into the POST body", async () => {
      const { postMock } = setupMockAxios([OK_RESPONSE]);
      const client = makeClient();

      await client.post("/extapi/v1/users");

      expect(postMock).toHaveBeenCalledOnce();
      const bodyArg = postMock.mock.calls[0]?.[1] as string | undefined;
      expect(bodyArg).toContain("access_token_v2=");
    });

    it("includes additional params in the body", async () => {
      const { postMock } = setupMockAxios([OK_RESPONSE]);
      const client = makeClient();

      await client.post("/extapi/v1/user/search.by.username", {
        username: "Digital01",
      });

      const bodyArg = postMock.mock.calls[0]?.[1] as string | undefined;
      expect(bodyArg).toContain("username=Digital01");
    });

    it("does not include token in the path argument", async () => {
      const { postMock } = setupMockAxios([OK_RESPONSE]);
      const client = makeClient();

      await client.post("/extapi/v1/users");

      const pathArg = postMock.mock.calls[0]?.[0] as string | undefined;
      expect(pathArg).toBe("/extapi/v1/users");
      expect(pathArg).not.toContain("token");
    });
  });

  describe("retry — transient errors", () => {
    it("retries on HTTP 500 and succeeds on 3rd attempt", async () => {
      const { postMock } = setupMockAxios([
        { error: { response: { status: 500 } } },
        { error: { response: { status: 500 } } },
        OK_RESPONSE,
      ]);
      const client = makeClient();

      const promise = client.post("/extapi/v1/users");
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(postMock).toHaveBeenCalledTimes(3);
      expect((result as { code: number }).code).toBe(1);
    });

    it("retries on network error (no response object)", async () => {
      const { postMock } = setupMockAxios([
        { error: { code: "ECONNREFUSED" } },
        OK_RESPONSE,
      ]);
      const client = makeClient();

      const promise = client.post("/extapi/v1/users");
      await vi.runAllTimersAsync();
      await promise;

      expect(postMock).toHaveBeenCalledTimes(2);
    });

    it("exhausts all 3 attempts then throws on persistent 5xx", async () => {
      const { postMock } = setupMockAxios([
        { error: { response: { status: 503 } } },
        { error: { response: { status: 503 } } },
        { error: { response: { status: 503 } } },
      ]);
      const client = makeClient();

      const promise = client.post("/extapi/v1/users");
      const assertion = expect(promise).rejects.toMatchObject({ response: { status: 503 } });
      await vi.runAllTimersAsync();
      await assertion;

      expect(postMock).toHaveBeenCalledTimes(3);
    });
  });

  describe("retry — permanent errors (no retry)", () => {
    it("does NOT retry on HTTP 400", async () => {
      const { postMock } = setupMockAxios([
        { error: { response: { status: 400 } } },
      ]);
      const client = makeClient();

      const promise = client.post("/extapi/v1/users");
      const assertion = expect(promise).rejects.toMatchObject({ response: { status: 400 } });
      await vi.runAllTimersAsync();
      await assertion;

      expect(postMock).toHaveBeenCalledTimes(1);
    });

    it("does NOT retry on HTTP 401", async () => {
      const { postMock } = setupMockAxios([
        { error: { response: { status: 401 } } },
      ]);
      const client = makeClient();

      const promise = client.post("/extapi/v1/users");
      const assertion = expect(promise).rejects.toMatchObject({ response: { status: 401 } });
      await vi.runAllTimersAsync();
      await assertion;

      expect(postMock).toHaveBeenCalledTimes(1);
    });

    it("does NOT retry on HTTP 403", async () => {
      const { postMock } = setupMockAxios([
        { error: { response: { status: 403 } } },
      ]);
      const client = makeClient();

      const promise = client.post("/extapi/v1/users");
      const assertion = expect(promise).rejects.toMatchObject({ response: { status: 403 } });
      await vi.runAllTimersAsync();
      await assertion;

      expect(postMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("retry — HTTP 429 rate limiting", () => {
    it("retries on HTTP 429", async () => {
      const { postMock } = setupMockAxios([
        { error: { response: { status: 429, headers: {} } } },
        OK_RESPONSE,
      ]);
      const client = makeClient();

      const promise = client.post("/extapi/v1/users");
      await vi.runAllTimersAsync();
      await promise;

      expect(postMock).toHaveBeenCalledTimes(2);
    });

    it("uses Retry-After header value (3s) as wait time on 429", async () => {
      const { postMock } = setupMockAxios([
        {
          error: {
            response: {
              status: 429,
              headers: { "retry-after": "3" },
            },
          },
        },
        OK_RESPONSE,
      ]);
      const client = makeClient();

      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

      const promise = client.post("/extapi/v1/users");
      await vi.runAllTimersAsync();
      await promise;

      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 3000);
      expect(postMock).toHaveBeenCalledTimes(2);
    });
  });

  describe("token security", () => {
    it("token is not accessible as an enumerable public property", () => {
      setupMockAxios([]);
      const client = makeClient();

      const publicKeys = Object.keys(client);
      expect(publicKeys).not.toContain("token");
      expect(publicKeys).not.toContain("_token");

      const asAny = client as unknown as Record<string, unknown>;
      expect(asAny["token"]).toBeUndefined();
    });

    it("token string does not appear in the axios create call options", () => {
      setupMockAxios([]);
      makeClient();

      const callArg = vi.mocked(axios.create).mock.calls[0]?.[0];
      const serialized = JSON.stringify(callArg ?? {});
      expect(serialized).not.toContain("test-token-xyz");
    });
  });
});
