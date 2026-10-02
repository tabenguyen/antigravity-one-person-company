import { describe, expect, it } from "vitest";
import { openDb, type Db } from "@agyhq/db";
import { FakeEmailProvider } from "@agyhq/channels";
import { EventBus } from "../src/event-bus.ts";
import { Sender, isInQuietHours, isTransientError } from "../src/sender.ts";
import { makeTestConfig } from "./helpers.ts";

function setup(overrides: Partial<Parameters<typeof makeTestConfig>[0]> = {}) {
  const db = openDb(":memory:");
  const bus = new EventBus();
  const provider = new FakeEmailProvider();
  const config = makeTestConfig({
    sender: { name: "Mai", address: "sdr@ourco.example", companyAddressLine: "123 Test St, Test City" },
    unsubscribeMailto: "unsubscribe@ourco.example",
    ...overrides,
  });
  db.agents.create({ id: "sdr-01", role: "sales-sdr", displayName: "Mai", model: "m", workspacePath: "/tmp/sdr-01", policy: { builtins: [], mcp: [] }, trustTier: "assisted" });
  return { db, bus, provider, config };
}

function approvedDraft(db: Db, agentId: string, to = "lead@acme.com", threadKey?: string) {
  const draft = db.outbox.createDraft({ agentId, channel: "email", to, subject: "Hi", body: "Hello there", reason: "first touch", threadKey });
  return db.outbox.decide(draft.id, "approved", { decidedBy: "human:ops" });
}

describe("isInQuietHours", () => {
  it("handles a window that wraps past midnight", () => {
    const quietHours = { startHour: 21, endHour: 8, timezone: "UTC" };
    expect(isInQuietHours(quietHours, new Date("2025-01-01T22:00:00Z"))).toBe(true);
    expect(isInQuietHours(quietHours, new Date("2025-01-01T03:00:00Z"))).toBe(true);
    expect(isInQuietHours(quietHours, new Date("2025-01-01T12:00:00Z"))).toBe(false);
  });

  it("handles a same-day window", () => {
    const quietHours = { startHour: 9, endHour: 17, timezone: "UTC" };
    expect(isInQuietHours(quietHours, new Date("2025-01-01T12:00:00Z"))).toBe(true);
    expect(isInQuietHours(quietHours, new Date("2025-01-01T20:00:00Z"))).toBe(false);
  });

  it("returns false when quietHours is null", () => {
    expect(isInQuietHours(null, new Date())).toBe(false);
  });
});

describe("isTransientError", () => {
  it("treats a 550 SMTP rejection as permanent", () => {
    expect(isTransientError(new Error("550 5.1.1 no such user"))).toBe(false);
  });
  it("treats a timeout as transient", () => {
    expect(isTransientError(new Error("ETIMEDOUT"))).toBe(true);
  });
});

describe("Sender — kill switch and quiet hours", () => {
  it("never sends while outboundEnabled is false", async () => {
    const { db, bus, provider, config } = setup();
    approvedDraft(db, "sdr-01");
    db.settings.patch({ outboundEnabled: false, quietHours: null, sendRatePerHour: 100 });

    const sender = new Sender({ config, db, bus, provider, pollIntervalMs: 1_000_000 });
    await sender.tick();
    expect(provider.sent).toHaveLength(0);
    db.close();
  });

  it("does not send during quiet hours", async () => {
    const { db, bus, provider, config } = setup();
    approvedDraft(db, "sdr-01");
    db.settings.patch({ outboundEnabled: true, quietHours: { startHour: 0, endHour: 23, timezone: "UTC" }, sendRatePerHour: 100 });

    const sender = new Sender({ config, db, bus, provider, now: () => new Date("2025-01-01T12:00:00Z"), pollIntervalMs: 1_000_000 });
    await sender.tick();
    expect(provider.sent).toHaveLength(0);
    db.close();
  });
});

