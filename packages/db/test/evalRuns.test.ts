import { describe, expect, it } from "vitest";
import type { EvalCaseResult } from "@agyhq/core";
import { openDb, NotFoundError } from "../src/index.ts";

const result = (caseId: string, status: EvalCaseResult["status"]): EvalCaseResult => ({
  caseId,
  status,
  durationMs: 1000,
  assertions: [{ name: "result.status in [done]", ok: status === "pass" }],
  output: { status: "done" },
});

describe("evalRuns repo", () => {
  it("creates a running run, updates results, and finishes with a computed summary", () => {
    const db = openDb(":memory:");
    const run = db.evalRuns.create({ suite: "sales-sdr", model: "gemini-3.8-flash-medium" });
    expect(run).toMatchObject({ status: "running", finishedAt: null, results: [], summary: null });

    db.evalRuns.updateResults(run.id, [result("a", "pass")]);
    expect(db.evalRuns.get(run.id)?.results).toHaveLength(1);

    const done = db.evalRuns.finish(run.id, "done", [result("a", "pass"), result("b", "fail"), result("c", "error"), result("d", "skipped")]);
    expect(done.status).toBe("done");
    expect(done.finishedAt).not.toBeNull();
    expect(done.summary).toEqual({ total: 4, pass: 1, fail: 1, error: 1, skipped: 1 });
    expect(done.results.map((r) => r.caseId)).toEqual(["a", "b", "c", "d"]);
    db.close();
  });

  it("lists newest first, filters by suite, honors limit", () => {
    const db = openDb(":memory:");
    const a = db.evalRuns.create({ suite: "sales-sdr", model: "m1" });
    const b = db.evalRuns.create({ suite: "other", model: "m2" });
    const c = db.evalRuns.create({ suite: "sales-sdr", model: "m3" });
    expect(db.evalRuns.list().map((r) => r.id)).toEqual([c.id, b.id, a.id]);
    expect(db.evalRuns.list({ suite: "sales-sdr" }).map((r) => r.id)).toEqual([c.id, a.id]);
    expect(db.evalRuns.list({ limit: 1 })).toHaveLength(1);
    db.close();
  });

  it("throws NotFoundError for unknown ids", () => {
    const db = openDb(":memory:");
    expect(db.evalRuns.get("nope")).toBeNull();
    expect(() => db.evalRuns.updateResults("nope", [])).toThrow(NotFoundError);
    expect(() => db.evalRuns.finish("nope", "failed")).toThrow(NotFoundError);
    db.close();
  });
});
