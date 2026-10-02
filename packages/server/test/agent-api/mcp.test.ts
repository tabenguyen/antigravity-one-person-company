import { describe, expect, it } from "vitest";
import { mcpRoute } from "@agyhq/core";
import { setupTestApi } from "./test-helpers.ts";

describe("kb_search", () => {
  it("searches across company/role/agent scopes and audits kb.search", async () => {
    const { db, agentId, taskId, request } = setupTestApi();
    db.kb.upsertDocument({ scope: "company", title: "Pricing", sourcePath: "pricing.md", body: "# Pricing\nOur plans start at $10." });
    db.kb.upsertDocument({ scope: "role:sales-sdr", title: "Playbook", sourcePath: "playbook.md", body: "# Playbook\nAlways qualify BANT." });
    db.kb.upsertDocument({ scope: `agent:${agentId}`, title: "Notes", sourcePath: "notes.md", body: "# Notes\nPersonal reminder text." });
    db.kb.upsertDocument({ scope: "agent:some-other-agent", title: "Other", sourcePath: "other.md", body: "# Other\nShould not be found reminder." });

    const res = await request(mcpRoute("kb_search"), { query: "pricing" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { results: Array<{ title: string }> } };
    expect(json.data.results.some((r) => r.title === "Pricing")).toBe(true);

    const rows = db.audit.list({ agentId, taskId, kind: ["kb.search"] });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.data["resultCount"]).toBe(json.data.results.length);
  });

  it("rejects an empty query as invalid_request", async () => {
    const { request } = setupTestApi();
    const res = await request(mcpRoute("kb_search"), { query: "" });
    expect(res.status).toBe(400);
  });
});

describe("memory_list / memory_propose", () => {
  it("proposes a memory as pending, audits memory.proposed, and emits an event", async () => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const { db, agentId, taskId, request } = setupTestApi({ emit: (type, data) => events.push({ type, data }) });

    const res = await request(mcpRoute("memory_propose"), { content: "Prefers Vietnamese.", subject: "contact:jane@acme.com" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { item: { status: string; subject: string | null } } };
    expect(json.data.item.status).toBe("pending");
    expect(json.data.item.subject).toBe("contact:jane@acme.com");

    expect(db.audit.list({ agentId, taskId, kind: ["memory.proposed"] })).toHaveLength(1);
    expect(events.some((e) => e.type === "memory.proposed")).toBe(true);
  });

  it("memory_list only returns accepted memories, optionally filtered by subject", async () => {
    const { db, agentId, request } = setupTestApi();
    const general = db.memory.propose(agentId, "General fact.");
    db.memory.setStatus(general.id, "accepted");
    const pending = db.memory.propose(agentId, "Still pending.");
    void pending;
    const scoped = db.memory.propose(agentId, "Scoped fact.", "contact:jane@acme.com");
    db.memory.setStatus(scoped.id, "accepted");

    const all = await request(mcpRoute("memory_list"), {});
    const allJson = (await all.json()) as { data: { items: Array<{ content: string }> } };
    expect(allJson.data.items.map((i) => i.content).sort()).toEqual(["General fact.", "Scoped fact."]);

    const filtered = await request(mcpRoute("memory_list"), { subject: "contact:jane@acme.com" });
    const filteredJson = (await filtered.json()) as { data: { items: Array<{ content: string }> } };
    expect(filteredJson.data.items.map((i) => i.content)).toEqual(["Scoped fact."]);
  });
});

describe("crm_find_contact", () => {
  it("finds by email", async () => {
    const { db, request } = setupTestApi();
    db.crm.upsertContact({ email: "jane@acme.com", name: "Jane" });
    const res = await request(mcpRoute("crm_find_contact"), { email: "jane@acme.com" });
    const json = (await res.json()) as { data: { contacts: Array<{ email: string | null }> } };
    expect(json.data.contacts).toHaveLength(1);
    expect(json.data.contacts[0]?.email).toBe("jane@acme.com");
  });

  it("returns invalid_request when none of email/id/query are given", async () => {
    const { request } = setupTestApi();
    const res = await request(mcpRoute("crm_find_contact"), {});
    expect(res.status).toBe(400);
  });
});

