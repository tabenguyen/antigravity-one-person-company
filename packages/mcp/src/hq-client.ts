// Tiny fetch-based client for the agy-hq daemon's HTTP API, used by the
// company MCP server to execute each tool call. See packages/core/src/api.ts
// for the wire contract (ApiEnvelope, ENV, HEADERS, mcpRoute).

import { ENV, HEADERS, mcpRoute } from "@agyhq/core";
import type { ApiEnvelope, McpToolName } from "@agyhq/core";

export interface HqClientConfig {
  /** Base URL of the agy-hq daemon, e.g. "http://127.0.0.1:7317". */
  apiUrl: string;
  token: string;
  agentId: string;
  taskId?: string | null;
  /** Request timeout in ms. Default 15000 (per PHASE0.md D2 / mcp brief). */
  timeoutMs?: number;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Describes why the client could not be built from the environment, so the
 * MCP server can surface an actionable error instead of hanging/crashing.
 */
export interface HqClientEnvError {
  missing: string[];
}

export type HqClientOrError = { client: HqClient } | { client: null; error: HqClientEnvError };

export class HqClient {
  private readonly config: Required<Omit<HqClientConfig, "fetchImpl">> & Pick<HqClientConfig, "fetchImpl">;

  constructor(config: HqClientConfig) {
    this.config = {
      apiUrl: config.apiUrl,
      token: config.token,
      agentId: config.agentId,
      taskId: config.taskId ?? null,
      timeoutMs: config.timeoutMs ?? 15_000,
      fetchImpl: config.fetchImpl,
    };
  }

  /**
   * Builds a client from AGYHQ_* env vars (see core ENV). Returns a
   * descriptive error (never throws) when required vars are missing, so
   * callers can keep the MCP server alive and answer every tool call with a
   * clear misconfiguration message instead of hanging agy.
   */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): HqClientOrError {
    const apiUrl = env[ENV.apiUrl];
    const token = env[ENV.token];
    const agentId = env[ENV.agentId];
    const taskId = env[ENV.taskId];

    const missing: string[] = [];
    if (!apiUrl) missing.push(ENV.apiUrl);
    if (!token) missing.push(ENV.token);
    if (!agentId) missing.push(ENV.agentId);

    if (missing.length > 0 || !apiUrl || !token || !agentId) {
      return { client: null, error: { missing } };
    }

    return { client: new HqClient({ apiUrl, token, agentId, taskId: taskId ?? null }) };
  }

  /** POSTs tool arguments (already validated by the caller) to mcpRoute(tool). */
  async callTool<T>(tool: McpToolName, args: unknown): Promise<ApiEnvelope<T>> {
    return this.post<T>(mcpRoute(tool), args);
  }

  private async post<T>(path: string, body: unknown): Promise<ApiEnvelope<T>> {
    const url = new URL(path, this.config.apiUrl).toString();
    const doFetch = this.config.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);

    const headers: Record<string, string> = {
      "content-type": "application/json",
      authorization: `Bearer ${this.config.token}`,
      [HEADERS.agentId]: this.config.agentId,
    };
    if (this.config.taskId) headers[HEADERS.taskId] = this.config.taskId;

    try {
      const res = await doFetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body ?? {}),
        signal: controller.signal,
      });

      let json: unknown;
      try {
        json = await res.json();
      } catch {
        return {
          ok: false,
          error: { code: "internal", message: `daemon returned a non-JSON response (HTTP ${res.status})` },
        };
      }

      if (isApiEnvelope<T>(json)) return json;

      return {
        ok: false,
        error: { code: "internal", message: `daemon returned an unexpected response shape (HTTP ${res.status})` },
      };
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      const message = aborted
        ? `request to ${path} timed out after ${this.config.timeoutMs}ms`
        : `request to ${path} failed: ${err instanceof Error ? err.message : String(err)}`;
      return { ok: false, error: { code: "internal", message } };
    } finally {
      clearTimeout(timer);
    }
  }
}

function isApiEnvelope<T>(value: unknown): value is ApiEnvelope<T> {
  if (!value || typeof value !== "object" || !("ok" in value)) return false;
  const v = value as { ok: unknown };
  if (v.ok === true) return "data" in value;
  if (v.ok === false) return "error" in value;
  return false;
}
