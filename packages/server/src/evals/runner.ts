// Eval runner: each case gets a throwaway data dir and its own in-process daemon
// (startDaemon, email "none", random port) with a shadow-tier agent provisioned from
// the suite's role template and a hermetic KB (the suite's evals/kb/*.md, nothing
// from the user's real company KB). The case's contact + thread are seeded, one task
// is created, and when it settles the assertions run over what it left behind.
//
// Cases run sequentially by default (every case is a real model run = quota).
// Runs are capped at one attempt per task: a flaky run is reported as "error", not retried.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { AgentRole, EvalCaseResult, Iso, TaskResult } from "@agyhq/core";
import type { Db } from "@agyhq/db";
import { listTemplateRoles, loadTemplate } from "@agyhq/workspace";
import type { AgyhqConfig } from "../config.ts";
import { createAgent } from "../provision.ts";
import { ValidationError } from "../util.ts";
import { evaluateAssertions, type CaseObservation } from "./assertions.ts";
import { loadSuite } from "./suite.ts";
import type { EvalCase, LoadedSuite } from "./types.ts";

export const EVAL_AGENT_ID = "eval-agent";
const SETTLED = new Set(["done", "failed", "waiting_approval", "waiting_external", "cancelled"]);

export interface EvalRunnerOptions {
  /** The parent daemon's config: templates root, agy binary, built hooks/mcp artifacts. */
  config: AgyhqConfig;
  suite: string;
  /** Default: the role template's defaultModel. */
  model?: string;
  /** Subset of case ids; default all. */
  caseIds?: string[];
  /** Cases in flight at once (default 1 — quota!). */
  concurrency?: number;
  /** Per-case cap; default from suite.json (8 min). */
  caseTimeoutMs?: number;
  signal?: AbortSignal;
  /** Keep each case's temp data dir (workspaces, db) for debugging. Also AGYHQ_EVAL_KEEP=1. */
  keepData?: boolean;
  /** Called after every finished case, with all results so far (in case order, finished ones only). */
  onCaseDone?: (result: EvalCaseResult, finished: EvalCaseResult[]) => void;
  /** Called once the suite/model are resolved and cases are known (before any run). */
  onStart?: (info: { model: string; caseIds: string[] }) => void;
}

export interface EvalRunnerResult {
  model: string;
  results: EvalCaseResult[];
}

/** Validates suite + case ids and returns what would run (used synchronously by the start route). */
export function resolveEval(config: AgyhqConfig, suite: string, caseIds?: string[]): { loaded: LoadedSuite; cases: EvalCase[]; model: string } {
  const loaded = loadSuite(config.templatesRoot, suite);
  let cases = loaded.cases;
  if (caseIds && caseIds.length > 0) {
    const unknown = caseIds.filter((id) => !loaded.cases.some((c) => c.id === id));
    if (unknown.length) {
      throw new ValidationError(`unknown case id(s) for suite "${suite}": ${unknown.join(", ")}; available: ${loaded.cases.map((c) => c.id).join(", ")}`);
    }
    cases = loaded.cases.filter((c) => caseIds.includes(c.id));
  }
  let model: string;
  try {
    model = loadTemplate(config.templatesRoot, suite).defaultModel;
  } catch (err) {
    throw new ValidationError(`suite "${suite}" has no usable role template: ${(err as Error).message}`);
  }
  return { loaded, cases, model };
}

export async function runEvalCases(opts: EvalRunnerOptions): Promise<EvalRunnerResult> {
  const { loaded, cases, model: defaultModel } = resolveEval(opts.config, opts.suite, opts.caseIds);
  const model = opts.model ?? defaultModel;
  opts.onStart?.({ model, caseIds: cases.map((c) => c.id) });

  const keep = opts.keepData ?? process.env.AGYHQ_EVAL_KEEP === "1";
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "agyhq-eval-"));
  const templatesRoot = prepareTemplatesRoot(opts.config.templatesRoot, opts.suite, path.join(scratch, "templates"));
  const caseTimeoutMs = opts.caseTimeoutMs ?? loaded.config.caseTimeoutMs;

  const slots: (EvalCaseResult | undefined)[] = new Array(cases.length).fill(undefined);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= cases.length) return;
      const c = cases[i]!;
      const result: EvalCaseResult = opts.signal?.aborted
        ? { caseId: c.id, status: "skipped", durationMs: 0, assertions: [], output: { reason: "eval run aborted" } }
        : await runOneCase({ c, loaded, config: opts.config, templatesRoot, scratch, model, caseTimeoutMs, signal: opts.signal, keep });
      slots[i] = result;
      opts.onCaseDone?.(result, slots.filter((r): r is EvalCaseResult => r !== undefined));
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 1, cases.length)) }, worker));
  } finally {
    if (!keep) fs.rmSync(scratch, { recursive: true, force: true });
  }
  return { model, results: slots as EvalCaseResult[] };
}

