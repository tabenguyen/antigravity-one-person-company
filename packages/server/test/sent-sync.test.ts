// Sent-folder awareness: what a human sent from their own mail client is recorded, cancels follow-ups, supersedes
// drafts and shows up in thread summaries — and unrelated private mail is never stored.

import { describe, expect, it } from "vitest";
import { openDb, type Db } from "@agyhq/db";
import { FakeEmailProvider } from "@agyhq/channels";
import type { ParsedEmail } from "@agyhq/core";
import { EventBus } from "../src/event-bus.ts";
import { EmailPoller, EMAIL_SENT_CURSOR_KEY, ingestEmail, type InboundCtx } from "../src/inbound.ts";
import { ingestSentEmail } from "../src/sent-sync.ts";
import { Sender } from "../src/sender.ts";
import { buildPipelineSnapshot } from "../src/routines/run.ts";
import { makeTestConfig } from "./helpers.ts";

const OURS = "sdr@ourco.example";
const JANE = "jane@acme.com";
const THREAD = `contact:${JANE}`;

function makeCtx(db: Db): InboundCtx {
  return { db, bus: new EventBus(), config: makeTestConfig({ sender: { name: "Test Co", address: OURS, companyAddressLine: "123 St" }, email: { kind: "none", pollIntervalMs: 60_000 } }) };
}

function withAgent(db: Db, id = "sdr-01", trustTier: "shadow" | "assisted" | "autonomous" = "assisted") {
  db.agents.create({ id, role: "sales-sdr", displayName: "SDR", model: "m", workspacePath: `/tmp/${id}`, policy: { builtins: [], mcp: [] }, trustTier });
  return id;
}

function inboundMail(overrides: Partial<ParsedEmail> = {}): ParsedEmail {
  return {
    providerId: "1",
    messageId: "jane-1@mail.acme.com",
    inReplyTo: null,
    references: [],
    from: { address: JANE, name: "Jane Doe" },
    to: [{ address: OURS, name: null }],
    cc: [],
    replyTo: null,
    subject: "Báo giá",
    date: null,
    text: "Anh cho em xin báo giá nhé",
    replyText: "Anh cho em xin báo giá nhé",
    headers: {},
    attachments: [],
    ...overrides,
  };
}

function humanMail(overrides: Partial<ParsedEmail> = {}): ParsedEmail {
  return {
    providerId: "s1",
    messageId: "human-1@mail.ourco.example",
    inReplyTo: "jane-1@mail.acme.com",
    references: ["jane-1@mail.acme.com"],
    from: { address: "owner@ourco.example", name: "Owner" },
    to: [{ address: JANE, name: "Jane Doe" }],
    cc: [],
    replyTo: null,
    subject: "Re: Báo giá",
    date: new Date(Date.now() + 5000).toISOString(), // in the future: clamped to "now" at ingest, so tasks created a moment ago predate it
    text: "Dạ em gửi chị báo giá: 1.200.000đ/năm ạ.\n\nOn Mon, Jane wrote:\n> Anh cho em xin báo giá nhé",
    replyText: "Dạ em gửi chị báo giá: 1.200.000đ/năm ạ.",
    headers: {},
    attachments: [],
    ...overrides,
  };
}

/** An inbound mail from Jane, routed to the SDR: returns the event + the reply task. */
function janeWrote(ctx: InboundCtx, agentId: string, overrides: Partial<ParsedEmail> = {}) {
  ctx.db.crm.upsertContact({ email: JANE, name: "Jane", ownerAgentId: agentId });
  // a prior sent mail makes this a "reply" on a known thread
  const draft = ctx.db.outbox.createDraft({ agentId, channel: "email", to: JANE, subject: "Hello", body: "Hi Jane", reason: "r", threadKey: THREAD });
  ctx.db.outbox.decide(draft.id, "approved");
  ctx.db.outbox.claimNextToSend();
  ctx.db.outbox.decide(draft.id, "sent", { messageId: "ours-0@ourco.example", sentAt: new Date(Date.now() - 86_400_000).toISOString() });
  const event = ingestEmail(ctx, inboundMail({ inReplyTo: "ours-0@ourco.example", references: ["ours-0@ourco.example"], ...overrides }))!;
  return { event, replyTask: ctx.db.tasks.get(event.routedTaskId!)! };
}

