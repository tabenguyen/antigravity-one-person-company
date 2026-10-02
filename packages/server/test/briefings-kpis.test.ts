import { describe, expect, it } from "vitest";
import type { Task, TaskResult } from "@agyhq/core";
import { createAdminApi } from "../src/admin-api.ts";
import { storeBriefingFromTask } from "../src/briefings.ts";
import { EventBus } from "../src/event-bus.ts";
import { computeKpis } from "../src/kpis.ts";
import type { KpiReport } from "../src/admin-types.ts";
import { addAgent, makePhase4Env } from "./phase4-helpers.ts";

const DIGEST: TaskResult = { status: "done", summary: "ok", data: { digestMarkdown: "# Bản tin\n\n- Cần xử lý: 2 bản nháp" } };

function setup() {
  const env = makePhase4Env();
  addAgent(env.db, "cos-01", "chief-of-staff");
  const bus = new EventBus();
  const events: { type: string; data: Record<string, unknown> }[] = [];
  bus.subscribe((e) => events.push({ type: e.type, data: e.data }));
  const digestTask = (input: Record<string, unknown> = { periodStart: "2026-10-01T01:00:00.000Z", periodEnd: "2026-10-02T01:00:00.000Z" }): Task =>
    env.db.tasks.create({ agentId: "cos-01", kind: "cos.daily_digest", title: "Daily digest", input });
  const app = createAdminApi({ config: env.config, db: env.db, bus });
  const get = async <T = any>(path: string) => {
    const res = await app.request(path, { headers: { authorization: `Bearer ${env.config.adminToken}` } });
    return { status: res.status, body: (await res.json()) as { ok: boolean; data?: T; error?: { code: string; message: string } } };
  };
  return { ...env, bus, events, digestTask, app, get };
}

describe("storeBriefingFromTask", () => {
  it("stores a briefing from a done cos.daily_digest with digestMarkdown, audits and emits", () => {
    const t = setup();
    const task = t.digestTask();
    const b = storeBriefingFromTask(t.db, t.bus, task, DIGEST)!;
    expect(b).toMatchObject({ agentId: "cos-01", taskId: task.id, periodStart: "2026-10-01T01:00:00.000Z", periodEnd: "2026-10-02T01:00:00.000Z", markdown: "# Bản tin\n\n- Cần xử lý: 2 bản nháp" });
    expect(t.db.briefings.list()).toHaveLength(1);
    expect(t.db.audit.list({ kind: ["briefing.created"] })[0]).toMatchObject({ agentId: "cos-01", taskId: task.id });
    expect(t.events).toContainEqual({ type: "briefing.created", data: { briefingId: b.id, agentId: "cos-01", taskId: task.id } });
  });

  it("is idempotent per task and falls back to the task's own times when the input has none", () => {
    const t = setup();
    const task = t.digestTask({});
    const first = storeBriefingFromTask(t.db, t.bus, task, DIGEST)!;
    expect(first.periodStart).toBe(task.createdAt);
    expect(storeBriefingFromTask(t.db, t.bus, task, DIGEST)!.id).toBe(first.id);
    expect(t.db.briefings.list()).toHaveLength(1);
  });

  it.each<[string, TaskResult]>([
    ["needs_human", { status: "needs_human", summary: "x", data: { digestMarkdown: "# x" } }],
    ["failed", { status: "failed", summary: "x" }],
    ["no digestMarkdown", { status: "done", summary: "x", data: {} }],
    ["blank digestMarkdown", { status: "done", summary: "x", data: { digestMarkdown: "   " } }],
    ["non-string digestMarkdown", { status: "done", summary: "x", data: { digestMarkdown: 42 } }],
  ])("stores nothing for %s", (_name, result) => {
    const t = setup();
    expect(storeBriefingFromTask(t.db, t.bus, t.digestTask(), result)).toBeNull();
    expect(t.db.briefings.list()).toHaveLength(0);
  });

  it("ignores other task kinds", () => {
    const t = setup();
    const other = t.db.tasks.create({ agentId: "cos-01", kind: "cos.triage", title: "t" });
    expect(storeBriefingFromTask(t.db, t.bus, other, DIGEST)).toBeNull();
  });
});

describe("briefing routes", () => {
  it("lists latest first with limit, fetches one, 404s unknown ids and needs auth", async () => {
    const t = setup();
    const a = storeBriefingFromTask(t.db, t.bus, t.digestTask(), DIGEST)!;
    const b = storeBriefingFromTask(t.db, t.bus, t.digestTask(), { ...DIGEST, data: { digestMarkdown: "# second" } })!;
    expect((await t.get<{ briefings: { id: string }[] }>("/v1/admin/briefings")).body.data!.briefings.map((x) => x.id)).toEqual([b.id, a.id]);
    expect((await t.get<{ briefings: unknown[] }>("/v1/admin/briefings?limit=1")).body.data!.briefings).toHaveLength(1);
    expect((await t.get("/v1/admin/briefings?limit=zero")).status).toBe(400);
    expect((await t.get<{ briefing: { markdown: string } }>(`/v1/admin/briefings/${a.id}`)).body.data!.briefing.markdown).toContain("Bản tin");
    expect((await t.get("/v1/admin/briefings/nope")).status).toBe(404);
    expect((await t.app.request("/v1/admin/briefings")).status).toBe(401);
  });
});

