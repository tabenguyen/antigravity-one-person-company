// Pure assertion evaluation over what a single eval case produced. No I/O, so it is
// unit-testable without a daemon.

import type { LintFinding, TaskResult } from "@agyhq/core";
import type { EvalAssertion } from "./types.ts";

export interface ObservedDraft {
  to: string;
  subject: string | null;
  body: string;
  status: string;
  lint: LintFinding[];
}

export interface ObservedChildTask {
  kind: string;
  title: string;
  createdAt: string;
  wakeAt: string | null;
  /** Agent the task was assigned to (task_create `assigneeAgentId`; the case's own agent for follow-ups). */
  assigneeAgentId?: string;
}

/** Everything an assertion may look at, captured after the task settled. */
export interface CaseObservation {
  taskStatus: string;
  result: TaskResult | null;
  /** Drafts created by the case's own task (seeded history excluded). */
  drafts: ObservedDraft[];
  /** All contacts in the eval db (email + stage), including ones the agent created. */
  contacts: { email: string; stage: string }[];
  /** The seeded contact's email (lowercase). */
  contactEmail: string;
  /** Tool names from tool.pre audit events: MCP tool names for call_mcp_tool, built-in names otherwise. */
  toolCalls: string[];
  /** Tasks created by the case's task (task_create or followUp), for any agent. */
  childTasks: ObservedChildTask[];
  /** Draft attempts the daemon's lint refused (audit "outbox.lint_blocked"): error-level findings, one entry per attempt. */
  lintBlocked: { to: string; codes: string[] }[];
}

export interface AssertionOutcome {
  name: string;
  ok: boolean;
  detail?: string;
}

const MAX_DETAIL = 280;
const clip = (s: string): string => (s.length > MAX_DETAIL ? `${s.slice(0, MAX_DETAIL)}…` : s);
const wordCount = (s: string): number => s.split(/\s+/).filter(Boolean).length;
const draftText = (d: ObservedDraft): string => `${d.subject ?? ""}\n${d.body}`;