describe("crm_upsert_contact", () => {
  it("creates a new contact, defaulting ownerAgentId to the caller and source to 'agent'", async () => {
    const { agentId, request } = setupTestApi();
    const res = await request(mcpRoute("crm_upsert_contact"), { email: "new@acme.com", name: "New Guy" });
    const json = (await res.json()) as { data: { contact: { ownerAgentId: string | null; source: string | null }; created: boolean } };
    expect(json.data.created).toBe(true);
    expect(json.data.contact.ownerAgentId).toBe(agentId);
    expect(json.data.contact.source).toBe("agent");
  });

  it("does not overwrite an existing owner on update", async () => {
    const { db, agentId, request } = setupTestApi();
    db.crm.upsertContact({ email: "owned@acme.com", ownerAgentId: "am-01", source: "import" });

    const res = await request(mcpRoute("crm_upsert_contact"), { email: "owned@acme.com", title: "VP Sales" });
    const json = (await res.json()) as { data: { contact: { ownerAgentId: string | null; source: string | null; title: string | null } } };
    expect(json.data.contact.ownerAgentId).toBe("am-01");
    expect(json.data.contact.ownerAgentId).not.toBe(agentId);
    expect(json.data.contact.source).toBe("import");
    expect(json.data.contact.title).toBe("VP Sales");
  });

  it("respects an explicitly-given source even for a brand-new contact", async () => {
    const { request } = setupTestApi();
    const res = await request(mcpRoute("crm_upsert_contact"), { email: "explicit@acme.com", source: "webform" });
    const json = (await res.json()) as { data: { contact: { source: string | null } } };
    expect(json.data.contact.source).toBe("webform");
  });
});

describe("crm_add_note / crm_set_stage", () => {
  it("adds a note authored by the caller", async () => {
    const { db, agentId, request } = setupTestApi();
    const { contact } = db.crm.upsertContact({ email: "note@acme.com" });
    const res = await request(mcpRoute("crm_add_note"), { contactId: contact.id, body: "Had a great call." });
    const json = (await res.json()) as { data: { note: { authorAgentId: string | null; body: string } } };
    expect(json.data.note.authorAgentId).toBe(agentId);
    expect(json.data.note.body).toBe("Had a great call.");
  });

  it("returns not_found for an unknown contact", async () => {
    const { request } = setupTestApi();
    const res = await request(mcpRoute("crm_add_note"), { contactId: "ctc_missing", body: "x" });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("not_found");
  });

  it("sets stage and logs the reason as a note", async () => {
    const { db, request } = setupTestApi();
    const { contact } = db.crm.upsertContact({ email: "stage@acme.com" });
    const res = await request(mcpRoute("crm_set_stage"), { contactId: contact.id, stage: "qualified", reason: "Good BANT fit." });
    const json = (await res.json()) as { data: { contact: { stage: string } } };
    expect(json.data.contact.stage).toBe("qualified");
    const notes = db.crm.listRecentNotes("contact", contact.id, 5);
    expect(notes.some((n) => n.body.includes("Good BANT fit."))).toBe(true);
  });

  it("set_stage on an unknown contact returns not_found", async () => {
    const { request } = setupTestApi();
    const res = await request(mcpRoute("crm_set_stage"), { contactId: "ctc_missing", stage: "qualified", reason: "x" });
    expect(res.status).toBe(404);
  });
});

