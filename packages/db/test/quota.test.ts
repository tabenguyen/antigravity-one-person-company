import { describe, expect, it } from "vitest";
import { openDb } from "../src/index.ts";

describe("quota", () => {
  it("records snapshots and returns the latest one", () => {
    const db = openDb(":memory:");
    expect(db.quota.latest()).toBeNull();

    db.quota.record([{ group: "Gemini Models", window: "weekly", remainingFraction: 0.8, resetTime: null }]);
    const second = db.quota.record([
      { group: "Gemini Models", window: "weekly", remainingFraction: 0.75, resetTime: null },
    ]);

    const latest = db.quota.latest();
    expect(latest?.at).toBe(second.at);
    expect(latest?.buckets[0]!.remainingFraction).toBe(0.75);
    db.close();
  });
});
