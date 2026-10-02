import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { FakeEmailProvider } from "@agyhq/channels";
import { createAdminApi, type AdminApiDeps } from "../src/admin-api.ts";
import { EventBus } from "../src/event-bus.ts";
import { makeTestConfig, makeTempDataDir, openTestDb } from "./helpers.ts";

function buildApi(overrides: Partial<AdminApiDeps> = {}, configOverrides: Parameters<typeof makeTestConfig>[0] = {}) {
  const config = makeTestConfig(configOverrides);
  const db = openTestDb();
  const bus = new EventBus();
  const app = createAdminApi({ config, db, bus, ...overrides });
  return { app, config, db, bus };
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function authHeaders(token: string) {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

describe("admin API — outbox lifecycle", () => {
  it("edit only while pending_approval, and is rejected with 409 afterward", async () => {
    const { app, config, db } = buildApi();
    db.agents.create({ id: "sdr-01", role: "sales-sdr", displayName: "Mai", model: "m", workspacePath: "/tmp/sdr-01", policy: { builtins: [], mcp: [] }, trustTier: "assisted" });
    const draft = db.outbox.createDraft({ agentId: "sdr-01", channel: "email", to: "a@x.com", subject: "s", body: "b", reason: "r" });

    const editRes = await app.request(`/v1/admin/outbox/${draft.id}`, {
      method: "PATCH",
      headers: authHeaders(config.adminToken),
      body: JSON.stringify({ body: "edited body" }),
    });
    const edited = await json<{ ok: true; data: { item: { body: string; editedByHuman: boolean } } }>(editRes);
    expect(edited.data.item.body).toBe("edited body");
    expect(edited.data.item.editedByHuman).toBe(true);

    await app.request(`/v1/admin/outbox/${draft.id}/approve`, { method: "POST", headers: authHeaders(config.adminToken), body: "{}" });

    const editAgainRes = await app.request(`/v1/admin/outbox/${draft.id}`, {
      method: "PATCH",
      headers: authHeaders(config.adminToken),
      body: JSON.stringify({ body: "too late" }),
    });
    expect(editAgainRes.status).toBe(409);
  });

  it("refuses to approve a draft whose lint has errors (e.g. a placeholder left by a human edit)", async () => {
    const { app, config, db } = buildApi();
    db.agents.create({ id: "sdr-01", role: "sales-sdr", displayName: "Mai", model: "m", workspacePath: "/tmp/sdr-01", policy: { builtins: [], mcp: [] }, trustTier: "assisted" });
    const draft = db.outbox.createDraft({ agentId: "sdr-01", channel: "email", to: "a@x.com", subject: "s", body: "Hi {{name}}", reason: "r" });
    db.outbox.setLint(draft.id, [{ code: "placeholder", severity: "error", message: "unfilled placeholder {{name}}" }]);

    const res = await app.request(`/v1/admin/outbox/${draft.id}/approve`, { method: "POST", headers: authHeaders(config.adminToken), body: "{}" });
    expect(res.status).toBe(409);
    expect(db.outbox.get(draft.id)?.status).toBe("pending_approval");

    db.outbox.setLint(draft.id, [{ code: "too_long", severity: "warn", message: "long" }]); // warnings don't block
    const ok = await app.request(`/v1/admin/outbox/${draft.id}/approve`, { method: "POST", headers: authHeaders(config.adminToken), body: "{}" });
    expect(ok.status).toBe(200);
  });

  it("approving a shadow-tier agent's draft parks it in held, never approved", async () => {
    const { app, config, db } = buildApi();
    db.agents.create({ id: "sdr-01", role: "sales-sdr", displayName: "Mai", model: "m", workspacePath: "/tmp/sdr-01", policy: { builtins: [], mcp: [] }, trustTier: "shadow" });
    const draft = db.outbox.createDraft({ agentId: "sdr-01", channel: "email", to: "a@x.com", subject: "s", body: "b", reason: "r" });

    const res = await app.request(`/v1/admin/outbox/${draft.id}/approve`, { method: "POST", headers: authHeaders(config.adminToken), body: "{}" });
    const body = await json<{ ok: true; data: { item: { status: string } } }>(res);
    expect(body.data.item.status).toBe("held");

    const auditKinds = db.audit.list({}).map((a) => a.kind);
    expect(auditKinds).toContain("outbox.held");
  });

  it("reject requires a reason and writes an accepted agent memory", async () => {
    const { app, config, db } = buildApi();
    db.agents.create({ id: "sdr-01", role: "sales-sdr", displayName: "Mai", model: "m", workspacePath: "/tmp/sdr-01", policy: { builtins: [], mcp: [] } });
    const draft = db.outbox.createDraft({ agentId: "sdr-01", channel: "email", to: "a@x.com", subject: "s", body: "b", reason: "r", threadKey: "contact:a@x.com" });

    const missingReasonRes = await app.request(`/v1/admin/outbox/${draft.id}/reject`, { method: "POST", headers: authHeaders(config.adminToken), body: "{}" });
    expect(missingReasonRes.status).toBe(400);

    const res = await app.request(`/v1/admin/outbox/${draft.id}/reject`, {
      method: "POST",
      headers: authHeaders(config.adminToken),
      body: JSON.stringify({ reason: "too pushy", reviewer: "ops" }),
    });
    const body = await json<{ ok: true; data: { item: { status: string; decisionNote: string | null } } }>(res);
    expect(body.data.item.status).toBe("rejected");
    expect(body.data.item.decisionNote).toBe("too pushy");

    const memories = db.memory.list("sdr-01", { subject: "contact:a@x.com" });
    expect(memories).toHaveLength(1);
    expect(memories[0]!.status).toBe("accepted");
    expect(memories[0]!.content).toContain("too pushy");
  });

  it("retry moves a failed item back to approved", async () => {
    const { app, config, db } = buildApi();
    db.agents.create({ id: "sdr-01", role: "sales-sdr", displayName: "Mai", model: "m", workspacePath: "/tmp/sdr-01", policy: { builtins: [], mcp: [] } });
    const draft = db.outbox.createDraft({ agentId: "sdr-01", channel: "email", to: "a@x.com", subject: "s", body: "b", reason: "r" });
    db.outbox.decide(draft.id, "approved");
    db.outbox.claimNextToSend();
    db.outbox.markTerminalFailure(draft.id, "smtp down");

    const res = await app.request(`/v1/admin/outbox/${draft.id}/retry`, { method: "POST", headers: { authorization: `Bearer ${config.adminToken}` } });
    const body = await json<{ ok: true; data: { item: { status: string } } }>(res);
    expect(body.data.item.status).toBe("approved");
  });
});

describe("admin API — inbound", () => {
  it("lists and gets inbound events", async () => {
    const { app, config, db } = buildApi();
    const { event } = db.inbound.insertIfNew({ source: "email", externalId: "m1", bodyText: "hi", classification: "new_lead" });

    const listRes = await app.request("/v1/admin/inbound", { headers: { authorization: `Bearer ${config.adminToken}` } });
    const list = await json<{ ok: true; data: { events: { id: string }[] } }>(listRes);
    expect(list.data.events.map((e) => e.id)).toEqual([event.id]);

    const getRes = await app.request(`/v1/admin/inbound/${event.id}`, { headers: { authorization: `Bearer ${config.adminToken}` } });
    expect(getRes.status).toBe(200);

    const missingRes = await app.request("/v1/admin/inbound/nope", { headers: { authorization: `Bearer ${config.adminToken}` } });
    expect(missingRes.status).toBe(404);
  });

  it("downloads a saved attachment as an octet-stream, 404 for unsaved or out-of-range ones", async () => {
    const { app, config, db } = buildApi();
    const { event } = db.inbound.insertIfNew({ source: "email", externalId: "m2", bodyText: "hi", classification: "reply" });
    fs.mkdirSync(path.join(config.dataDir, "attachments", event.id), { recursive: true });
    fs.writeFileSync(path.join(config.dataDir, "attachments", event.id, "01-hóa đơn.pdf"), "PDFDATA");
    db.inbound.patchPayload(event.id, {
      attachments: [
        { filename: "hóa đơn.pdf", contentType: "application/pdf", size: 7, file: `${event.id}/01-hóa đơn.pdf` },
        { filename: "x.png", contentType: "image/png", size: 1, file: null },
        { filename: "evil", contentType: "text/html", size: 1, file: "../secret.key" },
      ],
    });
    const get = (i: number) => app.request(`/v1/admin/inbound/${event.id}/attachments/${i}`, { headers: { authorization: `Bearer ${config.adminToken}` } });

    const res = await get(0);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("PDFDATA");
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toContain(`filename*=UTF-8''${encodeURIComponent("hóa đơn.pdf")}`);
    expect((await get(1)).status).toBe(404);
    expect((await get(2)).status).toBe(404);
    expect((await get(9)).status).toBe(404);

    const unauth = await app.request(`/v1/admin/inbound/${event.id}/attachments/0`);
    expect(unauth.status).toBe(401);
  });
});

describe("admin API — settings / killswitch / status", () => {
  it("gets and patches settings", async () => {
    const { app, config } = buildApi();
    const getRes = await app.request("/v1/admin/settings", { headers: { authorization: `Bearer ${config.adminToken}` } });
    const got = await json<{ ok: true; data: { settings: { outboundEnabled: boolean } } }>(getRes);
    expect(got.data.settings.outboundEnabled).toBe(false);

    const patchRes = await app.request("/v1/admin/settings", {
      method: "PATCH",
      headers: authHeaders(config.adminToken),
      body: JSON.stringify({ sendRatePerHour: 5 }),
    });
    const patched = await json<{ ok: true; data: { settings: { sendRatePerHour: number } } }>(patchRes);
    expect(patched.data.settings.sendRatePerHour).toBe(5);
  });

  it("rejects invalid settings patches without changing anything", async () => {
    const { app, config } = buildApi();
    for (const body of [
      { sendRatePerHour: -1 },
      { quietHours: { startHour: 21, endHour: 8, timezone: "Mars/Olympus" } },
      { sendRatePerHr: 5 }, // typo → unknown key
      { defaultSdrAgentId: "no-such-agent" },
    ]) {
      const res = await app.request("/v1/admin/settings", {
        method: "PATCH",
        headers: authHeaders(config.adminToken),
        body: JSON.stringify(body),
      });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    const getRes = await app.request("/v1/admin/settings", { headers: { authorization: `Bearer ${config.adminToken}` } });
    const got = await json<{ data: { settings: { sendRatePerHour: number; defaultSdrAgentId: string | null } } }>(getRes);
    expect(got.data.settings.sendRatePerHour).toBe(30);
    expect(got.data.settings.defaultSdrAgentId).toBeNull();
  });

  it("killswitch toggles outboundEnabled with a reason", async () => {
    const { app, config, db } = buildApi();
    const onRes = await app.request("/v1/admin/killswitch", {
      method: "POST",
      headers: authHeaders(config.adminToken),
      // force: the readiness gate (admin-readiness.ts) refuses a half-configured system; see readiness-routes.test.ts.
      body: JSON.stringify({ outboundEnabled: true, force: true }),
    });
    expect((await json<{ data: { settings: { outboundEnabled: boolean } } }>(onRes)).data.settings.outboundEnabled).toBe(true);

    const offRes = await app.request("/v1/admin/killswitch", {
      method: "POST",
      headers: authHeaders(config.adminToken),
      body: JSON.stringify({ outboundEnabled: false, reason: "incident" }),
    });
    const off = await json<{ data: { settings: { outboundEnabled: boolean; outboundDisabledReason: string | null } } }>(offRes);
    expect(off.data.settings.outboundEnabled).toBe(false);
    expect(off.data.settings.outboundDisabledReason).toBe("incident");

    const kinds = db.audit.list({}).map((a) => a.kind);
    expect(kinds.filter((k) => k === "settings.changed").length).toBeGreaterThanOrEqual(2);
  });

  it("status reports email provider health, version, and running counts", async () => {
    const provider = new FakeEmailProvider();
    const { app, config } = buildApi({ emailProvider: provider, runningTasks: () => 2, quotaThrottled: () => true });
    const res = await app.request("/v1/admin/status", { headers: { authorization: `Bearer ${config.adminToken}` } });
    const body = await json<{ ok: true; data: { status: { email: { ok: boolean }; runningTasks: number; quotaThrottled: boolean } } }>(res);
    expect(body.data.status.email.ok).toBe(true);
    expect(body.data.status.runningTasks).toBe(2);
    expect(body.data.status.quotaThrottled).toBe(true);
  });

  it("status explains why sending is impossible when no provider is configured", async () => {
    const { app, config } = buildApi({ emailProvider: null });
    const res = await app.request("/v1/admin/status", { headers: { authorization: `Bearer ${config.adminToken}` } });
    const body = await json<{ ok: true; data: { status: { email: { provider: string; ok: boolean; error: string | null } } } }>(res);
    expect(body.data.status.email.provider).toBe("none");
    expect(body.data.status.email.ok).toBe(false);
    expect(body.data.status.email.error).toMatch(/no email provider/);
  });
});

describe("admin API — stats", () => {
  it("returns per-agent stats and today's counters", async () => {
    const { app, config, db } = buildApi();
    db.agents.create({ id: "sdr-01", role: "sales-sdr", displayName: "Mai", model: "m", workspacePath: "/tmp/sdr-01", policy: { builtins: [], mcp: [] } });
    db.tasks.create({ agentId: "sdr-01", kind: "sdr.research_lead", title: "t" });

    const res = await app.request("/v1/admin/stats?days=7", { headers: { authorization: `Bearer ${config.adminToken}` } });
    const body = await json<{ ok: true; data: { agents: { agentId: string }[]; inboundToday: number; sentToday: number } }>(res);
    expect(body.data.agents.map((a) => a.agentId)).toContain("sdr-01");
    expect(typeof body.data.inboundToday).toBe("number");
    expect(typeof body.data.sentToday).toBe("number");
  });
});

describe("admin API — contact detail timeline", () => {
  it("combines notes, outbox, inbound and tasks into one chronological timeline", async () => {
    const { app, config, db } = buildApi();
    db.agents.create({ id: "sdr-01", role: "sales-sdr", displayName: "Mai", model: "m", workspacePath: "/tmp/sdr-01", policy: { builtins: [], mcp: [] } });
    const { contact } = db.crm.upsertContact({ email: "jane@acme.com", name: "Jane" });
    db.crm.addNote("contact", contact.id, "a note");
    db.outbox.createDraft({ agentId: "sdr-01", channel: "email", to: "jane@acme.com", subject: "s", body: "b", reason: "r" });
    db.inbound.insertIfNew({ source: "email", externalId: "e1", fromAddress: "jane@acme.com", bodyText: "hi", classification: "reply", contactId: contact.id });
    db.tasks.create({ agentId: "sdr-01", kind: "sdr.handle_reply", title: "t", threadKey: "contact:jane@acme.com" });

    const res = await app.request(`/v1/admin/contacts/${contact.id}`, { headers: { authorization: `Bearer ${config.adminToken}` } });
    const body = await json<{ ok: true; data: { timeline: { type: string }[] } }>(res);
    const types = body.data.timeline.map((t) => t.type).sort();
    expect(types).toEqual(["inbound", "note", "outbox", "task"]);
  });

  it("404s for an unknown contact", async () => {
    const { app, config } = buildApi();
    const res = await app.request("/v1/admin/contacts/nope", { headers: { authorization: `Bearer ${config.adminToken}` } });
    expect(res.status).toBe(404);
  });
});

describe("admin API — task transcript", () => {
  it("parses and simplifies a transcript_full.jsonl referenced by the latest hook.stop audit row", async () => {
    const { app, config, db } = buildApi();
    db.agents.create({ id: "sdr-01", role: "sales-sdr", displayName: "Mai", model: "m", workspacePath: "/tmp/sdr-01", policy: { builtins: [], mcp: [] } });
    const task = db.tasks.create({ agentId: "sdr-01", kind: "sdr.research_lead", title: "t" });

    const dataDir = makeTempDataDir();
    const transcriptPath = path.join(dataDir, "transcript_full.jsonl");
    const lines = [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2025-01-01T00:00:00Z", content: "do the task" },
      { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2025-01-01T00:00:01Z", content: "ok working on it", tool_calls: [{ name: "kb_search", args: { query: "pricing" } }] },
    ];
    fs.writeFileSync(transcriptPath, lines.map((l) => JSON.stringify(l)).join("\n"));
    db.audit.append({ kind: "hook.stop", agentId: "sdr-01", taskId: task.id, conversationId: "conv1", data: { transcriptPath, terminationReason: null } });

    const res = await app.request(`/v1/admin/tasks/${task.id}/transcript`, { headers: { authorization: `Bearer ${config.adminToken}` } });
    const body = await json<{ ok: true; data: { steps: { index: number; source: string; text: string }[]; transcriptPath: string } }>(res);
    expect(body.data.transcriptPath).toBe(transcriptPath);
    expect(body.data.steps).toHaveLength(2);
    expect(body.data.steps[0]!.text).toContain("do the task");
    expect(body.data.steps[1]!.text).toContain("kb_search");
  });

  it("returns an empty transcript when no hook.stop audit row exists yet", async () => {
    const { app, config, db } = buildApi();
    db.agents.create({ id: "sdr-01", role: "sales-sdr", displayName: "Mai", model: "m", workspacePath: "/tmp/sdr-01", policy: { builtins: [], mcp: [] } });
    const task = db.tasks.create({ agentId: "sdr-01", kind: "sdr.research_lead", title: "t" });
    const res = await app.request(`/v1/admin/tasks/${task.id}/transcript`, { headers: { authorization: `Bearer ${config.adminToken}` } });
    const body = await json<{ ok: true; data: { steps: unknown[]; transcriptPath: string | null } }>(res);
    expect(body.data.steps).toEqual([]);
    expect(body.data.transcriptPath).toBeNull();
  });
});

describe("admin API — kb docs/files", () => {
  it("put, list, get and delete a company kb file, rejecting path traversal", async () => {
    const dataDir = makeTempDataDir();
    const kbRoot = path.join(dataDir, "kb");
    fs.mkdirSync(kbRoot, { recursive: true });
    const { app, config } = buildApi({}, { dataDir, kbRoot });

    const putRes = await app.request("/v1/admin/kb/files", {
      method: "PUT",
      headers: authHeaders(config.adminToken),
      body: JSON.stringify({ scope: "company", relPath: "pricing.md", body: "# Pricing\n\nIt costs money." }),
    });
    expect(putRes.status).toBe(200);
    const put = await json<{ ok: true; data: { doc: { id: string; relPath: string } } }>(putRes);
    expect(put.data.doc.relPath).toBe("pricing.md");
    expect(fs.existsSync(path.join(kbRoot, "pricing.md"))).toBe(true);

    const listRes = await app.request("/v1/admin/kb/docs?scope=company", { headers: { authorization: `Bearer ${config.adminToken}` } });
    const list = await json<{ ok: true; data: { docs: { id: string; relPath: string | null }[] } }>(listRes);
    expect(list.data.docs.some((d) => d.relPath === "pricing.md")).toBe(true);

    const getRes = await app.request(`/v1/admin/kb/docs/${put.data.doc.id}`, { headers: { authorization: `Bearer ${config.adminToken}` } });
    const got = await json<{ ok: true; data: { doc: { body: string } } }>(getRes);
    expect(got.data.doc.body).toContain("It costs money");

    const traversalRes = await app.request("/v1/admin/kb/files", {
      method: "PUT",
      headers: authHeaders(config.adminToken),
      body: JSON.stringify({ scope: "company", relPath: "../../etc/evil.md", body: "pwned" }),
    });
    expect(traversalRes.status).toBe(400);

    const deleteRes = await app.request("/v1/admin/kb/files", {
      method: "DELETE",
      headers: authHeaders(config.adminToken),
      body: JSON.stringify({ scope: "company", relPath: "pricing.md" }),
    });
    expect(deleteRes.status).toBe(200);
    expect(fs.existsSync(path.join(kbRoot, "pricing.md"))).toBe(false);
  });

  it("rejects a relPath that doesn't match the required .md pattern before it ever reaches path resolution", async () => {
    const dataDir = makeTempDataDir();
    const kbRoot = path.join(dataDir, "kb");
    fs.mkdirSync(kbRoot, { recursive: true });
    const { app, config } = buildApi({}, { dataDir, kbRoot });

    const res = await app.request("/v1/admin/kb/files", {
      method: "PUT",
      headers: authHeaders(config.adminToken),
      body: JSON.stringify({ scope: "company", relPath: "/etc/passwd", body: "x" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("admin API — inbound webhook", () => {
  it("404s for an unknown source", async () => {
    const { app } = buildApi();
    const res = await app.request("/v1/inbound/webhook/nope", {
      method: "POST",
      headers: { "x-agyhq-webhook-secret": "whatever", "content-type": "application/json" },
      body: JSON.stringify({ email: "a@b.com" }),
    });
    expect(res.status).toBe(404);
  });

  it("401s on a wrong secret, accepts and routes a valid lead, and dedupes by externalId", async () => {
    const { app, db } = buildApi(
      {},
      { webhooks: { typeform: { secret: "shh" } } },
    );
    db.agents.create({ id: "sdr-01", role: "sales-sdr", displayName: "Mai", model: "m", workspacePath: "/tmp/sdr-01", policy: { builtins: [], mcp: [] } });
    db.settings.patch({ defaultSdrAgentId: "sdr-01" });

    const wrongRes = await app.request("/v1/inbound/webhook/typeform", {
      method: "POST",
      headers: { "x-agyhq-webhook-secret": "nope", "content-type": "application/json" },
      body: JSON.stringify({ email: "lead@biz.example", externalId: "ext-1" }),
    });
    expect(wrongRes.status).toBe(401);

    const okRes = await app.request("/v1/inbound/webhook/typeform", {
      method: "POST",
      headers: { "x-agyhq-webhook-secret": "shh", "content-type": "application/json" },
      body: JSON.stringify({ email: "lead@biz.example", name: "Lead", externalId: "ext-1" }),
    });
    expect(okRes.status).toBe(200);
    const body = await json<{ ok: true; data: { event: { classification: string; status: string } } }>(okRes);
    expect(body.data.event.classification).toBe("new_lead");
    expect(body.data.event.status).toBe("routed");

    const dupeRes = await app.request("/v1/inbound/webhook/typeform", {
      method: "POST",
      headers: { "x-agyhq-webhook-secret": "shh", "content-type": "application/json" },
      body: JSON.stringify({ email: "lead@biz.example", name: "Lead", externalId: "ext-1" }),
    });
    expect(dupeRes.status).toBe(200);
    expect(db.tasks.list({ agentId: "sdr-01" })).toHaveLength(1); // not routed twice
  });
});

describe("admin API — SSE access_token", () => {
  it("accepts ?access_token= on /v1/admin/events since EventSource can't set headers", async () => {
    const { app, config } = buildApi();
    const res = await app.request(`/v1/admin/events?access_token=${config.adminToken}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
  });

  it("still rejects a wrong access_token", async () => {
    const { app } = buildApi();
    const res = await app.request(`/v1/admin/events?access_token=wrong`);
    expect(res.status).toBe(401);
  });

  it("does not honor access_token on other admin routes (header still required)", async () => {
    const { app, config } = buildApi();
    const res = await app.request(`/v1/admin/agents?access_token=${config.adminToken}`);
    expect(res.status).toBe(401);
  });
});