describe("ingestSentEmail — recording", () => {
  it("records a human reply on a known thread, with the thread key resolved from In-Reply-To", () => {
    const db = openDb(":memory:");
    const ctx = makeCtx(db);
    const agentId = withAgent(db);
    janeWrote(ctx, agentId);

    const r = ingestSentEmail(ctx, humanMail(), "Sent");
    expect(r.outcome).toBe("recorded");
    expect(r.message).toMatchObject({ threadKey: THREAD, toAddress: JANE, subject: "Re: Báo giá", folder: "Sent" });
    expect(r.message!.bodyText).toBe("Dạ em gửi chị báo giá: 1.200.000đ/năm ạ."); // quoted history stripped
    expect(db.humanSent.listByThreadKey(THREAD)).toHaveLength(1);
    expect(db.audit.list({}).map((a) => a.kind)).toContain("email.human_sent");
    db.close();
  });

  it("dedupes by Message-ID", () => {
    const db = openDb(":memory:");
    const ctx = makeCtx(db);
    janeWrote(ctx, withAgent(db));
    expect(ingestSentEmail(ctx, humanMail(), "Sent").outcome).toBe("recorded");
    expect(ingestSentEmail(ctx, humanMail({ providerId: "other-uid" }), "Sent").outcome).toBe("duplicate");
    expect(db.humanSent.count()).toBe(1);
    db.close();
  });

  it("does NOT store unrelated mail (private / non-CRM correspondence)", () => {
    const db = openDb(":memory:");
    const ctx = makeCtx(db);
    withAgent(db);
    const r = ingestSentEmail(ctx, humanMail({ to: [{ address: "mum@family.example", name: null }], inReplyTo: null, references: [], subject: "Sunday lunch", messageId: "priv-1@x" }), "Sent");
    expect(r.outcome).toBe("unrelated");
    expect(db.humanSent.count()).toBe(0);
    expect(db.audit.list({}).map((a) => a.kind)).not.toContain("email.human_sent");
    db.close();
  });

  it("records mail to an existing contact even without threading headers, using the contact thread, and marks them contacted", () => {
    const db = openDb(":memory:");
    const ctx = makeCtx(db);
    withAgent(db);
    const { contact } = db.crm.upsertContact({ email: JANE, name: "Jane" });
    db.crm.setStage(contact.id, "researching", "test");
    const r = ingestSentEmail(ctx, humanMail({ inReplyTo: null, references: [], messageId: "fresh-1@x", subject: "Giới thiệu" }), "Sent");
    expect(r.outcome).toBe("recorded");
    expect(r.message!.threadKey).toBe(THREAD);
    expect(r.message!.contactId).toBe(contact.id);
    expect(db.crm.getContact(contact.id)!.stage).toBe("contacted");
    db.close();
  });

  it("skips mail our own Sender sent (it is already in the outbox)", () => {
    const db = openDb(":memory:");
    const ctx = makeCtx(db);
    const agentId = withAgent(db);
    const d = db.outbox.createDraft({ agentId, channel: "email", to: JANE, subject: "s", body: "b", reason: "r", threadKey: THREAD });
    db.outbox.decide(d.id, "approved");
    db.outbox.claimNextToSend();
    db.outbox.decide(d.id, "sent", { messageId: "ours-1@ourco.example", sentAt: new Date().toISOString() });
    const r = ingestSentEmail(ctx, humanMail({ messageId: "ours-1@ourco.example" }), "Sent");
    expect(r.outcome).toBe("own");
    expect(db.humanSent.count()).toBe(0);
    db.close();
  });

  it("ignores our own address among the recipients and mail with no external recipient", () => {
    const db = openDb(":memory:");
    const ctx = makeCtx(db);
    janeWrote(ctx, withAgent(db));
    expect(ingestSentEmail(ctx, humanMail({ messageId: "self@x", to: [{ address: OURS, name: null }] }), "Sent").outcome).toBe("no_recipient");
    const both = ingestSentEmail(ctx, humanMail({ messageId: "both@x", to: [{ address: OURS, name: null }, { address: JANE, name: null }], cc: [{ address: "boss@ourco.example", name: null }] }), "Sent");
    expect(both.message!.recipients).toEqual([JANE, "boss@ourco.example"]);
    db.close();
  });
});

