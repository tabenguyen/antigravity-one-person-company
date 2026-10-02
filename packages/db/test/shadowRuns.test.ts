import { describe, expect, it } from "vitest";
import { openDb } from "../src/index.ts";
import { ConflictError, NotFoundError } from "../src/errors.ts";

describe("shadow runs repo", () => {
  it("creates, gets, lists newest first and dedupes agent ids", () => {
    const db = openDb(":memory:");
    const a = db.shadowRuns.create({ plannedDays: 14, agentIds: ["sdr-01", "sdr-01", "am-01"], notes: "first", startedAt: "2026-10-01T00:00:00.000Z" });
    expect(a.agentIds).toEqual(["sdr-01", "am-01"]);
    expect(a.endedAt).toBeNull();
    expect(db.shadowRuns.get(a.id)).toEqual(a);
    expect(db.shadowRuns.getActive()?.id).toBe(a.id);
    db.shadowRuns.end(a.id);
    const b = db.shadowRuns.create({ plannedDays: 7, agentIds: [], startedAt: "2026-11-01T00:00:00.000Z" });
    expect(db.shadowRuns.list().map((r) => r.id)).toEqual([b.id, a.id]);
    db.close();
  });

  it("allows only one active run and ends a run exactly once", () => {
    const db = openDb(":memory:");
    const a = db.shadowRuns.create({ plannedDays: 14, agentIds: ["x"] });
    expect(() => db.shadowRuns.create({ plannedDays: 14, agentIds: ["x"] })).toThrow(ConflictError);
    const ended = db.shadowRuns.end(a.id, { notes: "done", endedAt: "2026-10-15T00:00:00.000Z" });
    expect(ended.endedAt).toBe("2026-10-15T00:00:00.000Z");
    expect(ended.notes).toBe("done");
    expect(db.shadowRuns.getActive()).toBeNull();
    expect(() => db.shadowRuns.end(a.id)).toThrow(ConflictError);
    expect(() => db.shadowRuns.end("nope")).toThrow(NotFoundError);
    expect(() => db.shadowRuns.create({ plannedDays: 14, agentIds: [] })).not.toThrow();
    db.close();
  });
});
