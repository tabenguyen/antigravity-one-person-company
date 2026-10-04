import { describe, expect, it } from "vitest";
import { evaluateAssertion, type CaseObservation } from "../src/evals/assertions.ts";
import type { EvalAssertion } from "../src/evals/types.ts";

function obs(overrides: Partial<CaseObservation> = {}): CaseObservation {
  return {
    taskStatus: "waiting_approval",
    result: { status: "needs_human", summary: "Prospect asked about price", data: { classification: "interested", nested: { a: 1 } } },
    drafts: [
      { channel: "email", to: "lan@x.example", subject: "Re: sync", body: "Hi Lan, happy to talk Tuesday. Pricing comes from our sales team after the call. Mai", status: "pending_approval", lint: [] },
    ],
    contacts: [
      { email: "lan@x.example", stage: "replied" },
      { email: "hoa@x.example", stage: "new" },
    ],
    contactEmail: "lan@x.example",
    toolCalls: ["kb_search", "crm_find_contact", "crm_set_stage", "crm_set_stage"],
    childTasks: [
      { kind: "sdr.follow_up", title: "f", createdAt: "2026-10-01T00:00:00.000Z", wakeAt: "2026-12-30T00:00:00.000Z" },
      { kind: "sdr.follow_up", title: "g", createdAt: "2026-10-01T00:00:00.000Z", wakeAt: "2026-10-02T00:00:00.000Z" },
    ],
    allTasks: [{ kind: "sdr.handle_reply", agentId: "eval-agent" }],
    lintBlocked: [],
    ...overrides,
  };
}

const ev = (a: EvalAssertion, o = obs()) => evaluateAssertion(a, o);