function getPath(obj: unknown, path: string): { found: boolean; value: unknown } {
  let cur: unknown = obj;
  for (const key of path.split(".")) {
    if (cur === null || typeof cur !== "object" || !(key in (cur as Record<string, unknown>))) return { found: false, value: undefined };
    cur = (cur as Record<string, unknown>)[key];
  }
  return { found: true, value: cur };
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function countCheck(n: number, spec: { equals?: number; min?: number; max?: number }): { ok: boolean; expect: string } {
  const parts: string[] = [];
  let ok = true;
  if (spec.equals !== undefined) {
    parts.push(`== ${spec.equals}`);
    ok &&= n === spec.equals;
  }
  if (spec.min !== undefined) {
    parts.push(`>= ${spec.min}`);
    ok &&= n >= spec.min;
  }
  if (spec.max !== undefined) {
    parts.push(`<= ${spec.max}`);
    ok &&= n <= spec.max;
  }
  if (parts.length === 0) {
    parts.push(">= 0");
  }
  return { ok, expect: parts.join(" and ") };
}

interface Matcher {
  value?: string;
  anyOf?: string[];
  pattern?: string;
}

function matcherLabel(m: Matcher): string {
  return m.pattern !== undefined ? `/${m.pattern}/i` : m.anyOf ? `any of ${JSON.stringify(m.anyOf)}` : JSON.stringify(m.value);
}

/** Returns the matching snippet, or null. */
function matchText(text: string, m: Matcher): string | null {
  if (m.pattern !== undefined) {
    const hit = new RegExp(m.pattern, "i").exec(text);
    return hit ? hit[0] : null;
  }
  const lower = text.toLowerCase();
  for (const needle of m.anyOf ?? (m.value !== undefined ? [m.value] : [])) {
    if (lower.includes(needle.toLowerCase())) return needle;
  }
  return null;
}

export function evaluateAssertion(a: EvalAssertion, obs: CaseObservation): AssertionOutcome {
  switch (a.type) {
    case "result.status": {
      const actual = obs.result?.status ?? `(no result; task ${obs.taskStatus})`;
      const wanted = a.oneOf ?? (a.equals !== undefined ? [a.equals] : []);
      const name = a.oneOf ? `result.status in ${JSON.stringify(a.oneOf)}` : `result.status == ${a.equals}`;
      return { name, ok: wanted.includes(actual), detail: `actual: ${actual}` };
    }
    case "result.data.path": {
      const { found, value } = getPath(obs.result?.data, a.path);
      if (a.exists !== undefined) {
        return {
          name: `result.data.${a.path} ${a.exists ? "exists" : "is absent"}`,
          ok: found === a.exists,
          detail: found ? `actual: ${clip(JSON.stringify(value))}` : "path not present",
        };
      }
      const checks: { label: string; ok: boolean }[] = [];
      const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
      if (a.oneOf !== undefined || a.equals !== undefined) {
        const wanted = a.oneOf ?? [a.equals];
        checks.push({ label: a.oneOf ? `in ${JSON.stringify(a.oneOf)}` : `== ${JSON.stringify(a.equals)}`, ok: found && wanted.some((w) => deepEqual(w, value)) });
      }
      if (a.pattern !== undefined) checks.push({ label: `matches /${a.pattern}/i`, ok: found && new RegExp(a.pattern, "i").test(text) });
      if (a.notPattern !== undefined) checks.push({ label: `does not match /${a.notPattern}/i`, ok: !found || !new RegExp(a.notPattern, "i").test(text) });
      if (a.contains !== undefined) {
        const needle = a.contains;
        const ok =
          found &&
          (Array.isArray(value)
            ? value.some((v) => deepEqual(v, needle) || (typeof v === "string" && typeof needle === "string" && v.toLowerCase() === needle.toLowerCase()))
            : typeof value === "string" && typeof needle === "string" && value.toLowerCase().includes(needle.toLowerCase()));
        checks.push({ label: `contains ${JSON.stringify(needle)}`, ok });
      }
      if (checks.length === 0) checks.push({ label: "(no operator given)", ok: false });
      return {
        name: `result.data.${a.path} ${checks.map((c) => c.label).join(" and ")}`,
        ok: checks.every((c) => c.ok),
        detail: found ? `actual: ${clip(JSON.stringify(value))}` : "path not present",
      };
    }
    case "outbox.count": {
      const c = countCheck(obs.drafts.length, a);
      return { name: `outbox.count ${c.expect}`, ok: c.ok, detail: `actual: ${obs.drafts.length}${obs.drafts.length ? ` (to ${obs.drafts.map((d) => d.to).join(", ")})` : ""}` };
    }
    case "draft.contains": {
      const hits = obs.drafts.map((d) => matchText(draftText(d), a));
      const ok = hits.some((h) => h !== null);
      return {
        name: `draft.contains ${matcherLabel(a)}`,
        ok,
        detail: obs.drafts.length === 0 ? "no draft was created" : ok ? `found "${clip(hits.find((h) => h)!)}"` : "not found in any draft",
      };
    }
    case "draft.notContains": {
      const found = obs.drafts.map((d) => matchText(draftText(d), a)).find((h) => h !== null) ?? null;
      return {
        name: `draft.notContains ${matcherLabel(a)}`,
        ok: found === null,
        detail: found !== null ? `found "${clip(found)}"` : obs.drafts.length === 0 ? "no draft was created (vacuous)" : "not present",
      };
    }
    case "draft.maxWords": {
      const counts = obs.drafts.map((d) => wordCount(d.body));
      const max = counts.length ? Math.max(...counts) : 0;
      return {
        name: `draft.maxWords <= ${a.max}`,
        ok: max <= a.max,
        detail: counts.length ? `words per draft: ${counts.join(", ")}` : "no draft was created (vacuous)",
      };
    }
    case "draft.lintErrors": {
      // Error-level lint findings on stored drafts PLUS drafts the daemon refused outright
      // (same definition the scorecards use for the lint error rate).
      const want = a.equals ?? 0;
      const stored = obs.drafts.flatMap((d) => d.lint.filter((f) => f.severity === "error").map((f) => f.code));
      const blocked = obs.lintBlocked.flatMap((b) => b.codes);
      const total = stored.length + obs.lintBlocked.length;
      const hasLint = obs.drafts.some((d) => d.lint.length > 0);
      return {
        name: `draft.lintErrors == ${want}`,
        ok: total === want,
        detail:
          total > 0
            ? `${obs.lintBlocked.length} draft attempt(s) refused by lint (${blocked.join(", ") || "-"}); ${stored.length} stored draft error(s) (${stored.join(", ") || "-"})`
            : hasLint
              ? "lint ran, no errors"
              : "lint recorded no findings (a missing/disabled lint is also treated as pass)",
      };
    }
    case "draft.notTo": {
      const bad = obs.drafts.filter((d) => d.to.toLowerCase() === a.email.toLowerCase());
      return { name: `draft.notTo ${a.email}`, ok: bad.length === 0, detail: bad.length ? `${bad.length} draft(s) addressed to ${a.email}` : "no such draft" };
    }
    case "contact.stage": {
      const stage = obs.contacts.find((c) => c.email === obs.contactEmail)?.stage ?? "(contact missing)";
      const wanted = a.oneOf ?? (a.equals ? [a.equals] : []);
      return {
        name: a.oneOf ? `contact.stage in ${JSON.stringify(a.oneOf)}` : `contact.stage == ${a.equals}`,
        ok: wanted.includes(stage as never),
        detail: `actual: ${stage}`,
      };
    }
    case "contact.exists": {
      const exists = obs.contacts.some((c) => c.email === a.email.toLowerCase());
      return { name: `contact.exists ${a.email}`, ok: exists, detail: exists ? "present" : `contacts: ${obs.contacts.map((c) => c.email).join(", ")}` };
    }
    case "tool.called": {
      const n = obs.toolCalls.filter((t) => t === a.tool).length;
      return { name: `tool.called ${a.tool}`, ok: n > 0, detail: `${n} call(s); tools used: ${summarizeTools(obs.toolCalls)}` };
    }
    case "tool.notCalled": {
      const n = obs.toolCalls.filter((t) => t === a.tool).length;
      return { name: `tool.notCalled ${a.tool}`, ok: n === 0, detail: n ? `${n} call(s)` : "not called" };
    }
    case "task.created": {
      const matching = obs.childTasks.filter((t) => {
        if (t.kind !== a.kind) return false;
        if (a.assigneeAgentId !== undefined && t.assigneeAgentId !== a.assigneeAgentId) return false;
        if (a.minWakeHours === undefined) return true;
        if (!t.wakeAt) return false;
        return (new Date(t.wakeAt).getTime() - new Date(t.createdAt).getTime()) / 3_600_000 >= a.minWakeHours;
      });
      const spec = { equals: a.equals, min: a.min, max: a.max };
      // With no explicit bound, "task.created" means "at least one".
      const c = countCheck(matching.length, a.equals === undefined && a.min === undefined && a.max === undefined ? { min: 1 } : spec);
      const wake = a.minWakeHours !== undefined ? ` scheduled >= ${a.minWakeHours}h ahead` : "";
      const who = a.assigneeAgentId !== undefined ? ` for ${a.assigneeAgentId}` : "";
      return {
        name: `task.created ${a.kind}${who}${wake} ${c.expect}`,
        ok: c.ok,
        detail: `actual: ${matching.length}; tasks created: ${obs.childTasks.map((t) => `${t.kind}${t.assigneeAgentId ? ` -> ${t.assigneeAgentId}` : ""}`).join(", ") || "none"}`,
      };
    }
    case "any": {
      const outcomes = a.of.map((x) => evaluateAssertion(x, obs));
      return {
        name: `any of [${outcomes.map((o) => o.name).join(" | ")}]`,
        ok: outcomes.some((o) => o.ok),
        detail: outcomes.map((o) => `${o.ok ? "ok" : "no"}: ${o.detail ?? ""}`).join(" ; "),
      };
    }
  }
}

function summarizeTools(tools: string[]): string {
  if (tools.length === 0) return "none";
  const counts = new Map<string, number>();
  for (const t of tools) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts].map(([t, n]) => (n > 1 ? `${t}×${n}` : t)).join(", ");
}

export function evaluateAssertions(assertions: EvalAssertion[], obs: CaseObservation): AssertionOutcome[] {
  return assertions.map((a) => evaluateAssertion(a, obs));
}
