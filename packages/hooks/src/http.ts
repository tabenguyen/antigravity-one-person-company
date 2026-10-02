// Minimal HTTP client for talking to the agy-hq daemon from a hook process.
// No dependencies beyond the global `fetch`/`AbortController` (Node 20).

import { HEADERS, type ApiEnvelope } from "@agyhq/core";
import type { HookEnv } from "./env.ts";

export type HookRequestErrorCode = "network" | "timeout" | "http_status" | "invalid_envelope";

export class HookRequestError extends Error {
  readonly code: HookRequestErrorCode;
  readonly status?: number;

  constructor(code: HookRequestErrorCode, message: string, status?: number) {
    super(message);
    this.name = "HookRequestError";
    this.code = code;
    this.status = status;
  }
}

function isApiEnvelope(value: unknown): value is ApiEnvelope<unknown> {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v["ok"] === true) return "data" in v;
  if (v["ok"] === false) {
    const err = v["error"];
    return !!err && typeof err === "object" && typeof (err as Record<string, unknown>)["code"] === "string" && typeof (err as Record<string, unknown>)["message"] === "string";
  }
  return false;
}

/**
 * POSTs `body` to `<env.apiUrl><route>` and returns the unwrapped `data` of
 * a successful ApiEnvelope. Throws HookRequestError on any failure: network
 * error, timeout, non-2xx status, a response that isn't valid JSON, or JSON
 * that doesn't match the ApiEnvelope shape (including `{ok:false}`).
 * Callers decide fail-open vs fail-closed; this function always throws on
 * failure rather than returning a sentinel.
 */
export async function postHook<T>(env: HookEnv, route: string, body: unknown, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(new URL(route, env.apiUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.token}`,
        [HEADERS.agentId]: env.agentId,
        ...(env.taskId ? { [HEADERS.taskId]: env.taskId } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      throw new HookRequestError("timeout", `POST ${route} timed out after ${timeoutMs}ms`);
    }
    throw new HookRequestError("network", `POST ${route} failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(timer);
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new HookRequestError("invalid_envelope", `POST ${route} returned non-JSON body (status ${res.status})`);
  }

  if (!res.ok) {
    throw new HookRequestError("http_status", `POST ${route} returned status ${res.status}`, res.status);
  }
  if (!isApiEnvelope(json)) {
    throw new HookRequestError("invalid_envelope", `POST ${route} returned a body that is not an ApiEnvelope`);
  }
  if (!json.ok) {
    throw new HookRequestError("http_status", `POST ${route} returned an error envelope: ${json.error.code} ${json.error.message}`);
  }
  return json.data as T;
}
