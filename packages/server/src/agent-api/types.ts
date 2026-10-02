// Shared types for the agent-facing API router.

import type { Agent } from "@agyhq/core";

/** What the auth middleware attaches to the request context once a run token checks out. */
export interface AuthContext {
  agentId: string;
  taskId: string;
  agent: Agent;
}

// Augment Hono's global variable map so `c.get("auth")`/`c.set("auth", ...)`
// are typed everywhere without needing to thread a custom Env generic through
// `createAgentApi`'s return type (which the fixed interface declares as the
// plain `Hono` type).
declare module "hono" {
  interface ContextVariableMap {
    auth: AuthContext;
  }
}