describe("task_create", () => {
  it("rejects a task kind the assignee's template doesn't define, listing the valid kinds", async () => {
    const { db, request } = setupTestApi({ taskKindsFor: () => ["sdr.research_lead", "sdr.first_touch"] });
    const res = await request(mcpRoute("task_create"), { kind: "first_touch", title: "t", input: {} });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message).toContain("sdr.first_touch");
    expect(db.tasks.list({ agentId: "sdr-01" }).length).toBe(1);
    const ok = await request(mcpRoute("task_create"), { kind: "sdr.first_touch", title: "t", input: {} });
    expect(ok.status).toBe(200);
  });

  it("defaults assignee to the caller, sets parentTaskId to the caller's task, and inherits no threadKey when the parent has none", async () => {
    const { agentId, taskId, request } = setupTestApi();
    const res = await request(mcpRoute("task_create"), { kind: "sdr.follow_up", title: "Follow up", input: {} });
    const json = (await res.json()) as { data: { task: { agentId: string; parentTaskId: string | null; threadKey: string | null; createdByAgentId: string | null } } };
    expect(json.data.task.agentId).toBe(agentId);
    expect(json.data.task.parentTaskId).toBe(taskId);
    expect(json.data.task.createdByAgentId).toBe(agentId);
    expect(json.data.task.threadKey).toBeNull();
  });

  it("inherits the parent task's threadKey when none is given", async () => {
    const { db, agentId, tokens, app } = setupTestApi();
    const parent = db.tasks.create({ agentId, kind: "sdr.research_lead", title: "p", threadKey: "contact:jane@acme.com" });
    const token = tokens.issue(agentId, parent.id);
    const res = await app.request(mcpRoute("task_create"), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "x-agyhq-agent-id": agentId, "x-agyhq-task-id": parent.id, "content-type": "application/json" },
      body: JSON.stringify({ kind: "sdr.follow_up", title: "Follow up", input: {} }),
    });
    const json = (await res.json()) as { data: { task: { threadKey: string | null } } };
    expect(json.data.task.threadKey).toBe("contact:jane@acme.com");
  });

  it("an explicit threadKey overrides the parent's", async () => {
    const { request } = setupTestApi();
    const res = await request(mcpRoute("task_create"), { kind: "sdr.follow_up", title: "t", input: {}, threadKey: "contact:explicit@acme.com" });
    const json = (await res.json()) as { data: { task: { threadKey: string | null } } };
    expect(json.data.task.threadKey).toBe("contact:explicit@acme.com");
  });

  it("afterHours becomes a wakeAt computed from the injected clock", async () => {
    const fixedNow = new Date("2026-01-01T00:00:00.000Z");
    const { request } = setupTestApi({ now: () => fixedNow });
    const res = await request(mcpRoute("task_create"), { kind: "sdr.follow_up", title: "t", input: {}, afterHours: 72 });
    const json = (await res.json()) as { data: { task: { wakeAt: string | null } } };
    expect(json.data.task.wakeAt).toBe("2026-01-04T00:00:00.000Z");
  });

  it("handoff: assigneeAgentId must reference an existing, active agent", async () => {
    const { db, request } = setupTestApi();
    const missing = await request(mcpRoute("task_create"), { kind: "sdr.follow_up", title: "t", input: {}, assigneeAgentId: "nope" });
    expect(missing.status).toBe(404);

    db.agents.create({
      id: "am-01",
      role: "account-manager",
      displayName: "AM",
      model: "m",
      workspacePath: "/tmp/am-01",
      policy: { builtins: [], mcp: [] },
      status: "paused",
    });
    const inactive = await request(mcpRoute("task_create"), { kind: "sdr.follow_up", title: "t", input: {}, assigneeAgentId: "am-01" });
    expect(inactive.status).toBe(400);
  });

  it("refuses to create a 21st child task for the same parent (self-recursion guard)", async () => {
    const { request } = setupTestApi();
    for (let i = 0; i < 20; i++) {
      const res = await request(mcpRoute("task_create"), { kind: "sdr.follow_up", title: `t${i}`, input: {} });
      expect(res.status).toBe(200);
    }
    const res21 = await request(mcpRoute("task_create"), { kind: "sdr.follow_up", title: "t21", input: {} });
    expect(res21.status).toBe(409);
    expect(((await res21.json()) as { error: { code: string } }).error.code).toBe("conflict");
  });
});

