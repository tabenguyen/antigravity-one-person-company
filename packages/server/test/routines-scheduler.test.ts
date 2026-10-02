import { afterEach, describe, expect, it } from "vitest";
import type { LeadStage } from "@agyhq/core";
import { createAgent } from "../src/provision.ts";
import { EventBus, type BusEvent } from "../src/event-bus.ts";
import { RoutineScheduler } from "../src/routines/scheduler.ts";
import { runRoutine } from "../src/routines/run.ts";
import { makeTestConfig, openTestDb, waitFor } from "./helpers.ts";

const HCM = "Asia/Ho_Chi_Minh";
// Thu 2026-10-01 08:00 +07 = 01:00Z ; weekdays 09:00 HCM = 02:00Z
const T0 = new Date("2026-10-01T01:00:00Z");
const NINE = "2026-10-01T02:00:00.000Z";

function setup() {
  const config = makeTestConfig();
  const db = openTestDb();
  const bus = new EventBus();
  const events: BusEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const agent = createAgent({ config, db }, { id: "sdr-01", role: "sales-sdr", displayName: "Mai" });
  const clock = { now: new Date(T0) };
  const scheduler = new RoutineScheduler({ db, bus, now: () => clock.now });
  return { config, db, bus, events, agent, clock, scheduler };
}

type Ctx = ReturnType<typeof setup>;

function addContact(c: Ctx, email: string, opts: { stage?: LeadStage; owner?: string | null; attributes?: Record<string, unknown>; name?: string; company?: string } = {}) {
  const { contact } = c.db.crm.upsertContact({
    email,
    name: opts.name ?? email.split("@")[0],
    ownerAgentId: opts.owner ?? undefined,
    attributes: opts.attributes,
    companyName: opts.company,
    companyDomain: opts.company ? `${opts.company.toLowerCase().replace(/\W/g, "")}.example` : undefined,
  });
  if (opts.stage && opts.stage !== "new") c.db.sqlite.prepare("UPDATE contacts SET stage = ? WHERE id = ?").run(opts.stage, contact.id);
  return contact;
}

function addRoutine(c: Ctx, kind: "prospecting" | "pipeline_review" | "custom_task", config: Record<string, unknown> = {}, nextRunAt = NINE) {
  return c.db.routines.create({
    agentId: c.agent.id,
    kind,
    name: `${kind} routine`,
    schedule: "0 9 * * 1-5",
    timezone: HCM,
    config,
    nextRunAt,
  });
}

