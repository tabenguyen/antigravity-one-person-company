import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EvalRun, Routine } from "@agyhq/core";
import { createAdminApi } from "../src/admin-api.ts";
import { createAgent } from "../src/provision.ts";
import { EventBus, type BusEvent } from "../src/event-bus.ts";
import { waitForEval } from "../src/evals/manager.ts";
import { makeTestConfig, openTestDb, REPO_ROOT } from "./helpers.ts";

const FAKE_EVAL_AGY = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "fixtures/fake-eval-agy.mjs");

function build(overrides: Parameters<typeof makeTestConfig>[0] = {}) {
  const config = makeTestConfig(overrides);
  const db = openTestDb();
  const bus = new EventBus();
  const events: BusEvent[] = [];
  bus.subscribe((e) => events.push(e));
  createAgent({ config, db }, { id: "sdr-01", role: "sales-sdr", displayName: "Mai" });
  const app = createAdminApi({ config, db, bus });
  const headers = { authorization: `Bearer ${config.adminToken}`, "content-type": "application/json" };
  async function call<T = any>(method: string, p: string, body?: unknown): Promise<{ status: number; body: { ok: boolean; data?: T; error?: { code: string; message: string } } }> {
    const res = await app.request(p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as never };
  }
  return { config, db, bus, events, app, call };
}

describe("routine routes", () => {
  it("requires the admin token", async () => {
    const { app } = build();
    expect((await app.request("/v1/admin/routines")).status).toBe(401);
  });

  it("creates with defaults, computes nextRunAt, lists (filter by agent), patches and deletes", async () => {
    const { call, db } = build();
    const created = await call<{ routine: Routine }>("POST", "/v1/admin/routines", {
      agentId: "sdr-01",
      kind: "prospecting",
      name: "Morning prospecting",
      schedule: "0 9 * * 1-5",
      config: { batchSize: 8 },
    });
    expect(created.status).toBe(200);
    const r = created.body.data!.routine;
    expect(r).toMatchObject({ agentId: "sdr-01", kind: "prospecting", timezone: "Asia/Ho_Chi_Minh", enabled: true, lastRunAt: null, config: { batchSize: 8, stages: ["new"] } });
    expect(new Date(r.nextRunAt!).getTime()).toBeGreaterThan(Date.now());
    expect(new Date(r.nextRunAt!).getUTCHours()).toBe(2); // 09:00 +07

    const list = await call<{ routines: Routine[] }>("GET", "/v1/admin/routines?agentId=sdr-01");
    expect(list.body.data!.routines.map((x) => x.id)).toEqual([r.id]);
    expect((await call<{ routines: Routine[] }>("GET", "/v1/admin/routines?agentId=other")).body.data!.routines).toEqual([]);

    // rescheduling recomputes nextRunAt; renaming does not
    const renamed = await call<{ routine: Routine }>("PATCH", `/v1/admin/routines/${r.id}`, { name: "Renamed" });
    expect(renamed.body.data!.routine).toMatchObject({ name: "Renamed", nextRunAt: r.nextRunAt });
    const moved = await call<{ routine: Routine }>("PATCH", `/v1/admin/routines/${r.id}`, { schedule: "30 8 * * *", timezone: "UTC" });
    expect(moved.body.data!.routine.nextRunAt).not.toBe(r.nextRunAt);
    expect(new Date(moved.body.data!.routine.nextRunAt!).getUTCMinutes()).toBe(30);

    // disabling clears nextRunAt; re-enabling restores it
    const off = await call<{ routine: Routine }>("PATCH", `/v1/admin/routines/${r.id}`, { enabled: false });
    expect(off.body.data!.routine).toMatchObject({ enabled: false, nextRunAt: null });
    const on = await call<{ routine: Routine }>("PATCH", `/v1/admin/routines/${r.id}`, { enabled: true });
    expect(on.body.data!.routine.nextRunAt).not.toBeNull();

    const del = await call("DELETE", `/v1/admin/routines/${r.id}`);
    expect(del.body).toMatchObject({ ok: true, data: { deleted: true } });
    expect(db.routines.list()).toHaveLength(0);
    expect((await call("DELETE", `/v1/admin/routines/${r.id}`)).status).toBe(404);
    expect((await call("PATCH", `/v1/admin/routines/${r.id}`, { name: "x" })).status).toBe(404);
  });

  it.each([
    [{ schedule: "61 9 * * *" }, /minute: value 61/],
    [{ schedule: "0 9 * * *", timezone: "Nope/Zone" }, /unknown timezone/],
    [{ schedule: "0 9 * * * *" }, /exactly 5 fields/],
    [{ kind: "prospecting", config: { batchSize: 99 } }, /batchSize/],
    [{ kind: "prospecting", config: { stages: ["bogus"] } }, /stages/],
    [{ kind: "custom_task", config: { title: "t" } }, /kind/],
    [{ kind: "custom_task", config: { kind: "sdr.nonexistent", title: "t" } }, /not defined by the sales-sdr template/],
    [{ agentId: "ghost" }, /agent not found/],
  ])("rejects invalid input %j", async (patch, message) => {
    const { call } = build();
    const res = await call("POST", "/v1/admin/routines", { agentId: "sdr-01", kind: "prospecting", name: "x", schedule: "0 9 * * *", ...patch });
    expect([400, 404]).toContain(res.status);
    expect(res.body.ok).toBe(false);
    expect(res.body.error!.message).toMatch(message);
  });

  it("pipeline_review routines are accepted (kind exists in the SDR template)", async () => {
    const { call } = build();
    const res = await call<{ routine: Routine }>("POST", "/v1/admin/routines", { agentId: "sdr-01", kind: "pipeline_review", name: "Daily review", schedule: "30 8 * * *" });
    expect(res.status).toBe(200);
    expect(res.body.data!.routine.config).toEqual({ maxContacts: 40, staleAfterDays: 7 });
  });

  it("run-now executes immediately regardless of schedule, emits routine.ran, and keeps nextRunAt", async () => {
    const { call, db, events } = build();
    db.crm.upsertContact({ email: "lead@x.example", name: "Lead" });
    const created = await call<{ routine: Routine }>("POST", "/v1/admin/routines", { agentId: "sdr-01", kind: "prospecting", name: "p", schedule: "0 9 * * 1-5" });
    const before = created.body.data!.routine;
    const res = await call<{ routine: Routine }>("POST", `/v1/admin/routines/${before.id}/run`);
    expect(res.status).toBe(200);
    expect(res.body.data!.routine).toMatchObject({ lastResult: "queued 1 research task (1 eligible)", nextRunAt: before.nextRunAt });
    expect(res.body.data!.routine.lastRunAt).not.toBeNull();
    expect(db.tasks.list()).toHaveLength(1);
    expect(events.some((e) => e.type === "routine.ran")).toBe(true);
    expect((await call("POST", "/v1/admin/routines/nope/run")).status).toBe(404);
  });
});