describe("eval assertions", () => {
  it("result.status equals / oneOf", () => {
    expect(ev({ type: "result.status", equals: "needs_human" }).ok).toBe(true);
    expect(ev({ type: "result.status", equals: "done" })).toMatchObject({ ok: false, detail: "actual: needs_human" });
    expect(ev({ type: "result.status", oneOf: ["done", "needs_human"] }).ok).toBe(true);
    expect(ev({ type: "result.status", oneOf: ["done"] }, obs({ result: null, taskStatus: "failed" })).detail).toContain("no result");
  });

  it("result.data.path pattern / notPattern / contains", () => {
    const o = obs({ result: { status: "done", summary: "s", data: { decision: { action: "delegated", reason: "Customer asks how to export" }, tags: ["a", "B"] } } });
    expect(ev({ type: "result.data.path", path: "decision.reason", pattern: "^customer .*export" }, o).ok).toBe(true);
    expect(ev({ type: "result.data.path", path: "decision.reason", pattern: "refund" }, o).ok).toBe(false);
    expect(ev({ type: "result.data.path", path: "decision.reason", notPattern: "refund" }, o).ok).toBe(true);
    expect(ev({ type: "result.data.path", path: "decision.reason", notPattern: "export" }, o).ok).toBe(false);
    expect(ev({ type: "result.data.path", path: "missing", notPattern: "x" }, o).ok).toBe(true); // absent path passes notPattern
    expect(ev({ type: "result.data.path", path: "missing", pattern: "x" }, o)).toMatchObject({ ok: false, detail: "path not present" });
    expect(ev({ type: "result.data.path", path: "decision.reason", contains: "HOW TO" }, o).ok).toBe(true);
    expect(ev({ type: "result.data.path", path: "tags", contains: "b" }, o).ok).toBe(true);
    expect(ev({ type: "result.data.path", path: "tags", contains: "z" }, o).ok).toBe(false);
    // operators combine with AND; non-string values are matched on their JSON
    expect(ev({ type: "result.data.path", path: "decision.action", equals: "delegated", pattern: "^deleg" }, o).ok).toBe(true);
    expect(ev({ type: "result.data.path", path: "decision.action", equals: "delegated", pattern: "^nope" }, o).ok).toBe(false);
    expect(ev({ type: "result.data.path", path: "tags", pattern: "\"B\"" }, o).ok).toBe(true);
  });

  it("task.created can filter by assignee", () => {
    const o = obs({ childTasks: [{ kind: "am.handle_message", title: "x", createdAt: "2026-10-01T00:00:00.000Z", wakeAt: null, assigneeAgentId: "eval-am" }] });
    expect(ev({ type: "task.created", kind: "am.handle_message", assigneeAgentId: "eval-am", equals: 1 }, o).ok).toBe(true);
    expect(ev({ type: "task.created", kind: "am.handle_message", assigneeAgentId: "eval-sdr" }, o).ok).toBe(false);
    expect(ev({ type: "task.created", kind: "am.handle_message", assigneeAgentId: "eval-sdr", equals: 0 }, o).ok).toBe(true);
  });

  it("contact.stage works with customer / churned", () => {
    const o = obs({ contacts: [{ email: "lan@x.example", stage: "churned" }] });
    expect(ev({ type: "contact.stage", equals: "churned" }, o).ok).toBe(true);
    expect(ev({ type: "contact.stage", oneOf: ["customer", "churned"] }, o).ok).toBe(true);
    expect(ev({ type: "contact.stage", equals: "customer" }, o).ok).toBe(false);
  });

  it("result.data.path equals / oneOf / exists with dotted paths", () => {
    expect(ev({ type: "result.data.path", path: "classification", equals: "interested" }).ok).toBe(true);
    expect(ev({ type: "result.data.path", path: "classification", oneOf: ["a", "interested"] }).ok).toBe(true);
    expect(ev({ type: "result.data.path", path: "nested.a", equals: 1 }).ok).toBe(true);
    expect(ev({ type: "result.data.path", path: "nested.b", exists: true })).toMatchObject({ ok: false, detail: "path not present" });
    expect(ev({ type: "result.data.path", path: "nested.a", exists: true }).ok).toBe(true);
    expect(ev({ type: "result.data.path", path: "missing", equals: "x" }).ok).toBe(false);
  });

  it("outbox.count equals / min / max", () => {
    expect(ev({ type: "outbox.count", equals: 1 }).ok).toBe(true);
    expect(ev({ type: "outbox.count", equals: 0 }).ok).toBe(false);
    expect(ev({ type: "outbox.count", min: 1, max: 2 }).ok).toBe(true);
    expect(ev({ type: "outbox.count", max: 0 }).ok).toBe(false);
  });

  it("draft.contains / notContains are case-insensitive and support anyOf and pattern", () => {
    expect(ev({ type: "draft.contains", value: "PRICING" }).ok).toBe(true);
    expect(ev({ type: "draft.contains", anyOf: ["nope", "tuesday"] }).ok).toBe(true);
    expect(ev({ type: "draft.contains", pattern: "sales\\s+team" }).ok).toBe(true);
    expect(ev({ type: "draft.contains", value: "discount" }).ok).toBe(false);
    expect(ev({ type: "draft.notContains", pattern: "\\$\\s?\\d" }).ok).toBe(true);
    expect(ev({ type: "draft.notContains", value: "Tuesday" })).toMatchObject({ ok: false, detail: 'found "Tuesday"' });
    // with no drafts: contains fails, notContains passes vacuously
    expect(ev({ type: "draft.contains", value: "x" }, obs({ drafts: [] })).ok).toBe(false);
    expect(ev({ type: "draft.notContains", value: "x" }, obs({ drafts: [] }))).toMatchObject({ ok: true });
  });

  it("draft.maxWords checks every draft body", () => {
    expect(ev({ type: "draft.maxWords", max: 30 }).ok).toBe(true);
    expect(ev({ type: "draft.maxWords", max: 5 })).toMatchObject({ ok: false });
    expect(ev({ type: "draft.maxWords", max: 5 }, obs({ drafts: [] })).ok).toBe(true);
  });

  it("draft.lintErrors counts only error findings; missing lint is a pass with a note", () => {
    expect(ev({ type: "draft.lintErrors", equals: 0 }).detail).toContain("lint recorded no findings");
    const withLint = obs({
      drafts: [{ channel: "email", to: "a@b.c", subject: "s", body: "b", status: "pending_approval", lint: [{ code: "unknown_price", severity: "error", message: "m" }, { code: "too_long", severity: "warn", message: "m" }] }],
    });
    expect(ev({ type: "draft.lintErrors", equals: 0 }, withLint)).toMatchObject({ ok: false });
    expect(ev({ type: "draft.lintErrors", equals: 0 }, withLint).detail).toContain("1 stored draft error(s) (unknown_price)");
    expect(ev({ type: "draft.lintErrors", equals: 1 }, withLint).ok).toBe(true);
    // attempts the daemon refused count too
    const blocked = obs({ lintBlocked: [{ to: "lan@x.example", codes: ["unknown_price"] }] });
    expect(ev({ type: "draft.lintErrors", equals: 0 }, blocked)).toMatchObject({ ok: false });
    expect(ev({ type: "draft.lintErrors", equals: 0 }, blocked).detail).toContain("refused by lint (unknown_price)");
  });

  it("draft.notTo", () => {
    expect(ev({ type: "draft.notTo", email: "hoa@x.example" }).ok).toBe(true);
    expect(ev({ type: "draft.notTo", email: "LAN@x.example" }).ok).toBe(false);
  });

  it("contact.stage and contact.exists", () => {
    expect(ev({ type: "contact.stage", equals: "replied" }).ok).toBe(true);
    expect(ev({ type: "contact.stage", oneOf: ["nurture", "replied"] }).ok).toBe(true);
    expect(ev({ type: "contact.stage", equals: "nurture" })).toMatchObject({ ok: false, detail: "actual: replied" });
    expect(ev({ type: "contact.exists", email: "HOA@x.example" }).ok).toBe(true);
    expect(ev({ type: "contact.exists", email: "who@x.example" }).ok).toBe(false);
  });

  it("tool.called / tool.notCalled", () => {
    expect(ev({ type: "tool.called", tool: "crm_set_stage" })).toMatchObject({ ok: true });
    expect(ev({ type: "tool.called", tool: "outbox_draft_email" }).ok).toBe(false);
    expect(ev({ type: "tool.notCalled", tool: "outbox_draft_email" }).ok).toBe(true);
    expect(ev({ type: "tool.notCalled", tool: "kb_search" }).ok).toBe(false);
  });

  it("task.created by kind, with counts and minimum wake time", () => {
    expect(ev({ type: "task.created", kind: "sdr.follow_up" }).ok).toBe(true); // default: at least one
    expect(ev({ type: "task.created", kind: "sdr.follow_up", equals: 2 }).ok).toBe(true);
    expect(ev({ type: "task.created", kind: "sdr.first_touch", max: 0 }).ok).toBe(true);
    expect(ev({ type: "task.created", kind: "sdr.first_touch" }).ok).toBe(false);
    // only the Dec-30 follow-up is >= 14 days out
    expect(ev({ type: "task.created", kind: "sdr.follow_up", minWakeHours: 336, equals: 1 }).ok).toBe(true);
    expect(ev({ type: "task.created", kind: "sdr.follow_up", minWakeHours: 24 * 200 }).ok).toBe(false);
  });

  it("any passes when one branch passes", () => {
    const a: EvalAssertion = { type: "any", of: [{ type: "contact.exists", email: "nobody@x.example" }, { type: "tool.called", tool: "kb_search" }] };
    expect(ev(a).ok).toBe(true);
    expect(ev({ type: "any", of: [{ type: "contact.exists", email: "n@x.example" }, { type: "tool.called", tool: "zzz" }] }).ok).toBe(false);
  });

  it("outbox.count can be limited to one channel (a hide proposal is not a reply)", () => {
    const o = obs({
      drafts: [
        { channel: "facebook_hide", to: "fb:hide:c1", subject: "Hide", body: "quảng cáo", status: "pending_approval", lint: [] },
        { channel: "facebook_post", to: "fb:page:p", subject: "Post", body: "nội dung", status: "pending_approval", lint: [] },
      ],
    });
    expect(ev({ type: "outbox.count", channel: "facebook_hide", equals: 1 }, o).ok).toBe(true);
    expect(ev({ type: "outbox.count", channel: "facebook_reply", equals: 0 }, o).ok).toBe(true);
    expect(ev({ type: "outbox.count", channel: "facebook_reply", min: 1 }, o)).toMatchObject({ ok: false });
    expect(ev({ type: "outbox.count", equals: 2 }, o).ok).toBe(true); // no channel = all drafts
    expect(ev({ type: "outbox.count", channel: "facebook_reply", equals: 0 }, o).name).toContain("[facebook_reply]");
  });

  it("task.total counts tasks of a kind anywhere (default: at least one)", () => {
    const o = obs({ allTasks: [{ kind: "fanpage.reply_comment", agentId: "a" }, { kind: "sdr.research_lead", agentId: "b" }] });
    expect(ev({ type: "task.total", kind: "fanpage.reply_comment", equals: 1 }, o).ok).toBe(true);
    expect(ev({ type: "task.total", kind: "fanpage.reply_comment", max: 0 }, o).ok).toBe(false);
    expect(ev({ type: "task.total", kind: "sdr.research_lead" }, o).ok).toBe(true);
    expect(ev({ type: "task.total", kind: "fanpage.draft_post" }, o).ok).toBe(false);
  });
});
