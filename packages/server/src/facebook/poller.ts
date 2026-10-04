// FacebookPoller: the polling half of the Fanpage channel (no webhooks in v1, docs/FANPAGE.md section 3). Same shape as
// EmailPoller: a timer, one poll at a time, a persisted cursor, errors kept for the status page instead of thrown.
//
// One cycle: fetch since the cursor -> store posts and comments (dedupe by comment id, the Page's own comments skipped) ->
// persist the cursor -> create reply tasks for the default Fanpage agent (when one is set; otherwise the comments stay
// `new` for the `comment_poll` routine).

import type { FacebookPageProvider } from "@agyhq/core";
import { nowIso } from "@agyhq/core";
import type { Db } from "@agyhq/db";
import type { FacebookConfig } from "../config.ts";
import type { EventBus } from "../event-bus.ts";
import { assignAndAnnounce, defaultFanpageAgent, storeFetched, type StoreSummary } from "./intake.ts";

export const FACEBOOK_CURSOR_KEY = "facebook";

export interface FacebookPollerCtx {
  db: Db;
  bus: EventBus;
  config: { facebook: FacebookConfig };
}

export interface FacebookPollResult extends StoreSummary {
  tasksCreated: number;
  cursor: string | null;
}

export class FacebookPoller {
  #ctx: FacebookPollerCtx;
  #provider: () => FacebookPageProvider | null;
  #timer: NodeJS.Timeout | null = null;
  #stopped = false;
  #started = false;
  #polling: Promise<FacebookPollResult | null> | null = null;
  #lastPollAt: string | null = null;
  #lastError: string | null = null;

  constructor(ctx: FacebookPollerCtx, provider: () => FacebookPageProvider | null) {
    this.#ctx = ctx;
    this.#provider = provider;
  }

  get lastPollAt(): string | null {
    return this.#lastPollAt;
  }

  get lastError(): string | null {
    return this.#lastError;
  }

  start(): void {
    this.#started = true;
    this.#stopped = false;
    this.#schedule(0);
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  async stopAndDrain(): Promise<void> {
    this.stop();
    await this.#polling?.catch(() => {});
  }

  #schedule(delayMs: number): void {
    if (this.#stopped || !this.#started) return;
    this.#timer = setTimeout(() => {
      void this.pollNow().finally(() => this.#schedule(this.#ctx.config.facebook.pollIntervalMs));
    }, delayMs);
    this.#timer.unref?.();
  }

  /** One poll cycle (exposed so tests and the eval runner can drive it deterministically). null when no provider is configured. */
  pollNow(): Promise<FacebookPollResult | null> {
    if (this.#polling) return this.#polling;
    this.#polling = this.#pollOnce().finally(() => {
      this.#polling = null;
    });
    return this.#polling;
  }

  async #pollOnce(): Promise<FacebookPollResult | null> {
    const provider = this.#provider();
    const { db, bus, config } = this.#ctx;
    if (!provider) {
      this.#lastError = null;
      return null;
    }
    try {
      const cursor = db.channelCursors.get(FACEBOOK_CURSOR_KEY);
      const fetched = await provider.fetchNew(cursor, { lookbackDays: config.facebook.lookbackDays });
      const summary = storeFetched({ db, bus, pageId: provider.pageId }, fetched);
      if (fetched.cursor !== cursor) db.channelCursors.set(FACEBOOK_CURSOR_KEY, fetched.cursor);

      let tasksCreated = 0;
      const agent = defaultFanpageAgent(db);
      if (agent && db.facebook.countUnassigned() > 0) tasksCreated = assignAndAnnounce(db, bus, agent, 50).length;
      this.#lastError = null;
      return { ...summary, tasksCreated, cursor: fetched.cursor };
    } catch (err) {
      this.#lastError = err instanceof Error ? err.message : String(err);
      bus.emit("facebook.error", { error: this.#lastError });
      return null;
    } finally {
      this.#lastPollAt = nowIso();
    }
  }
}
