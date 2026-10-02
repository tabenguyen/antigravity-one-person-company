// Outbound sender (docs/PLAN.md §3.4): a background loop that claims
// `approved` outbox items one at a time and sends them, behind every gate
// the brief calls for — kill switch, quiet hours, rate limit, and a final
// per-send guard that re-checks opt-out/bounce/archived status right before
// the network call (policy can change between approval and send).

import type { Db } from "@agyhq/db";
import { nowIso } from "@agyhq/core";
import type { EmailProvider, HqSettings, OutboxItem, OutgoingEmail } from "@agyhq/core";
import { newMessageId } from "@agyhq/channels";
import type { AgyhqConfig } from "./config.ts";
import type { EventBus } from "./event-bus.ts";
import { effectiveSender, type EffectiveSender } from "./setup/sender-settings.ts";
import { SUPERSEDED_PREFIX } from "./sent-sync.ts";

export interface SenderDeps {
  config: AgyhqConfig;
  db: Db;
  bus: EventBus;
  /**
   * null when no provider is configured — the sender simply never sends; status explains why. A function is read on
   * every send attempt so the setup wizard can hot-swap the mailbox (EmailRuntime) without restarting the daemon.
   */
  provider: EmailProvider | null | (() => EmailProvider | null);
  now?: () => Date;
  /** How often to check for work. Default 2000ms. */
  pollIntervalMs?: number;
  /** Called before claiming an item; may disable outbound (e.g. the readiness monitor re-checking). */
  beforeSend?: () => Promise<void>;
}

function getHourInTimezone(date: Date, timezone: string): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: timezone }).formatToParts(
      date,
    );
    return Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
  } catch {
    return date.getUTCHours();
  }
}

export function isInQuietHours(quietHours: HqSettings["quietHours"], now: Date): boolean {
  if (!quietHours) return false;
  const { startHour, endHour, timezone } = quietHours;
  if (startHour === endHour) return false;
  const hour = getHourInTimezone(now, timezone);
  if (startHour < endHour) return hour >= startHour && hour < endHour;
  return hour >= startHour || hour < endHour; // wraps past midnight, e.g. 21 -> 8
}

const PERMANENT_SMTP_RE = /^(5\d\d)\b|invalid (recipient|address)|no such user|mailbox (unavailable|not found)/i;

/** Transient (retryable) unless it looks like a permanent SMTP rejection (5xx, unknown user, ...). */
export function isTransientError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return !PERMANENT_SMTP_RE.test(message);
}

function ensureFooter(body: string, sender: EffectiveSender): string {
  if (sender.companyAddressLine && body.includes(sender.companyAddressLine)) return body;
  const footerLines = ["", "--"];
  if (sender.name) footerLines.push(sender.name);
  if (sender.companyAddressLine) footerLines.push(sender.companyAddressLine);
  if (sender.unsubscribeMailto) {
    footerLines.push(`Don't want these emails? Reply "unsubscribe" or email ${sender.unsubscribeMailto}.`);
  }
  return `${body.trimEnd()}\n${footerLines.join("\n")}`;
}

export class Sender {
  #deps: SenderDeps;
  #timer: NodeJS.Timeout | null = null;
  #stopped = false;
  #ticking = false;
  #lastSendAt: string | null = null;
  #backoffUntil = new Map<string, number>();

  constructor(deps: SenderDeps) {
    this.#deps = deps;
  }

