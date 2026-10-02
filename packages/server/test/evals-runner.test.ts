import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { buildTaskInput, runEvalCases } from "../src/evals/runner.ts";
import type { EvalCase } from "../src/evals/types.ts";
import { makeTestConfig, REPO_ROOT } from "./helpers.ts";

const FAKE_EVAL_AGY = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "fixtures/fake-eval-agy.mjs");

const THANKS = "Hi Lan, thanks for the reply. Pricing comes from our sales team after a short intro call, so I'm passing your question to them. Does Tuesday afternoon work for the call?\n\nMai, StockSync";

function caseFile(c: Record<string, unknown>): string {
  return JSON.stringify(c, null, 2);
}

const REPLY_CASE = {
  id: "reply-price",
  description: "interested + price",
  kind: "sdr.handle_reply",
  contact: { email: "lan@fakeco-eval.example", name: "Lan", companyName: "FakeCo", companyDomain: "fakeco-eval.example" },
  thread: { sent: [{ subject: "Hello", body: "first touch body" }], inbound: [{ body: "What does it cost?" }] },
  assertions: [
    { type: "result.status", equals: "needs_human" },
    { type: "outbox.count", equals: 1 },
    { type: "draft.notContains", pattern: "\\$\\s?\\d" },
    { type: "contact.stage", equals: "replied" },
    { type: "tool.called", tool: "crm_set_stage" },
  ],
};
const BAD_PRICE_CASE = {
  id: "reply-invents-price",
  description: "agent promises a guarantee -> must FAIL; and its priced draft attempt is refused by lint",
  kind: "sdr.handle_reply",
  contact: { email: "bad@fakeco-eval.example", name: "Bad" },
  thread: { inbound: [{ body: "price?" }] },
  assertions: [{ type: "draft.notContains", value: "guarantee" }, { type: "outbox.count", equals: 1 }, { type: "draft.lintErrors", equals: 0 }],
};
const FAILED_CASE = {
  id: "agent-fails",
  description: "agent reports failure -> error",
  kind: "sdr.research_lead",
  contact: { email: "err@fakeco-eval.example" },
  input: { context: "x" },
  assertions: [{ type: "result.status", equals: "done" }],
};
const FOLLOWUP_CASE = {
  id: "followup-child",
  description: "creates a follow-up via task_create; must not be run by the eval daemon",
  kind: "sdr.handle_reply",
  contact: { email: "later@fakeco-eval.example" },
  thread: { inbound: [{ body: "not now" }] },
  assertions: [
    { type: "contact.stage", equals: "nurture" },
    { type: "task.created", kind: "sdr.follow_up", min: 1, minWakeHours: 24 * 30 },
    { type: "outbox.count", equals: 0 },
  ],
};
const HANG_CASE = { id: "hangs", description: "never finishes", kind: "sdr.handle_reply", contact: { email: "hang@fakeco-eval.example" }, thread: { inbound: [{ body: "hi" }] }, assertions: [{ type: "result.status", equals: "done" }] };

const SCRIPT = [
  {
    match: "lan@fakeco-eval.example",
    actions: [
      { tool: "crm_set_stage", input: { contactEmail: "lan@fakeco-eval.example", stage: "replied", reason: "interested" } },
      { tool: "outbox_draft_email", input: { to: "lan@fakeco-eval.example", subject: "Re: Hello", body: THANKS, reason: "answer + handoff" } },
    ],
    result: { status: "needs_human", summary: "Asked for price; routed to sales.", data: { classification: "interested" } },
  },
  {
    match: "bad@fakeco-eval.example",
    actions: [
      { tool: "outbox_draft_email", input: { to: "bad@fakeco-eval.example", subject: "Re", body: "It is $49 per month.", reason: "answer" } },
      { tool: "outbox_draft_email", input: { to: "bad@fakeco-eval.example", subject: "Re", body: "We guarantee results. Want a call this week?", reason: "answer" } },
    ],
    result: { status: "done", summary: "answered", data: {} },
  },
  { match: "err@fakeco-eval.example", result: { status: "failed", summary: "could not research" } },
  {
    match: "later@fakeco-eval.example",
    actions: [
      { tool: "crm_set_stage", input: { contactEmail: "later@fakeco-eval.example", stage: "nurture", reason: "not now" } },
      { tool: "task_create", input: { kind: "sdr.follow_up", title: "Check back", afterHours: 2160, input: {} } },
    ],
    result: { status: "done", summary: "nurture + follow-up", data: { classification: "not-now" } },
  },
  { match: "hang@fakeco-eval.example", hang: true },
];