describe("Sender — send, compose, gating", () => {
  it("sends an approved item when enabled and outside quiet hours; composes footer + headers + threading", async () => {
    const { db, bus, provider, config } = setup();
    db.crm.upsertContact({ email: "lead@acme.com" });
    db.inbound.insertIfNew({
      source: "email",
      externalId: "inbound-1",
      fromAddress: "lead@acme.com",
      bodyText: "hi",
      messageId: "inbound1@mail.example",
      references: ["old1@mail.example"],
      threadKey: "contact:lead@acme.com",
      classification: "reply",
    });
    approvedDraft(db, "sdr-01", "lead@acme.com", "contact:lead@acme.com");
    db.settings.patch({ outboundEnabled: true, quietHours: null, sendRatePerHour: 100 });

    const sender = new Sender({ config, db, bus, provider, pollIntervalMs: 1_000_000 });
    await sender.tick();

    expect(provider.sent).toHaveLength(1);
    const sent = provider.sent[0]!;
    expect(sent.from.address).toBe("sdr@ourco.example");
    expect(sent.inReplyTo).toBe("inbound1@mail.example");
    expect(sent.references).toContain("old1@mail.example");
    expect(sent.references).toContain("inbound1@mail.example");
    expect(sent.text).toContain("123 Test St, Test City");
    expect(sent.text).toContain("unsubscribe@ourco.example");
    expect(sent.listUnsubscribe).toContain("unsubscribe@ourco.example");

    const items = db.outbox.list({ agentId: "sdr-01" });
    expect(items[0]!.status).toBe("sent");
    expect(items[0]!.messageId).toBe(sent.messageId);

    const contact = db.crm.findContacts({ email: "lead@acme.com" })[0]!;
    expect(contact.stage).toBe("contacted");
    db.close();
  });

  it("respects the hourly rate limit", async () => {
    const { db, bus, provider, config } = setup();
    approvedDraft(db, "sdr-01", "a@acme.com");
    approvedDraft(db, "sdr-01", "b@acme.com");
    db.settings.patch({ outboundEnabled: true, quietHours: null, sendRatePerHour: 1 });

    const sender = new Sender({ config, db, bus, provider, pollIntervalMs: 1_000_000 });
    await sender.tick();
    expect(provider.sent).toHaveLength(1);
    await sender.tick();
    expect(provider.sent).toHaveLength(1); // rate limit hit, second item untouched
    db.close();
  });

  it("final guard blocks a send to an opted-out contact even though it was approved earlier", async () => {
    const { db, bus, provider, config } = setup();
    const draft = approvedDraft(db, "sdr-01", "lead@acme.com");
    db.crm.upsertContact({ email: "lead@acme.com", attributes: { optOut: true } });
    db.settings.patch({ outboundEnabled: true, quietHours: null, sendRatePerHour: 100 });

    const sender = new Sender({ config, db, bus, provider, pollIntervalMs: 1_000_000 });
    await sender.tick();
    expect(provider.sent).toHaveLength(0);
    expect(db.outbox.get(draft.id)!.status).toBe("blocked");
    db.close();
  });

  it("retries a transient failure, then permanently fails after repeated transient errors", async () => {
    const { db, bus, provider, config } = setup();
    const draft = approvedDraft(db, "sdr-01");
    db.settings.patch({ outboundEnabled: true, quietHours: null, sendRatePerHour: 100 });

    const sender = new Sender({ config, db, bus, provider, pollIntervalMs: 1_000_000 });

    provider.failNextSend(new Error("ETIMEDOUT"));
    await sender.tick();
    expect(db.outbox.get(draft.id)!.status).toBe("approved");
    expect(db.outbox.get(draft.id)!.attempts).toBe(1);

    sender.clearBackoff(draft.id); // don't make the test wait on wall-clock backoff
    provider.failNextSend(new Error("ETIMEDOUT"));
    await sender.tick();
    expect(db.outbox.get(draft.id)!.attempts).toBe(2);
    expect(db.outbox.get(draft.id)!.status).toBe("approved");

    sender.clearBackoff(draft.id);
    provider.failNextSend(new Error("ETIMEDOUT"));
    await sender.tick();
    expect(db.outbox.get(draft.id)!.status).toBe("failed");
    expect(db.outbox.get(draft.id)!.attempts).toBe(3);
    db.close();
  });

  it("fails permanently on the first attempt for a non-transient (5xx) SMTP error", async () => {
    const { db, bus, provider, config } = setup();
    const draft = approvedDraft(db, "sdr-01");
    db.settings.patch({ outboundEnabled: true, quietHours: null, sendRatePerHour: 100 });
    const sender = new Sender({ config, db, bus, provider, pollIntervalMs: 1_000_000 });

    provider.failNextSend(new Error("550 5.1.1 no such user"));
    await sender.tick();
    expect(db.outbox.get(draft.id)!.status).toBe("failed");
    expect(db.outbox.get(draft.id)!.attempts).toBe(1);
    db.close();
  });

  it("does nothing when no provider is configured", async () => {
    const { db, bus, config } = setup();
    approvedDraft(db, "sdr-01");
    db.settings.patch({ outboundEnabled: true, quietHours: null, sendRatePerHour: 100 });

    const sender = new Sender({ config, db, bus, provider: null, pollIntervalMs: 1_000_000 });
    await sender.tick();
    expect(db.outbox.list({ status: ["approved"] })).toHaveLength(1); // untouched
    db.close();
  });
});

describe("Sender — crash recovery and auto-trip", () => {
  it("start() recovers items stuck in sending back to approved", () => {
    const { db, bus, provider, config } = setup();
    const draft = approvedDraft(db, "sdr-01");
    db.outbox.claimNextToSend();
    expect(db.outbox.get(draft.id)!.status).toBe("sending");

    const sender = new Sender({ config, db, bus, provider, pollIntervalMs: 1_000_000 });
    sender.start();
    expect(db.outbox.get(draft.id)!.status).toBe("approved");
    sender.stop();
    db.close();
  });

  it("trips the kill switch when the bounce rate over the window exceeds the threshold", async () => {
    const { db, bus, provider, config } = setup();
    db.settings.patch({ outboundEnabled: true, quietHours: null, sendRatePerHour: 1000, autoTrip: { windowSize: 2, maxBounceRate: 0.4 } });
    const sender = new Sender({ config, db, bus, provider, pollIntervalMs: 1_000_000 });

    const first = approvedDraft(db, "sdr-01", "a@acme.com");
    await sender.tick();
    db.outbox.annotateBounce(first.id, "mailbox full");
    expect(db.settings.get().outboundEnabled).toBe(true); // window not full yet (only 1 sent)

    approvedDraft(db, "sdr-01", "b@acme.com");
    await sender.tick();

    expect(db.settings.get().outboundEnabled).toBe(false); // 1/2 = 50% > 40% threshold
    expect(db.settings.get().outboundDisabledReason).toMatch(/auto-trip/);
    db.close();
  });
});
