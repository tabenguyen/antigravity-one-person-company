import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "@agyhq/core";
import { openDb } from "../src/index.ts";

function withAgent(db: ReturnType<typeof openDb>, id = "cos-01") {
  db.agents.create({ id, role: "chief-of-staff", displayName: "Khoa", model: "m", workspacePath: `/tmp/${id}`, policy: { builtins: [], mcp: [] } });
}

describe("briefings repo", () => {
  it("creates, gets, looks up by task and lists latest first", () => {
    const db = openDb(":memory:");
    withAgent(db);
    const a = db.briefings.create({ agentId: "cos-01", taskId: "tsk_a", periodStart: "2026-10-01T00:00:00.000Z", periodEnd: "2026-10-02T00:00:00.000Z", markdown: "# One" });
    const b = db.briefings.create({ agentId: "cos-01", taskId: "tsk_b", periodStart: "2026-10-02T00:00:00.000Z", periodEnd: "2026-10-03T00:00:00.000Z", markdown: "# Two" });
    expect(db.briefings.get(a.id)).toEqual(a);
    expect(db.briefings.getByTaskId("tsk_b")?.id).toBe(b.id);
    expect(db.briefings.getByTaskId("nope")).toBeNull();
    expect(db.briefings.list().map((x) => x.markdown)).toEqual(["# Two", "# One"]);
    expect(db.briefings.list({ limit: 1 })).toHaveLength(1);
    expect(db.briefings.list({ agentId: "someone-else" })).toEqual([]);
    db.close();
  });

  it("allows one briefing per task", () => {
    const db = openDb(":memory:");
    withAgent(db);
    const input = { agentId: "cos-01", taskId: "tsk_a", periodStart: "2026-10-01T00:00:00.000Z", periodEnd: "2026-10-02T00:00:00.000Z", markdown: "x" };
    db.briefings.create(input);
    expect(() => db.briefings.create(input)).toThrow();
    db.close();
  });
});

describe("phase 4 domain defaults", () => {
  it("settings default the AM / CoS agents to null", () => {
    const db = openDb(":memory:");
    expect(db.settings.get()).toMatchObject({ defaultAmAgentId: null, defaultCosAgentId: null });
    expect(DEFAULT_SETTINGS.defaultAmAgentId).toBeNull();
    db.close();
  });

  it("stores the new customer / churned stages", () => {
    const db = openDb(":memory:");
    const { contact } = db.crm.upsertContact({ email: "a@acme.com" });
    expect(db.crm.setStage(contact.id, "customer", "won").stage).toBe("customer");
    expect(db.crm.setStage(contact.id, "churned", "cancelled").stage).toBe("churned");
    expect(db.crm.getContact(contact.id)?.stage).toBe("churned");
    db.close();
  });
});