describe("eval runner (fake agy)", () => {
  let root: string;
  let templatesRoot: string;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "agyhq-evalrunner-test-"));
    templatesRoot = path.join(root, "templates");
    fs.cpSync(path.join(REPO_ROOT, "templates/sales-sdr"), path.join(templatesRoot, "sales-sdr"), { recursive: true });
    const evalsDir = path.join(templatesRoot, "sales-sdr/evals");
    fs.rmSync(evalsDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(evalsDir, "kb"), { recursive: true });
    fs.writeFileSync(path.join(evalsDir, "suite.json"), JSON.stringify({ companyName: "StockSync", caseTimeoutMs: 20000 }));
    fs.writeFileSync(path.join(evalsDir, "kb/pricing.md"), "# Pricing policy\n\nWe do not publish prices.\n");
    fs.writeFileSync(path.join(evalsDir, "10-reply.json"), caseFile(REPLY_CASE));
    fs.writeFileSync(path.join(evalsDir, "20-others.json"), JSON.stringify([BAD_PRICE_CASE, FAILED_CASE, FOLLOWUP_CASE, HANG_CASE]));
    process.env.FAKE_EVAL_SCRIPT = JSON.stringify(SCRIPT);
  });

  afterAll(() => {
    delete process.env.FAKE_EVAL_SCRIPT;
    fs.rmSync(root, { recursive: true, force: true });
  });

  function config() {
    return makeTestConfig({ agyBin: FAKE_EVAL_AGY, templatesRoot });
  }

  it("runs cases in isolated daemons and reports pass / fail / error with per-assertion detail", async () => {
    const seen: string[] = [];
    const { model, results } = await runEvalCases({
      config: config(),
      suite: "sales-sdr",
      caseIds: ["reply-price", "reply-invents-price", "agent-fails", "followup-child"],
      onCaseDone: (r) => seen.push(r.caseId),
    });
    expect(model).toBe("gemini-3.8-flash-medium");
    expect(results.map((r) => r.caseId)).toEqual(["reply-price", "reply-invents-price", "agent-fails", "followup-child"]);

    const byId = Object.fromEntries(results.map((r) => [r.caseId, r]));
    expect(byId["reply-price"]!.status, JSON.stringify(byId["reply-price"]!.assertions)).toBe("pass");
    expect(byId["reply-price"]!.assertions.every((a) => a.ok)).toBe(true);
    expect(byId["reply-price"]!.output).toMatchObject({ taskStatus: "waiting_approval", contactStage: "replied" });

    expect(byId["reply-invents-price"]!.status).toBe("fail");
    const failures = byId["reply-invents-price"]!.assertions.filter((a) => !a.ok);
    expect(failures.map((f) => f.name)).toEqual(["draft.notContains \"guarantee\"", "draft.lintErrors == 0"]);
    expect(failures[0]!.detail).toContain("guarantee");
    expect(failures[1]!.detail).toContain("refused by lint");

    expect(byId["agent-fails"]!.status).toBe("error");
    expect(byId["agent-fails"]!.assertions[0]).toMatchObject({ name: "run completed", ok: false });

    // the follow-up the agent created is observed but never executed (agent paused on settle)
    expect(byId["followup-child"]!.status, JSON.stringify(byId["followup-child"]!.assertions)).toBe("pass");
    expect(seen.sort()).toEqual(["agent-fails", "followup-child", "reply-invents-price", "reply-price"]);
  }, 60_000);

  it("times a case out as an error instead of hanging", async () => {
    const { results } = await runEvalCases({ config: config(), suite: "sales-sdr", caseIds: ["hangs"], caseTimeoutMs: 1500 });
    expect(results[0]).toMatchObject({ caseId: "hangs", status: "error" });
    expect(results[0]!.assertions[0]!.detail).toMatch(/timed out/);
  }, 30_000);

  it("rejects unknown case ids and unknown suites before running anything", async () => {
    await expect(runEvalCases({ config: config(), suite: "sales-sdr", caseIds: ["nope"] })).rejects.toThrow(/unknown case id/);
    await expect(runEvalCases({ config: config(), suite: "nope" })).rejects.toThrow(/not found/);
  });

  it("buildTaskInput fills contact, reply and thread summary but lets the case override", () => {
    const input = buildTaskInput({ ...(REPLY_CASE as unknown as EvalCase), input: { contactName: "Override" } });
    expect(input).toMatchObject({ contactName: "Override", contactEmail: "lan@fakeco-eval.example", replyBody: "What does it cost?", leadCompanyName: "FakeCo" });
    expect(String(input["threadSummary"])).toContain('We sent ("Hello")');
  });
});
