// Agent-facing API: serves /v1/hooks/* (called by @agyhq/hooks scripts) and
// /v1/mcp/* (called by @agyhq/mcp's company MCP server). See docs/PHASE0.md
// D3/D5 for the security model this implements and packages/core/src/api.ts
// for the wire contract (ApiEnvelope, HOOK_ROUTES, McpTools, ENV/HEADERS).
//
// This module owns nothing but the HTTP surface: auth, the PreToolUse policy
// engine, audit-event shaping, and MCP tool validation/dispatch. All state
// lives in @agyhq/db.

import { Hono } from "hono";
import type { Agent } from "@agyhq/core";
import type { Db } from "@agyhq/db";
import "./types.ts"; // registers the `auth` key on Hono's ContextVariableMap
import { createAuthMiddleware } from "./auth.ts";
import { resolveDeps } from "./deps.ts";
import { registerHookRoutes } from "./hooks.ts";
import { registerMcpRoutes } from "./mcp.ts";
import { RunTokenRegistry } from "./tokens.ts";

export { RunTokenRegistry } from "./tokens.ts";
export { evaluatePolicy } from "./policy.ts";

export interface AgentApiDeps {
  db: Db;
  tokens: RunTokenRegistry;
  /** Injectable clock, for tests. Defaults to `() => new Date()`. */
  now?: () => Date;
  /** Per-agent cap on outbox drafts created per UTC day. Default 50. */
  outboxDailyLimit?: number;
  /** Live event sink for the UI (memory.proposed, outbox.drafted). Optional no-op by default. */
  emit?: (type: string, data: Record<string, unknown>) => void;
  /** agy's state dir (brain/, mcp/ schemas) that file tools may read. Default ~/.gemini/antigravity-cli. */
  agyStateDir?: string;
  /** Root of saved inbound email attachments; a task routed from an inbound event may read that event's dir. */
  attachmentsRoot?: string;
  /** Valid task kinds for an agent (from its role template); null = don't validate. Used by task_create. */
  taskKindsFor?: (agent: Agent) => readonly string[] | null;
}

/** Builds the Hono app serving /v1/hooks/* and /v1/mcp/*. See the package README for the route list. */
export function createAgentApi(deps: AgentApiDeps): Hono {
  const resolved = resolveDeps(deps);
  const app = new Hono();

  // Scoped to exactly the two prefixes this router serves — NOT "*". This app is
  // mounted at "/" alongside the admin API and (Phase 2) the static UI; a
  // blanket "*" auth middleware would "claim" every request Hono tries against
  // this sub-app (e.g. "/", or any /v1/admin/* path admin-api's own router
  // didn't already terminally handle) and 401 it before the real handler for
  // that path ever runs, since a middleware match that doesn't call next()
  // short-circuits the whole composed chain.
  const auth = createAuthMiddleware(resolved.db, resolved.tokens);
  app.use("/v1/hooks/*", auth);
  app.use("/v1/mcp/*", auth);

  registerHookRoutes(app, resolved);
  registerMcpRoutes(app, resolved);

  return app;
}
