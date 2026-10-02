// Keeps outbound honest after it has been enabled: if a go-live readiness check
// starts failing while sending is on (e.g. placeholder text lands in the KB, the
// SDR agent is paused, the mailbox password is revoked), sending is paused
// automatically until a human re-enables it.
//
// Failures a human explicitly accepted when force-enabling are "acknowledged"
// (kv READINESS_ACK_KEY) and don't pause — otherwise a forced enable would be
// undone on the next tick. An acknowledged check that later passes is dropped
// from the acknowledgement, so if it regresses again it does pause.
//
// email.verified probes the network, so it must fail on two consecutive checks
// before it pauses; content/config failures pause immediately.

import type { ReadinessCheck, ReadinessReport } from "@agyhq/core";
import type { Db } from "@agyhq/db";
import type { AgyhqConfig } from "../config.ts";
import type { EventBus } from "../event-bus.ts";
import { computeReadiness, failingChecks, type VerifyResult } from "./checks.ts";

export const READINESS_ACK_KEY = "readiness_ack";
const TRANSIENT_CHECKS = new Set(["email.verified"]);
const TRANSIENT_STREAK_TO_PAUSE = 2;
const EVENT_DEBOUNCE_MS = 500;
/** Bus events after which readiness may have changed. */
const RECHECK_ON = new Set(["kb.synced", "kb.edited", "agent.created", "agent.updated", "settings.changed"]);

export function readAcknowledged(db: Db): string[] {
  return db.kv.get<{ ids: string[] }>(READINESS_ACK_KEY)?.ids ?? [];
}

/** Record which failing checks a human accepted when (force-)enabling outbound; [] clears. */
export function writeAcknowledged(db: Db, ids: string[]): void {
  db.kv.set(READINESS_ACK_KEY, { ids, at: new Date().toISOString() });
}

export interface ReadinessMonitorDeps {
  config: AgyhqConfig;
  db: Db;
  bus: EventBus;
  verifyEmail: (opts?: { fresh?: boolean }) => Promise<VerifyResult>;
  intervalMs?: number;
  /** Test seam: replaces computeReadiness. */
  compute?: () => Promise<ReadinessReport>;
}

export interface MonitorResult {
  paused: boolean;
  blocking: ReadinessCheck[];
  report: ReadinessReport;
}

export class ReadinessMonitor {
  readonly #deps: ReadinessMonitorDeps;
  readonly #intervalMs: number;
  #timer: ReturnType<typeof setInterval> | null = null;
  #debounce: ReturnType<typeof setTimeout> | null = null;
  #unsubscribe: (() => void) | null = null;
  #lastCheckedAt = 0;
  #transientStreak = 0;
  #inFlight: Promise<MonitorResult> | null = null;

  constructor(deps: ReadinessMonitorDeps) {
    this.#deps = deps;
    this.#intervalMs = deps.intervalMs ?? 30_000;
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.check().catch(logError), this.#intervalMs);
    this.#unsubscribe = this.#deps.bus.subscribe((event) => {
      if (!RECHECK_ON.has(event.type)) return;
      if (this.#debounce) clearTimeout(this.#debounce);
      this.#debounce = setTimeout(() => void this.check().catch(logError), EVENT_DEBOUNCE_MS);
    });
    void this.check().catch(logError);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    if (this.#debounce) clearTimeout(this.#debounce);
    this.#unsubscribe?.();
    this.#timer = null;
    this.#debounce = null;
    this.#unsubscribe = null;
  }

  /** Re-check if the last check is older than the interval (the sender calls this before each send). */
  async checkIfStale(): Promise<void> {
    if (Date.now() - this.#lastCheckedAt < this.#intervalMs) return;
    await this.check();
  }

  /** One evaluation; concurrent callers share the in-flight run. */
  check(): Promise<MonitorResult> {
    this.#inFlight ??= this.#run().finally(() => {
      this.#inFlight = null;
    });
    return this.#inFlight;
  }

  async #run(): Promise<MonitorResult> {
    const { db, config } = this.#deps;
    const report = this.#deps.compute
      ? await this.#deps.compute()
      : await computeReadiness({ config, db, verifyEmail: () => this.#deps.verifyEmail({ fresh: false }) });
    this.#lastCheckedAt = Date.now();

    const failing = failingChecks(report);
    const failingIds = new Set(failing.map((f) => f.id));
    const acknowledged = readAcknowledged(db);
    const stillAcknowledged = acknowledged.filter((id) => failingIds.has(id));
    if (stillAcknowledged.length !== acknowledged.length) writeAcknowledged(db, stillAcknowledged);

    if (!db.settings.get().outboundEnabled) {
      this.#transientStreak = 0;
      return { paused: false, blocking: [], report };
    }

    const unacknowledged = failing.filter((f) => !stillAcknowledged.includes(f.id));
    const transientFailing = unacknowledged.some((f) => TRANSIENT_CHECKS.has(f.id));
    this.#transientStreak = transientFailing ? this.#transientStreak + 1 : 0;
    const blocking = unacknowledged.filter(
      (f) => !TRANSIENT_CHECKS.has(f.id) || this.#transientStreak >= TRANSIENT_STREAK_TO_PAUSE,
    );
    if (blocking.length === 0) return { paused: false, blocking, report };

    this.#pause(blocking);
    this.#transientStreak = 0;
    return { paused: true, blocking, report };
  }

  #pause(blocking: ReadinessCheck[]): void {
    const { db, bus } = this.#deps;
    const reason = `auto-paused: readiness failing — ${blocking.map((f) => f.title).join("; ")}`;
    db.settings.patch({ outboundEnabled: false, outboundDisabledReason: reason });
    db.audit.append({
      kind: "outbound.auto_paused",
      agentId: null,
      taskId: null,
      conversationId: null,
      data: { failing: blocking.map((f) => ({ id: f.id, title: f.title, detail: f.detail })) },
    });
    bus.emit("settings.changed", { outboundEnabled: false, reason });
    bus.emit("status.changed", { outboundEnabled: false, reason });
    bus.emit("outbound.auto_paused", { reason, failing: blocking.map((f) => f.id) });
  }
}

function logError(err: unknown): void {
  console.error("[readiness-monitor]", err instanceof Error ? err.message : err);
}
