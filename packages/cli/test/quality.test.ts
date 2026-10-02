import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { serve, type ServerType } from "@hono/node-server";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { cmdPromote, cmdScorecard } from "../src/commands/quality.ts";

const criteria = { minDecided: 30, minApprovalRate: 0.85, maxMedianEditRatio: 0.15, maxComplianceRejections: 0, maxLintErrorsRate: 0.05 };
const card = (over: object) => ({
  agentId: "sdr-01", role: "sales-sdr", trustTier: "shadow", windowDays: 14, drafts: 12, decided: 10, approved: 7, rejected: 3,
  approvalRate: 0.7, editedRate: 0.4, medianEditRatio: 0.08, rejectionsByCategory: { tone: 2, compliance: 1 }, lintErrorRate: 0.1,
  medianReviewMinutes: 12.5, sent: 0, replies: 0, replyRate: null, tasks: { done: 1, failed: 0, needsHuman: 0 },
  promotion: { nextTier: "assisted", eligible: false, unmet: ["decided drafts 10 < 30", "approval rate 70% < 85%"] }, ...over,
});

describe("hq scorecard / hq promote", () => {
  let server: ServerType;
  let url: string;
  const requests: { method: string; path: string; query: string; body: unknown }[] = [];
  let promoteStatus = 200;

  beforeAll(async () => {
    const app = new Hono();
    app.get("/v1/admin/scorecards", (c) => {
      requests.push({ method: "GET", path: c.req.path, query: new URL(c.req.url).search, body: null });
      return c.json({ ok: true, data: { days: Number(c.req.query("days")), criteria, scorecards: [card({}), card({ agentId: "sdr-02", trustTier: "assisted", promotion: { nextTier: "autonomous", eligible: true, unmet: [] }, rejectionsByCategory: {} })] } });
    });
    app.get("/v1/admin/agents/:id", (c) => c.json({ ok: true, data: { agent: { id: c.req.param("id"), trustTier: "shadow" } } }));
    app.post("/v1/admin/agents/:id/promote", async (c) => {
      requests.push({ method: "POST", path: c.req.path, query: "", body: await c.req.json() });
      if (promoteStatus === 409) return c.json({ ok: false, error: { code: "conflict", message: "not eligible: approval rate 70% < 85%" } }, 409);
      return c.json({ ok: true, data: { agent: { id: c.req.param("id"), trustTier: "assisted" } } });
    });
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
    promoteStatus = 200;
  });

  const globals = () => ({ json: false, url, token: "t", cwd: fs.mkdtempSync(path.join(os.tmpdir(), "agyhq-cli-q-")) });
  function capture() {
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
    return out;
  }

  it("scorecard prints a table with metrics, rejection breakdown and unmet reasons", async () => {
    const out = capture();
    await cmdScorecard(["--days", "7", "--agent", "sdr-01"], globals());
    const text = out.join("\n");
    expect(requests[0]!.query).toContain("days=7");
    expect(requests[0]!.query).toContain("agentId=sdr-01");
    expect(text).toContain("window: last 7 days");
    expect(text).toContain("approval");
    expect(text).toContain("70%");
    expect(text).toContain("assisted");
    expect(text).toContain("tone=2, compliance=1");
    expect(text).toContain("sdr-01 not yet eligible for assisted");
    expect(text).toContain("- approval rate 70% < 85%");
    expect(text).toContain("sdr-02 is eligible for autonomous: hq promote sdr-02");
  });

  it("scorecard --json prints the raw response", async () => {
    const out = capture();
    await cmdScorecard([], { ...globals(), json: true });
    expect(JSON.parse(out.join("\n")).days).toBe(14);
  });

  it("--help prints usage without calling the daemon", async () => {
    const out = capture();
    await cmdScorecard(["--help"], globals());
    await cmdPromote(["--help"], globals());
    expect(out[0]).toContain("usage: hq scorecard");
    expect(out[1]).toContain("usage: hq promote");
    expect(requests).toHaveLength(0);
  });

  it("promote sends force/note and reports the tier change", async () => {
    const out = capture();
    await cmdPromote(["sdr-01", "--force", "--note", "owner call"], globals());
    expect(requests[0]).toMatchObject({ method: "POST", path: "/v1/admin/agents/sdr-01/promote", body: { force: true, note: "owner call" } });
    expect(out.join("\n")).toBe("sdr-01: shadow -> assisted (forced)");
  });

  it("promote surfaces the 409 reasons as an error", async () => {
    promoteStatus = 409;
    capture();
    await expect(cmdPromote(["sdr-01"], globals())).rejects.toThrow(/approval rate 70% < 85%/);
    expect(requests[0]!.body).toEqual({});
  });
});