describe("eval routes", () => {
  let root: string;
  let templatesRoot: string;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "agyhq-evalroutes-test-"));
    templatesRoot = path.join(root, "templates");
    fs.cpSync(path.join(REPO_ROOT, "templates/sales-sdr"), path.join(templatesRoot, "sales-sdr"), { recursive: true });
    const evalsDir = path.join(templatesRoot, "sales-sdr/evals");
    fs.rmSync(evalsDir, { recursive: true, force: true });
    fs.mkdirSync(evalsDir, { recursive: true });
    fs.writeFileSync(
      path.join(evalsDir, "01.json"),
      JSON.stringify({
        id: "route-case",
        description: "route test",
        kind: "sdr.handle_reply",
        contact: { email: "route@fakeco-eval.example", name: "Route" },
        thread: { inbound: [{ body: "interested" }] },
        assertions: [{ type: "result.status", equals: "done" }, { type: "contact.stage", equals: "qualified" }],
      }),
    );
    process.env.FAKE_EVAL_SCRIPT = JSON.stringify([
      {
        match: "route@fakeco-eval.example",
        actions: [{ tool: "crm_set_stage", input: { contactEmail: "route@fakeco-eval.example", stage: "qualified", reason: "x" } }],
        result: { status: "done", summary: "ok", data: {} },
      },
    ]);
  });
  afterAll(() => {
    delete process.env.FAKE_EVAL_SCRIPT;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("lists suites with their cases", async () => {
    const { call } = build({ templatesRoot });
    const res = await call<{ suites: { name: string; defaultModel: string; cases: { id: string }[] }[] }>("GET", "/v1/admin/evals/suites");
    expect(res.body.data!.suites).toEqual([{ name: "sales-sdr", defaultModel: "gemini-3.8-flash-medium", cases: [{ id: "route-case", description: "route test", kind: "sdr.handle_reply" }] }]);
  });

  it("starts a run (async), persists results, audits eval.finished and emits eval.updated", async () => {
    const { call, db, events } = build({ templatesRoot, agyBin: FAKE_EVAL_AGY });
    const start = await call<{ run: EvalRun }>("POST", "/v1/admin/evals", { suite: "sales-sdr", model: "gemini-test-model" });
    expect(start.status).toBe(200);
    const started = start.body.data!.run;
    expect(started).toMatchObject({ suite: "sales-sdr", model: "gemini-test-model", status: "running", results: [], summary: null });

    // a second start while one is running is refused
    const again = await call("POST", "/v1/admin/evals", { suite: "sales-sdr" });
    expect(again.status).toBe(409);

    await waitForEval(db, started.id);
    const got = await call<{ run: EvalRun }>("GET", `/v1/admin/evals/${started.id}`);
    const run = got.body.data!.run;
    expect(run.status).toBe("done");
    expect(run.summary).toEqual({ total: 1, pass: 1, fail: 0, error: 0, skipped: 0 });
    expect(run.results[0]).toMatchObject({ caseId: "route-case", status: "pass" });
    expect(run.finishedAt).not.toBeNull();

    const list = await call<{ runs: EvalRun[] }>("GET", "/v1/admin/evals?suite=sales-sdr&limit=5");
    expect(list.body.data!.runs.map((r) => r.id)).toEqual([started.id]);
    expect((await call<{ runs: EvalRun[] }>("GET", "/v1/admin/evals?suite=other")).body.data!.runs).toEqual([]);

    expect(db.audit.list({ kind: ["eval.finished"] })[0]!.data).toMatchObject({ runId: started.id, suite: "sales-sdr", model: "gemini-test-model", summary: { pass: 1 } });
    const updates = events.filter((e) => e.type === "eval.updated").map((e) => e.data["status"]);
    expect(updates[0]).toBe("running");
    expect(updates.at(-1)).toBe("done");
  }, 30_000);

  it("validates start requests", async () => {
    const { call } = build({ templatesRoot });
    expect((await call("POST", "/v1/admin/evals", { suite: "nope" })).status).toBe(400);
    const bad = await call("POST", "/v1/admin/evals", { suite: "sales-sdr", caseIds: ["ghost"] });
    expect(bad.status).toBe(400);
    expect(bad.body.error!.message).toMatch(/unknown case id/);
    expect((await call("GET", "/v1/admin/evals/missing")).status).toBe(404);
  });
});
