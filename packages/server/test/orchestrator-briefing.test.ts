import { afterEach, describe, expect, it } from "vitest";
import { RunTokenRegistry } from "../src/agent-api/index.ts";
import { EventBus } from "../src/event-bus.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { createAgent } from "../src/provision.ts";
import { waitFor } from "./helpers.ts";
import { makePhase4Env } from "./phase4-helpers.ts";

describe("Orchestrator — daily digest becomes a briefing", () => {
  const orchestrators: Orchestrator[] = [];
  afterEach(async () => {
    delete process.env.FAKE_AGY_RESULT;
    await Promise.all(orchestrators.splice(0).map((o) => o.stop()));
  });

  function setup() {
    const env = makePhase4Env();
    createAgent({ config: env.config, db: env.db }, { id: "cos-01", role: "chief-of-staff", displayName: "Khoa" });
    const bus = new EventBus();
    const events: string[] = [];
    bus.subscribe((e) => events.push(e.type));
    const orchestrator = new Orchestrator({ config: env.config, db: env.db, bus, tokens: new RunTokenRegistry(), backoffMinutes: [0] });
    orchestrators.push(orchestrator);
    return { ...env, events, orchestrator };
  }
  const digestInput = { periodStart: "2026-10-01T01:00:00.000Z", periodEnd: "2026-10-02T01:00:00.000Z", snapshot: {} };

  it("a done cos.daily_digest with data.digestMarkdown stores a Briefing, audits and announces it", async () => {
    const t = setup();
    process.env.FAKE_AGY_RESULT = JSON.stringify({ status: "done", summary: "digest written", data: { digestMarkdown: "# Bản tin ngày\n\n- Không có gì cần xử lý." } });
    const task = t.db.tasks.create({ agentId: "cos-01", kind: "cos.daily_digest", title: "Daily digest", input: digestInput });
    t.orchestrator.start();
    await waitFor(() => t.db.tasks.get(task.id)!.status === "done");
    const [briefing] = t.db.briefings.list();
    expect(briefing).toMatchObject({ agentId: "cos-01", taskId: task.id, periodStart: digestInput.periodStart, periodEnd: digestInput.periodEnd, markdown: "# Bản tin ngày\n\n- Không có gì cần xử lý." });
    expect(t.db.audit.list({ kind: ["briefing.created"] })).toHaveLength(1);
    expect(t.events).toContain("briefing.created");
  });

  it("no briefing when the digest task did not produce markdown", async () => {
    const t = setup();
    process.env.FAKE_AGY_RESULT = JSON.stringify({ status: "done", summary: "nothing", data: {} });
    const task = t.db.tasks.create({ agentId: "cos-01", kind: "cos.daily_digest", title: "Daily digest", input: digestInput });
    t.orchestrator.start();
    await waitFor(() => t.db.tasks.get(task.id)!.status === "done");
    expect(t.db.briefings.list()).toEqual([]);
  });
});
