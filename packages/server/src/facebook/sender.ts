// FacebookSender: the only path from the outbox to Facebook (docs/FANPAGE.md section 5). A background loop, modeled on the
// email Sender: it claims `approved` facebook_* items one at a time behind every gate (kill switch, quiet hours for the
// instant actions, rate limit, a final guard that re-checks the facts right before the network call).
//
// A post is NEVER published immediately: it is handed to Facebook as a scheduled post at max(the time the agent proposed,
// now + config.facebook.scheduleLeadHours), so a human can still cancel it in Meta Business Suite or on the Scheduled posts page.

import type { FacebookPageProvider, OutboxChannel, OutboxItem, OutboxPayload } from "@agyhq/core";
import { FACEBOOK_OUTBOX_CHANNELS } from "@agyhq/core";
import { FB_SCHEDULE_MAX_MS, isTransientFacebookError } from "@agyhq/channels";
import type { Db } from "@agyhq/db";
import type { AgyhqConfig } from "../config.ts";
import type { EventBus } from "../event-bus.ts";
import { isInQuietHours } from "../sender.ts";

export interface FacebookSenderDeps {
  config: Pick<AgyhqConfig, "facebook">;
  db: Db;
  bus: EventBus;
  /** null when no Facebook provider is configured: nothing is sent. A function is read on every attempt. */
  provider: FacebookPageProvider | null | (() => FacebookPageProvider | null);
  now?: () => Date;
  /** How often to check for work. Default 2000ms. */
  pollIntervalMs?: number;
}

/** When a post approved at `now` goes live: never earlier than now + the lead time, never earlier than the agent proposed. */
export function plannedPublishTime(publishAt: string | null | undefined, now: Date, leadHours: number): Date {
  const earliest = now.getTime() + leadHours * 3_600_000;
  const proposed = publishAt ? new Date(publishAt).getTime() : NaN;
  return new Date(Number.isFinite(proposed) && proposed > earliest ? proposed : earliest);
}

export class FacebookSender {
  #deps: FacebookSenderDeps;
  #timer: NodeJS.Timeout | null = null;
  #stopped = false;
  #ticking = false;
  #lastSendAt: string | null = null;
  #backoffUntil = new Map<string, number>();

  constructor(deps: FacebookSenderDeps) {
    this.#deps = deps;
  }

