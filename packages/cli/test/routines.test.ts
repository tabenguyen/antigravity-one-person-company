import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { serve, type ServerType } from "@hono/node-server";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import type { EvalRun, Routine } from "@agyhq/core";
import {
  cmdEval,
  cmdRoutine,
  evalCaseRows,
  evalFailureLines,
  formatDuration,
  parseEvalRunArgs,
  parseRoutineCreateArgs,
  parseRoutineUpdateArgs,
  routineRows,
  waitForEvalRun,
} from "../src/commands/routines.ts";

const routine = (over: Partial<Routine> = {}): Routine => ({
  id: "rtn_1", agentId: "sdr-01", kind: "prospecting", name: "Morning", schedule: "0 9 * * 1-5", timezone: "Asia/Ho_Chi_Minh", config: { batchSize: 5 },
  enabled: true, lastRunAt: null, nextRunAt: "2026-10-02T02:00:00.000Z", lastResult: null, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", ...over,
});

const finishedRun = (over: Partial<EvalRun> = {}): EvalRun => ({
  id: "evr_1", suite: "sales-sdr", model: "gemini-3.8-flash-medium", status: "done", startedAt: "2026-10-01T10:00:00.000Z", finishedAt: "2026-10-01T10:03:05.000Z",
  results: [
    { caseId: "reply-price", status: "pass", durationMs: 41_000, assertions: [{ name: "result.status == needs_human", ok: true }], output: {} },
    {
      caseId: "reply-vi", status: "fail", durationMs: 52_000, output: {},
      assertions: [{ name: "result.status in [done]", ok: true }, { name: "draft.contains /[à-ỹ]/i", ok: false, detail: "not found in any draft" }],
    },
    { caseId: "research", status: "error", durationMs: 1000, assertions: [{ name: "run completed", ok: false, detail: "task failed: boom" }], output: null },
  ],
  summary: { total: 3, pass: 1, fail: 1, error: 1, skipped: 0 }, ...over,
});

describe("hq routine / hq eval — argument parsing", () => {
  it("routine create: required flags, defaults, config JSON, --disabled", () => {
    const a = parseRoutineCreateArgs(["--agent", "sdr-01", "--kind", "prospecting", "--name", "Morning", "--schedule", "0 9 * * 1-5", "--tz", "UTC", "--config", '{"batchSize":3}', "--disabled"]);
    expect(a.body).toEqual({ agentId: "sdr-01", kind: "prospecting", name: "Morning", schedule: "0 9 * * 1-5", timezone: "UTC", config: { batchSize: 3 }, enabled: false });
    const b = parseRoutineCreateArgs(["--agent", "a", "--kind", "pipeline_review", "--name", "n", "--schedule", "30 8 * * *"]);
    expect(b.body).toMatchObject({ config: {}, enabled: true });
    expect(b.body).not.toHaveProperty("timezone");
    expect(parseRoutineCreateArgs(["--help"]).help).toBe(true);
    expect(() => parseRoutineCreateArgs(["--agent", "a"])).toThrow(/--kind is required/);
    expect(() => parseRoutineCreateArgs(["--agent", "a", "--kind", "nope", "--name", "n", "--schedule", "* * * * *"])).toThrow(/--kind must be one of/);
    expect(() => parseRoutineCreateArgs(["--agent", "a", "--kind", "prospecting", "--name", "n", "--schedule", "* * * * *", "--config", "{bad"])).toThrow(/valid JSON/);
    expect(() => parseRoutineCreateArgs(["--agent", "a", "--kind", "prospecting", "--name", "n", "--schedule", "* * * * *", "--config", "[]"])).toThrow(/JSON object/);
    expect(() => parseRoutineCreateArgs(["--bogus"])).toThrow(/Unknown option/);
  });

  it("routine update: maps flags onto the patch body", () => {
    expect(parseRoutineUpdateArgs(["rtn_1", "--schedule", "30 8 * * *", "--tz", "UTC", "--enabled", "false", "--name", "X", "--config", "{}"])).toEqual({
      help: false, id: "rtn_1", body: { schedule: "30 8 * * *", timezone: "UTC", enabled: false, name: "X", config: {} },
    });
    expect(() => parseRoutineUpdateArgs([])).toThrow(/routine update <id>/);
    expect(() => parseRoutineUpdateArgs(["rtn_1"])).toThrow(/nothing to update/);
    expect(() => parseRoutineUpdateArgs(["rtn_1", "--enabled", "maybe"])).toThrow(/"true" or "false"/);
  });

  it("eval run: defaults to the sales-sdr suite; --case is repeatable and comma separated", () => {
    expect(parseEvalRunArgs([])).toEqual({ help: false, wait: false, body: { suite: "sales-sdr" } });
    expect(parseEvalRunArgs(["--suite", "other", "--case", "a", "--case", "b,c", "--model", "m", "--wait"])).toEqual({
      help: false, wait: true, body: { suite: "other", model: "m", caseIds: ["a", "b", "c"] },
    });
    expect(() => parseEvalRunArgs(["--wat"])).toThrow(/Unknown option/);
  });

  it("formatters", () => {
    expect(formatDuration(450)).toBe("450ms");
    expect(formatDuration(41_000)).toBe("41s");
    expect(formatDuration(185_000)).toBe("3m05s");
    expect(routineRows([routine({ enabled: false })])[0]).toMatchObject({ schedule: "0 9 * * 1-5 (Asia/Ho_Chi_Minh)", enabled: "no", last: "-" });
    const rows = evalCaseRows(finishedRun().results);
    expect(rows.map((r) => r["result"])).toEqual(["PASS", "FAIL", "ERROR"]);
    expect(rows[1]).toMatchObject({ assertions: "1/2", failed: expect.stringContaining("draft.contains") });
    const lines = evalFailureLines(finishedRun().results).join("\n");
    expect(lines).toContain("FAIL reply-vi");
    expect(lines).toContain("not found in any draft");
    expect(lines).toContain("ERROR research");
    expect(lines).not.toContain("reply-price");
  });
});

