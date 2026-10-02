import { describe, expect, it } from "vitest";
import { openDb } from "../src/index.ts";

describe("HumanSentRepo", () => {
  it("dedupes by externalId, lists by thread and recipient, tracks the last touch", () => {
    const db = openDb(":memory:");
    const a = db.humanSent.insertIfNew({ externalId: "m1", messageId: "m1", recipients: ["jane@acme.com", "bob@acme.com"], toAddress: "jane@acme.com", bodyText: "hi", threadKey: "contact:jane@acme.com", sentAt: "2026-01-01T10:00:00.000Z" });
    expect(a.created).toBe(true);
    expect(db.humanSent.insertIfNew({ externalId: "m1", bodyText: "other", sentAt: "2026-01-02T00:00:00.000Z" }).created).toBe(false);
    db.humanSent.insertIfNew({ externalId: "m2", messageId: "m2", recipients: ["jane@acme.com"], bodyText: "again", threadKey: "contact:jane@acme.com", sentAt: "2026-01-03T10:00:00.000Z", references: ["m1"] });
    expect(db.humanSent.count()).toBe(2);
    expect(db.humanSent.listByThreadKey("contact:jane@acme.com").map((m) => m.messageId)).toEqual(["m2", "m1"]);
    expect(db.humanSent.findByMessageId("m1")!.recipients).toEqual(["jane@acme.com", "bob@acme.com"]);
    expect(db.humanSent.lastSentTo("Jane@Acme.com")).toBe("2026-01-03T10:00:00.000Z");
    expect(db.humanSent.lastSentTo("bob@acme.com")).toBe("2026-01-01T10:00:00.000Z");
    expect(db.humanSent.lastSentTo("nobody@acme.com")).toBeNull();
    db.close();
  });
});
