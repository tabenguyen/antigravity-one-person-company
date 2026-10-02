import { describe, expect, it } from "vitest";
import { evaluateAssertion, type CaseObservation } from "../src/evals/assertions.ts";
import type { EvalAssertion } from "../src/evals/types.ts";

function obs(overrides: Partial<CaseObservation> = {}): CaseObservation {
  return {
    taskStatus: "waiting_approval",
    result: { status: "needs_human", summary: "Prospect asked about price", data: { classification: "interested", nested: { a: 1 } } },
    drafts: [
      { to: "lan@x.example", subject: "Re: sync", body: "Hi Lan, happy to talk Tuesday. Pricing comes from our sales team after the call. Mai", status: "pending_approval", lint: [] },
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
      drafts: [{ to: "a@b.c", subject: "s", body: "b", status: "pending_approval", lint: [{ code: "unknown_price", severity: "error", message: "m" }, { code: "too_long", severity: "warn", message: "m" }] }],
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
});
