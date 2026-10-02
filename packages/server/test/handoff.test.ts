import { describe, expect, it } from "vitest";
import { mcpRoute, type Agent, type AgentRole, type ToolPolicy } from "@agyhq/core";
import { createAdminApi } from "../src/admin-api.ts";
import { createAgentApi, RunTokenRegistry } from "../src/agent-api/index.ts";
import { EventBus } from "../src/event-bus.ts";
import { roleRouting, roleTaskKinds } from "../src/routing.ts";
import { makePhase4Env } from "./phase4-helpers.ts";

const policy = (...tools: string[]): ToolPolicy => ({ builtins: [], mcp: tools.map((tool) => ({ server: "company", tool })) });

function setup(opts: { am?: boolean } = {}) {
  const env = makePhase4Env();
  const { db, config } = env;
  const bus = new EventBus();
  const events: { type: string; data: Record<string, unknown> }[] = [];
  bus.subscribe((e) => events.push({ type: e.type, data: e.data }));
  const mk = (id: string, role: AgentRole, p: ToolPolicy) =>
    db.agents.create({ id, role, displayName: id, model: "m", workspacePath: `/tmp/${id}`, policy: p });
  mk("sdr-01", "sales-sdr", policy("contact_handoff", "task_create", "kb_search", "crm_set_stage"));
  mk("sdr-02", "sales-sdr", policy("contact_handoff"));
  if (opts.am !== false) {
    mk("am-01", "account-manager", policy("task_create"));
    db.settings.patch({ defaultAmAgentId: "am-01" });
  }
  const tokens = new RunTokenRegistry();
  const agentApi = createAgentApi({
    db,
    tokens,
    emit: (type, data) => events.push({ type, data }),
    taskKindsFor: (a: Agent) => roleTaskKinds(config, a.role),
    followUpKindsFor: (a) => roleRouting(config, a?.role ?? "sales-sdr")?.followUpKinds ?? ["sdr.follow_up"],
  });
  const admin = createAdminApi({ config, db, bus });

  /** Call an MCP tool as `agentId`, running inside a fresh task of kind `taskKind`. */
  async function callTool(agentId: string, tool: Parameters<typeof mcpRoute>[0], body: unknown, taskKind = "sdr.handle_reply") {
    const task = db.tasks.create({ agentId, kind: taskKind, title: "t", threadKey: "contact:lan@acme.com" });
    const token = tokens.issue(agentId, task.id);
    const res = await agentApi.request(mcpRoute(tool), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "x-agyhq-agent-id": agentId, "x-agyhq-task-id": task.id, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { res, json: (await res.json()) as { ok: boolean; data?: any; error?: { code: string; message: string } }, task };
  }
  async function adminHandoff(contactId: string, body: unknown = { toRole: "account-manager", summary: "Won by phone" }) {
    const res = await admin.request(`/v1/admin/contacts/${contactId}/handoff`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.adminToken}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { res, json: (await res.json()) as { ok: boolean; data?: any; error?: { code: string; message: string } } };
  }
  function lead(stage: "new" | "qualified" | "meeting_booked" | "replied" | "contacted" | "customer" = "qualified", ownerAgentId = "sdr-01") {
    const { contact } = db.crm.upsertContact({ email: "lan@acme.com", name: "Lan", ownerAgentId, companyName: "Acme" });
    db.crm.setStage(contact.id, stage, "setup");
    return contact;
  }
  return { ...env, events, callTool, adminHandoff, lead };
}

describe("contact_handoff (agent tool)", () => {
  it("hands a qualified lead to the default AM in one go: owner, stage, note, onboarding task, audit, event", async () => {
    const t = setup();
    const contact = t.lead("qualified");
    const { res, json, task: callerTask } = await t.callTool("sdr-01", "contact_handoff", { contactId: contact.id, toRole: "account-manager", summary: "Signed order form; wants to start next week." });
    expect(res.status).toBe(200);
    expect(json.data).toMatchObject({ fromAgentId: "sdr-01", toAgentId: "am-01", contact: { ownerAgentId: "am-01", stage: "customer" } });

    const onboard = t.db.tasks.get(json.data.task.id)!;
    expect(onboard).toMatchObject({ agentId: "am-01", kind: "am.onboard", threadKey: "contact:lan@acme.com", createdByAgentId: "sdr-01", status: "queued" });
    expect(onboard.input).toEqual({
      contactId: contact.id,
      contactName: "Lan",
      contactEmail: "lan@acme.com",
      companyName: "Acme",
      handoffSummary: "Signed order form; wants to start next week.",
      fromAgentId: "sdr-01",
    });

    const notes = t.db.crm.listRecentNotes("contact", contact.id, 10).map((n) => n.body);
    expect(notes.some((n) => n.startsWith("Handed off from sdr-01 to am-01: Signed order form"))).toBe(true);
    const audit = t.db.audit.list({ kind: ["contact.handoff"] });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ agentId: "sdr-01", taskId: callerTask.id });
    expect(audit[0]!.data).toMatchObject({ contactId: contact.id, fromAgentId: "sdr-01", toAgentId: "am-01", onboardTaskId: onboard.id });
    expect(t.events.map((e) => e.type)).toContain("contact.handoff");
  });

  it("cancels the previous owner's queued follow-ups on the thread, and only those", async () => {
    const t = setup();
    const contact = t.lead("replied");
    const fu = t.db.tasks.create({ agentId: "sdr-01", kind: "sdr.follow_up", title: "fu", threadKey: "contact:lan@acme.com" });
    const waiting = t.db.tasks.create({ agentId: "sdr-01", kind: "sdr.follow_up", title: "fu2", threadKey: "contact:lan@acme.com", wakeAt: new Date(Date.now() + 86_400_000).toISOString() });
    const otherThread = t.db.tasks.create({ agentId: "sdr-01", kind: "sdr.follow_up", title: "other", threadKey: "contact:someone@else.com" });
    const research = t.db.tasks.create({ agentId: "sdr-01", kind: "sdr.research_lead", title: "r", threadKey: "contact:lan@acme.com" });
    const { res } = await t.callTool("sdr-01", "contact_handoff", { contactId: contact.id, toRole: "account-manager", summary: "won" });
    expect(res.status).toBe(200);
    expect(t.db.tasks.get(fu.id)!.status).toBe("cancelled");
    expect(t.db.tasks.get(waiting.id)!.status).toBe("cancelled");
    expect(t.db.tasks.get(otherThread.id)!.status).toBe("queued");
    expect(t.db.tasks.get(research.id)!.status).toBe("queued");
    expect(t.db.audit.list({ kind: ["contact.handoff"] })[0]!.data["cancelledTaskIds"]).toEqual(expect.arrayContaining([fu.id, waiting.id]));
  });

  it("is an invalid_request when no default Account Manager is set, and changes nothing", async () => {
    const t = setup({ am: false });
    const contact = t.lead("qualified");
    const { res, json } = await t.callTool("sdr-01", "contact_handoff", { contactId: contact.id, toRole: "account-manager", summary: "won" });
    expect(res.status).toBe(400);
    expect(json.error).toMatchObject({ code: "invalid_request" });
    expect(json.error!.message).toMatch(/default Account Manager/);
    expect(t.db.crm.getContact(contact.id)).toMatchObject({ stage: "qualified", ownerAgentId: "sdr-01" });
    expect(t.db.tasks.list({}).filter((x) => x.kind === "am.onboard")).toHaveLength(0);
  });

  it("is an invalid_request when the default AM is paused, or its template lacks am.onboard", async () => {
    const t = setup();
    const contact = t.lead("qualified");
    t.db.agents.setStatus("am-01", "paused");
    expect((await t.callTool("sdr-01", "contact_handoff", { contactId: contact.id, toRole: "account-manager", summary: "won" })).res.status).toBe(400);
    t.db.agents.setStatus("am-01", "active");
    // a role template without am.onboard
    const fs = await import("node:fs");
    const p = `${t.templatesRoot}/account-manager/template.json`;
    const tpl = JSON.parse(fs.readFileSync(p, "utf8"));
    tpl.taskKinds = tpl.taskKinds.filter((k: { kind: string }) => k.kind !== "am.onboard");
    tpl.routing = undefined;
    fs.writeFileSync(p, JSON.stringify(tpl));
    const { json } = await t.callTool("sdr-01", "contact_handoff", { contactId: contact.id, toRole: "account-manager", summary: "won" });
    expect(json.error!.message).toMatch(/am\.onboard/);
  });

  it.each(["new", "researching", "contacted", "nurture", "disqualified", "customer", "churned"] as const)("refuses an agent handoff from stage %s", async (stage) => {
    const t = setup();
    const contact = t.lead("qualified");
    t.db.sqlite.prepare("UPDATE contacts SET stage = ? WHERE id = ?").run(stage, contact.id);
    const { res, json } = await t.callTool("sdr-01", "contact_handoff", { contactId: contact.id, toRole: "account-manager", summary: "won" });
    expect(res.status).toBe(400);
    expect(json.error!.message).toMatch(/stage/);
    expect(t.db.crm.getContact(contact.id)!.ownerAgentId).toBe("sdr-01");
  });

  it("allows meeting_booked, and refuses an agent that does not own the contact", async () => {
    const t = setup();
    const contact = t.lead("meeting_booked");
    const other = await t.callTool("sdr-02", "contact_handoff", { contactId: contact.id, toRole: "account-manager", summary: "won" });
    expect(other.res.status).toBe(400);
    expect(other.json.error!.message).toMatch(/owned by "sdr-01"/);
    expect((await t.callTool("sdr-01", "contact_handoff", { contactId: contact.id, toRole: "account-manager", summary: "won" })).res.status).toBe(200);
  });

  it("an unowned contact can be handed off by the agent handling it (previous owner = the caller)", async () => {
    const t = setup();
    const { contact } = t.db.crm.upsertContact({ email: "lan@acme.com", name: "Lan" });
    t.db.crm.setStage(contact.id, "replied", "x");
    const { json } = await t.callTool("sdr-01", "contact_handoff", { contactId: contact.id, toRole: "account-manager", summary: "won" });
    expect(json.data.fromAgentId).toBe("sdr-01");
  });

  it("rejects an unknown contact, a wrong role and an empty summary", async () => {
    const t = setup();
    t.lead();
    expect((await t.callTool("sdr-01", "contact_handoff", { contactId: "nope", toRole: "account-manager", summary: "won" })).res.status).toBe(404);
    expect((await t.callTool("sdr-01", "contact_handoff", { contactId: "x", toRole: "chief-of-staff", summary: "won" })).res.status).toBe(400);
    expect((await t.callTool("sdr-01", "contact_handoff", { contactId: "x", toRole: "account-manager", summary: "  " })).res.status).toBe(400);
  });

  it("is denied for an agent whose policy lacks the tool", async () => {
    const t = setup();
    const contact = t.lead();
    const { res } = await t.callTool("am-01", "contact_handoff", { contactId: contact.id, toRole: "account-manager", summary: "won" }, "am.handle_message");
    expect(res.status).toBe(403);
  });
});