describe("KPIs", () => {
  it("with no data: counts are 0 and every rate / median is null (never a fake 0)", async () => {
    const t = setup();
    const { status, body } = await t.get<KpiReport>("/v1/admin/kpis");
    expect(status).toBe(200);
    const k = body.data!;
    expect(k.windowDays).toBe(7);
    expect(k.roles["sales-sdr"]).toEqual({ agents: 0, leadsResearched: 0, firstTouchDrafted: 0, emailsSent: 0, replies: 0, replyRate: null, qualified: 0, meetingsBooked: 0, handoffs: 0 });
    expect(k.roles["account-manager"]).toEqual({ agents: 0, accounts: 0, messagesHandled: 0, medianFirstResponseMinutes: null, escalations: 0, checkInsDrafted: 0, churned: 0 });
    expect(k.roles["chief-of-staff"]).toEqual({ agents: 1, triaged: 0, delegated: 0, escalated: 0, digests: 0 });
    expect(k.common).toEqual({ tasksDone: 0, tasksFailed: 0, needsHuman: 0, approvalRate: null, medianEditRatio: null });
  });

  it("validates ?days", async () => {
    const t = setup();
    expect((await t.get("/v1/admin/kpis?days=30")).body.data).toMatchObject({ windowDays: 30 });
    for (const bad of ["0", "366", "abc", "1.5"]) expect((await t.get(`/v1/admin/kpis?days=${bad}`)).status).toBe(400);
  });

  it("computes per-role numbers from real rows", () => {
    const t = setup();
    const { db } = t;
    addAgent(db, "sdr-01", "sales-sdr");
    addAgent(db, "am-01", "account-manager");
    const now = new Date();
    const done = (agentId: string, kind: string, data?: Record<string, unknown>, to: "done" | "failed" | "waiting_approval" = "done") => {
      const task = db.tasks.create({ agentId, kind, title: kind });
      db.tasks.transition(task.id, "running");
      db.tasks.transition(task.id, to, { result: { status: to === "done" ? "done" : "needs_human", summary: "s", data } });
      return task;
    };

    // SDR: two researched, one first-touch draft sent, one reply, one stage change each
    done("sdr-01", "sdr.research_lead");
    done("sdr-01", "sdr.research_lead");
    const ft = done("sdr-01", "sdr.first_touch");
    const sentDraft = db.outbox.createDraft({ agentId: "sdr-01", taskId: ft.id, channel: "email", to: "lan@acme.com", subject: "s", body: "hello there friend", reason: "r", threadKey: "contact:lan@acme.com" });
    db.outbox.decide(sentDraft.id, "approved", { decidedBy: "human:admin", decidedAt: now.toISOString() });
    db.sqlite.prepare("UPDATE outbox SET status = 'sent', sent_at = ? WHERE id = ?").run(now.toISOString(), sentDraft.id);
    const replyTask = done("sdr-01", "sdr.handle_reply");
    db.inbound.insertIfNew({ source: "email", externalId: "r1", fromAddress: "lan@acme.com", bodyText: "yes", classification: "reply", payload: {}, routedTaskId: replyTask.id });
    const { contact: lan } = db.crm.upsertContact({ email: "lan@acme.com" });
    db.crm.setStage(lan.id, "qualified", "bant");
    db.crm.setStage(lan.id, "meeting_booked", "booked");
    db.audit.append({ kind: "contact.handoff", agentId: "sdr-01", taskId: null, conversationId: null, data: {} });

    // AM: a customer message answered 30 minutes after it arrived, one escalation, one check-in draft, one churn
    const { contact: cust } = db.crm.upsertContact({ email: "cust@acme.com" });
    db.crm.setStage(cust.id, "customer", "won");
    const { contact: gone } = db.crm.upsertContact({ email: "gone@acme.com" });
    db.crm.setStage(gone.id, "churned", "cancelled");
    const msg = done("am-01", "am.handle_message", undefined, "done");
    const received = new Date(now.getTime() - 30 * 60_000).toISOString();
    db.inbound.insertIfNew({ source: "email", externalId: "c1", fromAddress: "cust@acme.com", bodyText: "q", classification: "reply", payload: {}, routedTaskId: msg.id, receivedAt: received });
    const answer = db.outbox.createDraft({ agentId: "am-01", taskId: msg.id, channel: "email", to: "cust@acme.com", subject: "Re", body: "answer", reason: "r" });
    db.sqlite.prepare("UPDATE outbox SET status = 'sent', sent_at = ?, decided_by = 'human:admin' WHERE id = ?").run(now.toISOString(), answer.id);
    done("am-01", "am.handle_message", undefined, "waiting_approval"); // escalation
    const ci = done("am-01", "am.check_in");
    db.outbox.createDraft({ agentId: "am-01", taskId: ci.id, channel: "email", to: "cust@acme.com", subject: "Hi", body: "check in", reason: "r" });
    const rejected = db.outbox.createDraft({ agentId: "am-01", taskId: ci.id, channel: "email", to: "cust@acme.com", subject: "Hi2", body: "no", reason: "r" });
    db.outbox.decide(rejected.id, "rejected", { decidedBy: "human:admin", decidedAt: now.toISOString(), rejectionCategory: "tone" });

    // CoS: delegated, escalated, no_action
    done("cos-01", "cos.triage", { decision: { action: "delegated", assigneeAgentId: "sdr-01" } });
    done("cos-01", "cos.triage", { decision: { action: "no_action" } });
    done("cos-01", "cos.triage", { decision: { action: "needs_human" } }, "waiting_approval");
    storeBriefingFromTask(db, undefined, t.digestTask(), DIGEST);

    const k = computeKpis(db, 7, new Date(now.getTime() + 1000));
    expect(k.roles["sales-sdr"]).toMatchObject({ agents: 1, leadsResearched: 2, firstTouchDrafted: 1, emailsSent: 1, replies: 1, replyRate: 1, qualified: 1, meetingsBooked: 1, handoffs: 1 });
    expect(k.roles["account-manager"]).toMatchObject({ agents: 1, accounts: 1, messagesHandled: 1, escalations: 1, checkInsDrafted: 2, churned: 1 });
    expect(k.roles["account-manager"].medianFirstResponseMinutes).toBeCloseTo(30, 0);
    expect(k.roles["chief-of-staff"]).toEqual({ agents: 1, triaged: 3, delegated: 1, escalated: 1, digests: 1 });
    // approvals: sdr draft approved + am answer approved(sent w/ decidedBy) vs one human rejection
    expect(k.common).toMatchObject({ needsHuman: 2, approvalRate: 2 / 3 });
    expect(k.common.tasksFailed).toBe(0);
    expect(k.common.medianEditRatio).toBe(0);
  });

  it("only counts the window", () => {
    const t = setup();
    addAgent(t.db, "sdr-01", "sales-sdr");
    const task = t.db.tasks.create({ agentId: "sdr-01", kind: "sdr.research_lead", title: "old" });
    t.db.tasks.transition(task.id, "running");
    t.db.tasks.transition(task.id, "done", { result: { status: "done", summary: "s" } });
    t.db.sqlite.prepare("UPDATE tasks SET created_at = ? WHERE id = ?").run(new Date(Date.now() - 20 * 86_400_000).toISOString(), task.id);
    expect(computeKpis(t.db, 7).roles["sales-sdr"].leadsResearched).toBe(0);
    expect(computeKpis(t.db, 30).roles["sales-sdr"].leadsResearched).toBe(1);
  });
});

