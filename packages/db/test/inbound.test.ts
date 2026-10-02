import { describe, expect, it } from "vitest";
import { openDb } from "../src/index.ts";

describe("inbound", () => {
  it("insertIfNew dedupes by (source, externalId)", () => {
    const db = openDb(":memory:");
    const { event: a, created: created1 } = db.inbound.insertIfNew({
      source: "email",
      externalId: "msg-1@mail.example",
      bodyText: "hello",
      classification: "new_lead",
    });
    expect(created1).toBe(true);

    const { event: b, created: created2 } = db.inbound.insertIfNew({
      source: "email",
      externalId: "msg-1@mail.example",
      bodyText: "hello again (ignored, dedupe hit)",
      classification: "reply",
    });
    expect(created2).toBe(false);
    expect(b.id).toBe(a.id);
    expect(b.bodyText).toBe("hello"); // original row, not the "again" attempt

    expect(db.inbound.list()).toHaveLength(1);
    db.close();
  });

  it("list filters by status and classification", () => {
    const db = openDb(":memory:");
    db.inbound.insertIfNew({ source: "email", externalId: "1", bodyText: "a", classification: "reply" });
    db.inbound.insertIfNew({ source: "email", externalId: "2", bodyText: "b", classification: "new_lead" });
    const { event } = db.inbound.insertIfNew({ source: "webhook", externalId: "3", bodyText: "c", classification: "new_lead" });
    db.inbound.setStatus(event.id, "routed", { routedTaskId: "tsk_1" });

    expect(db.inbound.list({ classification: "new_lead" })).toHaveLength(2);
    expect(db.inbound.list({ status: "routed" })).toHaveLength(1);
    expect(db.inbound.list({ status: "received" })).toHaveLength(2);
    db.close();
  });

  it("findByMessageId and listByThreadKey", () => {
    const db = openDb(":memory:");
    db.inbound.insertIfNew({
      source: "email",
      externalId: "m1",
      bodyText: "first",
      messageId: "m1@mail.example",
      threadKey: "contact:a@x.com",
      classification: "reply",
    });
    db.inbound.insertIfNew({
      source: "email",
      externalId: "m2",
      bodyText: "second",
      messageId: "m2@mail.example",
      threadKey: "contact:a@x.com",
      classification: "reply",
    });
    expect(db.inbound.findByMessageId("m1@mail.example")?.bodyText).toBe("first");
    expect(db.inbound.findByMessageId("nope")).toBeNull();
    const thread = db.inbound.listByThreadKey("contact:a@x.com");
    expect(thread).toHaveLength(2);
    expect(thread[0]!.bodyText).toBe("second"); // newest first
    db.close();
  });

  it("setStatus updates status/statusReason/contactId/routedTaskId", () => {
    const db = openDb(":memory:");
    const { event } = db.inbound.insertIfNew({ source: "email", externalId: "1", bodyText: "a", classification: "unsubscribe" });
    const updated = db.inbound.setStatus(event.id, "ignored", { statusReason: "auto-reply" });
    expect(updated.status).toBe("ignored");
    expect(updated.statusReason).toBe("auto-reply");
    db.close();
  });
});