describe("outbox_draft_email", () => {
  it("drafts pending_approval for a normal recipient", async () => {
    const { db, agentId, taskId, request } = setupTestApi();
    const res = await request(mcpRoute("outbox_draft_email"), { to: "lead@acme.com", subject: "Hi", body: "Hello!", reason: "first touch" });
    const json = (await res.json()) as { data: { item: { status: string; taskId: string | null } } };
    expect(json.data.item.status).toBe("pending_approval");
    expect(json.data.item.taskId).toBe(taskId);
    expect(db.audit.list({ agentId, taskId, kind: ["outbox.drafted"] })).toHaveLength(1);
  });

  it("blocks when the recipient opted out via attributes.optOut", async () => {
    const { db, request } = setupTestApi();
    db.crm.upsertContact({ email: "optout@acme.com", attributes: { optOut: true } });
    const res = await request(mcpRoute("outbox_draft_email"), { to: "optout@acme.com", subject: "Hi", body: "Hello!", reason: "x" });
    const json = (await res.json()) as { data: { item: { status: string } } };
    expect(json.data.item.status).toBe("blocked");
  });

  it("blocks when the recipient opted out via attributes.doNotContact", async () => {
    const { db, request } = setupTestApi();
    db.crm.upsertContact({ email: "dnc@acme.com", attributes: { doNotContact: true } });
    const res = await request(mcpRoute("outbox_draft_email"), { to: "dnc@acme.com", subject: "Hi", body: "Hello!", reason: "x" });
    expect(((await res.json()) as { data: { item: { status: string } } }).data.item.status).toBe("blocked");
  });

  it("blocks when disqualified with an unsubscribe note", async () => {
    const { db, request } = setupTestApi();
    const { contact } = db.crm.upsertContact({ email: "unsub@acme.com" });
    db.crm.setStage(contact.id, "disqualified", "Asked to unsubscribe.");
    const res = await request(mcpRoute("outbox_draft_email"), { to: "unsub@acme.com", subject: "Hi", body: "Hello!", reason: "x" });
    expect(((await res.json()) as { data: { item: { status: string } } }).data.item.status).toBe("blocked");
  });

  it("does not block a disqualified contact with an unrelated reason", async () => {
    const { db, request } = setupTestApi();
    const { contact } = db.crm.upsertContact({ email: "notyet@acme.com" });
    db.crm.setStage(contact.id, "disqualified", "No budget.");
    const res = await request(mcpRoute("outbox_draft_email"), { to: "notyet@acme.com", subject: "Hi", body: "Hello!", reason: "x" });
    expect(((await res.json()) as { data: { item: { status: string } } }).data.item.status).toBe("pending_approval");
  });

  it("blocks once the agent's daily outbox limit is reached", async () => {
    const { request } = setupTestApi({ outboxDailyLimit: 2 });
    const first = await request(mcpRoute("outbox_draft_email"), { to: "a@acme.com", subject: "s", body: "b", reason: "r" });
    const second = await request(mcpRoute("outbox_draft_email"), { to: "b@acme.com", subject: "s", body: "b", reason: "r" });
    const third = await request(mcpRoute("outbox_draft_email"), { to: "c@acme.com", subject: "s", body: "b", reason: "r" });
    expect(((await first.json()) as { data: { item: { status: string } } }).data.item.status).toBe("pending_approval");
    expect(((await second.json()) as { data: { item: { status: string } } }).data.item.status).toBe("pending_approval");
    expect(((await third.json()) as { data: { item: { status: string } } }).data.item.status).toBe("blocked");
  });

  it("validates input (missing reason)", async () => {
    const { request } = setupTestApi();
    const res = await request(mcpRoute("outbox_draft_email"), { to: "x@acme.com", subject: "s", body: "b" });
    expect(res.status).toBe(400);
  });

  it("defaults threadKey to the current task's threadKey when the model omits it", async () => {
    const { db, tokens, app, agentId } = setupTestApi();
    const task = db.tasks.create({ agentId, kind: "sdr.handle_reply", title: "Reply", threadKey: "contact:jane@acme.com" });
    // A real reply task always has an inbound message behind it; "Re:" subjects need a prior thread (draft lint).
    db.inbound.insertIfNew({ source: "email", externalId: "m1", fromAddress: "jane@acme.com", subject: "hi", bodyText: "Can we talk?", threadKey: "contact:jane@acme.com", classification: "reply" });
    const token = tokens.issue(agentId, task.id);
    const res = await app.request(mcpRoute("outbox_draft_email"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "x-agyhq-agent-id": agentId,
        "x-agyhq-task-id": task.id,
        "content-type": "application/json",
      },
      body: JSON.stringify({ to: "jane@acme.com", subject: "Re: hi", body: "Sure, Tuesday works.", reason: "reply" }),
    });
    const json = (await res.json()) as { data: { item: { threadKey: string | null } } };
    expect(json.data.item.threadKey).toBe("contact:jane@acme.com");
  });

  it("autonomous-tier agent: stays pending_approval when prior approval is required and the recipient has no sent history", async () => {
    const { db, agentId, request } = setupTestApi();
    db.agents.update(agentId, { trustTier: "autonomous" });
    // settings.autonomousRequiresPriorApproval defaults to true
    const res = await request(mcpRoute("outbox_draft_email"), { to: "new@acme.com", subject: "s", body: "b", reason: "r" });
    const json = (await res.json()) as { data: { item: { status: string; decidedBy: string | null } } };
    expect(json.data.item.status).toBe("pending_approval");
    expect(json.data.item.decidedBy).toBeNull();
  });

  it("autonomous-tier agent: auto-approves once the recipient already has a human-approved sent email", async () => {
    const { db, agentId, request } = setupTestApi();
    db.agents.update(agentId, { trustTier: "autonomous" });
    const prior = db.outbox.createDraft({ agentId, channel: "email", to: "returning@acme.com", subject: "s", body: "b", reason: "r" });
    db.outbox.decide(prior.id, "approved", { decidedBy: "human:ops" });
    db.outbox.claimNextToSend();
    db.outbox.decide(prior.id, "sent", { sentAt: new Date().toISOString() });

    const res = await request(mcpRoute("outbox_draft_email"), { to: "returning@acme.com", subject: "s2", body: "b2", reason: "r2" });
    const json = (await res.json()) as { data: { item: { status: string; decidedBy: string | null } } };
    expect(json.data.item.status).toBe("approved");
    expect(json.data.item.decidedBy).toBe("policy:autonomous");
  });

  it("autonomous-tier agent: auto-approves immediately when autonomousRequiresPriorApproval is off", async () => {
    const { db, agentId, request } = setupTestApi();
    db.agents.update(agentId, { trustTier: "autonomous" });
    db.settings.patch({ autonomousRequiresPriorApproval: false });

    const res = await request(mcpRoute("outbox_draft_email"), { to: "brandnew@acme.com", subject: "s", body: "b", reason: "r" });
    const json = (await res.json()) as { data: { item: { status: string; decidedBy: string | null } } };
    expect(json.data.item.status).toBe("approved");
    expect(json.data.item.decidedBy).toBe("policy:autonomous");
  });

  it("shadow/assisted-tier agents are never auto-approved at draft time", async () => {
    const { db, agentId, request } = setupTestApi();
    db.settings.patch({ autonomousRequiresPriorApproval: false }); // even with the gate off
    db.agents.update(agentId, { trustTier: "shadow" });
    const res = await request(mcpRoute("outbox_draft_email"), { to: "x@acme.com", subject: "s", body: "b", reason: "r" });
    const json = (await res.json()) as { data: { item: { status: string } } };
    expect(json.data.item.status).toBe("pending_approval");
  });

  it("uses the model's explicit threadKey over the task's when both are present", async () => {
    const { db, tokens, app, agentId } = setupTestApi();
    const task = db.tasks.create({ agentId, kind: "sdr.handle_reply", title: "Reply", threadKey: "contact:jane@acme.com" });
    const token = tokens.issue(agentId, task.id);
    const res = await app.request(mcpRoute("outbox_draft_email"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "x-agyhq-agent-id": agentId,
        "x-agyhq-task-id": task.id,
        "content-type": "application/json",
      },
      body: JSON.stringify({ to: "jane@acme.com", subject: "s", body: "b", reason: "r", threadKey: "contact:other@acme.com" }),
    });
    const json = (await res.json()) as { data: { item: { threadKey: string | null } } };
    expect(json.data.item.threadKey).toBe("contact:other@acme.com");
  });
});

