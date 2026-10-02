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
import { loadTemplate } from "@agyhq/workspace";
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

/** A private copy of just the suite's role template, minus evals/ and its (placeholder) role KB. */
function prepareTemplatesRoot(srcRoot: string, role: string, destRoot: string): string {
  const dest = path.join(destRoot, role);
  fs.cpSync(path.join(srcRoot, role), dest, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(path.join(srcRoot, role), src);
      return !(rel === "evals" || rel.startsWith(`evals${path.sep}`) || rel === "kb" || rel.startsWith(`kb${path.sep}`));
    },
  });
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

    const seeded = seedCase(db, agent.id, c);
    const task = db.tasks.create({
      agentId: agent.id,
      kind: c.kind,
      title: `eval ${c.id}`,
      input: buildTaskInput(c),
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

export function seedCase(db: Db, agentId: string, c: EvalCase): { email: string; contactId: string } {
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
    ownerAgentId: agentId,
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
  for (const m of inbound) db.crm.addNote("contact", contact.id, `Reply received: ${m.body.slice(0, 500)}`, agentId);
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
    .list({ agentId })
    .filter((t) => t.parentTaskId === taskId)
    .reverse()
    .map((t) => ({ kind: t.kind, title: t.title, createdAt: t.createdAt as Iso, wakeAt: t.wakeAt }));
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
