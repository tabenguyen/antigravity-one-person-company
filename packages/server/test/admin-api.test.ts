import { describe, it, expect } from "vitest";
import { createAdminApi } from "../src/admin-api.ts";
import { EventBus } from "../src/event-bus.ts";
import { makeTestConfig, openTestDb } from "./helpers.ts";

function buildApi() {
  const config = makeTestConfig();
  const db = openTestDb();
  const bus = new EventBus();
  const app = createAdminApi({ config, db, bus });
  return { app, config, db, bus };
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

describe("admin API — auth", () => {
  it("rejects requests with no bearer token", async () => {
    const { app } = buildApi();
    const res = await app.request("/v1/admin/agents");
    expect(res.status).toBe(401);
  });

  it("rejects requests with the wrong token", async () => {
    const { app } = buildApi();
    const res = await app.request("/v1/admin/agents", { headers: { authorization: "Bearer wrong" } });
    expect(res.status).toBe(401);
  });

  it("accepts the configured admin token", async () => {
    const { app, config } = buildApi();
    const res = await app.request("/v1/admin/agents", { headers: { authorization: `Bearer ${config.adminToken}` } });
    expect(res.status).toBe(200);
  });
});

describe("admin API — agents", () => {
  it("creates, lists, gets, patches and rerenders an agent", async () => {
    const { app, config } = buildApi();
    const auth = { authorization: `Bearer ${config.adminToken}` };

    const createRes = await app.request("/v1/admin/agents", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ id: "sdr-01", role: "sales-sdr", displayName: "Mai" }),
    });
    expect(createRes.status).toBe(200);
    const created = await json<{ ok: true; data: { agent: { id: string } } }>(createRes);
    expect(created.data.agent.id).toBe("sdr-01");

    const listRes = await app.request("/v1/admin/agents", { headers: auth });
    const list = await json<{ ok: true; data: { agents: { id: string }[] } }>(listRes);
    expect(list.data.agents.map((a) => a.id)).toEqual(["sdr-01"]);

    const getRes = await app.request("/v1/admin/agents/sdr-01", { headers: auth });
    expect(getRes.status).toBe(200);

    const patchRes = await app.request("/v1/admin/agents/sdr-01", {
      method: "PATCH",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ status: "paused" }),
    });
    const patched = await json<{ ok: true; data: { agent: { status: string } } }>(patchRes);
    expect(patched.data.agent.status).toBe("paused");

    const rerenderRes = await app.request("/v1/admin/agents/sdr-01/rerender", { method: "POST", headers: auth });
    expect(rerenderRes.status).toBe(200);

    const missingRes = await app.request("/v1/admin/agents/nope", { headers: auth });
    expect(missingRes.status).toBe(404);
  });
});