describe("hq routine / hq eval — commands against a mock daemon", () => {
  let server: ServerType;
  let url: string;
  const requests: { method: string; path: string; query: string; body: unknown }[] = [];
  let pollCount = 0;

  beforeAll(async () => {
    const app = new Hono();
    const rec = async (c: { req: { method: string; path: string; url: string; json: () => Promise<unknown> } }, withBody: boolean) =>
      requests.push({ method: c.req.method, path: c.req.path, query: new URL(c.req.url).search, body: withBody ? await c.req.json().catch(() => null) : null });
    app.get("/v1/admin/routines", async (c) => (await rec(c, false), c.json({ ok: true, data: { routines: [routine()] } })));
    app.post("/v1/admin/routines", async (c) => (await rec(c, true), c.json({ ok: true, data: { routine: routine({ id: "rtn_new" }) } })));
    app.patch("/v1/admin/routines/:id", async (c) => (await rec(c, true), c.json({ ok: true, data: { routine: routine({ id: c.req.param("id"), name: "patched" }) } })));
    app.delete("/v1/admin/routines/:id", async (c) => (await rec(c, false), c.json({ ok: true, data: { deleted: true } })));
    app.post("/v1/admin/routines/:id/run", async (c) => (await rec(c, false), c.json({ ok: true, data: { routine: routine({ lastResult: "queued 3 research tasks (9 eligible)" }) } })));
    app.post("/v1/admin/evals", async (c) => {
      await rec(c, true);
      return c.json({ ok: true, data: { run: finishedRun({ status: "running", finishedAt: null, results: [], summary: null }) } });
    });
    app.get("/v1/admin/evals", async (c) => (await rec(c, false), c.json({ ok: true, data: { runs: [finishedRun()] } })));
    app.get("/v1/admin/evals/suites", async (c) =>
      c.json({ ok: true, data: { suites: [{ name: "sales-sdr", defaultModel: "m", cases: [{ id: "reply-price", kind: "sdr.handle_reply", description: "d" }] }] } }));
    app.get("/v1/admin/evals/:id", async (c) => {
      await rec(c, false);
      pollCount++;
      const full = finishedRun();
      if (pollCount === 1) return c.json({ ok: true, data: { run: { ...full, status: "running", finishedAt: null, summary: null, results: full.results.slice(0, 1) } } });
      return c.json({ ok: true, data: { run: full } });
    });
    app.get("/v1/admin/boom", (c) => c.json({ ok: false, error: { code: "internal", message: "x" } }, 500));
    const port = await new Promise<number>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => resolve(info.port));
    });
    url = `http://127.0.0.1:${port}`;
    process.env.AGYHQ_ADMIN_TOKEN = "t";
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    delete process.env.AGYHQ_ADMIN_TOKEN;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    requests.length = 0;
    pollCount = 0;
    process.exitCode = undefined;
  });

  const globals = (json = false) => ({ json, url, token: "t", cwd: fs.mkdtempSync(path.join(os.tmpdir(), "agyhq-cli-r-")) });
  function capture() {
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void err.push(a.join(" ")));
    return { out, err };
  }

  it("--help prints usage without calling the daemon", async () => {
    const { out } = capture();
    await cmdRoutine([], globals());
    await cmdRoutine(["--help"], globals());
    await cmdRoutine(["create", "--help"], globals());
    await cmdEval(["--help"], globals());
    await cmdEval(["run", "--help"], globals());
    expect(out.filter((l) => l.startsWith("usage: hq routine"))).toHaveLength(3);
    expect(out.filter((l) => l.startsWith("usage: hq eval"))).toHaveLength(2);
    expect(requests).toHaveLength(0);
  });

  it("routine list prints a table; --agent filters", async () => {
    const { out } = capture();
    await cmdRoutine(["list", "--agent", "sdr-01"], globals());
    expect(requests[0]).toMatchObject({ method: "GET", path: "/v1/admin/routines", query: "?agentId=sdr-01" });
    expect(out.join("\n")).toContain("Morning");
    expect(out.join("\n")).toContain("0 9 * * 1-5 (Asia/Ho_Chi_Minh)");
  });

  it("routine create / update / delete / run call the right routes", async () => {
    const { out } = capture();
    await cmdRoutine(["create", "--agent", "sdr-01", "--kind", "prospecting", "--name", "Morning", "--schedule", "0 9 * * 1-5", "--config", '{"batchSize":3}'], globals());
    expect(requests[0]).toMatchObject({ method: "POST", path: "/v1/admin/routines", body: { agentId: "sdr-01", kind: "prospecting", name: "Morning", schedule: "0 9 * * 1-5", config: { batchSize: 3 }, enabled: true } });
    expect(out[0]).toContain("created rtn_new");

    await cmdRoutine(["update", "rtn_1", "--enabled", "false"], globals());
    expect(requests[1]).toMatchObject({ method: "PATCH", path: "/v1/admin/routines/rtn_1", body: { enabled: false } });

    await cmdRoutine(["run", "rtn_1"], globals());
    expect(requests[2]).toMatchObject({ method: "POST", path: "/v1/admin/routines/rtn_1/run" });
    expect(out.join("\n")).toContain("queued 3 research tasks (9 eligible)");

    await cmdRoutine(["delete", "rtn_1"], globals());
    expect(requests[3]).toMatchObject({ method: "DELETE", path: "/v1/admin/routines/rtn_1" });
    expect(out.at(-1)).toBe("deleted rtn_1");
  });

  it("usage errors are printed as `hq: ...` with exit code 1, not thrown", async () => {
    const { err } = capture();
    await cmdRoutine(["create", "--agent", "a"], globals());
    expect(err[0]).toMatch(/^hq: --kind is required/);
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    await cmdRoutine(["bogus"], globals());
    expect(err[1]).toMatch(/unknown "routine" subcommand: bogus/);
    expect(requests).toHaveLength(0);
  });

  it("eval run without --wait starts the run and prints how to follow it", async () => {
    const { out } = capture();
    await cmdEval(["run", "--case", "reply-price", "--model", "m"], globals());
    expect(requests[0]).toMatchObject({ method: "POST", path: "/v1/admin/evals", body: { suite: "sales-sdr", model: "m", caseIds: ["reply-price"] } });
    expect(out.join("\n")).toContain("hq eval show evr_1");
  });

  it("eval run --wait polls until done, prints the case table and failure details, exits 1 when not all pass", async () => {
    const { out } = capture();
    process.env.AGYHQ_EVAL_POLL_MS = "5";
    try {
      await cmdEval(["run", "--wait"], globals());
    } finally {
      delete process.env.AGYHQ_EVAL_POLL_MS;
    }
    const text = out.join("\n");
    expect(text).toContain("1/3 passed, 1 failed, 1 error, 0 skipped");
    expect(text).toContain("reply-price");
    expect(text).toContain("PASS");
    expect(text).toContain("FAIL reply-vi");
    expect(text).toContain("not found in any draft");
    expect(text).toContain("1 case(s) finished");
    expect(process.exitCode).toBe(1);
  });

  it("eval list / show / suites", async () => {
    const { out } = capture();
    await cmdEval(["list", "--suite", "sales-sdr", "--limit", "5"], globals());
    expect(requests[0]!.query).toBe("?suite=sales-sdr&limit=5");
    expect(out.join("\n")).toContain("1/3");
    out.length = 0;
    pollCount = 1; // the mock returns a half-finished run on its first poll
    await cmdEval(["show", "evr_1"], globals());
    expect(out.join("\n")).toContain("run evr_1 [sales-sdr / gemini-3.8-flash-medium]");
    out.length = 0;
    await cmdEval(["suites"], globals());
    expect(out.join("\n")).toContain("reply-price");
  });

  it("--json prints raw data", async () => {
    const { out } = capture();
    await cmdEval(["list"], globals(true));
    expect(JSON.parse(out.join("\n"))[0].id).toBe("evr_1");
  });

  it("waitForEvalRun returns the finished run", async () => {
    let n = 0;
    const client = { get: async () => ({ run: n++ === 0 ? finishedRun({ status: "running", summary: null }) : finishedRun() }) } as never;
    const seen: number[] = [];
    const run = await waitForEvalRun(client, "evr_1", { intervalMs: 1, onProgress: (r) => seen.push(r.results.length) });
    expect(run.status).toBe("done");
    expect(seen).toEqual([3]);
  });
});
