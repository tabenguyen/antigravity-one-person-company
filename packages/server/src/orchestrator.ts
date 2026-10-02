// Worker / scheduler (docs/PLAN.md 3.1, 3.3; PHASE0.md D2/D4/D5).
//
// Polls the task queue, claims runnable tasks up to the global worker
// concurrency limit, spawns `agy` per task via @agyhq/runner, and maps the
// outcome back onto the task state machine. Per-agent concurrency and
// per-thread mutual exclusion are enforced inside db.tasks.claimNext(); this
// module only adds the quota-throttle priority filter on top (see
// #claimUpTo below), since claimNext has no priority-floor parameter.

import { nowIso, type Agent, type Task, type TaskResult, type TaskStatus } from "@agyhq/core";
import type { Db } from "@agyhq/db";
import { loadTemplate, renderPrompt, type Template } from "@agyhq/workspace";
import { startRun, type RunHandle, type RunResult } from "@agyhq/runner";
import type { AgyhqConfig } from "./config.ts";
import type { EventBus } from "./event-bus.ts";
import type { QuotaMonitor } from "./quota.ts";

/**
 * The orchestrator only needs to issue/revoke per-run tokens — not verify
 * them (that's the agent-api's job). Kept as a structural interface, not a
 * concrete import of RunTokenRegistry, so either the local stub or the real
 * packages/server/src/agent-api/index.ts implementation can be passed in.
 */
export interface TokenIssuer {
  issue(agentId: string, taskId: string): string;
  revoke(token: string): void;
}

export interface OrchestratorDeps {
  config: AgyhqConfig;
  db: Db;
  tokens: TokenIssuer;
  bus: EventBus;
  quota?: QuotaMonitor;
  /** Backoff schedule in minutes, by attempt number (1st retry, 2nd, ...; the
   *  last entry repeats for further attempts). Defaults to [1, 4, 16] per
   *  docs/PLAN.md; overridable so tests can use e.g. [0, 0] instead of
   *  waiting on real wall-clock minutes. */
  backoffMinutes?: number[];
}

/** Tasks at/above this priority are treated as "inbound replies" for quota-throttle purposes. */
export const THROTTLE_PRIORITY_FLOOR = 10;

const DEFAULT_BACKOFF_MINUTES = [1, 4, 16];

interface RunningEntry {
  task: Task;
  handle: RunHandle;
  token: string;
  killedForShutdown: boolean;
}

export class Orchestrator {
  #deps: OrchestratorDeps;
  #running = new Map<string, RunningEntry>();
  /** Completion promise per in-flight task, tracked separately from #running
   *  so stop() can await them even after #runTask has removed its #running
   *  entry (it does so right after handle.result settles, before the task's
   *  outcome is applied). */
  #completions = new Map<string, Promise<void>>();
  #templateCache = new Map<string, Template>();
  #stopped = false;
  #timer: NodeJS.Timeout | null = null;
  #ticking = false;
  #backoffMinutes: number[];

  constructor(deps: OrchestratorDeps) {
    this.#deps = deps;
    this.#backoffMinutes = deps.backoffMinutes ?? DEFAULT_BACKOFF_MINUTES;
  }

