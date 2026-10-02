import { describe, expect, it } from "vitest";
import { HOOK_ROUTES } from "@agyhq/core";
import { setupTestApi } from "./test-helpers.ts";

describe("auth middleware", () => {
  it("accepts a valid request end to end", async () => {
    const { request } = setupTestApi();
    const res = await request(HOOK_ROUTES.context, { conversationId: null });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean };
    expect(json.ok).toBe(true);
  });

  it("rejects a missing authorization header", async () => {
    const { request } = setupTestApi();
    const res = await request(HOOK_ROUTES.context, { conversationId: null }, { authorization: undefined });
    expect(res.status).toBe(401);
    const json = (await res.json()) as { ok: false; error: { code: string } };
    expect(json.ok).toBe(false);
    expect(json.error.code).toBe("unauthorized");
  });

  it("rejects a malformed authorization header (no Bearer prefix)", async () => {
    const { token, request } = setupTestApi();
    const res = await request(HOOK_ROUTES.context, { conversationId: null }, { authorization: token });
    expect(res.status).toBe(401);
  });

  it("rejects an unknown/invalid token", async () => {
    const { request } = setupTestApi();
    const res = await request(HOOK_ROUTES.context, { conversationId: null }, { authorization: "Bearer not-a-real-token" });
    expect(res.status).toBe(401);
  });

  it("rejects a revoked token", async () => {
    const { tokens, token, request } = setupTestApi();
    tokens.revoke(token);
    const res = await request(HOOK_ROUTES.context, { conversationId: null });
    expect(res.status).toBe(401);
  });

  it("rejects when x-agyhq-agent-id header is missing", async () => {
    const { request } = setupTestApi();
    const res = await request(HOOK_ROUTES.context, { conversationId: null }, { "x-agyhq-agent-id": undefined });
    expect(res.status).toBe(401);
  });

  it("rejects when x-agyhq-agent-id does not match the token's agent", async () => {
    const { request } = setupTestApi();
    const res = await request(HOOK_ROUTES.context, { conversationId: null }, { "x-agyhq-agent-id": "someone-else" });
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("forbidden");
  });

  it("rejects when x-agyhq-task-id is present but does not match the token's task", async () => {
    const { request } = setupTestApi();
    const res = await request(HOOK_ROUTES.context, { conversationId: null }, { "x-agyhq-task-id": "tsk_bogus" });
    expect(res.status).toBe(403);
  });

  it("allows when x-agyhq-task-id is simply omitted (optional per contract)", async () => {
    const { request } = setupTestApi();
    const res = await request(HOOK_ROUTES.context, { conversationId: null }, { "x-agyhq-task-id": undefined });
    expect(res.status).toBe(200);
  });

  it("rejects when the token's agent was never created (or no longer exists)", async () => {
    const { tokens, app } = setupTestApi();
    const ghostToken = tokens.issue("agent-that-does-not-exist", "tsk_ghost");
    const res = await app.request(HOOK_ROUTES.context, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ghostToken}`,
        "x-agyhq-agent-id": "agent-that-does-not-exist",
        "x-agyhq-task-id": "tsk_ghost",
        "content-type": "application/json",
      },
      body: JSON.stringify({ conversationId: null }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects when the agent is archived", async () => {
    const { db, agentId, request } = setupTestApi();
    db.agents.setStatus(agentId, "archived");
    const res = await request(HOOK_ROUTES.context, { conversationId: null });
    expect(res.status).toBe(403);
  });

  it("still allows a paused (not archived) agent", async () => {
    const { db, agentId, request } = setupTestApi();
    db.agents.setStatus(agentId, "paused");
    const res = await request(HOOK_ROUTES.context, { conversationId: null });
    expect(res.status).toBe(200);
  });
});
