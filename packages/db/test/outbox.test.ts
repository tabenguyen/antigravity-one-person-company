import { describe, expect, it } from "vitest";
import { openDb } from "../src/index.ts";
import { OutboxTransitionError, ConflictError, NotFoundError } from "../src/errors.ts";

function withAgent(db: ReturnType<typeof openDb>, id = "sdr-01") {
  db.agents.create({
    id,
    role: "sales-sdr",
    displayName: "SDR",
    model: "m",
    workspacePath: `/tmp/${id}`,
    policy: { builtins: [], mcp: [] },
  });
  return id;
}

describe("outbox", () => {
  it("creates a pending_approval draft and transitions status", () => {
    const db = openDb(":memory:");
    withAgent(db);

    const draft = db.outbox.createDraft({
      agentId: "sdr-01",
      channel: "email",
      to: "lead@example.com",
      subject: "Hi",
      body: "Hello there",
      reason: "first touch",
    });
    expect(draft.status).toBe("pending_approval");
    expect(draft.originalSubject).toBe("Hi");
    expect(draft.originalBody).toBe("Hello there");
    expect(draft.editedByHuman).toBe(false);

    const approved = db.outbox.decide(draft.id, "approved", { decidedBy: "human:ops" });
    expect(approved.status).toBe("approved");
    expect(approved.decidedBy).toBe("human:ops");

    const list = db.outbox.list({ agentId: "sdr-01", status: ["approved"] });
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(draft.id);
    db.close();
  });

  it("rejects an invalid transition", () => {
    const db = openDb(":memory:");
    withAgent(db);
    const draft = db.outbox.createDraft({
      agentId: "sdr-01",
      channel: "email",
      to: "a@example.com",
      subject: "s",
      body: "b",
      reason: "r",
    });
    db.outbox.decide(draft.id, "rejected", { decidedBy: "human:x" });
    expect(() => db.outbox.decide(draft.id, "approved")).toThrow(OutboxTransitionError);
    db.close();
  });

  it("throws NotFoundError for a missing id", () => {
    const db = openDb(":memory:");
    expect(() => db.outbox.decide("nope", "approved")).toThrow(NotFoundError);
    db.close();
  });

  it("edit only works while pending_approval and marks editedByHuman", () => {
    const db = openDb(":memory:");
    withAgent(db);
    const draft = db.outbox.createDraft({
      agentId: "sdr-01",
      channel: "email",
      to: "a@example.com",
      subject: "orig subject",
      body: "orig body",
      reason: "r",
    });
    const edited = db.outbox.edit(draft.id, { body: "edited body" });
    expect(edited.body).toBe("edited body");
    expect(edited.subject).toBe("orig subject");
    expect(edited.editedByHuman).toBe(true);
    expect(edited.originalBody).toBe("orig body"); // original preserved

    db.outbox.decide(draft.id, "approved");
    expect(() => db.outbox.edit(draft.id, { body: "too late" })).toThrow(ConflictError);
    db.close();
  });

  it("claimNextToSend atomically moves the oldest approved item to sending", () => {
    const db = openDb(":memory:");
    withAgent(db);
    const a = db.outbox.createDraft({ agentId: "sdr-01", channel: "email", to: "a@x.com", subject: "a", body: "a", reason: "r" });
    const b = db.outbox.createDraft({ agentId: "sdr-01", channel: "email", to: "b@x.com", subject: "b", body: "b", reason: "r" });
    db.outbox.decide(a.id, "approved");
    db.outbox.decide(b.id, "approved");

    const claimed = db.outbox.claimNextToSend();
    expect(claimed?.id).toBe(a.id);
    expect(claimed?.status).toBe("sending");

    const claimed2 = db.outbox.claimNextToSend();
    expect(claimed2?.id).toBe(b.id);

    expect(db.outbox.claimNextToSend()).toBeNull();
    db.close();
  });

  it("recoverSending puts crashed sending items back to approved", () => {
    const db = openDb(":memory:");
    withAgent(db);
    const a = db.outbox.createDraft({ agentId: "sdr-01", channel: "email", to: "a@x.com", subject: "a", body: "a", reason: "r" });
    db.outbox.decide(a.id, "approved");
    db.outbox.claimNextToSend();
    expect(db.outbox.get(a.id)!.status).toBe("sending");

    const recovered = db.outbox.recoverSending();
    expect(recovered).toEqual([a.id]);
    expect(db.outbox.get(a.id)!.status).toBe("approved");
    db.close();
  });

  it("markTransientFailure and markTerminalFailure bump attempts", () => {
    const db = openDb(":memory:");
    withAgent(db);
    const a = db.outbox.createDraft({ agentId: "sdr-01", channel: "email", to: "a@x.com", subject: "a", body: "a", reason: "r" });
    db.outbox.decide(a.id, "approved");
    db.outbox.claimNextToSend();

    const retried = db.outbox.markTransientFailure(a.id, "smtp timeout");
    expect(retried.status).toBe("approved");
    expect(retried.attempts).toBe(1);
    expect(retried.statusReason).toBe("smtp timeout");

    db.outbox.claimNextToSend();
    const failed = db.outbox.markTerminalFailure(a.id, "smtp rejected");
    expect(failed.status).toBe("failed");
    expect(failed.attempts).toBe(2);
    db.close();
  });

  it("hasHumanApprovedSentTo only true after a human-decided sent item", () => {
    const db = openDb(":memory:");
    withAgent(db);
    const a = db.outbox.createDraft({ agentId: "sdr-01", channel: "email", to: "a@x.com", subject: "a", body: "a", reason: "r" });
    expect(db.outbox.hasHumanApprovedSentTo("a@x.com")).toBe(false);
    db.outbox.decide(a.id, "approved", { decidedBy: "human:ops" });
    db.outbox.claimNextToSend();
    db.outbox.decide(a.id, "sent", { sentAt: new Date().toISOString(), messageId: "m1@x.com" });
    expect(db.outbox.hasHumanApprovedSentTo("a@x.com")).toBe(true);
    expect(db.outbox.hasHumanApprovedSentTo("A@X.com")).toBe(true);
    db.close();
  });

  it("policy-approved sends do not count as human-approved", () => {
    const db = openDb(":memory:");
    withAgent(db);
    const a = db.outbox.createDraft({ agentId: "sdr-01", channel: "email", to: "a@x.com", subject: "a", body: "a", reason: "r" });
    db.outbox.decide(a.id, "approved", { decidedBy: "policy:autonomous" });
    db.outbox.claimNextToSend();
    db.outbox.decide(a.id, "sent", { sentAt: new Date().toISOString() });
    expect(db.outbox.hasHumanApprovedSentTo("a@x.com")).toBe(false);
    db.close();
  });

  it("rejectAllTo rejects every pending/approved item to an address", () => {
    const db = openDb(":memory:");
    withAgent(db);
    const a = db.outbox.createDraft({ agentId: "sdr-01", channel: "email", to: "a@x.com", subject: "a", body: "a", reason: "r" });
    const b = db.outbox.createDraft({ agentId: "sdr-01", channel: "email", to: "a@x.com", subject: "b", body: "b", reason: "r" });
    db.outbox.decide(b.id, "approved");
    const c = db.outbox.createDraft({ agentId: "sdr-01", channel: "email", to: "other@x.com", subject: "c", body: "c", reason: "r" });

    const rejected = db.outbox.rejectAllTo("a@x.com", "policy:opt-out", "unsubscribed");
    expect(rejected.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
    expect(db.outbox.get(a.id)!.status).toBe("rejected");
    expect(db.outbox.get(c.id)!.status).toBe("pending_approval");
    db.close();
  });

  it("annotateBounce sets statusReason without changing the sent status", () => {
    const db = openDb(":memory:");
    withAgent(db);
    const a = db.outbox.createDraft({ agentId: "sdr-01", channel: "email", to: "a@x.com", subject: "a", body: "a", reason: "r" });
    db.outbox.decide(a.id, "approved");
    db.outbox.claimNextToSend();
    db.outbox.decide(a.id, "sent", { sentAt: new Date().toISOString() });
    const bounced = db.outbox.annotateBounce(a.id, "mailbox full");
    expect(bounced.status).toBe("sent");
    expect(bounced.statusReason).toBe("bounced: mailbox full");
    db.close();
  });

  it("countSentSince and lastSent support rate-limit and bounce-rate queries", () => {
    const db = openDb(":memory:");
    withAgent(db);
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      const item = db.outbox.createDraft({ agentId: "sdr-01", channel: "email", to: `x${i}@x.com`, subject: "s", body: "b", reason: "r" });
      db.outbox.decide(item.id, "approved");
      db.outbox.claimNextToSend();
      db.outbox.decide(item.id, "sent", { sentAt: new Date(now - i * 1000).toISOString() });
    }
    expect(db.outbox.countSentSince(new Date(now - 60_000).toISOString())).toBe(3);
    expect(db.outbox.lastSent(2)).toHaveLength(2);
    db.close();
  });

  it("findByMessageId finds a sent item by its Message-ID", () => {
    const db = openDb(":memory:");
    withAgent(db);
    const a = db.outbox.createDraft({ agentId: "sdr-01", channel: "email", to: "a@x.com", subject: "a", body: "a", reason: "r" });
    db.outbox.decide(a.id, "approved");
    db.outbox.claimNextToSend();
    db.outbox.decide(a.id, "sent", { messageId: "abc123@mail.example", sentAt: new Date().toISOString() });
    expect(db.outbox.findByMessageId("abc123@mail.example")?.id).toBe(a.id);
    expect(db.outbox.findByMessageId("nope")).toBeNull();
    db.close();
  });
});