describe("settings: default AM / CoS", () => {
  async function patch(t: ReturnType<typeof setup>, body: unknown) {
    const res = await t.app.request("/v1/admin/settings", {
      method: "PATCH",
      headers: { authorization: `Bearer ${t.config.adminToken}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as { ok: boolean; data?: { settings: Record<string, unknown> }; error?: { message: string } } };
  }

  it("accepts an active agent of the right role (or null) and persists it", async () => {
    const t = setup();
    addAgent(t.db, "am-01", "account-manager");
    const ok = await patch(t, { defaultAmAgentId: "am-01", defaultCosAgentId: "cos-01" });
    expect(ok.status).toBe(200);
    expect(ok.body.data!.settings).toMatchObject({ defaultAmAgentId: "am-01", defaultCosAgentId: "cos-01" });
    expect(t.db.settings.get().defaultAmAgentId).toBe("am-01");
    expect((await patch(t, { defaultAmAgentId: null })).body.data!.settings["defaultAmAgentId"]).toBeNull();
  });

  it("rejects unknown agents, the wrong role and inactive agents", async () => {
    const t = setup();
    addAgent(t.db, "sdr-01", "sales-sdr");
    addAgent(t.db, "am-02", "account-manager", "paused");
    expect((await patch(t, { defaultAmAgentId: "ghost" })).body.error!.message).toMatch(/not found/);
    expect((await patch(t, { defaultAmAgentId: "sdr-01" })).body.error!.message).toMatch(/account-manager/);
    expect((await patch(t, { defaultCosAgentId: "sdr-01" })).body.error!.message).toMatch(/chief-of-staff/);
    expect((await patch(t, { defaultAmAgentId: "am-02" })).body.error!.message).toMatch(/active/);
    expect(t.db.settings.get().defaultAmAgentId).toBeNull();
  });
});
