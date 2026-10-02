// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { api, ApiError } from "../src/api/client.ts";
import { onUnauthorized } from "../src/api/authEvents.ts";
import { setToken, clearToken } from "../src/auth/token.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("api client", () => {
  beforeEach(() => {
    clearToken();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    clearToken();
  });

  it("unwraps a successful ApiEnvelope into the data payload", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, data: { status: { version: "1.0.0" } } }));
    vi.stubGlobal("fetch", fetchMock);

    const { status } = await api.status();
    expect(status).toEqual({ version: "1.0.0" });
    expect(fetchMock).toHaveBeenCalledWith("/v1/admin/status", expect.objectContaining({ method: "GET" }));
  });

  it("sends the bearer token from localStorage on every request", async () => {
    setToken("secret-token");
    const fetchMock = vi.fn(async (_input: string, _init?: RequestInit) => jsonResponse({ ok: true, data: {} }));
    vi.stubGlobal("fetch", fetchMock);

    await api.status();

    const [, init] = fetchMock.mock.calls[0]!;
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer secret-token");
  });

  it("throws a readable ApiError with the server's code and message on failure", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: false, error: { code: "not_found", message: "agent sdr-99 not found" } }, 404));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.getAgent("sdr-99")).rejects.toMatchObject({
      name: "ApiError",
      code: "not_found",
      message: "agent sdr-99 not found",
    });
  });

  it("broadcasts onUnauthorized when the server rejects the token", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: false, error: { code: "unauthorized", message: "bad token" } }, 401));
    vi.stubGlobal("fetch", fetchMock);

    const handler = vi.fn();
    const unsubscribe = onUnauthorized(handler);
    try {
      await expect(api.status()).rejects.toBeInstanceOf(ApiError);
      expect(handler).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
    }
  });

  it("surfaces a network failure as an internal ApiError instead of throwing raw", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );

    await expect(api.status()).rejects.toMatchObject({ name: "ApiError", code: "internal" });
  });
});