  #backoffMs(attempts: number): number {
    const schedule = this.#backoffMinutes;
    const idx = Math.min(attempts, schedule.length) - 1;
    const minutes = schedule[Math.max(0, idx)] ?? schedule[schedule.length - 1] ?? 0;
    return minutes * 60_000;
  }

  get runningCount(): number {
    return this.#running.size;
  }

  start(): void {
    const recovered = this.#deps.db.tasks.recoverStale();
    if (recovered.length > 0) {
      this.#deps.bus.emit("orchestrator.recovered", { taskIds: recovered });
    }
    this.#scheduleTick(0);
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    for (const entry of this.#running.values()) {
      entry.killedForShutdown = true;
      entry.handle.kill("daemon shutdown");
    }
    await Promise.allSettled([...this.#completions.values()]);
  }

  #scheduleTick(delayMs: number): void {
    if (this.#stopped) return;
    this.#timer = setTimeout(() => {
      void this.#tick();
    }, delayMs);
  }

  async #tick(): Promise<void> {
    if (this.#stopped || this.#ticking) return;
    this.#ticking = true;
    try {
      this.#claimUpTo();
    } finally {
      this.#ticking = false;
      this.#scheduleTick(this.#deps.config.pollIntervalMs);
    }
  }

  /** Claim and launch tasks until the worker pool is full or nothing is claimable. */
  #claimUpTo(): void {
    const { db, config, quota } = this.#deps;
    while (this.#running.size < config.workerConcurrency) {
      if (quota?.isThrottled()) {
        const now = nowIso();
        const hasHighPriorityCandidate = db.tasks
          .list({ status: ["queued"] })
          .some((t) => t.priority >= THROTTLE_PRIORITY_FLOOR && (!t.wakeAt || t.wakeAt <= now));
        if (!hasHighPriorityCandidate) break;
      }
      const claimed = db.tasks.claimNext(nowIso());
      if (!claimed) break;
      this.#launch(claimed);
    }
  }

  #loadTemplate(role: string): Template {
    let tpl = this.#templateCache.get(role);
    if (!tpl) {
      tpl = loadTemplate(this.#deps.config.templatesRoot, role);
      this.#templateCache.set(role, tpl);
    }
    return tpl;
  }

  /** Drop a cached template so the next run for that role re-reads it (e.g. after an admin rerender). */
  invalidateTemplateCache(role?: string): void {
    if (role) this.#templateCache.delete(role);
    else this.#templateCache.clear();
  }

  /** Fire-and-forget: #runTask registers/deregisters itself in #running once it has a RunHandle. */
  #launch(task: Task): void {
    const { db, bus } = this.#deps;
    const promise = this.#runTask(task)
      .catch((err) => {
        // #runTask itself handles every expected failure path; this is a last
        // resort so a bug here can't silently wedge the worker slot forever.
        bus.emit("orchestrator.error", { taskId: task.id, error: (err as Error).message });
        try {
          db.tasks.transition(task.id, "failed", { error: `orchestrator error: ${(err as Error).message}` });
        } catch {
          // task may already be in a terminal state; nothing more to do.
        }
      })
      .finally(() => this.#completions.delete(task.id));
    this.#completions.set(task.id, promise);
  }

  async #runTask(task: Task): Promise<void> {
    const { db, config, bus, tokens } = this.#deps;

    const agent = db.agents.get(task.agentId);
    if (!agent) {
      db.tasks.transition(task.id, "failed", { error: `agent "${task.agentId}" not found` });
      return;
    }

    let template: Template;
    try {
      template = this.#loadTemplate(agent.role);
    } catch (err) {
      db.tasks.transition(task.id, "failed", { error: `failed to load template for role "${agent.role}": ${(err as Error).message}` });
      return;
    }

    const kindSpec = template.taskKinds.find((tk) => tk.kind === task.kind);
    if (!kindSpec) {
      db.tasks.transition(task.id, "failed", {
        error: `unknown task kind "${task.kind}" for role "${agent.role}". Known kinds: ${template.taskKinds.map((t) => t.kind).join(", ")}`,
      });
      return;
    }

    const prompt = buildPrompt(task, template);
    const conversationId =
      task.conversationId ?? (task.threadKey ? db.conversations.get(agent.id, task.threadKey) : null) ?? undefined;

    const token = tokens.issue(agent.id, task.id);
    const env: Record<string, string> = {
      AGYHQ_API_URL: `http://${config.host}:${config.port}`,
      AGYHQ_TOKEN: token,
      AGYHQ_AGENT_ID: agent.id,
      AGYHQ_TASK_ID: task.id,
    };

    db.audit.append({
      kind: "run.started",
      agentId: agent.id,
      taskId: task.id,
      conversationId: conversationId ?? null,
      data: { kind: task.kind, model: agent.model, attempt: task.attempts },
    });
    bus.emit("task.transition", { taskId: task.id, agentId: agent.id, from: "queued", to: "running" });

    const handle = startRun({
      cwd: agent.workspacePath,
      prompt,
      agent: agent.role,
      model: agent.model,
      conversationId,
      jsonSchema: template.resultSchema as object,
      timeoutMs: config.runTimeoutMs,
      env,
      agyBin: config.agyBin,
    });

    const entry: RunningEntry = { task, handle, token, killedForShutdown: false };
    this.#running.set(task.id, entry);

    // Forward live run events to the bus for SSE watchers; never let a
    // consumer error here affect run classification.
    void (async () => {
      try {
        for await (const ev of handle.events) {
          bus.emit("run.event", { taskId: task.id, agentId: agent.id, event: ev });
        }
      } catch {
        // best-effort forwarding only
      }
    })();

    let result: RunResult;
    try {
      result = await handle.result;
    } finally {
      tokens.revoke(token);
      this.#running.delete(task.id);
    }

    db.audit.append({
      kind: "run.finished",
      agentId: agent.id,
      taskId: task.id,
      conversationId: result.conversationId,
      data: {
        outcome: result.outcome,
        usage: result.usage,
        durationMs: result.durationMs,
        agyVersion: result.agyVersion,
        error: result.error,
      },
    });

    if (task.threadKey && result.conversationId) {
      db.conversations.set(agent.id, task.threadKey, result.conversationId);
    }

    if (entry.killedForShutdown) {
      // Graceful shutdown: don't classify/backoff, just put it back in the
      // queue so a restarted daemon picks it up immediately.
      try {
        db.tasks.transition(task.id, "queued", { wakeAt: null });
      } catch {
        // already terminal (e.g. finished right as shutdown began) — fine.
      }
      return;
    }

    this.#applyOutcome(agent, task, result);
  }

  #applyOutcome(agent: Agent, task: Task, result: RunResult): void {
    const { db, bus } = this.#deps;

    if (result.outcome === "denied") {
      db.tasks.transition(task.id, "failed", {
        error: `denied by policy: ${JSON.stringify(result.deniedActions)}`,
      });
      bus.emit("task.transition", { taskId: task.id, agentId: agent.id, to: "failed", reason: "denied" });
      return;
    }

    if (result.outcome === "ok") {
      const structured = parseTaskResult(result.structured);
      if (!structured) {
        this.#requeueOrFail(task, "invalid_output", "structured result missing or malformed");
        return;
      }
      this.#applyTaskResult(agent, task, structured);
      return;
    }

    // Transient outcomes: timeout, empty, invalid_output, error.
    this.#requeueOrFail(task, result.outcome, result.error ?? `run outcome: ${result.outcome}`);
  }

  #requeueOrFail(task: Task, outcome: string, message: string): void {
    const { db, bus } = this.#deps;
    if (task.attempts < task.maxAttempts) {
      const wakeAt = new Date(Date.now() + this.#backoffMs(task.attempts)).toISOString();
      db.tasks.transition(task.id, "queued", { wakeAt, error: message });
      bus.emit("task.transition", { taskId: task.id, agentId: task.agentId, to: "queued", reason: outcome, wakeAt });
    } else {
      db.tasks.transition(task.id, "failed", { error: `${message} (after ${task.attempts} attempts)` });
      bus.emit("task.transition", { taskId: task.id, agentId: task.agentId, to: "failed", reason: outcome });
    }
  }

  #applyTaskResult(agent: Agent, task: Task, structured: TaskResult): void {
    const { db, bus } = this.#deps;
    const statusMap: Record<TaskResult["status"], TaskStatus> = {
      done: "done",
      needs_human: "waiting_approval",
      waiting_external: "waiting_external",
      failed: "failed",
    };
    const to = statusMap[structured.status];
    const patch = to === "failed" ? { result: structured, error: structured.summary } : { result: structured };
    db.tasks.transition(task.id, to, patch);
    bus.emit("task.transition", { taskId: task.id, agentId: agent.id, to, status: structured.status });

    if (structured.followUp) {
      const template = this.#loadTemplate(agent.role);
      const prefix = task.kind.split(".")[0];
      const followUpKind = `${prefix}.follow_up`;
      const kind = template.taskKinds.some((tk) => tk.kind === followUpKind) ? followUpKind : task.kind;
      const wakeAt = new Date(Date.now() + structured.followUp.afterHours * 3_600_000).toISOString();
      db.tasks.create({
        agentId: agent.id,
        kind,
        title: `Follow-up: ${task.title}`,
        input: { ...task.input, note: structured.followUp.note, previousSummary: structured.summary },
        threadKey: task.threadKey,
        parentTaskId: task.id,
        wakeAt,
      });
    }
  }
}