describe("admin API — tasks", () => {
  it("creates a task, lists it, gets it with audit trail, cancels it, and rejects invalid retries", async () => {
    const { app, config } = buildApi();
    const auth = { authorization: `Bearer ${config.adminToken}` };

    await app.request("/v1/admin/agents", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ id: "sdr-01", role: "sales-sdr", displayName: "Mai" }),
    });

    const createRes = await app.request("/v1/admin/tasks", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ agentId: "sdr-01", kind: "sdr.research_lead", title: "Research" }),
    });
    const created = await json<{ ok: true; data: { task: { id: string; status: string } } }>(createRes);
    expect(created.data.task.status).toBe("queued");
    const id = created.data.task.id;

    const getRes = await app.request(`/v1/admin/tasks/${id}`, { headers: auth });
    const got = await json<{ ok: true; data: { task: unknown; audit: unknown[] } }>(getRes);
    expect(got.data.audit.length).toBeGreaterThan(0);

    const retryBeforeRes = await app.request(`/v1/admin/tasks/${id}/retry`, { method: "POST", headers: auth });
    expect(retryBeforeRes.status).toBe(409); // queued -> queued is not a valid transition

    const cancelRes = await app.request(`/v1/admin/tasks/${id}/cancel`, { method: "POST", headers: auth });
    expect(cancelRes.status).toBe(200);

    const listRes = await app.request(`/v1/admin/tasks?agentId=sdr-01&status=cancelled`, { headers: auth });
    const list = await json<{ ok: true; data: { tasks: { id: string }[] } }>(listRes);
    expect(list.data.tasks.map((t) => t.id)).toEqual([id]);
  });

  it("resolves a task waiting for a human: resume with guidance, or mark done", async () => {
    const { app, config, db } = buildApi();
    const auth = { authorization: `Bearer ${config.adminToken}`, "content-type": "application/json" };
    await app.request("/v1/admin/agents", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ id: "sdr-01", role: "sales-sdr", displayName: "Mai" }),
    });

    // Simulate the orchestrator: claimed, then the agent finished with needs_human.
    const handBack = () => {
      const task = db.tasks.create({ agentId: "sdr-01", kind: "sdr.research_lead", title: "Research", input: { contactName: "Tam" } });
      db.tasks.transition(task.id, "running");
      db.tasks.transition(task.id, "waiting_approval", {
        result: { status: "needs_human", summary: "Not enough info to qualify.", followUp: null, data: { fit: "fail" } },
      });
      return task.id;
    };

    const id = handBack();
    const emptyRes = await app.request(`/v1/admin/tasks/${id}/resume`, { method: "POST", headers: auth, body: JSON.stringify({ guidance: "  " }) });
    expect(emptyRes.status).toBe(400);

    const resumeRes = await app.request(`/v1/admin/tasks/${id}/resume`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ guidance: "Individual asking about invoices; treat as a fit." }),
    });
    expect(resumeRes.status).toBe(200);
    const resumed = db.tasks.get(id)!;
    expect(resumed.status).toBe("queued");
    expect(resumed.attempts).toBe(0);
    expect(resumed.input).toEqual({
      contactName: "Tam",
      humanGuidance: "Individual asking about invoices; treat as a fit.",
      previousSummary: "Not enough info to qualify.",
    });

    // Only a waiting_approval task can be resumed / completed.
    const againRes = await app.request(`/v1/admin/tasks/${id}/resume`, { method: "POST", headers: auth, body: JSON.stringify({ guidance: "x" }) });
    expect(againRes.status).toBe(409);
    const completeQueuedRes = await app.request(`/v1/admin/tasks/${id}/complete`, { method: "POST", headers: auth, body: "{}" });
    expect(completeQueuedRes.status).toBe(409);

    const id2 = handBack();
    const completeRes = await app.request(`/v1/admin/tasks/${id2}/complete`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ note: "Replied to them myself." }),
    });
    expect(completeRes.status).toBe(200);
    const done = db.tasks.get(id2)!;
    expect(done.status).toBe("done");
    expect(done.result?.summary).toBe("Replied to them myself.");
    expect(done.result?.data).toMatchObject({ fit: "fail", resolvedBy: "admin", agentSummary: "Not enough info to qualify." });
  });

  it("creates a follow-up task from a finished task, carrying the guidance", async () => {
    const { app, config, db } = buildApi();
    const auth = { authorization: `Bearer ${config.adminToken}`, "content-type": "application/json" };
    await app.request("/v1/admin/agents", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ id: "sdr-01", role: "sales-sdr", displayName: "Mai" }),
    });
    const parent = db.tasks.create({
      agentId: "sdr-01",
      kind: "sdr.research_lead",
      title: "Research Tam",
      input: { contactName: "Tam" },
      threadKey: "contact:tam@example.com",
    });

    const tooEarly = await app.request(`/v1/admin/tasks/${parent.id}/follow-up`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ guidance: "Reply to them." }),
    });
    expect(tooEarly.status).toBe(409); // still queued

    db.tasks.transition(parent.id, "running");
    db.tasks.transition(parent.id, "done", {
      result: { status: "done", summary: "Disqualified: single XML download.", followUp: null },
    });
    const res = await app.request(`/v1/admin/tasks/${parent.id}/follow-up`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ guidance: "Reply to them." }),
    });
    expect(res.status).toBe(200);
    const { data } = await json<{ ok: true; data: { task: { id: string } } }>(res);
    const child = db.tasks.get(data.task.id)!;
    expect(child).toMatchObject({
      agentId: "sdr-01",
      kind: "sdr.research_lead",
      title: "Follow-up: Research Tam",
      status: "queued",
      parentTaskId: parent.id,
      threadKey: "contact:tam@example.com",
      input: { contactName: "Tam", humanGuidance: "Reply to them.", previousSummary: "Disqualified: single XML download." },
    });
  });

  it("rejects a task for a non-existent agent", async () => {
    const { app, config } = buildApi();
    const auth = { authorization: `Bearer ${config.adminToken}` };
    const res = await app.request("/v1/admin/tasks", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ agentId: "nope", kind: "sdr.research_lead", title: "x" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("admin API — outbox / memory / contacts / kb / quota", () => {
  it("outbox approve/reject and contacts create/list round-trip", async () => {
    const { app, config, db } = buildApi();
    const auth = { authorization: `Bearer ${config.adminToken}` };

    await app.request("/v1/admin/agents", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ id: "sdr-01", role: "sales-sdr", displayName: "Mai", trustTier: "assisted" }),
    });
    const draft = db.outbox.createDraft({ agentId: "sdr-01", channel: "email", to: "lan@example.com", body: "hi", reason: "first touch" });

    const approveRes = await app.request(`/v1/admin/outbox/${draft.id}/approve`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ reviewer: "ops" }),
    });
    const approved = await json<{ ok: true; data: { item: { status: string; decidedBy: string | null } } }>(approveRes);
    expect(approved.data.item.status).toBe("approved");
    expect(approved.data.item.decidedBy).toBe("human:ops");

    const contactRes = await app.request("/v1/admin/contacts", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ email: "lan@example.com", name: "Lan Nguyen" }),
    });
    const contact = await json<{ ok: true; data: { contact: { id: string }; created: boolean } }>(contactRes);
    expect(contact.data.created).toBe(true);

    const listRes = await app.request("/v1/admin/contacts", { headers: auth });
    const list = await json<{ ok: true; data: { contacts: { email: string | null }[] } }>(listRes);
    expect(list.data.contacts.some((c) => c.email === "lan@example.com")).toBe(true);
  });

  it("memory list defaults to pending and accept/reject update status", async () => {
    const { app, config, db } = buildApi();
    const auth = { authorization: `Bearer ${config.adminToken}` };
    db.agents.create({ id: "sdr-01", role: "sales-sdr", displayName: "Mai", model: "m", workspacePath: "/tmp/x", policy: { builtins: [], mcp: [] } });
    const mem = db.memory.propose("sdr-01", "prefers Vietnamese", "contact:lan@example.com");

    const listRes = await app.request("/v1/admin/memory?agentId=sdr-01", { headers: auth });
    const list = await json<{ ok: true; data: { items: { id: string }[] } }>(listRes);
    expect(list.data.items.map((i) => i.id)).toEqual([mem.id]);

    const acceptRes = await app.request(`/v1/admin/memory/${mem.id}/accept`, { method: "POST", headers: auth });
    const accepted = await json<{ ok: true; data: { item: { status: string } } }>(acceptRes);
    expect(accepted.data.item.status).toBe("accepted");
  });

  it("kb sync and search work end to end", async () => {
    const { app, config } = buildApi();
    const auth = { authorization: `Bearer ${config.adminToken}` };
    const syncRes = await app.request("/v1/admin/kb/sync", { method: "POST", headers: auth });
    expect(syncRes.status).toBe(200);

    const searchRes = await app.request(`/v1/admin/kb/search?query=ICP&scopes=${encodeURIComponent("role:sales-sdr")}`, { headers: auth });
    expect(searchRes.status).toBe(200);
  });

  it("quota returns null before any snapshot has been recorded", async () => {
    const { app, config } = buildApi();
    const auth = { authorization: `Bearer ${config.adminToken}` };
    const res = await app.request("/v1/admin/quota", { headers: auth });
    const body = await json<{ ok: true; data: unknown }>(res);
    expect(body.data).toBeNull();
  });
});

describe("admin API — events (SSE)", () => {
  it("streams bus events as they're emitted", async () => {
    const { app, config, bus } = buildApi();
    const auth = { authorization: `Bearer ${config.adminToken}` };
    const res = await app.request("/v1/admin/events", { headers: auth });
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    // Drain the initial ": connected" comment.
    const first = await reader.read();
    expect(decoder.decode(first.value)).toContain("connected");

    bus.emit("task.created", { taskId: "tsk_123" });
    const second = await reader.read();
    const text = decoder.decode(second.value);
    expect(text).toContain("task.created");
    expect(text).toContain("tsk_123");

    await reader.cancel();
  });
});
