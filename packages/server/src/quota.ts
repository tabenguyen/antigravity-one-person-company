// Quota poller / throttle (docs/PHASE0.md D7, docs/PLAN.md 3.1).
//
// Polls `agy --print "/usage"` on an interval (and once at start), records
// every snapshot, and exposes a simple isThrottled() the orchestrator
// consults before claiming low-priority work. Must never crash the daemon —
// readQuota() already swallows every failure and resolves [], and this class
// wraps the rest (db write, scheduling) defensively too.
//
// Simplification for Phase 1: agy's quota buckets are grouped by model
// family ("Gemini Models", "Claude and GPT models"), not by individual model
// id, and nothing in the observed /usage shape maps an agent's configured
// model back to a group name. Rather than guess at that mapping, throttling
// triggers when ANY bucket's remainingFraction drops below the configured
// floor — documented as a known over-approximation in the daemon's README.

import { readQuota } from "@agyhq/runner";
import type { Db } from "@agyhq/db";
import type { AgyhqConfig } from "./config.ts";
import type { EventBus } from "./event-bus.ts";

export interface QuotaMonitorDeps {
  config: AgyhqConfig;
  db: Db;
  bus: EventBus;
}

export class QuotaMonitor {
  #deps: QuotaMonitorDeps;
  #throttled = false;
  #timer: NodeJS.Timeout | null = null;
  #stopped = false;

  constructor(deps: QuotaMonitorDeps) {
    this.#deps = deps;
  }

  isThrottled(): boolean {
    return this.#throttled;
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
      const nextThrottled = minFraction < this.#deps.config.quota.minRemainingFraction;
      if (nextThrottled !== this.#throttled) {
        this.#deps.bus.emit("quota.throttle", { throttled: nextThrottled, minFraction, buckets });
      }
      this.#throttled = nextThrottled;
    } catch {
      // readQuota() already never throws; this is defense in depth around
      // db.quota.record() / bus.emit() so a quota hiccup can never take the
      // daemon down.
    }
  }
}
