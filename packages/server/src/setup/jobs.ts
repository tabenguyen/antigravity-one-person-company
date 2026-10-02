// Setup-wizard generation jobs: one at a time per daemon, persisted in kv "setup_jobs" (newest first, last 20),
// announced over SSE ("setup.job.updated", "setup.job.progress"). A job left "running" by a previous process can never
// finish and is marked failed ("daemon restarted") when the manager starts.

import path from "node:path";
import { randomBytes } from "node:crypto";
import { loadTemplate } from "@agyhq/workspace";
import { ConflictError, type Db } from "@agyhq/db";
import type { AgyhqConfig } from "../config.ts";
import type { EventBus } from "../event-bus.ts";
import type { GeneratedSetup, SetupJob } from "../admin-types.ts";
import { GenerationCancelled, GenerationError, generateSetup, type ParsedGenerateRequest } from "./generator.ts";

export const SETUP_JOBS_KEY = "setup_jobs";
export const MAX_JOBS = 20;
export const MAX_PROGRESS_LINES = 200;
const FALLBACK_MODEL = "gemini-3.8-flash-medium";

export interface SetupJobManagerDeps {
  config: AgyhqConfig;
  db: Db;
  bus: EventBus;
  /** Test seam: replace the whole generator (default: generateSetup via agy). */
  generate?: typeof generateSetup;
  /** Test seams for the researcher gate (see researcher-workspace.ts). */
  brainRoot?: string;
  dnsCheck?: boolean;
  timeoutMs?: number;
  repairTimeoutMs?: number;
}

interface Active {
  jobId: string;
  controller: AbortController;
  done: Promise<void>;
}

export class SetupJobManager {
  readonly #deps: SetupJobManagerDeps;
  #jobs: SetupJob[];
  #active: Active | null = null;

  constructor(deps: SetupJobManagerDeps) {
    this.#deps = deps;
    this.#jobs = deps.db.kv.get<{ jobs: SetupJob[] }>(SETUP_JOBS_KEY)?.jobs ?? [];
    let changed = false;
    for (const job of this.#jobs) {
      if (job.status !== "running") continue;
      job.status = "failed";
      job.error = "daemon restarted before the research finished";
      job.finishedAt = new Date().toISOString();
      changed = true;
    }
    if (changed) this.#persist();
  }

  get workspaceDir(): string {
    return path.join(this.#deps.config.dataDir, "setup-workspace");
  }

  list(): SetupJob[] {
    return this.#jobs.map(clone);
  }

  get(id: string): SetupJob | null {
    const job = this.#jobs.find((j) => j.id === id);
    return job ? clone(job) : null;
  }

  defaultModel(): string {
    const { config } = this.#deps;
    if (config.setupModel) return config.setupModel;
    try {
      return loadTemplate(config.templatesRoot, "sales-sdr").defaultModel || FALLBACK_MODEL;
    } catch {
      return FALLBACK_MODEL;
    }
  }

  /** Starts a job (returns immediately). Throws ConflictError if one is already running. */
  start(req: ParsedGenerateRequest): SetupJob {
    if (this.#active) throw new ConflictError("a setup research job is already running; wait for it to finish or cancel it");
    const job: SetupJob = {
      id: `setup_${randomBytes(6).toString("hex")}`,
      domain: req.domain,
      model: req.model?.trim() || this.defaultModel(),
      status: "running",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      progress: [],
      result: null,
      error: null,
      usage: null,
    };
    this.#jobs.unshift(job);
    this.#jobs = this.#jobs.slice(0, MAX_JOBS);
    this.#persist();
    this.#deps.bus.emit("setup.job.updated", { jobId: job.id, status: job.status });

    const controller = new AbortController();
    const done = this.#run(job, req, controller).finally(() => {
      if (this.#active?.jobId === job.id) this.#active = null;
    });
    this.#active = { jobId: job.id, controller, done };
    return clone(job);
  }

  /** Cancels a running job (kills agy). A finished job is returned unchanged. */
  cancel(id: string): SetupJob | null {
    const job = this.#jobs.find((j) => j.id === id);
    if (!job) return null;
    if (job.status === "running" && this.#active?.jobId === id) {
      this.#finish(job, "cancelled", { error: "cancelled by the user" });
      this.#active.controller.abort();
    }
    return clone(job);
  }

  /** Resolves when `id` (if running here) has fully wound down. */
  waitFor(id: string): Promise<void> {
    return this.#active?.jobId === id ? this.#active.done : Promise.resolve();
  }

  /** Daemon shutdown: abort the running job (it is marked cancelled) and wait for agy to exit. */
  async abortAll(): Promise<void> {
    const active = this.#active;
    if (!active) return;
    const job = this.#jobs.find((j) => j.id === active.jobId);
    if (job && job.status === "running") this.#finish(job, "cancelled", { error: "daemon shutting down" });
    active.controller.abort();
    await active.done.catch(() => {});
  }

  async #run(job: SetupJob, req: ParsedGenerateRequest, controller: AbortController): Promise<void> {
    const generate = this.#deps.generate ?? generateSetup;
    try {
      const outcome = await generate({
        config: this.#deps.config,
        req,
        model: job.model,
        workspaceDir: this.workspaceDir,
        signal: controller.signal,
        onProgress: (line) => this.#progress(job, line),
        brainRoot: this.#deps.brainRoot,
        dnsCheck: this.#deps.dnsCheck,
        timeoutMs: this.#deps.timeoutMs,
        repairTimeoutMs: this.#deps.repairTimeoutMs,
      });
      this.#finish(job, "done", { result: outcome.setup, usage: outcome.usage });
    } catch (err) {
      if (err instanceof GenerationCancelled || controller.signal.aborted) {
        this.#finish(job, "cancelled", { error: "cancelled by the user" });
      } else {
        const usage = err instanceof GenerationError ? err.usage : null;
        this.#finish(job, "failed", { error: err instanceof Error ? err.message : String(err), usage });
      }
    }
  }

  #progress(job: SetupJob, rawLine: string): void {
    if (job.status !== "running") return;
    const line = rawLine.slice(0, 500);
    job.progress.push({ at: new Date().toISOString(), line });
    if (job.progress.length > MAX_PROGRESS_LINES) job.progress.splice(0, job.progress.length - MAX_PROGRESS_LINES);
    this.#persist();
    this.#deps.bus.emit("setup.job.progress", { jobId: job.id, line });
  }

  #finish(
    job: SetupJob,
    status: "done" | "failed" | "cancelled",
    extra: { result?: GeneratedSetup; error?: string; usage?: { inputTokens: number; outputTokens: number } | null },
  ): void {
    if (job.status !== "running") return; // first terminal state wins (cancel racing completion)
    job.status = status;
    job.finishedAt = new Date().toISOString();
    job.result = status === "done" ? (extra.result ?? null) : null;
    job.error = status === "done" ? null : (extra.error ?? "failed");
    job.usage = extra.usage ?? null;
    this.#persist();
    this.#deps.bus.emit("setup.job.updated", { jobId: job.id, status });
  }

  #persist(): void {
    this.#deps.db.kv.set(SETUP_JOBS_KEY, { jobs: this.#jobs });
  }
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
