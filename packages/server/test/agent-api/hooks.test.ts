import { describe, expect, it } from "vitest";
import { HOOK_ROUTES } from "@agyhq/core";
import { setupTestApi } from "./test-helpers.ts";

describe("POST /v1/hooks/pre-tool-use", () => {
  it("allows a listed builtin and audits tool.pre", async () => {
    const { db, agentId, taskId, request } = setupTestApi();
    const res = await request(HOOK_ROUTES.preToolUse, { conversationId: "conv-1", toolName: "view_file", parameters: { path: "a.md" } });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: true; data: { decision: string } };
    expect(json.data).toEqual({ decision: "allow" });

    const rows = db.audit.list({ agentId, taskId, kind: ["tool.pre"] });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.data["toolName"]).toBe("view_file");
  });

  it("denies an unlisted tool and audits tool.denied with the reason", async () => {
    const { db, agentId, taskId, request } = setupTestApi();
    const res = await request(HOOK_ROUTES.preToolUse, { conversationId: null, toolName: "run_command", parameters: {} });
    expect(res.status).toBe(200); // policy decisions are 200s; "deny" is a valid decision, not an API error
    const json = (await res.json()) as { data: { decision: string; reason: string } };
    expect(json.data.decision).toBe("deny");
    expect(json.data.reason).toContain("run_command");

    const rows = db.audit.list({ agentId, taskId, kind: ["tool.denied"] });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.data["reason"]).toBe(json.data.reason);
  });

  it("records the MCP server/tool for call_mcp_tool in the audit row", async () => {
    const { db, agentId, taskId, request } = setupTestApi();
    await request(HOOK_ROUTES.preToolUse, {
      conversationId: "conv-2",
      toolName: "call_mcp_tool",
      parameters: { ServerName: "company", ToolName: "kb_search", Arguments: { query: "pricing" } },
    });
    const rows = db.audit.list({ agentId, taskId, kind: ["tool.pre"] });
    expect(rows[0]?.data).toMatchObject({ mcpServer: "company", mcpTool: "kb_search" });
  });

  it("lets a task read the saved attachments of the inbound email it came from, and nothing else's", async () => {
    const { db, agentId, tokens, request } = setupTestApi({ attachmentsRoot: "/data/attachments" });
    const task = db.tasks.create({ agentId, kind: "sdr.handle_reply", title: "Reply", input: { inboundEventId: "ibe_1" } });
    const auth = { authorization: `Bearer ${tokens.issue(agentId, task.id)}`, "x-agyhq-task-id": task.id };
    const decide = async (file: string) => {
      const res = await request(HOOK_ROUTES.preToolUse, { conversationId: null, toolName: "view_file", parameters: { AbsolutePath: file } }, auth);
      return ((await res.json()) as { data: { decision: string } }).data.decision;
    };
    expect(await decide("/data/attachments/ibe_1/01-invoice.pdf")).toBe("allow");
    expect(await decide("/data/attachments/ibe_2/01-other.pdf")).toBe("deny");
    expect(await decide("/data/attachments/ibe_1/../ibe_2/01-other.pdf")).toBe("deny");
  });

  it("returns invalid_request for a malformed body", async () => {
    const { request } = setupTestApi();
    const res = await request(HOOK_ROUTES.preToolUse, { conversationId: null, parameters: {} }); // missing toolName
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("invalid_request");
  });
});

describe("POST /v1/hooks/audit", () => {
  it("records a PostToolUse event as tool.post and returns {recorded:true}", async () => {
    const { db, agentId, taskId, request } = setupTestApi();
    const res = await request(HOOK_ROUTES.audit, {
      event: "PostToolUse",
      conversationId: "conv-3",
      payload: { toolCall: { name: "view_file", args: {} }, error: "" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: { recorded: true } });

    const rows = db.audit.list({ agentId, taskId, kind: ["tool.post"] });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.data["event"]).toBe("PostToolUse");
    expect(rows[0]?.data["toolName"]).toBe("view_file");
  });

  it("records a PostInvocation event too, distinguished by data.event", async () => {
    const { db, agentId, taskId, request } = setupTestApi();
    await request(HOOK_ROUTES.audit, { event: "PostInvocation", conversationId: null, payload: { invocationNum: 1 } });
    const rows = db.audit.list({ agentId, taskId, kind: ["tool.post"] });
    expect(rows[0]?.data["event"]).toBe("PostInvocation");
  });

  it("truncates a very large payload", async () => {
    const { db, agentId, taskId, request } = setupTestApi();
    const bigArgs = { blob: "x".repeat(20_000) };
    await request(HOOK_ROUTES.audit, { event: "PostToolUse", conversationId: null, payload: { toolCall: { name: "t", args: bigArgs }, error: "" } });
    const rows = db.audit.list({ agentId, taskId, kind: ["tool.post"] });
    const payload = rows[0]?.data["payload"] as string;
    expect(payload.length).toBeLessThan(20_000);
    expect(payload).toContain("truncated");
  });
});