describe("POST /v1/admin/contacts/:id/handoff (human)", () => {
  it("hands off from any stage, with the human as actor", async () => {
    const t = setup();
    const contact = t.lead("contacted");
    const { res, json } = await t.adminHandoff(contact.id);
    expect(res.status).toBe(200);
    expect(json.data).toMatchObject({ toAgentId: "am-01", fromAgentId: "sdr-01", contact: { ownerAgentId: "am-01", stage: "customer" } });
    const task = t.db.tasks.get(json.data.task.id)!;
    expect(task).toMatchObject({ kind: "am.onboard", createdByAgentId: null });
    expect(task.input["handoffSummary"]).toBe("Won by phone");
    expect(t.db.audit.list({ kind: ["contact.handoff"] })[0]!.data["by"]).toBe("human");
  });

  it("summary is optional for a human", async () => {
    const t = setup();
    const contact = t.lead("new");
    const { res, json } = await t.adminHandoff(contact.id, {});
    expect(res.status).toBe(200);
    expect(t.db.tasks.get(json.data.task.id)!.input["handoffSummary"]).toBe("(no summary given)");
  });

  it("handing off to the current owner is a conflict (idempotent guard)", async () => {
    const t = setup();
    const contact = t.lead("qualified");
    expect((await t.adminHandoff(contact.id)).res.status).toBe(200);
    const again = await t.adminHandoff(contact.id);
    expect(again.res.status).toBe(409);
    expect(t.db.tasks.list({}).filter((x) => x.kind === "am.onboard")).toHaveLength(1);
  });

  it("404 for an unknown contact, 400 without a default AM", async () => {
    const t = setup({ am: false });
    expect((await t.adminHandoff("nope")).res.status).toBe(404);
    const contact = t.lead();
    expect((await t.adminHandoff(contact.id)).res.status).toBe(400);
  });

  it("requires the admin token", async () => {
    const t = setup();
    const admin = createAdminApi({ config: t.config, db: t.db, bus: new EventBus() });
    expect((await admin.request("/v1/admin/contacts/x/handoff", { method: "POST", body: "{}" })).status).toBe(401);
  });
});

