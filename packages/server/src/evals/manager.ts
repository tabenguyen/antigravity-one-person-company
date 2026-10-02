// Starts eval runs in the background of the daemon and persists/announces their progress.
// One run at a time per daemon: every case is a real model run, and parallel suites would
// burn through quota and make timings meaningless.

import type { EvalCaseResult, EvalRun } from "@agyhq/core";
import { ConflictError, type Db } from "@agyhq/db";
import type { AgyhqConfig } from "../config.ts";
import type { EventBus } from "../event-bus.ts";
import { resolveEval, runEvalCases, type EvalRunnerOptions, type EvalRunnerResult } from "./runner.ts";

export interface EvalManagerDeps {
  config: AgyhqConfig;
  db: Db;
  bus: EventBus;
  /** Test seam: replace the runner. */
  run?: (opts: EvalRunnerOptions) => Promise<EvalRunnerResult>;
}

export interface StartEvalArgs {
  suite: string;
  model?: string;
  caseIds?: string[];
  concurrency?: number;
  caseTimeoutMs?: number;
}

interface Active {
  runId: string;
  controller: AbortController;
  done: Promise<void>;
}

// In-flight runs are tracked per Db (i.e. per daemon): eval runs spin up child daemons
// in this same process, and stopping one of those must never abort its parent's run.
const registries = new WeakMap<Db, Map<string, Active>>();

function activeFor(db: Db): Map<string, Active> {
  let m = registries.get(db);
  if (!m) {
    m = new Map();
    registries.set(db, m);
  }
  return m;
}

/** Abort every in-flight eval run of this daemon (shutdown) and wait for them to wind down. */
export async function abortAllEvals(db: Db): Promise<void> {
  const active = activeFor(db);
  for (const a of active.values()) a.controller.abort();
  await Promise.allSettled([...active.values()].map((a) => a.done));
}

/** Resolves when `runId` (if in flight in this daemon) has finished and been persisted. */
export function waitForEval(db: Db, runId: string): Promise<void> {
  return activeFor(db).get(runId)?.done ?? Promise.resolve();
}

/** Runs left "running" by a previous process can never finish; mark them failed. Call once at startup. */
export function failInterruptedEvalRuns(db: Db): number {
  let n = 0;
  const active = activeFor(db);
  for (const run of db.evalRuns.list({ limit: 500 })) {
    if (run.status !== "running" || active.has(run.id)) continue;
    db.evalRuns.finish(run.id, "failed", markUnfinished(run.results, [], "interrupted: daemon restarted before the run finished"));
    n++;
  }
  return n;
}

function markUnfinished(finished: EvalCaseResult[], allIds: string[], reason: string): EvalCaseResult[] {
  const have = new Set(finished.map((r) => r.caseId));
  const rest: EvalCaseResult[] = allIds.filter((id) => !have.has(id)).map((id) => ({ caseId: id, status: "skipped", durationMs: 0, assertions: [], output: { reason } }));
  return [...finished, ...rest];
}

/**
 * Validates the request (throws ValidationError / ConflictError), stores a "running" EvalRun and
 * returns it immediately; the cases run in the background, updating the stored run after each one.
 */
export function startEvalRun(deps: EvalManagerDeps, args: StartEvalArgs): EvalRun {
  const { db, bus, config } = deps;
  const active = activeFor(db);
  if (active.size > 0) throw new ConflictError("an eval run is already in progress; wait for it to finish");
  const { cases, model: defaultModel } = resolveEval(config, args.suite, args.caseIds);
  const model = args.model ?? defaultModel;
  const caseIds = cases.map((c) => c.id);

  const run = db.evalRuns.create({ suite: args.suite, model });
  const controller = new AbortController();
  const runner = deps.run ?? runEvalCases;
  const startedMs = Date.now();
  bus.emit("eval.updated", { runId: run.id, suite: run.suite, status: "running", done: 0, total: caseIds.length });

  const done = (async () => {
    let finishedSoFar: EvalCaseResult[] = [];
    try {
      const { results } = await runner({
        config,
        suite: args.suite,
        model,
        caseIds,
        concurrency: args.concurrency,
        caseTimeoutMs: args.caseTimeoutMs,
        signal: controller.signal,
        onCaseDone: (_r, finished) => {
          finishedSoFar = finished;
          db.evalRuns.updateResults(run.id, finished);
          bus.emit("eval.updated", { runId: run.id, suite: run.suite, status: "running", done: finished.length, total: caseIds.length });
        },
      });
      finish(results, "done");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      finish(markUnfinished(finishedSoFar, caseIds, `eval runner crashed: ${message}`), "failed", message);
    }
  })().finally(() => active.delete(run.id));

  function finish(results: EvalCaseResult[], status: "done" | "failed", error?: string): void {
    try {
      const finished = db.evalRuns.finish(run.id, status, results);
      db.audit.append({
        kind: "eval.finished",
        agentId: null,
        taskId: null,
        conversationId: null,
        data: { runId: run.id, suite: run.suite, model, status, summary: finished.summary, durationMs: Date.now() - startedMs, ...(error ? { error } : {}) },
      });
      bus.emit("eval.updated", { runId: run.id, suite: run.suite, status, done: results.length, total: caseIds.length, summary: finished.summary });
    } catch {
      // db closed during shutdown — nothing left to record
    }
  }

  active.set(run.id, { runId: run.id, controller, done });
  return run;
}
