import { describe, it, expect, afterEach } from "vitest";
import type { Task } from "@agyhq/core";
import { RunTokenRegistry } from "../src/agent-api/index.ts";
import { createAgent } from "../src/provision.ts";
import { Orchestrator, THROTTLE_PRIORITY_FLOOR } from "../src/orchestrator.ts";
import { QuotaMonitor } from "../src/quota.ts";
import { EventBus } from "../src/event-bus.ts";
import { makeTestConfig, openTestDb, waitFor, RESEARCH_LEAD_INPUT } from "./helpers.ts";

function setFakeResult(result: Record<string, unknown> | null): void {
  if (result === null) delete process.env.FAKE_AGY_RESULT;
  else process.env.FAKE_AGY_RESULT = JSON.stringify(result);
}

function setFakeScenario(scenario: string | null): void {
  if (scenario === null) delete process.env.FAKE_AGY_SCENARIO;
  else process.env.FAKE_AGY_SCENARIO = scenario;
}

describe("Orchestrator — task lifecycle", () => {
  const orchestrators: Orchestrator[] = [];

  afterEach(async () => {
    setFakeResult(null);
    setFakeScenario(null);
    delete process.env.FAKE_AGY_QUOTA_FRACTION;
    await Promise.all(orchestrators.splice(0).map((o) => o.stop()));
  });

  function setup(overrides: Parameters<typeof makeTestConfig>[0] = {}, agentMaxConcurrency = 10) {
    const config = makeTestConfig(overrides);
    const db = openTestDb();
    const bus = new EventBus();
    const tokens = new RunTokenRegistry();
    const agent = createAgent(
      { config, db },
      { id: "sdr-01", role: "sales-sdr", displayName: "Mai", maxConcurrency: agentMaxConcurrency },
    );
    const orchestrator = new Orchestrator({ config, db, bus, tokens, backoffMinutes: [0, 0, 0] });
    orchestrators.push(orchestrator);
    return { config, db, bus, tokens, agent, orchestrator };
  }

  it("ok outcome with status done -> task done, with the structured result saved", async () => {
    const { db, agent, orchestrator } = setup();
    setFakeResult({ status: "done", summary: "qualified", data: { fit: "pass" } });

    const task = db.tasks.create({
      agentId: agent.id,
      kind: "sdr.research_lead",
      title: "Research Example Co",
      input: RESEARCH_LEAD_INPUT,
    });

    orchestrator.start();
    await waitFor(() => db.tasks.get(task.id)!.status === "done");

    const final = db.tasks.get(task.id)!;
    expect(final.result?.status).toBe("done");
    expect(final.result?.data).toEqual({ fit: "pass" });
    db.close();
  });

  it("needs_human -> waiting_approval", async () => {
    const { db, agent, orchestrator } = setup();
    setFakeResult({ status: "needs_human", summary: "not enough info" });

    const task = db.tasks.create({
      agentId: agent.id,
      kind: "sdr.research_lead",
      title: "Research Example Co",
      input: RESEARCH_LEAD_INPUT,
    });

    orchestrator.start();
    await waitFor(() => db.tasks.get(task.id)!.status === "waiting_approval");
    db.close();
  });

  it("a followUp in the result creates a delayed follow-up task for the same agent/thread", async () => {
    const { db, agent, orchestrator } = setup();
    setFakeResult({
      status: "done",
      summary: "qualified, scheduling follow-up",
      followUp: { afterHours: 48, note: "check back after demo" },
    });

    const task = db.tasks.create({
      agentId: agent.id,
      kind: "sdr.research_lead",
      title: "Research Example Co",
      input: RESEARCH_LEAD_INPUT,
      threadKey: "contact:lan@example.com",
    });

    orchestrator.start();
    await waitFor(() => db.tasks.get(task.id)!.status === "done");

    await waitFor(() => db.tasks.list({ agentId: agent.id }).length === 2);
    const followUp = db.tasks.list({ agentId: agent.id }).find((t) => t.id !== task.id)!;
    expect(followUp.parentTaskId).toBe(task.id);
    expect(followUp.threadKey).toBe("contact:lan@example.com");
    expect(followUp.status).toBe("queued");
    expect(followUp.wakeAt).not.toBeNull();
    expect(new Date(followUp.wakeAt!).getTime()).toBeGreaterThan(Date.now());
    expect((followUp.input as Record<string, unknown>).note).toBe("check back after demo");
    db.close();
  });

  it("transient outcome backs off, then fails after maxAttempts", async () => {
    const { db, agent, orchestrator } = setup();
    setFakeScenario("exit1"); // -> RunOutcome "error", a transient outcome

    const task = db.tasks.create({
      agentId: agent.id,
      kind: "sdr.research_lead",
      title: "Research Example Co",
      input: RESEARCH_LEAD_INPUT,
      maxAttempts: 2,
    });

    orchestrator.start();
    await waitFor(() => db.tasks.get(task.id)!.status === "failed", 10_000);

    const final = db.tasks.get(task.id)!;
    expect(final.attempts).toBe(2);
    expect(final.error).toContain("after 2 attempts");

    const transitions = db.audit.list({ taskId: task.id, kind: ["task.transition"] });
    // at least one requeue (queued) before the final failed transition.
    expect(transitions.some((t) => (t.data as { to?: string }).to === "queued")).toBe(true);
    db.close();
  });

  it("denied outcome fails immediately without retrying", async () => {
    const { db, agent, orchestrator } = setup();
    setFakeScenario("denied_actions");

    const task = db.tasks.create({
      agentId: agent.id,
      kind: "sdr.research_lead",
      title: "Research Example Co",
      input: RESEARCH_LEAD_INPUT,
      maxAttempts: 5,
    });

    orchestrator.start();
    await waitFor(() => db.tasks.get(task.id)!.status === "failed");

    const final = db.tasks.get(task.id)!;
    expect(final.attempts).toBe(1); // no retry
    expect(final.error).toContain("denied");
    db.close();
  });

  it("unknown task kind fails immediately with a clear error", async () => {
    const { db, agent, orchestrator } = setup();

    const task = db.tasks.create({
      agentId: agent.id,
      kind: "sdr.nonexistent_kind",
      title: "Bogus task",
      input: {},
    });

    orchestrator.start();
    await waitFor(() => db.tasks.get(task.id)!.status === "failed");

    const final = db.tasks.get(task.id)!;
    expect(final.error).toContain('unknown task kind "sdr.nonexistent_kind"');
    db.close();
  });

  it("respects the global worker concurrency limit", async () => {
    const { db, agent, orchestrator } = setup({ workerConcurrency: 2 }, 10);
    setFakeResult({ status: "done", summary: "done" });

    const tasks: Task[] = [];
    for (let i = 0; i < 5; i++) {
      tasks.push(
        db.tasks.create({
          agentId: agent.id,
          kind: "sdr.research_lead",
          title: `Research ${i}`,
          input: RESEARCH_LEAD_INPUT,
        }),
      );
    }

    orchestrator.start();

    // At every point while tasks remain, no more than 2 should be running at once.
    let sawRunning = false;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const running = db.tasks.list({ agentId: agent.id, status: ["running"] });
      expect(running.length).toBeLessThanOrEqual(2);
      if (running.length > 0) sawRunning = true;
      if (tasks.every((t) => db.tasks.get(t.id)!.status === "done")) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(tasks.every((t) => db.tasks.get(t.id)!.status === "done")).toBe(true);
    expect(sawRunning).toBe(true);
    db.close();
  });

  it("while quota-throttled, only claims tasks at/above the priority floor", async () => {
    process.env.FAKE_AGY_QUOTA_FRACTION = "0.05"; // below the 0.15 default floor -> throttled
    const config = makeTestConfig();
    const db = openTestDb();
    const bus = new EventBus();
    const tokens = new RunTokenRegistry();
    const agent = createAgent({ config, db }, { id: "sdr-01", role: "sales-sdr", displayName: "Mai", maxConcurrency: 10 });
    const quota = new QuotaMonitor({ config, db, bus });
    await quota.start();
    expect(quota.isThrottled()).toBe(true);

    const orchestrator = new Orchestrator({ config, db, bus, tokens, quota, backoffMinutes: [0, 0, 0] });
    orchestrators.push(orchestrator);

    setFakeResult({ status: "done", summary: "done" });
    const low = db.tasks.create({
      agentId: agent.id,
      kind: "sdr.research_lead",
      title: "low priority",
      input: RESEARCH_LEAD_INPUT,
      priority: 0,
    });
    const high = db.tasks.create({
      agentId: agent.id,
      kind: "sdr.research_lead",
      title: "high priority (inbound reply)",
      input: RESEARCH_LEAD_INPUT,
      priority: THROTTLE_PRIORITY_FLOOR,
    });

    orchestrator.start();
    await waitFor(() => db.tasks.get(high.id)!.status === "done");

    // Give the low-priority task a few idle ticks to prove it's being skipped, not just slow.
    await new Promise((r) => setTimeout(r, 150));
    expect(db.tasks.get(low.id)!.status).toBe("queued");

    quota.stop();
    db.close();
  });

  it("while only the Gemini quota is low, an agent on a Claude model keeps claiming low-priority work", async () => {
    process.env.FAKE_AGY_QUOTA_FRACTION = "0.01"; // Gemini drained; Claude/GPT stays at the fixture's 0.6
    const config = makeTestConfig();
    const db = openTestDb();
    const bus = new EventBus();
    const tokens = new RunTokenRegistry();
    const gemini = createAgent({ config, db }, { id: "sdr-01", role: "sales-sdr", displayName: "Mai", maxConcurrency: 10 });
    const claude = createAgent({ config, db }, { id: "sdr-02", role: "sales-sdr", displayName: "Lan", maxConcurrency: 10, model: "claude-sonnet-5-5-medium" });
    expect(gemini.model.startsWith("gemini")).toBe(true);
    const quota = new QuotaMonitor({ config, db, bus });
    await quota.start();
    expect(quota.isThrottled()).toBe(true);

    const orchestrator = new Orchestrator({ config, db, bus, tokens, quota, backoffMinutes: [0, 0, 0] });
    orchestrators.push(orchestrator);
    setFakeResult({ status: "done", summary: "done" });
    const geminiLow = db.tasks.create({ agentId: gemini.id, kind: "sdr.research_lead", title: "gemini low", input: RESEARCH_LEAD_INPUT, priority: 0 });
    const claudeLow = db.tasks.create({ agentId: claude.id, kind: "sdr.research_lead", title: "claude low", input: RESEARCH_LEAD_INPUT, priority: 0 });

    orchestrator.start();
    await waitFor(() => db.tasks.get(claudeLow.id)!.status === "done");
    await new Promise((r) => setTimeout(r, 150));
    expect(db.tasks.get(geminiLow.id)!.status).toBe("queued");

    quota.stop();
    db.close();
  });

  it("graceful shutdown requeues in-flight tasks instead of letting them backoff", async () => {
    const { db, agent, orchestrator } = setup({ runTimeoutMs: 20_000 });
    setFakeScenario("result");
    // No FAKE_AGY_RESULT delay mechanism is available in the fixture, so to
    // reliably catch a task mid-flight we stop the orchestrator immediately
    // after starting it — the fake agy process still takes a few ms of real
    // process-spawn overhead, which is enough for the task to be "running".
    setFakeResult({ status: "done", summary: "done" });

    const task = db.tasks.create({
      agentId: agent.id,
      kind: "sdr.research_lead",
      title: "Research Example Co",
      input: RESEARCH_LEAD_INPUT,
    });

    orchestrator.start();
    await waitFor(() => db.tasks.get(task.id)!.status === "running");
    await orchestrator.stop();

    const final = db.tasks.get(task.id)!;
    expect(["queued", "done"]).toContain(final.status);
    if (final.status === "queued") {
      expect(final.wakeAt).toBeNull(); // immediate requeue, not a backoff wakeAt
    }
    db.close();
  });
});