describe("task_create: delegation by a Chief of Staff", () => {
  it("can assign a valid kind to any active agent, and refuses unknown kinds or inactive agents", async () => {
    const t = setup();
    t.db.agents.create({ id: "cos-01", role: "chief-of-staff", displayName: "cos", model: "m", workspacePath: "/tmp/cos", policy: policy("task_create") });
    t.db.agents.create({ id: "am-02", role: "account-manager", displayName: "am2", model: "m", workspacePath: "/tmp/am2", policy: policy("task_create") });
    t.db.agents.setStatus("am-02", "paused");
    const ok = await t.callTool("cos-01", "task_create", { kind: "am.handle_message", title: "Customer question", assigneeAgentId: "am-01", input: { contactEmail: "a@b.com" } }, "cos.triage");
    expect(ok.res.status).toBe(200);
    expect(t.db.tasks.get(ok.json.data.task.id)).toMatchObject({ agentId: "am-01", kind: "am.handle_message", createdByAgentId: "cos-01", parentTaskId: ok.task.id });
    const sdr = await t.callTool("cos-01", "task_create", { kind: "sdr.research_lead", title: "Lead", assigneeAgentId: "sdr-01" }, "cos.triage");
    expect(sdr.res.status).toBe(200);
    const wrongKind = await t.callTool("cos-01", "task_create", { kind: "sdr.research_lead", title: "Lead", assigneeAgentId: "am-01" }, "cos.triage");
    expect(wrongKind.res.status).toBe(400);
    const paused = await t.callTool("cos-01", "task_create", { kind: "am.check_in", title: "x", assigneeAgentId: "am-02" }, "cos.triage");
    expect(paused.res.status).toBe(400);
  });
});
