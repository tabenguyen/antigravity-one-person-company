import { describe, expect, it } from "vitest";
import { openDb } from "../src/index.ts";

describe("memory", () => {
  it("proposes memories as pending and lets a human accept/reject them", () => {
    const db = openDb(":memory:");
    db.agents.create({
      id: "sdr-01",
      role: "sales-sdr",
      displayName: "SDR",
      model: "m",
      workspacePath: "/tmp/sdr-01",
      policy: { builtins: [], mcp: [] },
    });

    const item = db.memory.propose("sdr-01", "Jane prefers Vietnamese", "contact:jane@acme.com");
    expect(item.status).toBe("pending");

    const bySubject = db.memory.list("sdr-01", { subject: "contact:jane@acme.com" });
    expect(bySubject).toHaveLength(1);

    const accepted = db.memory.setStatus(item.id, "accepted");
    expect(accepted.status).toBe("accepted");

    const pendingOnly = db.memory.list("sdr-01", { status: "pending" });
    expect(pendingOnly).toHaveLength(0);
    db.close();
  });
});
