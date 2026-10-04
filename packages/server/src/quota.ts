// Quota poller / throttle (docs/PHASE0.md D7, docs/PLAN.md 3.1).
//
// Polls `agy --print "/usage"` on an interval (and once at start), records
// every snapshot, and exposes a simple isThrottled() the orchestrator
// consults before claiming low-priority work. Must never crash the daemon —
// readQuota() already swallows every failure and resolves [], and this class
// wraps the rest (db write, scheduling) defensively too.
//
// agy's quota buckets are grouped by model family ("Gemini Models",
// "Claude and GPT models"), not by model id. isThrottledFor(model) maps an
// agent's model to its family by prefix (gemini-* / claude-* / gpt-*), so a
// drained Gemini bucket doesn't hold back agents running on Claude. A model
// id that matches no family falls back to isThrottled(): any bucket below
// the floor.

import { readQuota } from "@agyhq/runner";
import type { QuotaBucket } from "@agyhq/core";
import type { Db } from "@agyhq/db";
import type { AgyhqConfig } from "./config.ts";
import type { EventBus } from "./event-bus.ts";

/** The quota family a bucket group name or a model id belongs to; null when it names no known family. */
export function quotaFamily(nameOrModel: string): "gemini" | "claude-gpt" | null {
  const s = nameOrModel.toLowerCase();
  if (s.startsWith("gemini") || s.includes("gemini models")) return "gemini";
  if (s.startsWith("claude") || s.startsWith("gpt") || s.includes("claude and gpt")) return "claude-gpt";
  return null;
}

/** Families (or raw group names, for unknown families) with a bucket below the floor. */
export function throttledFamilies(buckets: QuotaBucket[], floor: number): Set<string> {
  const out = new Set<string>();
  for (const b of buckets) if (b.remainingFraction < floor) out.add(quotaFamily(b.group) ?? b.group);
  return out;
}

export interface QuotaMonitorDeps {
  config: AgyhqConfig;
  db: Db;
  bus: EventBus;
}

export class QuotaMonitor {
  #deps: QuotaMonitorDeps;
  #throttled = new Set<string>();
  #timer: NodeJS.Timeout | null = null;
  #stopped = false;

  constructor(deps: QuotaMonitorDeps) {
    this.#deps = deps;
  }

  /** Any quota family is below the floor (status display, and models of unknown family). */
  isThrottled(): boolean {
    return this.#throttled.size > 0;
  }

  /** Whether an agent running `model` should hold back low-priority work. */
  isThrottledFor(model: string): boolean {
    const family = quotaFamily(model);
    return family === null ? this.isThrottled() : this.#throttled.has(family);
  }

  async start(): Promise<void> {
    await this.#poll();
    this.#schedule();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  #schedule(): void {
    if (this.#stopped) return;
    this.#timer = setTimeout(() => {
      void this.#poll().finally(() => this.#schedule());
    }, this.#deps.config.quota.pollIntervalMs);
  }

  async #poll(): Promise<void> {
    try {
      const buckets = await readQuota(this.#deps.config.agyBin);
      if (buckets.length === 0) return; // agy's /usage failed or returned nothing — never crash, just skip this cycle.
      this.#deps.db.quota.record(buckets);
      const minFraction = Math.min(...buckets.map((b) => b.remainingFraction));
      const next = throttledFamilies(buckets, this.#deps.config.quota.minRemainingFraction);
      const changed = next.size !== this.#throttled.size || [...next].some((f) => !this.#throttled.has(f));
      this.#throttled = next;
      if (changed) {
        this.#deps.bus.emit("quota.throttle", { throttled: next.size > 0, families: [...next], minFraction, buckets });
      }
    } catch {
      // readQuota() already never throws; this is defense in depth around
      // db.quota.record() / bus.emit() so a quota hiccup can never take the
      // daemon down.
    }
  }
}