describe("ingestSentEmail — effects on tasks, drafts and summaries", () => {
  it("cancels the thread's pending follow-ups (like an inbound reply does) but leaves other threads and later tasks alone", () => {
    const db = openDb(":memory:");
    const ctx = makeCtx(db);
    const agentId = withAgent(db);
    janeWrote(ctx, agentId);
    const followUp = db.tasks.create({ agentId, kind: "sdr.follow_up", title: "chase", threadKey: THREAD, wakeAt: new Date(Date.now() + 3 * 86_400_000).toISOString() });
    const otherThread = db.tasks.create({ agentId, kind: "sdr.follow_up", title: "other", threadKey: "contact:bob@acme.com" });

    const r = ingestSentEmail(ctx, humanMail(), "Sent");
    expect(r.cancelledTasks).toContain(followUp.id);
    expect(db.tasks.get(followUp.id)!.status).toBe("cancelled");
    expect(db.tasks.get(otherThread.id)!.status).toBe("queued");

    // a follow-up scheduled AFTER the human wrote is not answered by that message
    const later = db.tasks.create({ agentId, kind: "sdr.follow_up", title: "later", threadKey: THREAD });
    ingestSentEmail(ctx, humanMail({ messageId: "human-old@x", date: new Date(Date.now() - 3_600_000).toISOString() }), "Sent");
    expect(db.tasks.get(later.id)!.status).toBe("queued");
    db.close();
  });

  it("cancels a not-yet-started reply task for the inbound mail the human just answered — but not a running one, nor one for a different message", () => {
    const db = openDb(":memory:");
    const ctx = makeCtx(db);
    const agentId = withAgent(db);
    const { replyTask } = janeWrote(ctx, agentId);
    expect(replyTask.status).toBe("queued");

    const second = ingestEmail(ctx, inboundMail({ messageId: "jane-2@mail.acme.com", inReplyTo: "ours-0@ourco.example", references: ["ours-0@ourco.example"], subject: "Câu hỏi khác", providerId: "2" }))!;
    const secondTask = db.tasks.get(second.routedTaskId!)!;
    expect(secondTask.threadKey).toBe(THREAD);

    const r = ingestSentEmail(ctx, humanMail(), "Sent"); // answers jane-1 only
    expect(r.cancelledTasks).toContain(replyTask.id);
    expect(db.tasks.get(replyTask.id)!.status).toBe("cancelled");
    expect(db.tasks.get(secondTask.id)!.status).toBe("queued");

    // a reply task that already started is never cancelled
    db.tasks.transition(secondTask.id, "running");
    const r2 = ingestSentEmail(ctx, humanMail({ messageId: "human-2@x", inReplyTo: "jane-2@mail.acme.com", references: ["jane-2@mail.acme.com"] }), "Sent");
    expect(r2.cancelledTasks).toEqual([]);
    expect(db.tasks.get(secondTask.id)!.status).toBe("running");
    db.close();
  });

  it("marks pending / held / approved drafts written before the human's reply as superseded, leaving other people's and later drafts alone", () => {
    const db = openDb(":memory:");
    const ctx = makeCtx(db);
    const agentId = withAgent(db, "sdr-01", "assisted");
    janeWrote(ctx, agentId);
    const mk = (to: string, thread: string | null = THREAD) => db.outbox.createDraft({ agentId, channel: "email", to, subject: "Re: Báo giá", body: "draft", reason: "r", threadKey: thread });
    const pending = mk(JANE);
    const held = mk(JANE);
    db.outbox.decide(held.id, "held", { decidedBy: "human:ops" });
    const approved = mk(JANE);
    db.outbox.decide(approved.id, "approved", { decidedBy: "human:ops" });
    const someoneElse = mk("bob@acme.com", "contact:bob@acme.com");
    const rejected = mk(JANE);
    db.outbox.decide(rejected.id, "rejected", { decidedBy: "human:ops" });

    const r = ingestSentEmail(ctx, humanMail({ date: new Date(Date.now() + 5).toISOString() }), "Sent");
    expect(new Set(r.supersededDrafts)).toEqual(new Set([pending.id, held.id, approved.id]));
    for (const id of [pending.id, held.id, approved.id]) expect(db.outbox.get(id)!.statusReason).toMatch(/^superseded: a human already replied/);
    expect(db.outbox.get(pending.id)!.status).toBe("pending_approval"); // status itself is untouched: the human still decides
    expect(db.outbox.get(someoneElse.id)!.statusReason).toBeNull();
    expect(db.outbox.get(rejected.id)!.statusReason).toBeNull();
    expect(db.audit.list({}).filter((a) => a.kind === "outbox.superseded")).toHaveLength(3);

    // a draft created after the human's message is not superseded by it
    const after = mk(JANE);
    ingestSentEmail(ctx, humanMail({ messageId: "human-3@x", date: new Date(Date.now() - 60_000).toISOString() }), "Sent");
    expect(db.outbox.get(after.id)!.statusReason).toBeNull();
    db.close();
  });

  it("the Sender refuses an APPROVED draft that was superseded, but a human who approves a superseded pending draft overrides it", async () => {
    const db = openDb(":memory:");
    const ctx = makeCtx(db);
    const agentId = withAgent(db, "sdr-01", "assisted");
    janeWrote(ctx, agentId);
    const approved = db.outbox.createDraft({ agentId, channel: "email", to: JANE, subject: "Re: Báo giá", body: "draft", reason: "r", threadKey: THREAD });
    db.outbox.decide(approved.id, "approved", { decidedBy: "human:ops" });
    ingestSentEmail(ctx, humanMail({ date: new Date(Date.now() + 5).toISOString() }), "Sent");
    db.settings.patch({ outboundEnabled: true, quietHours: null, sendRatePerHour: 100 });

    const provider = new FakeEmailProvider();
    const sender = new Sender({ config: ctx.config, db, bus: ctx.bus, provider, pollIntervalMs: 1_000_000 });
    await sender.tick();
    expect(provider.sent).toHaveLength(0);
    const blocked = db.outbox.get(approved.id)!;
    expect(blocked.status).toBe("blocked");
    expect(blocked.statusReason).toMatch(/^superseded:/);
    db.close();
  });

  it("makes the human's reply visible in the next inbound task's thread summary, and a customer's answer to it is a reply, not a new lead", () => {
    const db = openDb(":memory:");
    const ctx = makeCtx(db);
    const agentId = withAgent(db);
    janeWrote(ctx, agentId);
    ingestSentEmail(ctx, humanMail(), "Sent");

    const next = ingestEmail(ctx, inboundMail({ messageId: "jane-3@mail.acme.com", inReplyTo: "human-1@mail.ourco.example", references: ["jane-1@mail.acme.com", "human-1@mail.ourco.example"], subject: "Re: Re: Báo giá", text: "Cảm ơn anh", replyText: "Cảm ơn anh", providerId: "3" }))!;
    expect(next.classification).toBe("reply");
    expect(next.threadKey).toBe(THREAD);
    const task = db.tasks.get(next.routedTaskId!)!;
    const summary = String(task.input["threadSummary"]);
    expect(summary).toMatch(/A teammate replied from their own mail client \("Re: Báo giá"\): Dạ em gửi chị báo giá: 1\.200\.000đ\/năm ạ\./);
    expect(summary).toMatch(/They wrote/);
    db.close();
  });

  it("a human touch counts in pipeline reviews, so a chased-by-a-human contact is not flagged stale", () => {
    const db = openDb(":memory:");
    const ctx = makeCtx(db);
    const agentId = withAgent(db);
    const { contact } = db.crm.upsertContact({ email: JANE, name: "Jane", ownerAgentId: agentId });
    db.crm.setStage(contact.id, "contacted", "t");
    const old = new Date(Date.now() - 20 * 86_400_000).toISOString();
    const d = db.outbox.createDraft({ agentId, channel: "email", to: JANE, subject: "s", body: "b", reason: "r", threadKey: THREAD });
    db.outbox.decide(d.id, "approved");
    db.outbox.claimNextToSend();
    db.outbox.decide(d.id, "sent", { messageId: "ours-9@x", sentAt: old });
    db.sqlite.prepare("UPDATE outbox SET sent_at = ? WHERE id = ?").run(old, d.id);

    const before = buildPipelineSnapshot(db, agentId, new Date(), 10, 7);
    expect(before[0]!.staleHint).toBe(true);

    ingestSentEmail(ctx, humanMail({ inReplyTo: null, references: [], messageId: "touch@x" }), "Sent");
    const after = buildPipelineSnapshot(db, agentId, new Date(), 10, 7);
    expect(after[0]!.staleHint).toBe(false);
    expect(after[0]!.daysSinceLastTouch).toBe(0);
    db.close();
  });
});

