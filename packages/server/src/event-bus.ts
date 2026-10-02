// Tiny in-process pub/sub used to fan out task transitions, run events, and
// outbox/memory changes to the admin SSE endpoint (and, in future, agy-ui).
// Node EventEmitter under the hood; nothing here persists — the audit log
// (@agyhq/db) is the durable record, this is just for live updates.

import { EventEmitter } from "node:events";
import { nowIso } from "@agyhq/core";

export interface BusEvent {
  type: string;
  data: Record<string, unknown>;
  at: string;
}

export type BusListener = (event: BusEvent) => void;

export class EventBus {
  #emitter = new EventEmitter();

  constructor() {
    // Many SSE clients / internal subscribers over the daemon's lifetime.
    this.#emitter.setMaxListeners(200);
  }

  emit(type: string, data: Record<string, unknown> = {}): void {
    const event: BusEvent = { type, data, at: nowIso() };
    this.#emitter.emit("event", event);
  }

  subscribe(listener: BusListener): () => void {
    this.#emitter.on("event", listener);
    return () => this.#emitter.off("event", listener);
  }
}
