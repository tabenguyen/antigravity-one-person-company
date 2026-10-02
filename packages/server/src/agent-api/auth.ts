// Auth middleware for every /v1/hooks/* and /v1/mcp/* route.
//
// Checks, in order:
//  1. `authorization: Bearer <token>` present and well-formed.
//  2. `tokens.verify(token)` resolves it to a (agentId, taskId) run.
//     Token lookup is a Map keyed directly by the 32-byte random token
//     itself — a practical attacker cannot narrow down a guess via timing,
//     since there is no secret-dependent byte-by-byte comparison on the hot
//     path (V8's Map hashing is not a character-by-character compare loop
//     the way a naive `===` scan over attacker-controlled prefixes would
//     be) and the token space (2^256) makes online guessing infeasible
//     regardless. `@agyhq/db`'s AgentTokensRepo uses an explicit
//     `timingSafeEqual` because it compares a *hash the caller can see fail
//     one byte at a time via repeated requests against a fixed stored value*
//     in a lower-entropy-adjacent path; here there's nothing to compare
//     against except "is this exact token currently issued", which is a
//     hash-table membership test, not a per-field compare.
//  3. `x-agyhq-agent-id` header matches the token's agentId.
//  4. `x-agyhq-task-id` header, if present, matches the token's taskId.
//  5. The agent exists and is not archived.
//
// Any failure returns an ApiEnvelope error with the matching HTTP status
// before the route handler runs.

import type { Context, MiddlewareHandler, Next } from "hono";
import { HEADERS } from "@agyhq/core";
import type { Db } from "@agyhq/db";
import { err } from "./envelope.ts";
import type { RunTokenRegistry } from "./tokens.ts";

export function createAuthMiddleware(db: Db, tokens: RunTokenRegistry): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const authHeader = c.req.header("authorization") ?? c.req.header("Authorization");
    const match = authHeader?.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      return err(c, "unauthorized", "missing or malformed authorization header; expected: Bearer <token>");
    }
    const token = match[1]!.trim();
    if (!token) {
      return err(c, "unauthorized", "missing bearer token");
    }

    const claim = tokens.verify(token);
    if (!claim) {
      return err(c, "unauthorized", "invalid or expired run token");
    }

    const headerAgentId = c.req.header(HEADERS.agentId);
    if (!headerAgentId) {
      return err(c, "unauthorized", `missing required header ${HEADERS.agentId}`);
    }
    if (headerAgentId !== claim.agentId) {
      return err(c, "forbidden", `${HEADERS.agentId} does not match the agent bound to this token`);
    }

    const headerTaskId = c.req.header(HEADERS.taskId);
    if (headerTaskId !== undefined && headerTaskId !== claim.taskId) {
      return err(c, "forbidden", `${HEADERS.taskId} does not match the task bound to this token`);
    }

    const agent = db.agents.get(claim.agentId);
    if (!agent) {
      return err(c, "forbidden", "agent no longer exists");
    }
    if (agent.status === "archived") {
      return err(c, "forbidden", "agent is archived");
    }

    c.set("auth", { agentId: claim.agentId, taskId: claim.taskId, agent });
    await next();
  };
}
