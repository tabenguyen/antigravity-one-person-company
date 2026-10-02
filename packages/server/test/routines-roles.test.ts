import { describe, expect, it } from "vitest";
import type { Routine, RoutineKind } from "@agyhq/core";
import { createAdminApi } from "../src/admin-api.ts";
import { EventBus } from "../src/event-bus.ts";
import { AccountReviewConfigZ, DailyDigestConfigZ, parseRoutineConfig } from "../src/routines/config.ts";
import { buildAccountSnapshot, buildDigestSnapshot, runRoutine } from "../src/routines/run.ts";
import { addAgent, makePhase4Env } from "./phase4-helpers.ts";

const NOW = new Date("2026-10-02T02:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

function setup() {
  const env = makePhase4Env();
  addAgent(env.db, "sdr-01", "sales-sdr");
  addAgent(env.db, "am-01", "account-manager");
  addAgent(env.db, "cos-01", "chief-of-staff");
  const routine = (agentId: string, kind: RoutineKind, config: Record<string, unknown> = {}): Routine =>
    env.db.routines.create({ agentId, kind, name: `${kind} r`, schedule: "0 9 * * *", timezone: "UTC", config, nextRunAt: NOW.toISOString() });
  const customer = (email: string, opts: { owner?: string; name?: string; company?: string; sentDaysAgo?: number; inboundDaysAgo?: number; stage?: string } = {}) => {
    const { contact } = env.db.crm.upsertContact({ email, name: opts.name ?? email.split("@")[0], ownerAgentId: opts.owner ?? "am-01", companyName: opts.company });
    env.db.sqlite.prepare("UPDATE contacts SET stage = ?, updated_at = ? WHERE id = ?").run(opts.stage ?? "customer", daysAgo(90), contact.id);
    if (opts.sentDaysAgo !== undefined) {
      const d = env.db.outbox.createDraft({ agentId: "am-01", channel: "email", to: email, subject: "s", body: "b", reason: "r", threadKey: `contact:${email}` });
      env.db.sqlite.prepare("UPDATE outbox SET status = 'sent', sent_at = ? WHERE id = ?").run(daysAgo(opts.sentDaysAgo), d.id);
    }
    if (opts.inboundDaysAgo !== undefined) {
      env.db.inbound.insertIfNew({ source: "email", externalId: `in-${email}`, fromAddress: email, bodyText: "hi", classification: "reply", payload: {}, receivedAt: daysAgo(opts.inboundDaysAgo) });
    }
    return contact;
  };
  return { ...env, routine, customer };
}

describe("routine config schemas", () => {
  it("account_review defaults and bounds", () => {
    expect(AccountReviewConfigZ.parse({})).toEqual({ maxAccounts: 40, staleAfterDays: 14 });
    expect(parseRoutineConfig("account_review", { maxAccounts: 200, staleAfterDays: 180 })).toEqual({ maxAccounts: 200, staleAfterDays: 180 });
    expect(() => parseRoutineConfig("account_review", { maxAccounts: 201 })).toThrow(/maxAccounts/);
    expect(() => parseRoutineConfig("account_review", { staleAfterDays: 0 })).toThrow(/staleAfterDays/);
    expect(() => parseRoutineConfig("account_review", { nope: 1 })).toThrow(/invalid account_review config/);
  });

  it("daily_digest defaults and bounds", () => {
    expect(DailyDigestConfigZ.parse({})).toEqual({ lookbackHours: 24 });
    expect(parseRoutineConfig("daily_digest", { lookbackHours: 168 })).toEqual({ lookbackHours: 168 });
    expect(() => parseRoutineConfig("daily_digest", { lookbackHours: 169 })).toThrow(/lookbackHours/);
    expect(() => parseRoutineConfig("daily_digest", { lookbackHours: 0 })).toThrow(/lookbackHours/);
  });

  it("existing kinds still validate", () => {
    expect(parseRoutineConfig("pipeline_review", {})).toEqual({ maxContacts: 40, staleAfterDays: 7 });
    expect(parseRoutineConfig("prospecting", {})).toEqual({ batchSize: 5, stages: ["new"] });
  });
});

describe("account_review routine", () => {
  it("snapshots the agent's own customers, most stale first, and queues am.account_review with reviewDate/staleAfterDays", () => {
    const t = setup();
    t.customer("fresh@acme.com", { sentDaysAgo: 2, company: "Fresh Co" });
    t.customer("stale@acme.com", { sentDaysAgo: 40, inboundDaysAgo: 30, company: "Stale Co" });
    t.customer("older@acme.com", { sentDaysAgo: 60 });
    t.customer("busy@acme.com", { sentDaysAgo: 50 });
    t.db.tasks.create({ agentId: "am-01", kind: "am.check_in", title: "ci", threadKey: "contact:busy@acme.com" });
    t.customer("other-owner@acme.com", { owner: "sdr-01", sentDaysAgo: 80 });
    t.customer("lead@acme.com", { stage: "contacted", sentDaysAgo: 80 });
    t.customer("optout@acme.com", { sentDaysAgo: 80 });
    t.db.crm.upsertContact({ email: "optout@acme.com", attributes: { optOut: true } });

    const outcome = runRoutine({ db: t.db, now: () => NOW }, t.routine("am-01", "account_review", { staleAfterDays: 14 }), { manual: false });
    expect(outcome.taskIds).toHaveLength(1);
    expect(outcome.result).toMatch(/4 accounts, 2 likely stale/);
    const task = t.db.tasks.get(outcome.taskIds[0]!)!;
    expect(task).toMatchObject({ agentId: "am-01", kind: "am.account_review", status: "queued" });
    expect(task.input).toMatchObject({ reviewDate: "2026-10-02", staleAfterDays: 14 });
    const accounts = task.input["accounts"] as ReturnType<typeof buildAccountSnapshot>;
    expect(accounts.map((a) => a.email)).toEqual(["older@acme.com", "stale@acme.com", "busy@acme.com", "fresh@acme.com"]);
    expect(accounts[1]).toMatchObject({ company: "Stale Co", stage: "customer", staleHint: true, daysSinceActivity: 30, openTasks: [] });
    expect(accounts[1]!.lastActivityAt).toBe(daysAgo(30)); // the newer of "we sent" (40d) and "they wrote" (30d)
    expect(accounts[2]).toMatchObject({ staleHint: false, openTasks: [{ kind: "am.check_in", status: "queued", wakeAt: null }] });
    expect(accounts[3]).toMatchObject({ staleHint: false, daysSinceActivity: 2 });
  });

  it("honours maxAccounts, skips while a review is still open, and does nothing without customers", () => {
    const t = setup();
    const r = t.routine("am-01", "account_review", { maxAccounts: 1 });
    expect(runRoutine({ db: t.db, now: () => NOW }, r, { manual: true })).toMatchObject({ taskIds: [], result: "no customer accounts to review" });
    t.customer("a@acme.com", { sentDaysAgo: 30 });
    t.customer("b@acme.com", { sentDaysAgo: 40 });
    const first = runRoutine({ db: t.db, now: () => NOW }, r, { manual: true });
    expect((t.db.tasks.get(first.taskIds[0]!)!.input["accounts"] as unknown[]).length).toBe(1);
    const again = runRoutine({ db: t.db, now: () => NOW }, r, { manual: true });
    expect(again.taskIds).toEqual([]);
    expect(again.result).toMatch(/still queued/);
  });

  it("with no activity on record, staleness counts from when the contact was last touched", () => {
    const t = setup();
    t.customer("quiet@acme.com");
    const [a] = buildAccountSnapshot(t.db, "am-01", NOW, 10, 14);
    expect(a).toMatchObject({ lastActivityAt: null, daysSinceActivity: 90, staleHint: true });
  });
});

describe("daily_digest routine", () => {
  it("queues cos.daily_digest with the period and a server-built snapshot", () => {
    const t = setup();
    // pending approval, failed task, needs-human task, new contact, handoff
    const draft = t.db.outbox.createDraft({ agentId: "sdr-01", channel: "email", to: "x@y.com", subject: "Hi", body: "b", reason: "r" });
    const failed = t.db.tasks.create({ agentId: "sdr-01", kind: "sdr.follow_up", title: "boom" });
    t.db.tasks.transition(failed.id, "running");
    t.db.tasks.transition(failed.id, "failed", { error: "run timed out" });
    const waiting = t.db.tasks.create({ agentId: "am-01", kind: "am.handle_message", title: "Refund?" });
    t.db.tasks.transition(waiting.id, "running");
    t.db.tasks.transition(waiting.id, "waiting_approval", { result: { status: "needs_human", summary: "Customer wants a refund" } });
    t.db.crm.upsertContact({ email: "new@acme.com", name: "New", companyName: "NewCo", source: "inbound-email" });
    t.db.audit.append({ kind: "contact.handoff", agentId: "sdr-01", taskId: null, conversationId: null, data: { contactId: "c1", email: "won@acme.com", fromAgentId: "sdr-01", toAgentId: "am-01", summary: "Signed" } });

    const real = new Date(); // rows above were stamped "now"
    const outcome = runRoutine({ db: t.db, now: () => real }, t.routine("cos-01", "daily_digest", { lookbackHours: 12 }), { manual: false });
    expect(outcome.taskIds).toHaveLength(1);
    const task = t.db.tasks.get(outcome.taskIds[0]!)!;
    expect(task).toMatchObject({ agentId: "cos-01", kind: "cos.daily_digest" });
    expect(task.input).toMatchObject({ periodEnd: real.toISOString(), periodStart: new Date(real.getTime() - 12 * 3_600_000).toISOString() });
    const s = task.input["snapshot"] as ReturnType<typeof buildDigestSnapshot>;
    expect(s.pendingApprovals).toMatchObject({ count: 1, oldestAt: draft.createdAt, items: [{ outboxId: draft.id, to: "x@y.com" }] });
    expect(s.failedTasks).toMatchObject({ count: 1, items: [{ taskId: failed.id, error: "run timed out" }] });
    expect(s.needsHuman).toMatchObject({ count: 1, items: [{ taskId: waiting.id, summary: "Customer wants a refund" }] });
    expect(s.newContacts).toMatchObject({ count: 1, items: [{ email: "new@acme.com", company: "NewCo", source: "inbound-email" }] });
    expect(s.handoffs).toMatchObject({ count: 1, items: [{ contactId: "c1", toAgentId: "am-01", summary: "Signed" }] });
    expect(s.kpis.windowDays).toBe(0.5);
    expect(s.kpis.common.tasksFailed).toBe(1);
  });

  it("skips while the previous digest is still open, and an empty day still produces a digest", () => {
    const t = setup();
    const r = t.routine("cos-01", "daily_digest");
    const first = runRoutine({ db: t.db, now: () => NOW }, r, { manual: true });
    const s = t.db.tasks.get(first.taskIds[0]!)!.input["snapshot"] as ReturnType<typeof buildDigestSnapshot>;
    expect(s.pendingApprovals).toEqual({ count: 0, oldestAt: null, items: [] });
    expect(s.kpis.common.approvalRate).toBeNull();
    expect(runRoutine({ db: t.db, now: () => NOW }, r, { manual: true }).result).toMatch(/still queued/);
  });
});

describe("routine routes accept the new kinds", () => {
  async function call(t: ReturnType<typeof setup>, body: Record<string, unknown>) {
    const app = createAdminApi({ config: t.config, db: t.db, bus: new EventBus() });
    const res = await app.request("/v1/admin/routines", {
      method: "POST",
      headers: { authorization: `Bearer ${t.config.adminToken}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "n", schedule: "0 9 * * *", timezone: "UTC", ...body }),
    });
    return { status: res.status, body: (await res.json()) as { ok: boolean; data?: { routine: Routine }; error?: { message: string } } };
  }

  it("creates account_review for an AM and daily_digest for a CoS, with normalized config", async () => {
    const t = setup();
    const am = await call(t, { agentId: "am-01", kind: "account_review", config: {} });
    expect(am.status).toBe(200);
    expect(am.body.data!.routine.config).toEqual({ maxAccounts: 40, staleAfterDays: 14 });
    const cos = await call(t, { agentId: "cos-01", kind: "daily_digest" });
    expect(cos.body.data!.routine.config).toEqual({ lookbackHours: 24 });
  });

  it("rejects a kind the agent's role does not define, and bad config", async () => {
    const t = setup();
    const wrong = await call(t, { agentId: "sdr-01", kind: "account_review" });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error!.message).toMatch(/am\.account_review.*sales-sdr/);
    expect((await call(t, { agentId: "cos-01", kind: "daily_digest", config: { lookbackHours: 500 } })).status).toBe(400);
  });
});
