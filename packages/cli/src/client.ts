// Thin fetch-based client for the agy-hq admin API. Resolves the base URL
// and admin token the same way the daemon does (@agyhq/server's loadConfig,
// which reads/creates <dataDir>/admin-token), so `hq` just works against a
// daemon started with the same config, with --url/--token as explicit
// overrides (handy for tests and for talking to a remote daemon).

import { loadConfig, type AgyhqConfig } from "@agyhq/server";
import type { ApiEnvelope, ApiErrorCode } from "@agyhq/core";

export interface ClientOptions {
  configPath?: string;
  url?: string;
  token?: string;
  cwd?: string;
}

export class HqApiError extends Error {
  readonly code: ApiErrorCode | "network";
  readonly status: number | null;

  constructor(code: ApiErrorCode | "network", message: string, status: number | null) {
    super(message);
    this.name = "HqApiError";
    this.code = code;
    this.status = status;
  }
}

export class HqClient {
  readonly baseUrl: string;
  readonly token: string;
  readonly config: AgyhqConfig;

  constructor(opts: ClientOptions = {}) {
    this.config = loadConfig({ configPath: opts.configPath, cwd: opts.cwd });
    this.baseUrl = opts.url ?? `http://${this.config.host}:${this.config.port}`;
    this.token = opts.token ?? this.config.adminToken;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new HqApiError("network", `could not reach agy-hq daemon at ${this.baseUrl}: ${(err as Error).message}`, null);
    }

    let envelope: ApiEnvelope<T>;
    try {
      envelope = (await res.json()) as ApiEnvelope<T>;
    } catch {
      throw new HqApiError("network", `agy-hq daemon returned a non-JSON response (status ${res.status})`, res.status);
    }

    if (!envelope.ok) {
      throw new HqApiError(envelope.error.code, envelope.error.message, res.status);
    }
    return envelope.data;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", path, body ?? {});
  }

  patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("PATCH", path, body ?? {});
  }

  /** Raw streaming GET for SSE (/v1/admin/events) — bypasses the ApiEnvelope JSON parsing above. */
  async stream(path: string, signal?: AbortSignal): Promise<Response> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: { authorization: `Bearer ${this.token}` },
      signal,
    });
    if (!res.ok || !res.body) {
      throw new HqApiError("network", `could not open event stream (status ${res.status})`, res.status);
    }
    return res;
  }
}