  #provider(): EmailProvider | null {
    const p = this.#deps.provider;
    return typeof p === "function" ? p() : p;
  }

  get lastSendAt(): string | null {
    return this.#lastSendAt;
  }

  start(): void {
    const recovered = this.#deps.db.outbox.recoverSending();
    if (recovered.length > 0) this.#deps.bus.emit("orchestrator.recovered", { outboxIds: recovered });
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
  }

  /** Runs exactly one send-attempt cycle. Exposed (not just internal) so tests can drive it deterministically without waiting on the poll timer. */
  async tick(): Promise<void> {
    if (this.#stopped || this.#ticking) return;
    this.#ticking = true;
    try {
      await this.#trySendOne();
    } finally {
      this.#ticking = false;
    }
  }

  /** Test seam: clears the in-process retry backoff for one item so a retry test doesn't have to wait on wall-clock time. */
  clearBackoff(outboxId: string): void {
    this.#backoffUntil.delete(outboxId);
  }

  /** Runs exactly one send attempt per call (if one is due) — exposed so tests can drive it deterministically. */
  async #trySendOne(): Promise<void> {
    const { db, bus } = this.#deps;
    const provider = this.#provider();
    if (!provider) return;

    const now = this.#deps.now ? this.#deps.now() : new Date();
    let settings = db.settings.get();
    if (!settings.outboundEnabled) return;
    if (isInQuietHours(settings.quietHours, now)) return;
    if (this.#deps.beforeSend) {
      await this.#deps.beforeSend();
      settings = db.settings.get();
      if (!settings.outboundEnabled) return;
    }

    const sinceHour = new Date(now.getTime() - 3_600_000).toISOString();
    if (db.outbox.countSentSince(sinceHour) >= settings.sendRatePerHour) return;

    const claimed = db.outbox.claimNextToSend();
    if (!claimed) return;

    const notBefore = this.#backoffUntil.get(claimed.id);
    if (notBefore && notBefore > now.getTime()) {
      db.outbox.decide(claimed.id, "approved", {});
      return;
    }

    const blockReason = this.#finalGuard(claimed);
    if (blockReason) {
      // OUTBOX_TRANSITIONS has no sending -> blocked edge (blocked is a draft-time-only
      // outcome in the normal lifecycle); release back to approved first, then block.
      db.outbox.decide(claimed.id, "approved", {});
      db.outbox.decide(claimed.id, "blocked", { statusReason: blockReason });
      bus.emit("outbox.updated", { outboxId: claimed.id, status: "blocked", reason: blockReason });
      return;
    }

    const email = this.#compose(claimed);

    try {
      const result = await provider.send(email);
      const sentAt = nowIso();
      db.outbox.decide(claimed.id, "sent", { messageId: result.messageId, inReplyTo: email.inReplyTo ?? null, sentAt });
      this.#backoffUntil.delete(claimed.id);
      this.#lastSendAt = sentAt;

      db.audit.append({
        kind: "outbox.sent",
        agentId: claimed.agentId,
        taskId: claimed.taskId,
        conversationId: null,
        data: { id: claimed.id, to: claimed.to, messageId: result.messageId },
      });
      bus.emit("outbox.updated", { outboxId: claimed.id, status: "sent" });

      const contact = db.crm.findContacts({ email: claimed.to })[0] ?? null;
      if (contact && (["new", "researching", "qualified"] as string[]).includes(contact.stage)) {
        db.crm.setStage(contact.id, "contacted", "outbound email sent");
      }

      this.#checkAutoTrip();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isTransientError(err) && claimed.attempts < 2) {
        const updated = db.outbox.markTransientFailure(claimed.id, message);
        this.#backoffUntil.set(claimed.id, Date.now() + updated.attempts * 5_000);
        bus.emit("outbox.updated", { outboxId: claimed.id, status: updated.status, reason: message });
      } else {
        db.outbox.markTerminalFailure(claimed.id, message);
        this.#backoffUntil.delete(claimed.id);
        db.audit.append({
          kind: "outbox.failed",
          agentId: claimed.agentId,
          taskId: claimed.taskId,
          conversationId: null,
          data: { id: claimed.id, error: message },
        });
        bus.emit("outbox.updated", { outboxId: claimed.id, status: "failed", reason: message });
      }
    }
  }

  #finalGuard(item: OutboxItem): string | null {
    const { db } = this.#deps;
    const agent = db.agents.get(item.agentId);
    if (!agent || agent.status === "archived") return "agent is archived or no longer exists";
    // Shadow-tier agents NEVER send. A human "approving" their draft parks it in `held`, so an `approved` item should
    // not exist for one — unless the agent was demoted to shadow after the approval. Refuse either way.
    if (agent.trustTier === "shadow") return "agent is in the shadow tier: shadow drafts are never sent";
    // A human already answered this person from their own mail client after this draft was written (Sent-folder sync).
    if (item.statusReason?.startsWith(SUPERSEDED_PREFIX)) return item.statusReason;
    const contact = db.crm.findContacts({ email: item.to })[0] ?? null;
    if (contact) {
      const attrs = contact.attributes ?? {};
      if (attrs["optOut"] === true || attrs["doNotContact"] === true || attrs["emailBounced"] === true) {
        return "recipient has opted out, bounced, or is marked do-not-contact";
      }
    }
    return null;
  }

  #compose(item: OutboxItem): OutgoingEmail {
    const { config, db } = this.#deps;
    const sender = effectiveSender(config, db);
    const domain = sender.address.split("@")[1] || "localhost";
    const messageId = newMessageId(domain);

    let inReplyTo: string | null = null;
    let references: string[] = [];
    if (item.threadKey) {
      const latestInbound = db.inbound.listByThreadKey(item.threadKey, 1)[0] ?? null;
      if (latestInbound?.messageId) {
        inReplyTo = latestInbound.messageId;
        references = [...new Set([...latestInbound.references, latestInbound.messageId])];
      }
    }

    return {
      from: { address: sender.address, name: sender.name || null },
      to: { address: item.to, name: null },
      subject: item.subject ?? "(no subject)",
      text: ensureFooter(item.body, sender),
      messageId,
      inReplyTo,
      references,
      listUnsubscribe: sender.unsubscribeMailto ? `<mailto:${sender.unsubscribeMailto}?subject=unsubscribe>` : null,
    };
  }

  #checkAutoTrip(): void {
    const { db, bus } = this.#deps;
    const settings = db.settings.get();
    if (!settings.outboundEnabled) return;
    const windowSize = settings.autoTrip.windowSize;
    const recent = db.outbox.lastSent(windowSize);
    if (recent.length < windowSize) return;
    const bounced = recent.filter((i) => i.statusReason?.startsWith("bounced:")).length;
    const rate = bounced / recent.length;
    if (rate > settings.autoTrip.maxBounceRate) {
      const reason = `auto-trip: bounce rate ${(rate * 100).toFixed(1)}% over the last ${recent.length} sends exceeds ${(settings.autoTrip.maxBounceRate * 100).toFixed(1)}%`;
      db.settings.patch({ outboundEnabled: false, outboundDisabledReason: reason });
      db.audit.append({
        kind: "settings.changed",
        agentId: null,
        taskId: null,
        conversationId: null,
        data: { outboundEnabled: false, reason },
      });
      bus.emit("settings.changed", { outboundEnabled: false, reason });
      bus.emit("status.changed", { outboundEnabled: false, reason });
    }
  }
}
