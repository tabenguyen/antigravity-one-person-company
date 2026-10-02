import { describe, expect, it } from "vitest";
import { openDb, NotFoundError } from "../src/index.ts";

function setup() {
  const db = openDb(":memory:");
  db.agents.create({
    id: "sdr-01",
    role: "sales-sdr",
    displayName: "Mai",
    model: "gemini-3.8-flash-medium",
    workspacePath: "/tmp/ws/sdr-01",
    policy: { builtins: [], mcp: [] },
  });
  return db;
}

describe("routines repo", () => {
  it("creates, gets, lists (optionally by agent), updates and deletes", () => {
    const db = setup();
    const r = db.routines.create({
      agentId: "sdr-01",
      kind: "prospecting",
      name: "Morning prospecting",
      schedule: "0 9 * * 1-5",
      timezone: "Asia/Ho_Chi_Minh",
      config: { batchSize: 5 },
      nextRunAt: "2026-10-02T02:00:00.000Z",
    });
    expect(r.enabled).toBe(true);
    expect(r.lastRunAt).toBeNull();
    expect(db.routines.get(r.id)).toEqual(r);
    expect(db.routines.list()).toHaveLength(1);
    expect(db.routines.list("sdr-01")).toHaveLength(1);
    expect(db.routines.list("nobody")).toHaveLength(0);

    const updated = db.routines.update(r.id, { name: "Renamed", config: { batchSize: 10 }, enabled: false, nextRunAt: null });
    expect(updated).toMatchObject({ name: "Renamed", config: { batchSize: 10 }, enabled: false, nextRunAt: null });
    expect(db.routines.get(r.id)?.schedule).toBe("0 9 * * 1-5");

    expect(db.routines.delete(r.id)).toBe(true);
    expect(db.routines.delete(r.id)).toBe(false);
    expect(db.routines.get(r.id)).toBeNull();
    expect(() => db.routines.update(r.id, { name: "x" })).toThrow(NotFoundError);
    db.close();
  });

  it("listDue returns only enabled routines whose nextRunAt has arrived, oldest first", () => {
    const db = setup();
    const mk = (name: string, nextRunAt: string | null, enabled = true) =>
      db.routines.create({ agentId: "sdr-01", kind: "pipeline_review", name, schedule: "0 8 * * *", timezone: "UTC", nextRunAt, enabled });
    const late = mk("late", "2026-10-01T09:00:00.000Z");
    const early = mk("early", "2026-10-01T07:00:00.000Z");
    mk("future", "2026-10-02T07:00:00.000Z");
    mk("disabled", "2026-10-01T06:00:00.000Z", false);
    mk("never", null);
    const due = db.routines.listDue("2026-10-01T10:00:00.000Z");
    expect(due.map((r) => r.id)).toEqual([early.id, late.id]);
    db.close();
  });

  it("markRan records last run/result and moves nextRunAt", () => {
    const db = setup();
    const r = db.routines.create({
      agentId: "sdr-01",
      kind: "custom_task",
      name: "x",
      schedule: "0 8 * * *",
      timezone: "UTC",
      nextRunAt: "2026-10-01T08:00:00.000Z",
    });
    const ran = db.routines.markRan(r.id, "queued 3 research tasks (7 eligible)", "2026-10-02T08:00:00.000Z", "2026-10-01T08:00:05.000Z");
    expect(ran).toMatchObject({ lastRunAt: "2026-10-01T08:00:05.000Z", nextRunAt: "2026-10-02T08:00:00.000Z" });
    expect(db.routines.get(r.id)?.lastResult).toBe("queued 3 research tasks (7 eligible)");
    expect(db.routines.listDue("2026-10-01T09:00:00.000Z")).toHaveLength(0);
    expect(() => db.routines.markRan("nope", "x", null)).toThrow(NotFoundError);
    db.close();
  });
});
