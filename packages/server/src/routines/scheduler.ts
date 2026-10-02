// Routine scheduler: every `tickMs` (30s) runs each enabled routine whose nextRunAt
// has arrived — once. A run always moves nextRunAt to the next cron slot after "now"
// inside the same transaction as its tasks, so a restart (or a slow tick) can never
// run the same slot twice. A slot that was missed by more than a day (daemon down /
// laptop asleep) is skipped and recorded as "missed" instead of being replayed.

import type { Routine } from "@agyhq/core";
import type { Db } from "@agyhq/db";
import type { EventBus } from "../event-bus.ts";
import { computeNextRunAt, runRoutine, type RoutineRunOutcome } from "./run.ts";

export const MISSED_THRESHOLD_MS = 24 * 3_600_000;
export const DEFAULT_TICK_MS = 30_000;

export interface RoutineSchedulerDeps {
  db: Db;
  bus: EventBus;
  tickMs?: number;
  now?: () => Date;
}

export interface TickResult extends RoutineRunOutcome {
  missed?: boolean;
}

export class RoutineScheduler {
  readonly #deps: RoutineSchedulerDeps;
  #timer: NodeJS.Timeout | null = null;
  #stopped = true;

  constructor(deps: RoutineSchedulerDeps) {
    this.#deps = deps;
  }

  #now(): Date {
    return (this.#deps.now ?? (() => new Date()))();
  }

  /** Fills in nextRunAt for enabled routines that lack one, then starts ticking (first tick immediately). */
  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.reconcile();
    this.#schedule(0);
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  #schedule(delay: number): void {
    if (this.#stopped) return;
    this.#timer = setTimeout(() => {
      try {
        this.tick();
      } catch (err) {
        this.#deps.bus.emit("routine.error", { error: err instanceof Error ? err.message : String(err) });
      }
      this.#schedule(this.#deps.tickMs ?? DEFAULT_TICK_MS);
    }, delay);
    this.#timer.unref?.();
  }

  /** Enabled routines with no nextRunAt (e.g. created by hand in the db) get one. Never runs anything. */
  reconcile(): void {
    const now = this.#now();
    for (const r of this.#deps.db.routines.list()) {
      if (r.enabled && !r.nextRunAt) {
        this.#deps.db.routines.update(r.id, { nextRunAt: computeNextRunAt(r, now) });
      }
    }
  }

  /** One scheduler pass over due routines. Synchronous (all db work); exposed for tests. */
  tick(): TickResult[] {
    const { db, bus } = this.#deps;
    const now = this.#now();
    const results: TickResult[] = [];
    for (const routine of db.routines.listDue(now.toISOString())) {
      if (this.#isMissed(routine, now)) {
        const result = `missed: scheduled run at ${routine.nextRunAt} was skipped (more than 1 day late)`;
        db.routines.update(routine.id, { lastResult: result, nextRunAt: computeNextRunAt(routine, now) });
        db.audit.append({
          kind: "routine.ran",
          agentId: routine.agentId,
          taskId: null,
          conversationId: null,
          data: { routineId: routine.id, name: routine.name, kind: routine.kind, manual: false, missed: true, result, skipped: true, taskIds: [] },
        });
        bus.emit("routine.ran", { routineId: routine.id, agentId: routine.agentId, result, skipped: true, missed: true, manual: false });
        results.push({ routineId: routine.id, result, skipped: true, taskIds: [], missed: true });
        continue;
      }
      results.push(runRoutine({ db, bus, now: () => now }, routine, { manual: false }));
    }
    return results;
  }

  #isMissed(routine: Routine, now: Date): boolean {
    return routine.nextRunAt !== null && now.getTime() - new Date(routine.nextRunAt).getTime() > MISSED_THRESHOLD_MS;
  }
}