describe("POST /v1/hooks/context", () => {
  it("returns [] when there's nothing relevant", async () => {
    const { request } = setupTestApi();
    const res = await request(HOOK_ROUTES.context, { conversationId: null });
    const json = (await res.json()) as { data: { messages: string[] } };
    expect(json.data.messages).toEqual([]);
  });

  it("includes an accepted general memory", async () => {
    const { db, agentId, request } = setupTestApi();
    const mem = db.memory.propose(agentId, "Prefers short emails.");
    db.memory.setStatus(mem.id, "accepted");

    const res = await request(HOOK_ROUTES.context, { conversationId: null });
    const json = (await res.json()) as { data: { messages: string[] } };
    expect(json.data.messages.join("\n")).toContain("Prefers short emails.");
  });

  it("excludes a pending (not yet accepted) memory", async () => {
    const { db, agentId, request } = setupTestApi();
    db.memory.propose(agentId, "Unreviewed fact.");

    const res = await request(HOOK_ROUTES.context, { conversationId: null });
    const json = (await res.json()) as { data: { messages: string[] } };
    expect(json.data.messages.join("\n")).not.toContain("Unreviewed fact.");
  });

  it("excludes a memory scoped to a different thread", async () => {
    const { db, agentId, request } = setupTestApi();
    const mem = db.memory.propose(agentId, "Only for another contact.", "contact:other@example.com");
    db.memory.setStatus(mem.id, "accepted");

    const res = await request(HOOK_ROUTES.context, { conversationId: null });
    const json = (await res.json()) as { data: { messages: string[] } };
    expect(json.data.messages.join("\n")).not.toContain("Only for another contact.");
  });

  it("includes a contact summary (stage, company, last 3 notes) when the task's threadKey is contact:<email>", async () => {
    const { db, agentId, tokens, app } = setupTestApi();
    const { contact } = db.crm.upsertContact({ email: "jane@acme.com", name: "Jane", companyName: "Acme" });
    db.crm.setStage(contact.id, "qualified", "good fit");
    db.crm.addNote("contact", contact.id, "Called, left voicemail.");
    db.crm.addNote("contact", contact.id, "Replied with interest.");
    db.crm.addNote("contact", contact.id, "Sent proposal.");
    db.crm.addNote("contact", contact.id, "Booked a demo."); // only the last 3 of these should surface

    const task2 = db.tasks.create({ agentId, kind: "sdr.follow_up", title: "Follow up Jane", threadKey: "contact:jane@acme.com" });
    const token2 = tokens.issue(agentId, task2.id);

    const res = await app.request(HOOK_ROUTES.context, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token2}`,
        "x-agyhq-agent-id": agentId,
        "x-agyhq-task-id": task2.id,
        "content-type": "application/json",
      },
      body: JSON.stringify({ conversationId: null }),
    });
    const json = (await res.json()) as { data: { messages: string[] } };
    const text = json.data.messages.join("\n");
    expect(text).toContain("jane@acme.com");
    expect(text).toContain("qualified");
    expect(text).toContain("Acme");
    // Most recent 3 notes only (addNote inserted 4; "Called, left voicemail." should be dropped).
    expect(text).toContain("Booked a demo.");
    expect(text).toContain("Sent proposal.");
    expect(text).toContain("Replied with interest.");
    expect(text).not.toContain("Called, left voicemail.");
  });

  it("includes both general memory and contact summary together, capped under ~3000 chars", async () => {
    const { db, agentId, tokens, app } = setupTestApi();
    const mem = db.memory.propose(agentId, "x".repeat(2_000));
    db.memory.setStatus(mem.id, "accepted");
    db.crm.upsertContact({ email: "big@acme.com" });

    const task2 = db.tasks.create({ agentId, kind: "sdr.follow_up", title: "t", threadKey: "contact:big@acme.com" });
    const token2 = tokens.issue(agentId, task2.id);
    const res = await app.request(HOOK_ROUTES.context, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token2}`,
        "x-agyhq-agent-id": agentId,
        "x-agyhq-task-id": task2.id,
        "content-type": "application/json",
      },
      body: JSON.stringify({ conversationId: null }),
    });
    const json = (await res.json()) as { data: { messages: string[] } };
    const totalChars = json.data.messages.reduce((n, m) => n + m.length, 0);
    expect(totalChars).toBeLessThanOrEqual(3_000);
  });
});

describe("POST /v1/hooks/stop", () => {
  it("returns {decision:'stop'} and audits hook.stop", async () => {
    const { db, agentId, taskId, request } = setupTestApi();
    const res = await request(HOOK_ROUTES.stop, {
      conversationId: "conv-5",
      transcriptPath: "/tmp/t.jsonl",
      terminationReason: "NO_TOOL_CALL",
      payload: { fullyIdle: true },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: { decision: "stop" } });

    const rows = db.audit.list({ agentId, taskId, kind: ["hook.stop"] });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.data).toMatchObject({ transcriptPath: "/tmp/t.jsonl", terminationReason: "NO_TOOL_CALL" });
  });
});