  #provider(): FacebookPageProvider | null {
    const p = this.#deps.provider;
    return typeof p === "function" ? p() : p;
  }

  get lastSendAt(): string | null {
    return this.#lastSendAt;
  }

  start(): void {
    const recovered = this.#deps.db.sqlite
      .prepare(`SELECT id FROM outbox WHERE status = 'sending' AND channel IN (${FACEBOOK_OUTBOX_CHANNELS.map(() => "?").join(", ")})`)
      .all(...FACEBOOK_OUTBOX_CHANNELS) as { id: string }[];
    // An item left "sending" by a crash may or may not have reached Facebook: do NOT release it automatically (that could
    // post twice). Fail it with a clear reason; the human checks the Page and retries from the Inbox if it is not there.
    for (const { id } of recovered) {
      this.#deps.db.outbox.markTerminalFailure(id, "the daemon stopped while sending; check the Page (Meta Business Suite) before retrying so nothing is posted twice");
    }
    this.#scheduleTick(0);
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  #scheduleTick(delayMs: number): void {
    if (this.#stopped) return;
    this.#timer = setTimeout(() => {
      void this.tick().finally(() => this.#scheduleTick(this.#deps.pollIntervalMs ?? 2000));
    }, delayMs);
    this.#timer.unref?.();
  }

  /** One send-attempt cycle; exposed so tests drive it without waiting on the timer. */
  async tick(): Promise<void> {
    if (this.#stopped || this.#ticking) return;
    this.#ticking = true;
    try {
      await this.#trySendOne();
    } finally {
      this.#ticking = false;
    }
  }

  clearBackoff(outboxId: string): void {
    this.#backoffUntil.delete(outboxId);
  }

  async #trySendOne(): Promise<void> {
    const { db, bus, config } = this.#deps;
    const provider = this.#provider();
    if (!provider) return;

    const now = this.#deps.now ? this.#deps.now() : new Date();
    const settings = db.settings.get();
    if (!settings.outboundEnabled) return; // the kill switch covers Facebook too

    // Replies and hides are instant public actions: not at night. Scheduling a post is not (it goes live later anyway).
    const channels: OutboxChannel[] = isInQuietHours(settings.quietHours, now) ? ["facebook_post"] : [...FACEBOOK_OUTBOX_CHANNELS];
    const sinceHour = new Date(now.getTime() - 3_600_000).toISOString();
    if (db.outbox.countSentSince(sinceHour, FACEBOOK_OUTBOX_CHANNELS) >= settings.sendRatePerHour) return;

    const claimed = db.outbox.claimNextToSend(channels);
    if (!claimed) return;

    const notBefore = this.#backoffUntil.get(claimed.id);
    if (notBefore && notBefore > now.getTime()) {
      db.outbox.decide(claimed.id, "approved", {});
      return;
    }

    const blockReason = this.#finalGuard(claimed, now);
    if (blockReason) {
      db.outbox.decide(claimed.id, "approved", {}); // sending -> blocked is not an edge; release first, as the email sender does
      db.outbox.decide(claimed.id, "blocked", { statusReason: blockReason });
      bus.emit("outbox.updated", { outboxId: claimed.id, status: "blocked", reason: blockReason });
      return;
    }

    try {
      await this.#deliver(provider, claimed, now, config.facebook.scheduleLeadHours);
      this.#backoffUntil.delete(claimed.id);
      this.#lastSendAt = now.toISOString();
      bus.emit("outbox.updated", { outboxId: claimed.id, status: "sent" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isTransientFacebookError(err) && claimed.attempts < 2) {
        const updated = db.outbox.markTransientFailure(claimed.id, message);
        this.#backoffUntil.set(claimed.id, Date.now() + updated.attempts * 5_000);
        bus.emit("outbox.updated", { outboxId: claimed.id, status: updated.status, reason: message });
      } else {
        db.outbox.markTerminalFailure(claimed.id, message);
        this.#backoffUntil.delete(claimed.id);
        db.audit.append({ kind: "outbox.failed", agentId: claimed.agentId, taskId: claimed.taskId, conversationId: null, data: { id: claimed.id, error: message } });
        bus.emit("outbox.updated", { outboxId: claimed.id, status: "failed", reason: message });
      }
    }
  }

  /** Re-check, right before the call, what could have changed since the human approved. */
  #finalGuard(item: OutboxItem, now: Date): string | null {
    const { db, config } = this.#deps;
    const agent = db.agents.get(item.agentId);
    if (!agent || agent.status === "archived") return "agent is archived or no longer exists";
    // Shadow-tier approvals park in `held`; an `approved` item for a shadow agent means it was demoted after approval.
    if (agent.trustTier === "shadow") return "agent is in the shadow tier: shadow drafts are never sent";
    const payload = item.payload;
    if (!payload) return "the item has no Facebook payload (it was not created by a fanpage tool)";

    if (item.channel === "facebook_post" && payload.kind === "post") {
      const at = plannedPublishTime(payload.publishAt, now, config.facebook.scheduleLeadHours);
      if (at.getTime() - now.getTime() > FB_SCHEDULE_MAX_MS) return "the planned publish time is more than 75 days ahead; edit it to an earlier time";
      return null;
    }
    if ((item.channel === "facebook_reply" || item.channel === "facebook_hide") && (payload.kind === "reply" || payload.kind === "hide")) {
      const comment = db.facebook.getComment(payload.commentId);
      if (!comment) return `comment ${payload.commentId} is not known (was it deleted?)`;
      if (comment.status === "own") return `comment ${payload.commentId} was written by the Page or is one of our own replies`;
      if (item.channel === "facebook_reply") {
        if (comment.status === "hidden") return "the comment was hidden meanwhile; not replying to a hidden comment";
        if (db.facebook.repliesTo(payload.commentId).length > 0) return "this comment already has a reply from us";
      } else if (comment.status === "hidden") return "the comment is already hidden";
      return null;
    }
    return `channel ${item.channel} does not match the payload (${payload.kind})`;
  }

  async #deliver(provider: FacebookPageProvider, item: OutboxItem, now: Date, leadHours: number): Promise<void> {
    const { db } = this.#deps;
    const payload = item.payload as OutboxPayload; // checked by #finalGuard
    const sentAt = now.toISOString();

    if (payload.kind === "post") {
      const at = plannedPublishTime(payload.publishAt, now, leadHours);
      const result = await provider.createPost({ message: item.body, link: payload.link, mode: "scheduled", scheduledPublishTime: at.toISOString() });
      db.outbox.decide(item.id, "sent", { messageId: result.postId, sentAt });
      db.outbox.setPayload(item.id, { ...payload, scheduledPublishTime: result.scheduledPublishTime, fbPostId: result.postId });
      db.facebook.recordAgentPost({
        id: result.postId,
        message: item.body,
        permalinkUrl: null,
        createdTime: sentAt,
        isPublished: false,
        scheduledPublishTime: result.scheduledPublishTime,
        outboxId: item.id,
      });
      this.#audit("facebook.post_scheduled", item, { postId: result.postId, scheduledPublishTime: result.scheduledPublishTime });
      this.#deps.bus.emit("facebook.post_scheduled", { outboxId: item.id, postId: result.postId, scheduledPublishTime: result.scheduledPublishTime });
    } else if (payload.kind === "reply") {
      const result = await provider.replyToComment({ commentId: payload.commentId, message: item.body });
      db.outbox.decide(item.id, "sent", { messageId: result.replyId, inReplyTo: payload.commentId, sentAt });
      db.outbox.setPayload(item.id, { ...payload, fbReplyId: result.replyId });
      db.facebook.recordReply({ replyId: result.replyId, commentId: payload.commentId, outboxId: item.id });
      db.facebook.setCommentStatus(payload.commentId, "replied");
      this.#audit("facebook.replied", item, { commentId: payload.commentId, replyId: result.replyId });
    } else {
      await provider.hideComment(payload.commentId);
      db.outbox.decide(item.id, "sent", { messageId: payload.commentId, sentAt });
      db.facebook.setCommentStatus(payload.commentId, "hidden");
      this.#audit("facebook.hidden", item, { commentId: payload.commentId });
    }
  }

  #audit(kind: "facebook.post_scheduled" | "facebook.replied" | "facebook.hidden", item: OutboxItem, data: Record<string, unknown>): void {
    this.#deps.db.audit.append({ kind, agentId: item.agentId, taskId: item.taskId, conversationId: null, data: { id: item.id, ...data } });
  }
}