function buildPrompt(task: Task, template: Template): string {
  const rendered = renderPrompt(template, task.kind, task.input);
  return [
    `# Task ${task.id}: ${task.title}`,
    "",
    "Finish by returning the structured task result exactly as specified " +
      "(status, a one/two sentence summary, optional followUp, and data) — the task is not " +
      "considered done until you return it.",
    "",
    "---",
    "",
    rendered,
    ...humanGuidanceSection(task),
  ].join("\n");
}

/** A task resumed from waiting_approval carries the reviewer's guidance; put it in front of the agent. */
function humanGuidanceSection(task: Task): string[] {
  const guidance = task.input.humanGuidance;
  if (typeof guidance !== "string" || !guidance.trim()) return [];
  const previous = typeof task.input.previousSummary === "string" ? task.input.previousSummary : null;
  return [
    "",
    "---",
    "",
    "## Guidance from a human reviewer",
    "",
    ...(previous ? [`Your previous run on this ended with: ${previous}`, ""] : []),
    "The reviewer answered:",
    "",
    guidance.trim(),
    "",
    "Treat this as authoritative and continue the task with it.",
  ];
}

function parseTaskResult(structured: unknown): TaskResult | null {
  if (!structured || typeof structured !== "object") return null;
  const obj = structured as Record<string, unknown>;
  const status = obj.status;
  if (status !== "done" && status !== "needs_human" && status !== "waiting_external" && status !== "failed") {
    return null;
  }
  if (typeof obj.summary !== "string") return null;
  const followUpRaw = obj.followUp;
  let followUp: TaskResult["followUp"] = null;
  if (followUpRaw && typeof followUpRaw === "object") {
    const f = followUpRaw as Record<string, unknown>;
    if (typeof f.afterHours === "number" && typeof f.note === "string") {
      followUp = { afterHours: f.afterHours, note: f.note };
    }
  }
  const data = obj.data && typeof obj.data === "object" ? (obj.data as Record<string, unknown>) : undefined;
  return { status, summary: obj.summary, followUp, data };
}