describe("MCP-layer policy enforcement (belt-and-suspenders, PHASE0.md D3 layer 3)", () => {
  // This must hold even when a workspace's hooks.json is missing/broken and
  // PreToolUse never ran — the route itself re-checks agent.policy.mcp before
  // running the handler, independent of the PreToolUse hook.

  it("403s a tool the agent's policy does not list, without ever running the handler", async () => {
    const { db, agentId, taskId, request } = setupTestApi();
    db.agents.update(agentId, {
      policy: {
        builtins: [],
        mcp: [{ server: "company", tool: "kb_search" }], // outbox_draft_email intentionally omitted
      },
    });

    const res = await request(mcpRoute("outbox_draft_email"), { to: "x@acme.com", subject: "s", body: "b", reason: "r" });
    expect(res.status).toBe(403);
    const json = (await res.json()) as { ok: false; error: { code: string; message: string } };
    expect(json.ok).toBe(false);
    expect(json.error.code).toBe("forbidden");
    expect(json.error.message).toContain("outbox_draft_email");

    // The handler must not have run: no outbox row created.
    expect(db.outbox.list({ agentId })).toHaveLength(0);

    const denied = db.audit.list({ agentId, taskId, kind: ["tool.denied"] });
    expect(denied).toHaveLength(1);
    expect(denied[0]?.data).toMatchObject({ layer: "mcp", mcpServer: "company", mcpTool: "outbox_draft_email" });
  });

  it("a wildcard ('*') policy entry allows every tool on that server", async () => {
    const { db, agentId, request } = setupTestApi();
    db.agents.update(agentId, { policy: { builtins: [], mcp: [{ server: "company", tool: "*" }] } });

    const res = await request(mcpRoute("outbox_draft_email"), { to: "x@acme.com", subject: "s", body: "b", reason: "r" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { item: { status: string } } };
    expect(json.data.item.status).toBe("pending_approval");
  });

  it("still allows a tool that IS listed in the agent's policy", async () => {
    const { db, agentId, request } = setupTestApi();
    db.agents.update(agentId, { policy: { builtins: [], mcp: [{ server: "company", tool: "kb_search" }] } });

    const res = await request(mcpRoute("kb_search"), { query: "anything" });
    expect(res.status).toBe(200);
  });

  it("denies a tool offered under a different (e.g. namespaced) server name — exact match only", async () => {
    const { agentId, db, request } = setupTestApi();
    db.agents.update(agentId, { policy: { builtins: [], mcp: [{ server: "someplugin_company", tool: "*" }] } });

    const res = await request(mcpRoute("kb_search"), { query: "anything" });
    expect(res.status).toBe(403);
  });
});
