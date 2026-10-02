import { describe, expect, it } from "vitest";
import type { EvalCaseResult } from "@agyhq/core";
import { ConflictError } from "@agyhq/db";
import { EventBus, type BusEvent } from "../src/event-bus.ts";
import { abortAllEvals, failInterruptedEvalRuns, startEvalRun, waitForEval } from "../src/evals/manager.ts";
import type { EvalRunnerOptions } from "../src/evals/runner.ts";
import { makeTestConfig, openTestDb } from "./helpers.ts";

const pass = (caseId: string): EvalCaseResult => ({ caseId, status: "pass", durationMs: 5, assertions: [{ name: "a", ok: true }], output: {} });

function setup(run: (o: EvalRunnerOptions) => Promise<{ model: string; results: EvalCaseResult[] }>) {
  const config = makeTestConfig(); // real templates: the shipped sales-sdr suite (7 cases)
  const db = openTestDb();
  const bus = new EventBus();
  const events: BusEvent[] = [];
  bus.subscribe((e) => events.push(e));
  return { config, db, bus, events, deps: { config, db, bus, run } };
}

describe("eval manager", () => {
  it("persists per-case progress, finishes with a summary, audits and emits updates", async () => {
    let resolveSecond!: () => void;
    const gate = new Promise<void>((r) => (resolveSecond = r));
    const { db, events, deps } = setup(async (o) => {
      expect(o.model).toBe("m-1");
      expect(o.caseIds).toEqual(["reply-not-now-q1", "research-out-of-icp"]);
      o.onCaseDone?.(pass("reply-not-now-q1"), [pass("reply-not-now-q1")]);
      await gate;
      const fail: EvalCaseResult = { caseId: "research-out-of-icp", status: "fail", durationMs: 7, assertions: [{ name: "x", ok: false }], output: {} };
      return { model: "m-1", results: [pass("reply-not-now-q1"), fail] };
    });
    const run = startEvalRun(deps, { suite: "sales-sdr", model: "m-1", caseIds: ["reply-not-now-q1", "research-out-of-icp"] });
    expect(run.status).toBe("running");
    await new Promise((r) => setTimeout(r, 20));
    expect(db.evalRuns.get(run.id)!.results.map((r) => r.caseId)).toEqual(["reply-not-now-q1"]); // visible mid-run

    expect(() => startEvalRun(deps, { suite: "sales-sdr" })).toThrow(ConflictError);
    resolveSecond();
    await waitForEval(db, run.id);

    const done = db.evalRuns.get(run.id)!;
    expect(done).toMatchObject({ status: "done", summary: { total: 2, pass: 1, fail: 1, error: 0, skipped: 0 } });
    expect(db.audit.list({ kind: ["eval.finished"] })[0]!.data).toMatchObject({ runId: run.id, status: "done", summary: { fail: 1 } });
    const statuses = events.filter((e) => e.type === "eval.updated").map((e) => `${e.data["status"]}:${e.data["done"]}/${e.data["total"]}`);
    expect(statuses).toEqual(["running:0/2", "running:1/2", "done:2/2"]);

    // a new run is allowed once the first finished
    const again = startEvalRun({ ...deps, run: async () => ({ model: "m", results: [] }) }, { suite: "sales-sdr", caseIds: ["research-out-of-icp"] });
    await waitForEval(db, again.id);
  });

  it("a crashing runner marks the run failed and the unfinished cases skipped", async () => {
    const { db, deps } = setup(async (o) => {
      o.onCaseDone?.(pass("reply-not-now-q1"), [pass("reply-not-now-q1")]);
      throw new Error("daemon exploded");
    });
    const run = startEvalRun(deps, { suite: "sales-sdr", caseIds: ["reply-not-now-q1", "research-out-of-icp"] });
    await waitForEval(db, run.id);
    const failed = db.evalRuns.get(run.id)!;
    expect(failed.status).toBe("failed");
    expect(failed.results.map((r) => `${r.caseId}:${r.status}`)).toEqual(["reply-not-now-q1:pass", "research-out-of-icp:skipped"]);
    expect(failed.summary).toMatchObject({ pass: 1, skipped: 1 });
    expect(db.audit.list({ kind: ["eval.finished"] })[0]!.data).toMatchObject({ status: "failed", error: "daemon exploded" });
  });

  it("abortAllEvals signals the runner and waits for it", async () => {
    const { db, deps } = setup((o) =>
      new Promise((resolve) => {
        o.signal!.addEventListener("abort", () => resolve({ model: "m", results: [{ caseId: "research-out-of-icp", status: "skipped", durationMs: 0, assertions: [], output: null }] }));
      }),
    );
    const run = startEvalRun(deps, { suite: "sales-sdr", caseIds: ["research-out-of-icp"] });
    await abortAllEvals(db);
    expect(db.evalRuns.get(run.id)!.status).toBe("done");
  });

  it("failInterruptedEvalRuns closes runs a dead process left running", () => {
    const { db } = setup(async () => ({ model: "m", results: [] }));
    const stale = db.evalRuns.create({ suite: "sales-sdr", model: "m" });
    db.evalRuns.updateResults(stale.id, [pass("x")]);
    expect(failInterruptedEvalRuns(db)).toBe(1);
    expect(db.evalRuns.get(stale.id)).toMatchObject({ status: "failed", summary: { pass: 1 } });
    expect(failInterruptedEvalRuns(db)).toBe(0);
  });
});
