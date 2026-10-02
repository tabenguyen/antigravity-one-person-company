import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "@agyhq/core";
import { openDb } from "../src/index.ts";

describe("settings", () => {
  it("get() returns DEFAULT_SETTINGS when nothing is stored", () => {
    const db = openDb(":memory:");
    expect(db.settings.get()).toEqual(DEFAULT_SETTINGS);
    db.close();
  });

  it("patch() merges a partial update over the current settings and persists it", () => {
    const db = openDb(":memory:");
    const updated = db.settings.patch({ outboundEnabled: true });
    expect(updated.outboundEnabled).toBe(true);
    expect(updated.sendRatePerHour).toBe(DEFAULT_SETTINGS.sendRatePerHour); // untouched fields keep their default

    const reread = db.settings.get();
    expect(reread.outboundEnabled).toBe(true);

    const second = db.settings.patch({ sendRatePerHour: 5 });
    expect(second.outboundEnabled).toBe(true); // first patch survives
    expect(second.sendRatePerHour).toBe(5);
    db.close();
  });

  it("patch() replaces nested objects wholesale, not deep-merged", () => {
    const db = openDb(":memory:");
    const updated = db.settings.patch({ quietHours: { startHour: 1, endHour: 2, timezone: "UTC" } });
    expect(updated.quietHours).toEqual({ startHour: 1, endHour: 2, timezone: "UTC" });
    db.close();
  });
});
