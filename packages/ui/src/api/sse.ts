// Live event hub: one EventSource for the whole app, with auto-reconnect and
// backoff. Hooks subscribe to a type ("outbox.drafted") or "*" for
// everything. Each listener receives the parsed JSON payload the daemon put
// in `data:` (shape: BusEvent — at least { type, ...fields }).

import { eventsUrl } from "./client.ts";
import { getToken } from "../auth/token.ts";

export type HubEvent = { type: string; [key: string]: unknown };
export type HubListener = (event: HubEvent) => void;
export type ConnectionState = "connecting" | "open" | "closed";

const MAX_BACKOFF_MS = 15_000;

class EventHub {
  private source: EventSource | null = null;
  private listeners = new Map<string, Set<HubListener>>();
  private stateListeners = new Set<(s: ConnectionState) => void>();
  private state: ConnectionState = "closed";
  private backoff = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;

  start(): void {
    if (this.started) return;
    this.started = true;
    this.connect();
  }

  stop(): void {
    this.started = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.source?.close();
    this.source = null;
    this.setState("closed");
  }

  /** Force a reconnect, e.g. right after the token changes. */
  restart(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.source?.close();
    this.source = null;
    this.backoff = 1000;
    if (this.started) this.connect();
  }

  subscribe(type: string, listener: HubListener): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
    return () => set!.delete(listener);
  }

  subscribeState(listener: (s: ConnectionState) => void): () => void {
    this.stateListeners.add(listener);
    listener(this.state);
    return () => this.stateListeners.delete(listener);
  }

  private setState(state: ConnectionState): void {
    this.state = state;
    for (const l of this.stateListeners) l(state);
  }

  private connect(): void {
    const token = getToken();
    if (!token) {
      this.setState("closed");
      return;
    }
    this.setState("connecting");
    const es = new EventSource(eventsUrl(token));
    this.source = es;
    es.onopen = () => {
      this.backoff = 1000;
      this.setState("open");
    };
    es.onmessage = (ev) => this.dispatch(ev);
    // Named events (event: outbox.drafted) arrive as separate listeners in
    // the browser's EventSource; the server also sends a generic message.
    const knownTypes = [
      "task.transition",
      "run.event",
      "run.finished",
      "outbox.drafted",
      "outbox.updated",
      "memory.proposed",
      "inbound.received",
      "inbound.routed",
      "settings.changed",
      "status.changed",
      "routine.ran",
      "routine.updated",
      "eval.updated",
      "outbound.auto_paused",
      "setup.job.updated",
      "setup.job.progress",
      "contact.handoff",
      "briefing.created",
      // Emitted by the daemon and watched by pages (useApi refreshOn); without a listener here they never arrive.
      "task.created",
      "agent.created",
      "agent.updated",
      "contact.upserted",
      "contact.imported",
      "memory.updated",
      "kb.synced",
    ];
    for (const t of knownTypes) {
      es.addEventListener(t, (ev) => this.dispatch(ev as MessageEvent));
    }
    es.onerror = () => {
      es.close();
      this.source = null;
      this.setState("closed");
      if (!this.started) return;
      this.reconnectTimer = setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    };
  }

  private dispatch(ev: MessageEvent): void {
    let parsed: HubEvent;
    try {
      const raw = JSON.parse(ev.data) as HubEvent & { data?: unknown };
      // The daemon sends { type, data: {...}, at }. Lift data's fields to the top level so
      // listeners can read e.taskId etc. directly; `data` stays available too.
      const data = raw.data && typeof raw.data === "object" && !Array.isArray(raw.data) ? (raw.data as Record<string, unknown>) : {};
      parsed = { ...data, ...raw };
    } catch {
      return;
    }
    const type = parsed.type ?? "unknown";
    for (const l of this.listeners.get(type) ?? []) l(parsed);
    for (const l of this.listeners.get("*") ?? []) l(parsed);
  }
}

export const eventHub = new EventHub();