describe("RoutineScheduler — prospecting", () => {
  const schedulers: RoutineScheduler[] = [];
  afterEach(() => schedulers.splice(0).forEach((s) => s.stop()));

  it("does nothing before a routine is due", () => {
    const c = setup();
    addRoutine(c, "prospecting");
    addContact(c, "a@x.example");
    expect(c.scheduler.tick()).toEqual([]);
    expect(c.db.tasks.list()).toHaveLength(0);
  });

  it("when due: queues research tasks for eligible contacts, sets owner, advances nextRunAt, audits and emits", () => {
    const c = setup();
    const r = addRoutine(c, "prospecting", { batchSize: 2 });
    addContact(c, "first@x.example", { name: "First One", company: "Alpha" });
    addContact(c, "second@x.example");
    addContact(c, "third@x.example");
    c.clock.now = new Date("2026-10-01T02:00:05Z");

    const [res] = c.scheduler.tick();
    expect(res).toMatchObject({ routineId: r.id, skipped: false });
    expect(res!.result).toBe("queued 2 research tasks (3 eligible)");

    const tasks = c.db.tasks.list({ agentId: "sdr-01" });
    expect(tasks).toHaveLength(2);
    // oldest contacts first
    expect(tasks.map((t) => t.input["contactEmail"]).sort()).toEqual(["first@x.example", "second@x.example"]);
    const first = tasks.find((t) => t.input["contactEmail"] === "first@x.example")!;
    expect(first).toMatchObject({ kind: "sdr.research_lead", priority: 1, threadKey: "contact:first@x.example", status: "queued" });
    expect(first.input).toMatchObject({ contactName: "First One", leadCompanyName: "Alpha", leadCompanyDomain: "alpha.example" });
    expect(String(first.input["context"])).toContain("prospecting");

    expect(c.db.crm.findContacts({ email: "first@x.example" })[0]).toMatchObject({ ownerAgentId: "sdr-01", stage: "researching" });
    expect(c.db.crm.findContacts({ email: "third@x.example" })[0]).toMatchObject({ ownerAgentId: null, stage: "new" });

    const after = c.db.routines.get(r.id)!;
    expect(after.lastRunAt).toBe("2026-10-01T02:00:05.000Z");
    expect(after.lastResult).toBe(res!.result);
    expect(after.nextRunAt).toBe("2026-10-02T02:00:00.000Z"); // Fri 09:00 HCM

    const audit = c.db.audit.list({ kind: ["routine.ran"] });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.data).toMatchObject({ routineId: r.id, manual: false, taskIds: expect.arrayContaining(tasks.map((t) => t.id)) });
    expect(c.events.find((e) => e.type === "routine.ran")?.data).toMatchObject({ routineId: r.id, skipped: false });
  });

  it("never picks opted-out, do-not-contact, bounced, other-agent-owned, wrong-stage or busy contacts", () => {
    const c = setup();
    createAgent({ config: c.config, db: c.db }, { id: "sdr-02", role: "sales-sdr", displayName: "Bao" });
    addRoutine(c, "prospecting", { batchSize: 25 });
    addContact(c, "good@x.example");
    addContact(c, "unowned-ok@x.example");
    addContact(c, "mine@x.example", { owner: "sdr-01" });
    addContact(c, "optout@x.example", { attributes: { optOut: true } });
    addContact(c, "dnc@x.example", { attributes: { doNotContact: true } });
    addContact(c, "bounced@x.example", { attributes: { emailBounced: true } });
    addContact(c, "theirs@x.example", { owner: "sdr-02" });
    addContact(c, "contacted@x.example", { stage: "contacted" });
    addContact(c, "busy@x.example");
    c.db.tasks.create({ agentId: "sdr-01", kind: "sdr.research_lead", title: "already on it", threadKey: "contact:busy@x.example" });
    addContact(c, "waiting@x.example");
    const waiting = c.db.tasks.create({ agentId: "sdr-01", kind: "sdr.handle_reply", title: "needs human", threadKey: "contact:waiting@x.example" });
    c.db.tasks.transition(waiting.id, "running");
    c.db.tasks.transition(waiting.id, "waiting_approval");
    addContact(c, "finished@x.example"); // a DONE task on its thread does not block
    const done = c.db.tasks.create({ agentId: "sdr-01", kind: "sdr.research_lead", title: "old", threadKey: "contact:finished@x.example" });
    c.db.tasks.transition(done.id, "running");
    c.db.tasks.transition(done.id, "done");

    c.clock.now = new Date("2026-10-01T02:00:05Z");
    const [res] = c.scheduler.tick();
    const queued = c.db.tasks.list({ agentId: "sdr-01" }).filter((t) => t.title !== "already on it" && t.title !== "needs human" && t.title !== "old");
    expect(queued.map((t) => t.input["contactEmail"]).sort()).toEqual(["finished@x.example", "good@x.example", "mine@x.example", "unowned-ok@x.example"]);
    expect(res!.result).toBe("queued 4 research tasks (4 eligible)");
    expect(c.db.crm.findContacts({ email: "unowned-ok@x.example" })[0]!.ownerAgentId).toBe("sdr-01");
    expect(c.db.crm.findContacts({ email: "theirs@x.example" })[0]!.ownerAgentId).toBe("sdr-02");
  });

  it("honours custom stages (e.g. nurture) and defaults batchSize to 5", () => {
    const c = setup();
    addRoutine(c, "prospecting", { stages: ["nurture"] });
    for (let i = 0; i < 7; i++) addContact(c, `n${i}@x.example`, { stage: "nurture" });
    addContact(c, "new@x.example");
    c.clock.now = new Date("2026-10-01T02:00:05Z");
    const [res] = c.scheduler.tick();
    expect(res!.result).toBe("queued 5 research tasks (7 eligible)");
    // nurture contacts keep their stage (only "new" moves to researching)
    expect(c.db.crm.findContacts({ email: "n0@x.example" })[0]!.stage).toBe("nurture");
  });

  it("never runs the same slot twice: repeated ticks, a restarted scheduler, and slow ticks all collapse to one run", () => {
    const c = setup();
    addRoutine(c, "prospecting", { batchSize: 1 });
    for (let i = 0; i < 4; i++) addContact(c, `p${i}@x.example`);
    c.clock.now = new Date("2026-10-01T02:00:05Z");
    expect(c.scheduler.tick()).toHaveLength(1);
    expect(c.scheduler.tick()).toHaveLength(0);
    // "restart": a brand new scheduler over the same db
    const restarted = new RoutineScheduler({ db: c.db, bus: c.bus, now: () => c.clock.now });
    restarted.reconcile();
    expect(restarted.tick()).toHaveLength(0);
    // still the same day, 5 hours later -> nothing
    c.clock.now = new Date("2026-10-01T07:00:00Z");
    expect(restarted.tick()).toHaveLength(0);
    expect(c.db.tasks.list()).toHaveLength(1);
    // next weekday slot -> exactly one more run
    c.clock.now = new Date("2026-10-02T02:00:30Z");
    expect(restarted.tick()).toHaveLength(1);
    expect(restarted.tick()).toHaveLength(0);
    expect(c.db.tasks.list()).toHaveLength(2);
    // Friday -> next is Monday (weekend skipped)
    expect(c.db.routines.list()[0]!.nextRunAt).toBe("2026-10-05T02:00:00.000Z");
  });

  it("a run that is hours late still runs (once); one missed by more than a day is skipped and recorded", () => {
    const c = setup();
    const late = addRoutine(c, "prospecting", { batchSize: 1 });
    addContact(c, "l@x.example");
    c.clock.now = new Date("2026-10-01T09:00:00Z"); // 7h late
    expect(c.scheduler.tick()[0]).toMatchObject({ routineId: late.id, skipped: false });
    expect(c.db.tasks.list()).toHaveLength(1);

    // now simulate a daemon that was down for 3 days
    const c2 = setup();
    const missed = addRoutine(c2, "prospecting", { batchSize: 1 });
    addContact(c2, "m@x.example");
    c2.clock.now = new Date("2026-10-04T05:00:00Z"); // Sun; due slot was Thu 02:00Z
    const [res] = c2.scheduler.tick();
    expect(res).toMatchObject({ routineId: missed.id, missed: true, skipped: true, taskIds: [] });
    expect(res!.result).toMatch(/^missed:/);
    expect(c2.db.tasks.list()).toHaveLength(0);
    const row = c2.db.routines.get(missed.id)!;
    expect(row.lastResult).toMatch(/^missed:/);
    expect(row.lastRunAt).toBeNull();
    expect(row.nextRunAt).toBe("2026-10-05T02:00:00.000Z"); // Monday 09:00 HCM
    expect(c2.db.audit.list({ kind: ["routine.ran"] })[0]!.data).toMatchObject({ missed: true });
    expect(c2.events.find((e) => e.type === "routine.ran")?.data).toMatchObject({ missed: true });
  });

  it("skips (with a recorded result) when the agent is paused or archived, and still advances the schedule", () => {
    const c = setup();
    const r = addRoutine(c, "prospecting");
    addContact(c, "p@x.example");
    c.db.agents.setStatus("sdr-01", "paused");
    c.clock.now = new Date("2026-10-01T02:00:05Z");
    const [res] = c.scheduler.tick();
    expect(res).toMatchObject({ skipped: true, taskIds: [] });
    expect(res!.result).toBe('skipped: agent "sdr-01" is paused');
    expect(c.db.tasks.list()).toHaveLength(0);
    expect(c.db.routines.get(r.id)).toMatchObject({ lastResult: res!.result, nextRunAt: "2026-10-02T02:00:00.000Z" });

    c.db.agents.setStatus("sdr-01", "archived");
    c.clock.now = new Date("2026-10-02T02:00:05Z");
    expect(c.scheduler.tick()[0]!.result).toBe('skipped: agent "sdr-01" is archived');

    c.db.agents.setStatus("sdr-01", "active");
    c.clock.now = new Date("2026-10-05T02:00:05Z");
    expect(c.scheduler.tick()[0]!.result).toBe("queued 1 research task (1 eligible)");
  });

  it("ignores disabled routines; reconcile() gives enabled ones without nextRunAt a schedule", () => {
    const c = setup();
    const off = c.db.routines.create({ agentId: "sdr-01", kind: "prospecting", name: "off", schedule: "0 9 * * *", timezone: HCM, enabled: false, nextRunAt: NINE });
    const noNext = c.db.routines.create({ agentId: "sdr-01", kind: "prospecting", name: "no next", schedule: "0 9 * * *", timezone: HCM, nextRunAt: null });
    c.clock.now = new Date("2026-10-01T03:00:00Z");
    c.scheduler.reconcile();
    expect(c.db.routines.get(noNext.id)!.nextRunAt).toBe("2026-10-02T02:00:00.000Z");
    expect(c.scheduler.tick()).toEqual([]);
    expect(c.db.routines.get(off.id)!.lastRunAt).toBeNull();
  });

  it("manual run executes regardless of schedule and leaves nextRunAt alone", () => {
    const c = setup();
    const r = addRoutine(c, "prospecting", { batchSize: 1 }, "2026-10-09T02:00:00.000Z");
    addContact(c, "m@x.example");
    const out = runRoutine({ db: c.db, bus: c.bus, now: () => c.clock.now }, r, { manual: true });
    expect(out.result).toBe("queued 1 research task (1 eligible)");
    expect(c.db.routines.get(r.id)).toMatchObject({ nextRunAt: "2026-10-09T02:00:00.000Z", lastRunAt: c.clock.now.toISOString() });
    expect(c.db.audit.list({ kind: ["routine.ran"] })[0]!.data).toMatchObject({ manual: true });
  });

  it("start() ticks on a timer; stop() halts it", async () => {
    const c = setup();
    const real = new RoutineScheduler({ db: c.db, bus: c.bus, tickMs: 20 });
    schedulers.push(real);
    c.db.routines.create({ agentId: "sdr-01", kind: "custom_task", name: "soon", schedule: "* * * * *", timezone: "UTC", nextRunAt: new Date(Date.now() - 1000).toISOString(), config: { kind: "sdr.follow_up", title: "t" } });
    real.start();
    await waitFor(() => c.db.tasks.list().length === 1, 2000);
    real.stop();
    expect(c.db.tasks.list()[0]).toMatchObject({ kind: "sdr.follow_up", title: "t" });
  });
});

