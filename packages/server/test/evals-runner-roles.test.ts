import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTaskInput, runEvalCases, seedCase, teammateSpecs } from "../src/evals/runner.ts";
import { EvalCaseZ } from "../src/evals/types.ts";
import { hasPriorThread } from "../src/quality/lint-context.ts";
import { makeTestConfig, openTestDb } from "./helpers.ts";
import { addAgent, writeFixtureTemplates } from "./phase4-helpers.ts";

const FAKE_EVAL_AGY = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "fixtures/fake-eval-agy.mjs");

const ROSTER = [
  { agentId: "eval-sdr", role: "sales-sdr", displayName: "Mai", kinds: ["sdr.research_lead"] },
  { agentId: "eval-am", role: "account-manager", displayName: "Linh", kinds: ["am.handle_message"] },
];

const TRIAGE_CASE = {
  id: "triage-to-am",
  description: "customer question is delegated to the AM",
  kind: "cos.triage",
  contact: { email: "quang@minhphat-eval.example", name: "Quang", stage: "customer" },
  input: { inboundEventId: "evt-1", subject: "How do I export?", body: "where is export", classification: "other", roster: ROSTER },
  assertions: [
    { type: "result.status", equals: "done" },
    { type: "result.data.path", path: "decision.action", equals: "delegated" },
    { type: "result.data.path", path: "decision.reason", pattern: "^customer .*export" },
    { type: "result.data.path", path: "decision.reason", notPattern: "refund" },
    { type: "result.data.path", path: "decision.assigneeAgentId", contains: "eval-am" },
    { type: "task.created", kind: "am.handle_message", assigneeAgentId: "eval-am", equals: 1 },
    { type: "task.created", kind: "am.handle_message", assigneeAgentId: "eval-sdr", equals: 0 },
    { type: "contact.stage", equals: "customer" },
    { type: "tool.notCalled", tool: "outbox_draft_email" },
  ],
};

describe("eval runner — roster agents and chief-of-staff cases", () => {
  let root: string;
  let templatesRoot: string;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "agyhq-evals-roles-"));
    templatesRoot = path.join(root, "templates");
    writeFixtureTemplates(templatesRoot);
    const evals = path.join(templatesRoot, "chief-of-staff/evals");
    fs.mkdirSync(evals, { recursive: true });
    fs.writeFileSync(path.join(evals, "suite.json"), JSON.stringify({ companyName: "Eval Co", displayName: "Khoa" }));
    fs.writeFileSync(path.join(evals, "01-triage.json"), JSON.stringify(TRIAGE_CASE));
    process.env.FAKE_EVAL_SCRIPT = JSON.stringify([
      {
        match: "quang@minhphat-eval.example",
        actions: [{ tool: "task_create", input: { kind: "am.handle_message", title: "Customer question", assigneeAgentId: "eval-am", input: { contactEmail: "quang@minhphat-eval.example" } } }],
        result: { status: "done", summary: "delegated", data: { decision: { action: "delegated", assigneeAgentId: "eval-am", kind: "am.handle_message", reason: "customer asks how to export" } } },
      },
    ]);
  });

  afterAll(() => {
    delete process.env.FAKE_EVAL_SCRIPT;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("provisions the roster agents so task_create can delegate, and observes tasks created for them", async () => {
    const { results } = await runEvalCases({ config: makeTestConfig({ agyBin: FAKE_EVAL_AGY, templatesRoot }), suite: "chief-of-staff" });
    expect(results).toHaveLength(1);
    expect(results[0]!.status, JSON.stringify(results[0]!.assertions)).toBe("pass");
    expect(results[0]!.output).toMatchObject({ tasksCreated: [{ kind: "am.handle_message", assigneeAgentId: "eval-am" }] });
  }, 60_000);

  it("teammateSpecs reads agents + roster (deduped, never the eval agent)", () => {
    const c = EvalCaseZ.parse({ ...TRIAGE_CASE, agents: [{ id: "eval-am", role: "account-manager", displayName: "Custom" }, { id: "eval-agent", role: "chief-of-staff" }] });
    expect(teammateSpecs(c)).toEqual([
      { id: "eval-am", role: "account-manager", displayName: "Custom" },
      { id: "eval-sdr", role: "sales-sdr", displayName: "Mai" },
    ]);
  });

  it("seedCase: owner is the eval agent by default, can be none, and the stage can be customer", () => {
    const db = openTestDb();
    addAgent(db, "eval-agent", "account-manager");
    const c = EvalCaseZ.parse({ ...TRIAGE_CASE });
    const owned = seedCase(db, "eval-agent", c);
    expect(db.crm.getContact(owned.contactId)).toMatchObject({ ownerAgentId: "eval-agent", stage: "customer" });
    const none = seedCase(db, "eval-agent", EvalCaseZ.parse({ ...TRIAGE_CASE, contact: { email: "other@x.example" } }), { ownerAgentId: null });
    expect(db.crm.getContact(none.contactId)!.ownerAgentId).toBeNull();
  });

  it("seedCase stores a thread.inbound message as an inbound event, so a Re: reply to it is not a deceptive subject", () => {
    const db = openTestDb();
    addAgent(db, "eval-agent", "sales-sdr");
    const c = EvalCaseZ.parse({
      ...TRIAGE_CASE,
      contact: { email: "An.Le@x.example", name: "An" },
      thread: { inbound: [{ subject: "Do you support Amazon?", body: "Does it work with Amazon?" }] },
    });
    seedCase(db, "eval-agent", c);
    const events = db.inbound.listByThreadKey("contact:an.le@x.example", 5);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ fromAddress: "an.le@x.example", subject: "Do you support Amazon?", classification: "new_lead", status: "routed" });
    expect(hasPriorThread(db, "an.le@x.example")).toBe(true);
  });

  it("the task input carries contactId when a contact is seeded (case input still wins)", () => {
    const c = EvalCaseZ.parse(TRIAGE_CASE);
    expect(buildTaskInput(c)).toMatchObject({ contactEmail: "quang@minhphat-eval.example", subject: "How do I export?" });
    const c2 = EvalCaseZ.parse({ ...TRIAGE_CASE, input: { ...TRIAGE_CASE.input, contactId: "mine" } });
    expect({ contactId: "seeded", ...buildTaskInput(c2) }["contactId"]).toBe("mine");
  });
});
