import { describe, expect, it } from "vitest";
import { openDb } from "../src/index.ts";

describe("audit", () => {
  it("appends and lists newest-first, with filters", () => {
    const db = openDb(":memory:");
    db.audit.append({ kind: "kb.search", agentId: "sdr-01", taskId: null, conversationId: null, data: { q: "a" } });
    db.audit.append({ kind: "memory.proposed", agentId: "sdr-01", taskId: "tsk-1", conversationId: null, data: {} });
    db.audit.append({ kind: "kb.search", agentId: "sdr-02", taskId: null, conversationId: null, data: { q: "b" } });

    const all = db.audit.list();
    expect(all).toHaveLength(3);
    // newest first
    expect(all[0]!.data).toEqual({ q: "b" });

    const byAgent = db.audit.list({ agentId: "sdr-01" });
    expect(byAgent).toHaveLength(2);

    const byKind = db.audit.list({ kind: ["kb.search"] });
    expect(byKind).toHaveLength(2);
    expect(byKind.every((e) => e.kind === "kb.search")).toBe(true);

    const byTask = db.audit.list({ taskId: "tsk-1" });
    expect(byTask).toHaveLength(1);

    const limited = db.audit.list({ limit: 1 });
    expect(limited).toHaveLength(1);
    db.close();
  });
});