describe("RoutineScheduler — pipeline_review and custom_task", () => {
  it("pipeline_review queues one sdr.pipeline_review task with a snapshot that flags stale leads, and skips while a previous one is open", () => {
    const c = setup();
    addRoutine(c, "pipeline_review");
    const stale = addContact(c, "stale@x.example", { stage: "contacted", owner: "sdr-01", name: "Stale Sam", company: "Alpha" });
    const covered = addContact(c, "covered@x.example", { stage: "contacted", owner: "sdr-01" });
    const replied = addContact(c, "replied@x.example", { stage: "contacted", owner: "sdr-01" });
    const fresh = addContact(c, "fresh@x.example", { stage: "contacted", owner: "sdr-01" });
    addContact(c, "optout@x.example", { stage: "contacted", owner: "sdr-01", attributes: { optOut: true } });
    addContact(c, "other@x.example", { stage: "contacted", owner: null });
    addContact(c, "newbie@x.example", { owner: "sdr-01" }); // stage new: not part of the pipeline

    const sentAt = (days: number) => new Date(c.clock.now.getTime() - days * 86_400_000).toISOString();
    for (const [email, days] of [["stale@x.example", 10], ["covered@x.example", 10], ["replied@x.example", 10], ["fresh@x.example", 2]] as const) {
      const d = c.db.outbox.createDraft({ agentId: "sdr-01", channel: "email", to: email, subject: "hi", body: "b", reason: "r" });
      c.db.sqlite.prepare("UPDATE outbox SET status='sent', sent_at=?, decided_at=? WHERE id=?").run(sentAt(days), sentAt(days), d.id);
    }
    c.db.tasks.create({ agentId: "sdr-01", kind: "sdr.follow_up", title: "scheduled", threadKey: "contact:covered@x.example", wakeAt: sentAt(-1) });
    c.db.sqlite
      .prepare(
        `INSERT INTO inbound_events (id, source, external_id, from_address, body_text, classification, status, received_at, created_at)
         VALUES ('ib1','email','e1','replied@x.example','thanks','reply','routed',?,?)`,
      )
      .run(sentAt(5), sentAt(5));
    void stale; void covered; void replied; void fresh;

    c.clock.now = new Date("2026-10-01T02:00:05Z");
    const [res] = c.scheduler.tick();
    expect(res!.result).toBe("queued pipeline review (4 contacts, 1 likely stale)");
    const review = c.db.tasks.list().find((t) => t.kind === "sdr.pipeline_review")!;
    expect(review).toMatchObject({ agentId: "sdr-01", status: "queued", threadKey: null });
    const snap = review.input["pipelineSnapshot"] as { email: string; staleHint: boolean; daysSinceLastTouch: number | null; repliedSinceLastTouch: boolean; openTasks: unknown[] }[];
    expect(snap.map((s) => s.email)).toEqual(expect.arrayContaining(["stale@x.example", "covered@x.example", "replied@x.example", "fresh@x.example"]));
    expect(snap[0]!.email).toBe("stale@x.example"); // stale first
    const by = Object.fromEntries(snap.map((s) => [s.email, s]));
    expect(by["stale@x.example"]).toMatchObject({ staleHint: true, daysSinceLastTouch: expect.any(Number) });
    expect(by["covered@x.example"]).toMatchObject({ staleHint: false });
    expect(by["covered@x.example"]!.openTasks).toHaveLength(1);
    expect(by["replied@x.example"]).toMatchObject({ staleHint: false, repliedSinceLastTouch: true });
    expect(by["fresh@x.example"]).toMatchObject({ staleHint: false });
    expect(by["optout@x.example"]).toBeUndefined();
    expect(by["newbie@x.example"]).toBeUndefined();

    // next day, previous review still queued -> skipped, not duplicated
    c.clock.now = new Date("2026-10-02T02:00:05Z");
    expect(c.scheduler.tick()[0]!.result).toMatch(/^skipped: previous pipeline review/);
    expect(c.db.tasks.list().filter((t) => t.kind === "sdr.pipeline_review")).toHaveLength(1);
  });

  it("custom_task creates the configured task each run", () => {
    const c = setup();
    addRoutine(c, "custom_task", { kind: "sdr.follow_up", title: "Weekly nudge", input: { note: "hi" }, priority: 3 });
    c.clock.now = new Date("2026-10-01T02:00:05Z");
    const [res] = c.scheduler.tick();
    expect(res!.result).toMatch(/^queued task tsk_\S+ \(sdr\.follow_up\)$/);
    expect(c.db.tasks.list()[0]).toMatchObject({ kind: "sdr.follow_up", title: "Weekly nudge", input: { note: "hi" }, priority: 3, agentId: "sdr-01" });
  });

  it("a broken custom_task config records a failure instead of throwing", () => {
    const c = setup();
    addRoutine(c, "custom_task", { nope: true });
    c.clock.now = new Date("2026-10-01T02:00:05Z");
    expect(c.scheduler.tick()[0]!.result).toMatch(/^failed: invalid custom_task config/);
    expect(c.db.tasks.list()).toHaveLength(0);
  });
});