describe("EmailPoller — Sent folder", () => {
  function setup() {
    const db = openDb(":memory:");
    const ctx = makeCtx(db);
    const provider = new FakeEmailProvider();
    const poller = new EmailPoller(ctx, provider, 60_000);
    return { db, ctx, provider, poller };
  }

  it("is off unless the provider syncs Sent", async () => {
    const { db, provider, poller } = setup();
    provider.deliverSent({ to: [{ address: JANE, name: null }] });
    await poller.pollNow();
    expect(poller.sentSync.enabled).toBe(false);
    expect(db.channelCursors.get(EMAIL_SENT_CURSOR_KEY)).toBeNull();
    db.close();
  });

  it("polls the Sent folder with its own cursor (from now: pre-existing sent mail is not processed), after the inbox", async () => {
    const { db, ctx, provider, poller } = setup();
    withAgent(db);
    db.crm.upsertContact({ email: JANE, name: "Jane" });
    provider.enableSentSync();
    provider.deliverSent({ to: [{ address: JANE, name: null }], messageId: "history@x", subject: "old history" });

    await poller.pollNow();
    expect(poller.sentSync).toMatchObject({ enabled: true, folder: "Sent", lastError: null });
    expect(db.humanSent.count()).toBe(0); // history before we connected is not ingested

    provider.deliverSent({ to: [{ address: JANE, name: null }], messageId: "new@x", subject: "fresh" });
    provider.deliverSent({ to: [{ address: "mum@family.example", name: null }], messageId: "private@x", subject: "private" });
    await poller.pollNow();
    expect(db.humanSent.count()).toBe(1);
    expect(poller.sentSync.counts).toMatchObject({ recorded: 1, unrelated: 1 });
    expect(db.channelCursors.get(EMAIL_SENT_CURSOR_KEY)).not.toBeNull();

    await poller.pollNow(); // nothing new: idempotent
    expect(db.humanSent.count()).toBe(1);
    void ctx;
    db.close();
  });

  it("a Sent-folder failure (e.g. no Sent folder) is reported separately and never breaks inbox polling", async () => {
    const { db, provider, poller } = setup();
    withAgent(db);
    provider.enableSentSync();
    provider.failNextFetchSent(new Error("could not find the Sent folder automatically; set sentFolder explicitly"));
    provider.deliver({ from: { address: JANE, name: "Jane" }, to: [{ address: OURS, name: null }], subject: "hi", text: "hello" });

    await poller.pollNow();
    expect(poller.lastError).toBeNull();
    expect(db.inbound.list()).toHaveLength(1);
    expect(poller.sentSync.lastError).toMatch(/set sentFolder/);

    await poller.pollNow(); // recovers by itself
    expect(poller.sentSync.lastError).toBeNull();
    db.close();
  });
});