/**
 * A private copy of the role templates (the suite's role, plus the other roles so a case can provision teammates, plus
 * `_shared`), minus evals/ and the placeholder role KB — the suite's own evals/kb is the only KB in an eval daemon.
 */
function prepareTemplatesRoot(srcRoot: string, _role: string, destRoot: string): string {
  const roles = listTemplateRoles(srcRoot);
  for (const name of [...roles, "_shared"]) {
    const src = path.join(srcRoot, name);
    if (!fs.existsSync(src)) continue;
    fs.cpSync(src, path.join(destRoot, name), {
      recursive: true,
      filter: (file) => {
        const rel = path.relative(src, file);
        return !(rel === "evals" || rel.startsWith(`evals${path.sep}`) || rel === "kb" || rel.startsWith(`kb${path.sep}`));
      },
    });
  }
  return destRoot;
}

interface CaseCtx {
  c: EvalCase;
  loaded: LoadedSuite;
  config: AgyhqConfig;
  templatesRoot: string;
  scratch: string;
  model: string;
  caseTimeoutMs: number;
  signal?: AbortSignal;
  keep: boolean;
}

async function runOneCase(ctx: CaseCtx): Promise<EvalCaseResult> {
  const { c, loaded, config } = ctx;
  const started = Date.now();
  const dataDir = path.join(ctx.scratch, `case-${c.id}`);
  const kbRoot = path.join(dataDir, "kb");
  fs.mkdirSync(kbRoot, { recursive: true });
  for (const f of loaded.kbFiles) fs.copyFileSync(f, path.join(kbRoot, path.basename(f)));

  const childConfig: AgyhqConfig = {
    ...config,
    dataDir,
    dbPath: path.join(dataDir, "agyhq.db"),
    workspacesRoot: path.join(dataDir, "workspaces"),
    host: "127.0.0.1",
    port: 0,
    adminToken: randomBytes(16).toString("hex"),
    companyName: loaded.config.companyName,
    templatesRoot: ctx.templatesRoot,
    kbRoot,
    configPath: null,
    workerConcurrency: 1,
    pollIntervalMs: 100,
    runTimeoutMs: Math.max(1000, ctx.caseTimeoutMs - 5_000),
    quota: { minRemainingFraction: 0, pollIntervalMs: 3_600_000 },
    email: { kind: "none", pollIntervalMs: 60_000 },
    webhooks: {},
  };

  const { startDaemon } = await import("../main.ts"); // lazy: main.ts -> app.ts -> admin-routines.ts -> here
  let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;
  try {
    daemon = await startDaemon(childConfig);
    const { db } = daemon;
    const agent = createAgent(
      { config: daemon.config, db },
      { id: EVAL_AGENT_ID, role: loaded.name as AgentRole, displayName: loaded.config.displayName, model: ctx.model, trustTier: "shadow", maxConcurrency: 1 },
    );

    // Teammates the case refers to (e.g. a Chief of Staff's roster) exist so task_create can assign to them, but with
    // zero concurrency they can never claim a task: only the case's own agent costs model runs.
    const teammates = provisionTeammates({ config: daemon.config, db }, c, agent.id);
    const owner = c.contact.ownerAgentId ?? (loaded.name === "chief-of-staff" ? null : agent.id);
    if (owner && !db.agents.get(owner)) throw new Error(`case ${c.id}: contact.ownerAgentId "${owner}" is not the eval agent or a provisioned teammate (${teammates.join(", ") || "none"})`);
    const seeded = seedCase(db, agent.id, c, { ownerAgentId: owner });
    const task = db.tasks.create({
      agentId: agent.id,
      kind: c.kind,
      title: `eval ${c.id}`,
      input: { contactId: seeded.contactId, ...buildTaskInput(c) },
      threadKey: `contact:${seeded.email}`,
      priority: 10,
      maxAttempts: 1,
    });

    // The moment the task settles, pause the agent so no follow-up/child task the agent
    // queued can be claimed (and cost a model run) before we tear the daemon down.
    const unsubscribe = daemon.bus.subscribe((ev) => {
      if (ev.type === "task.transition" && ev.data["taskId"] === task.id && SETTLED.has(String(ev.data["to"]))) {
        try {
          db.agents.setStatus(agent.id, "paused");
        } catch {
          // best effort
        }
      }
    });

    let outcome: "settled" | "timeout" | "aborted" = "timeout";
    const deadline = Date.now() + ctx.caseTimeoutMs;
    try {
      for (;;) {
        const t = db.tasks.get(task.id)!;
        if (SETTLED.has(t.status)) {
          outcome = "settled";
          break;
        }
        if (ctx.signal?.aborted) {
          outcome = "aborted";
          break;
        }
        if (Date.now() > deadline) break;
        await new Promise((r) => setTimeout(r, 50));
      }
    } finally {
      unsubscribe();
    }

    const final = db.tasks.get(task.id)!;
    const obs = observe(db, agent.id, final.id, seeded.email, final.status, final.result);
    const output = summarizeOutput(final.status, final.result, final.error, obs);

    if (outcome !== "settled") {
      const why = outcome === "aborted" ? "eval run aborted" : `timed out after ${Math.round(ctx.caseTimeoutMs / 1000)}s (task still ${final.status})`;
      return { caseId: c.id, status: outcome === "aborted" ? "skipped" : "error", durationMs: Date.now() - started, assertions: [{ name: "run completed", ok: false, detail: why }], output };
    }
    if (final.status === "failed" || final.status === "cancelled") {
      return {
        caseId: c.id,
        status: "error",
        durationMs: Date.now() - started,
        assertions: [{ name: "run completed", ok: false, detail: `task ${final.status}: ${final.error ?? "no error recorded"}` }],
        output,
      };
    }
    const assertions = evaluateAssertions(c.assertions, obs);
    return { caseId: c.id, status: assertions.every((a) => a.ok) ? "pass" : "fail", durationMs: Date.now() - started, assertions, output };
  } catch (err) {
    return {
      caseId: c.id,
      status: "error",
      durationMs: Date.now() - started,
      assertions: [{ name: "run completed", ok: false, detail: err instanceof Error ? err.message : String(err) }],
      output: null,
    };
  } finally {
    try {
      await daemon?.stop();
    } catch {
      // ignore teardown errors
    }
    if (!ctx.keep) fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Seeding

/** Ids the case needs besides the eval agent: `agents` plus the `input.roster` entries. */
export function teammateSpecs(c: EvalCase): { id: string; role: AgentRole; displayName: string }[] {
  const specs = new Map<string, { id: string; role: AgentRole; displayName: string }>();
  for (const a of c.agents) specs.set(a.id, { id: a.id, role: a.role, displayName: a.displayName ?? a.id });
  const roster = c.input["roster"];
  if (Array.isArray(roster)) {
    for (const r of roster) {
      const e = r as { agentId?: unknown; role?: unknown; displayName?: unknown };
      if (typeof e?.agentId === "string" && typeof e.role === "string" && !specs.has(e.agentId)) {
        specs.set(e.agentId, { id: e.agentId, role: e.role as AgentRole, displayName: typeof e.displayName === "string" ? e.displayName : e.agentId });
      }
    }
  }
  specs.delete(EVAL_AGENT_ID);
  return [...specs.values()];
}

function provisionTeammates(ctx: { config: AgyhqConfig; db: Db }, c: EvalCase, _evalAgentId: string): string[] {
  const ids: string[] = [];
  for (const spec of teammateSpecs(c)) {
    createAgent(ctx, { id: spec.id, role: spec.role, displayName: spec.displayName, trustTier: "shadow", maxConcurrency: 0 });
    ids.push(spec.id);
  }
  return ids;
}

export function seedCase(db: Db, agentId: string, c: EvalCase, opts: { ownerAgentId?: string | null } = {}): { email: string; contactId: string } {
  const ct = c.contact;
  const email = ct.email.toLowerCase();
  if (ct.companyName || ct.companyDomain) {
    db.crm.upsertCompany({
      name: ct.companyName ?? ct.companyDomain!,
      domain: ct.companyDomain ?? null,
      industry: ct.companyIndustry ?? null,
      size: ct.companySize ?? null,
      country: ct.companyCountry ?? null,
    });
  }
  const { contact } = db.crm.upsertContact({
    email,
    name: ct.name,
    title: ct.title,
    language: ct.language,
    source: ct.source ?? "eval-seed",
    ownerAgentId: opts.ownerAgentId === undefined ? agentId : opts.ownerAgentId,
    companyName: ct.companyName,
    companyDomain: ct.companyDomain,
    attributes: ct.attributes,
  });

  const sent = c.thread?.sent ?? [];
  const inbound = c.thread?.inbound ?? [];
  const stage = ct.stage ?? (inbound.length > 0 ? "replied" : sent.length > 0 ? "contacted" : "new");
  // Direct update: seeding must not leave "Stage changed" notes the agent would read as history.
  db.sqlite.prepare("UPDATE contacts SET stage = ? WHERE id = ?").run(stage, contact.id);

  const threadKey = `contact:${email}`;
  let sentAt = Date.now() - 7 * 86_400_000;
  for (const [i, s] of sent.entries()) {
    const draft = db.outbox.createDraft({ agentId, channel: "email", to: email, subject: s.subject, body: s.body, reason: "eval seed: earlier outreach", threadKey });
    const at = new Date(sentAt + i * 3_600_000).toISOString();
    db.sqlite
      .prepare("UPDATE outbox SET status = 'sent', decided_by = 'human:eval-seed', decided_at = ?, sent_at = ?, message_id = ? WHERE id = ?")
      .run(at, at, `seed-${i}-${draft.id}@eval.example`, draft.id);
    db.crm.addNote("contact", contact.id, `Sent email "${s.subject}".`, agentId);
  }
  const lastSentSubject = sent.length > 0 ? sent[sent.length - 1]!.subject : null;
  for (const [i, m] of inbound.entries()) {
    db.crm.addNote("contact", contact.id, `Reply received: ${m.body.slice(0, 500)}`, agentId);
    // In production every message from a contact is an inbound_events row (and that is what makes a "Re:" subject
    // legitimate), so the seed stores one too. Marked routed so the daemon does not route it into another task.
    db.inbound.insertIfNew({
      source: "email",
      externalId: `eval-seed-${i}-${contact.id}`,
      fromAddress: email,
      fromName: ct.name ?? null,
      subject: m.subject ?? (lastSentSubject ? `Re: ${lastSentSubject}` : null),
      bodyText: m.body,
      threadKey,
      contactId: contact.id,
      classification: sent.length > 0 ? "reply" : "new_lead",
      status: "routed",
      statusReason: "eval seed",
    });
  }
  return { email, contactId: contact.id };
}

export function buildTaskInput(c: EvalCase): Record<string, unknown> {
  const ct = c.contact;
  const input: Record<string, unknown> = {
    contactName: ct.name ?? null,
    contactEmail: ct.email,
    leadCompanyName: ct.companyName ?? null,
    leadCompanyDomain: ct.companyDomain ?? null,
  };
  const sent = c.thread?.sent ?? [];
  const inbound = c.thread?.inbound ?? [];
  const lastSentSubject = sent.length > 0 ? sent[sent.length - 1]!.subject : null;
  const inboundSubject = (m: { subject?: string }) => m.subject ?? (lastSentSubject ? `Re: ${lastSentSubject}` : "(no subject)");
  if (inbound.length > 0) {
    const last = inbound[inbound.length - 1]!;
    input["replyBody"] = last.body;
    input["subject"] = inboundSubject(last);
  }
  if (sent.length + inbound.length > 0) {
    input["threadSummary"] = [
      ...sent.map((s) => `We sent ("${s.subject}"): ${s.body}`),
      ...inbound.slice(0, -1).map((m) => `They wrote ("${inboundSubject(m)}"): ${m.body}`),
    ].join("\n\n") || "(no prior thread)";
  }
  return { ...input, ...c.input };
}

// ---------------------------------------------------------------------------
// Observation

function observe(db: Db, agentId: string, taskId: string, contactEmail: string, taskStatus: string, result: TaskResult | null): CaseObservation {
  const drafts = db.outbox
    .list({ agentId })
    .filter((i) => i.taskId === taskId)
    .reverse()
    .map((i) => ({ to: i.to, subject: i.subject, body: i.body, status: i.status, lint: i.lint ?? [] }));
  const contacts = (db.sqlite.prepare("SELECT email, stage FROM contacts WHERE email IS NOT NULL").all() as { email: string; stage: string }[]).map((r) => ({
    email: r.email.toLowerCase(),
    stage: r.stage,
  }));
  const toolCalls = db.audit
    .list({ taskId, kind: ["tool.pre"] })
    .reverse()
    .map((e) => String(e.data["mcpTool"] ?? e.data["toolName"] ?? "unknown"));
  const childTasks = db.tasks
    .list({})
    .filter((t) => t.parentTaskId === taskId)
    .reverse()
    .map((t) => ({ kind: t.kind, title: t.title, createdAt: t.createdAt as Iso, wakeAt: t.wakeAt, assigneeAgentId: t.agentId }));
  const lintBlocked = db.audit
    .list({ taskId, kind: ["outbox.lint_blocked"] })
    .reverse()
    .map((e) => {
      const findings = Array.isArray(e.data["findings"]) ? (e.data["findings"] as { code?: string; severity?: string }[]) : [];
      return { to: String(e.data["to"] ?? ""), codes: findings.filter((f) => f.severity === "error").map((f) => String(f.code)) };
    });
  return { taskStatus, result, drafts, contacts, contactEmail: contactEmail.toLowerCase(), toolCalls, childTasks, lintBlocked };
}

function summarizeOutput(taskStatus: string, result: TaskResult | null, error: string | null, obs: CaseObservation): unknown {
  return {
    taskStatus,
    result,
    error,
    drafts: obs.drafts,
    contactStage: obs.contacts.find((c) => c.email === obs.contactEmail)?.stage ?? null,
    contacts: obs.contacts,
    tasksCreated: obs.childTasks,
    toolCalls: obs.toolCalls,
    lintBlocked: obs.lintBlocked,
  };
}
