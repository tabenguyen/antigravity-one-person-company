import { describe, expect, it } from "vitest";
import { openDb } from "../src/index.ts";
import { TaskTransitionError } from "../src/errors.ts";
import type { Db } from "../src/index.ts";
import type { ToolPolicy } from "@agyhq/core";

const POLICY: ToolPolicy = { builtins: [], mcp: [] };

function makeAgent(db: Db, id: string, overrides: Partial<Parameters<Db["agents"]["create"]>[0]> = {}) {
  return db.agents.create({
    id,
    role: "sales-sdr",
    displayName: id,
    model: "gemini-3-flash",
    workspacePath: `/tmp/${id}`,
    policy: POLICY,
    maxConcurrency: 1,
    ...overrides,
  });
}

describe("tasks.transition", () => {
  it("allows a valid transition and records an audit event", () => {
    const db = openDb(":memory:");
    makeAgent(db, "sdr-01");
    const task = db.tasks.create({ agentId: "sdr-01", kind: "sdr.research_lead", title: "t1" });
    expect(task.status).toBe("queued");

    const updated = db.tasks.transition(task.id, "running");
    expect(updated.status).toBe("running");

    const events = db.audit.list({ taskId: task.id, kind: ["task.transition"] });
    expect(events.some((e) => e.data.from === "queued" && e.data.to === "running")).toBe(true);
    db.close();
  });

  it("rejects an invalid transition", () => {
    const db = openDb(":memory:");
    makeAgent(db, "sdr-01");
    const task = db.tasks.create({ agentId: "sdr-01", kind: "sdr.research_lead", title: "t1" });
    expect(() => db.tasks.transition(task.id, "done")).toThrow(TaskTransitionError);
    db.close();
  });

  it("done and cancelled are terminal", () => {
    const db = openDb(":memory:");
    makeAgent(db, "sdr-01");
    const task = db.tasks.create({ agentId: "sdr-01", kind: "k", title: "t" });
    db.tasks.transition(task.id, "running");
    const done = db.tasks.transition(task.id, "done", { result: { status: "done", summary: "ok" } });
    expect(done.status).toBe("done");
    expect(() => db.tasks.transition(done.id, "queued")).toThrow(TaskTransitionError);
    db.close();
  });
});

describe("tasks.claimNext", () => {
  it("picks the highest-priority queued task first, then oldest createdAt", () => {
    const db = openDb(":memory:");
    makeAgent(db, "sdr-01", { maxConcurrency: 5 });
    const low = db.tasks.create({ agentId: "sdr-01", kind: "k", title: "low", priority: 0 });
    const high = db.tasks.create({ agentId: "sdr-01", kind: "k", title: "high", priority: 10 });

    const claimed = db.tasks.claimNext(new Date().toISOString());
    expect(claimed?.id).toBe(high.id);
    expect(claimed?.status).toBe("running");
    expect(claimed?.attempts).toBe(1);

    const next = db.tasks.claimNext(new Date().toISOString());
    expect(next?.id).toBe(low.id);
    db.close();
  });

  it("skips tasks whose wakeAt is in the future", () => {
    const db = openDb(":memory:");
    makeAgent(db, "sdr-01", { maxConcurrency: 5 });
    const future = new Date(Date.now() + 3600_000).toISOString();
    db.tasks.create({ agentId: "sdr-01", kind: "k", title: "future", wakeAt: future });
    const ready = db.tasks.create({ agentId: "sdr-01", kind: "k", title: "ready" });

    const claimed = db.tasks.claimNext(new Date().toISOString());
    expect(claimed?.id).toBe(ready.id);

    // Nothing else claimable right now.
    expect(db.tasks.claimNext(new Date().toISOString())).toBeNull();

    // Once "now" passes wakeAt, it becomes claimable.
    const claimedFuture = db.tasks.claimNext(future);
    expect(claimedFuture).not.toBeNull();
    db.close();
  });

  it("never claims tasks belonging to a paused agent", () => {
    const db = openDb(":memory:");
    makeAgent(db, "sdr-paused", { status: "paused" });
    db.tasks.create({ agentId: "sdr-paused", kind: "k", title: "t" });
    expect(db.tasks.claimNext(new Date().toISOString())).toBeNull();
    db.close();
  });

  it("respects an agent's maxConcurrency", () => {
    const db = openDb(":memory:");
    makeAgent(db, "sdr-01", { maxConcurrency: 1 });
    db.tasks.create({ agentId: "sdr-01", kind: "k", title: "a" });
    db.tasks.create({ agentId: "sdr-01", kind: "k", title: "b" });

    const first = db.tasks.claimNext(new Date().toISOString());
    expect(first).not.toBeNull();
    // Second claim should find nothing: the one running task already saturates maxConcurrency=1.
    expect(db.tasks.claimNext(new Date().toISOString())).toBeNull();

    db.tasks.transition(first!.id, "done", { result: { status: "done", summary: "ok" } });
    const second = db.tasks.claimNext(new Date().toISOString());
    expect(second).not.toBeNull();
    db.close();
  });

  it("never runs two tasks with the same non-null threadKey concurrently", () => {
    const db = openDb(":memory:");
    makeAgent(db, "sdr-01", { maxConcurrency: 5 });
    db.tasks.create({ agentId: "sdr-01", kind: "k", title: "a", threadKey: "contact:jane@acme.com" });
    db.tasks.create({ agentId: "sdr-01", kind: "k", title: "b", threadKey: "contact:jane@acme.com" });
    db.tasks.create({ agentId: "sdr-01", kind: "k", title: "c", threadKey: null });

    const first = db.tasks.claimNext(new Date().toISOString());
    expect(first).not.toBeNull();
    // With the thread locked, only the unrelated (threadKey=null) task is claimable.
    const second = db.tasks.claimNext(new Date().toISOString());
    expect(second?.threadKey).toBeNull();
    // Nothing else left (the other same-thread task is still blocked).
    expect(db.tasks.claimNext(new Date().toISOString())).toBeNull();
    db.close();
  });

  it("is safe to call repeatedly with nothing left to claim", () => {
    const db = openDb(":memory:");
    makeAgent(db, "sdr-01");
    expect(db.tasks.claimNext(new Date().toISOString())).toBeNull();
    expect(db.tasks.claimNext(new Date().toISOString())).toBeNull();
    db.close();
  });
});

describe("tasks.requeue / listDue", () => {
  it("requeue sets wakeAt and moves a running task back to queued", () => {
    const db = openDb(":memory:");
    makeAgent(db, "sdr-01");
    const task = db.tasks.create({ agentId: "sdr-01", kind: "k", title: "t" });
    db.tasks.transition(task.id, "running");
    const wakeAt = new Date(Date.now() + 1000).toISOString();
    const requeued = db.tasks.requeue(task.id, wakeAt);
    expect(requeued.status).toBe("queued");
    expect(requeued.wakeAt).toBe(wakeAt);
    db.close();
  });

  it("listDue returns only queued tasks whose wakeAt has arrived", () => {
    const db = openDb(":memory:");
    makeAgent(db, "sdr-01");
    const now = new Date();
    const past = new Date(now.getTime() - 1000).toISOString();
    const future = new Date(now.getTime() + 100_000).toISOString();
    const dueTask = db.tasks.create({ agentId: "sdr-01", kind: "k", title: "due", wakeAt: past });
    db.tasks.create({ agentId: "sdr-01", kind: "k", title: "not-due", wakeAt: future });
    db.tasks.create({ agentId: "sdr-01", kind: "k", title: "no-wake" });

    const due = db.tasks.listDue(now.toISOString());
    expect(due.map((t) => t.id)).toEqual([dueTask.id]);
    db.close();
  });
});

describe("tasks.recoverStale", () => {
  it("resets running tasks back to queued", () => {
    const db = openDb(":memory:");
    makeAgent(db, "sdr-01");
    const task = db.tasks.create({ agentId: "sdr-01", kind: "k", title: "t" });
    db.tasks.transition(task.id, "running");
    const ids = db.tasks.recoverStale();
    expect(ids).toEqual([task.id]);
    expect(db.tasks.get(task.id)?.status).toBe("queued");
    db.close();
  });
});
