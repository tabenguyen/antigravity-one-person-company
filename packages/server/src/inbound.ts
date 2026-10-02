// Inbound pipeline (docs/PLAN.md §3.4): turn a parsed email or a webhook lead
// into a persisted InboundEvent, then route it DETERMINISTICALLY — no model
// call on this path, since routing decides who gets a task and whether a
// contact is opted out, and inbound content is untrusted (PHASE0.md D3/D4).

import { createHash } from "node:crypto";
import { nowIso } from "@agyhq/core";
import type { Db, CreateInboundInput } from "@agyhq/db";
import type {
  EmailProvider,
  InboundClassification,
  InboundEvent,
  ParsedEmail,
  Task,
  TaskStatus,
} from "@agyhq/core";
import { classifyEmail } from "@agyhq/channels";
import type { AgyhqConfig } from "./config.ts";
import type { EventBus } from "./event-bus.ts";
import type { WebhookLeadRequest } from "./admin-types.ts";
import { effectiveSender } from "./setup/sender-settings.ts";
import { attachmentMeta, attachmentsRoot, eventAttachments, saveAttachments, withAttachmentNote } from "./attachments.ts";

export interface InboundCtx {
  db: Db;
  bus: EventBus;
  config: AgyhqConfig;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function ourAddresses(config: AgyhqConfig, db: Db): string[] {
  const addrs: string[] = [];
  const senderAddress = effectiveSender(config, db).address;
  if (senderAddress) addrs.push(senderAddress.toLowerCase());
  if ("address" in config.email && config.email.address) addrs.push(config.email.address.toLowerCase());
  return [...new Set(addrs)];
}

const CANCELLABLE_STATUSES: TaskStatus[] = ["queued", "waiting_approval", "waiting_external"];

function cancelTasksOnThread(ctx: InboundCtx, threadKey: string | null, kinds?: string[]): void {
  if (!threadKey) return;
  const tasks = ctx.db.tasks
    .list({ status: CANCELLABLE_STATUSES })
    .filter((t) => t.threadKey === threadKey && (!kinds || kinds.includes(t.kind)));
  for (const t of tasks) {
    try {
      ctx.db.tasks.transition(t.id, "cancelled");
      ctx.bus.emit("task.transition", { taskId: t.id, to: "cancelled", reason: "inbound routing" });
    } catch {
      // already terminal — fine, nothing to cancel.
    }
  }
}

/** Deterministic, truncated recap of a thread: last ~5 sent emails + inbound messages, chronological. Excludes `currentEventId` (the message being handled). */
function buildThreadSummary(ctx: InboundCtx, threadKey: string | null, currentEventId?: string): string {
  if (!threadKey) return "(no prior thread)";
  const sent = ctx.db.outbox.listByThreadKey(threadKey, 10).filter((i) => i.status === "sent");
  const inbound = ctx.db.inbound.listByThreadKey(threadKey, 10).filter((i) => i.id !== currentEventId);
  const items: { at: string; text: string }[] = [
    ...sent.map((s) => ({
      at: s.sentAt ?? s.updatedAt,
      text: `We sent ("${s.subject ?? "(no subject)"}"): ${truncate(s.body, 400)}`,
    })),
    ...inbound.map((i) => ({
      at: i.receivedAt,
      text: `They wrote ("${i.subject ?? "(no subject)"}"): ${truncate(i.bodyText.trim(), 400) || "(empty body)"}`,
    })),
  ];
  items.sort((a, b) => a.at.localeCompare(b.at));
  const recap = items.slice(-5).map((i) => i.text).join("\n\n");
  return truncate(recap || "(no prior thread)", 3000);
}

function routeUnsubscribe(ctx: InboundCtx, event: InboundEvent): void {
  const email = event.fromAddress;
  if (!email) {
    ctx.db.inbound.setStatus(event.id, "ignored", { statusReason: "unsubscribe with no from address" });
    return;
  }
  const { contact } = ctx.db.crm.upsertContact({ email, attributes: { optOut: true } });
  ctx.db.crm.setStage(contact.id, "disqualified", "unsubscribed via inbound email");
  cancelTasksOnThread(ctx, event.threadKey);
  const rejected = ctx.db.outbox.rejectAllTo(email, "policy:opt-out", "contact unsubscribed");
  for (const item of rejected) ctx.bus.emit("outbox.updated", { outboxId: item.id, status: "rejected" });

  ctx.db.audit.append({
    kind: "contact.opted_out",
    agentId: null,
    taskId: null,
    conversationId: null,
    data: { contactId: contact.id, email, rejectedOutboxCount: rejected.length },
  });
  ctx.db.inbound.setStatus(event.id, "routed", { contactId: contact.id });
  ctx.db.audit.append({
    kind: "inbound.routed",
    agentId: null,
    taskId: null,
    conversationId: null,
    data: { id: event.id, action: "opt_out" },
  });
  ctx.bus.emit("inbound.routed", { id: event.id, action: "opt_out" });
}

function routeBounce(ctx: InboundCtx, event: InboundEvent): void {
  const recipient = (event.payload["bouncedRecipient"] as string | undefined) ?? null;
  if (!recipient) {
    ctx.db.inbound.setStatus(event.id, "ignored", { statusReason: "bounce with no identifiable recipient" });
    return;
  }
  const { contact } = ctx.db.crm.upsertContact({ email: recipient, attributes: { emailBounced: true, doNotContact: true } });
  const sentToRecipient = ctx.db.outbox.list({ status: ["sent"] }).filter((i) => i.to.toLowerCase() === recipient.toLowerCase());
  for (const item of sentToRecipient) ctx.db.outbox.annotateBounce(item.id, "delivery status notification received");

  ctx.db.inbound.setStatus(event.id, "routed", { contactId: contact.id });
  ctx.db.audit.append({
    kind: "inbound.routed",
    agentId: null,
    taskId: null,
    conversationId: null,
    data: { id: event.id, action: "bounce", recipient, markedSent: sentToRecipient.map((i) => i.id) },
  });
  ctx.bus.emit("inbound.routed", { id: event.id, action: "bounce" });
}

function ignore(ctx: InboundCtx, event: InboundEvent, reason: string): void {
  ctx.db.inbound.setStatus(event.id, "ignored", { statusReason: reason });
  ctx.db.audit.append({
    kind: "inbound.ignored",
    agentId: null,
    taskId: null,
    conversationId: null,
    data: { id: event.id, reason },
  });
  ctx.bus.emit("inbound.routed", { id: event.id, status: "ignored", reason });
}

function routeReply(ctx: InboundCtx, event: InboundEvent): void {
  const contact = event.contactId
    ? ctx.db.crm.getContact(event.contactId)
    : event.fromAddress
      ? (ctx.db.crm.findContacts({ email: event.fromAddress })[0] ?? null)
      : null;

  const settings = ctx.db.settings.get();
  const ownerAgentId = contact?.ownerAgentId ?? settings.defaultSdrAgentId;
  if (!ownerAgentId) {
    ctx.db.inbound.setStatus(event.id, "received", {
      statusReason: "no owning or default agent configured for this reply",
      contactId: contact?.id ?? event.contactId,
    });
    return;
  }

  const threadSummary = buildThreadSummary(ctx, event.threadKey, event.id);
  const task: Task = ctx.db.tasks.create({
    agentId: ownerAgentId,
    kind: ctx.config.routing.replyKind,
    title: `Reply from ${contact?.name ?? event.fromName ?? event.fromAddress ?? "unknown"}`,
    input: {
      contactName: contact?.name ?? event.fromName ?? null,
      contactEmail: event.fromAddress,
      subject: event.subject,
      replyBody: withAttachmentNote(
        (event.payload["replyText"] as string | undefined) ?? event.bodyText,
        attachmentsRoot(ctx.config.dataDir),
        eventAttachments(event),
      ),
      threadSummary,
      inboundEventId: event.id,
    },
    threadKey: event.threadKey ?? undefined,
    priority: 10,
  });

  cancelTasksOnThread(ctx, event.threadKey, [ctx.config.routing.followUpKind]);
  if (contact) ctx.db.crm.setStage(contact.id, "replied", "inbound reply received");

  ctx.db.inbound.setStatus(event.id, "routed", { routedTaskId: task.id, contactId: contact?.id ?? event.contactId });
  ctx.db.audit.append({
    kind: "inbound.routed",
    agentId: ownerAgentId,
    taskId: task.id,
    conversationId: null,
    data: { id: event.id, taskId: task.id },
  });
  ctx.bus.emit("inbound.routed", { id: event.id, taskId: task.id });
}

function routeNewLead(ctx: InboundCtx, event: InboundEvent): void {
  const email = event.fromAddress;
  if (!email) {
    ctx.db.inbound.setStatus(event.id, "ignored", { statusReason: "new_lead with no from address" });
    return;
  }
  const payload = event.payload;
  const webhookSource = typeof payload["webhookSource"] === "string" ? (payload["webhookSource"] as string) : null;
  const { contact } = ctx.db.crm.upsertContact({
    email,
    name: event.fromName ?? undefined,
    title: typeof payload["title"] === "string" ? (payload["title"] as string) : undefined,
    phone: typeof payload["phone"] === "string" ? (payload["phone"] as string) : undefined,
    companyName: typeof payload["companyName"] === "string" ? (payload["companyName"] as string) : undefined,
    companyDomain: typeof payload["companyDomain"] === "string" ? (payload["companyDomain"] as string) : undefined,
    source: webhookSource ? `inbound-webhook:${webhookSource}` : "inbound-email",
  });

  const settings = ctx.db.settings.get();
  const agentId = settings.defaultSdrAgentId;
  if (!agentId) {
    ctx.db.inbound.setStatus(event.id, "received", { statusReason: "no default SDR agent configured", contactId: contact.id });
    return;
  }

  const contextParts = [event.subject, event.bodyText].filter((p): p is string => !!p && p.length > 0);
  const task: Task = ctx.db.tasks.create({
    agentId,
    kind: ctx.config.routing.newLeadKind,
    title: `Research ${contact.name ?? email}`,
    input: {
      contactName: contact.name,
      contactEmail: email,
      leadCompanyName: contact.company?.name ?? null,
      leadCompanyDomain: contact.company?.domain ?? null,
      context: withAttachmentNote(
        contextParts.join("\n\n") || "(no message body)",
        attachmentsRoot(ctx.config.dataDir),
        eventAttachments(event),
      ),
      inboundEventId: event.id,
    },
    threadKey: `contact:${email}`,
    priority: 5,
  });

  ctx.db.inbound.setStatus(event.id, "routed", { routedTaskId: task.id, contactId: contact.id });
  ctx.db.audit.append({
    kind: "inbound.routed",
    agentId,
    taskId: task.id,
    conversationId: null,
    data: { id: event.id, taskId: task.id },
  });
  ctx.bus.emit("inbound.routed", { id: event.id, taskId: task.id });
}

function routeInboundEvent(ctx: InboundCtx, event: InboundEvent): void {
  switch (event.classification) {
    case "unsubscribe":
      return routeUnsubscribe(ctx, event);
    case "bounce":
      return routeBounce(ctx, event);
    case "auto_reply":
      return ignore(ctx, event, "auto_reply");
    case "spam":
      return ignore(ctx, event, "spam");
    case "reply":
      return routeReply(ctx, event);
    case "new_lead":
      return routeNewLead(ctx, event);
    default:
      return ignore(ctx, event, "unclassified");
  }
}

/** Classify, persist (deduped by Message-ID) and deterministically route one parsed inbound email. Returns null if skipped (our own mail). */
export function ingestEmail(ctx: InboundCtx, parsed: ParsedEmail): InboundEvent | null {
  const ours = ourAddresses(ctx.config, ctx.db);
  if (parsed.from?.address && ours.includes(parsed.from.address.toLowerCase())) return null;

  const signals = classifyEmail(parsed, { ourAddresses: ours });

  const candidateIds = [parsed.inReplyTo, ...parsed.references].filter((x): x is string => !!x);
  let threadKey: string | null = null;
  let resolvedViaHeaders = false;
  for (const mid of candidateIds) {
    const outboxHit = ctx.db.outbox.findByMessageId(mid);
    if (outboxHit?.threadKey) {
      threadKey = outboxHit.threadKey;
      resolvedViaHeaders = true;
      break;
    }
    const inboundHit = ctx.db.inbound.findByMessageId(mid);
    if (inboundHit?.threadKey) {
      threadKey = inboundHit.threadKey;
      resolvedViaHeaders = true;
      break;
    }
  }
  if (!threadKey && parsed.from?.address) threadKey = `contact:${parsed.from.address.toLowerCase()}`;

  const contact = parsed.from?.address ? (ctx.db.crm.findContacts({ email: parsed.from.address })[0] ?? null) : null;
  const hasPriorOutbound = threadKey ? ctx.db.outbox.listByThreadKey(threadKey, 1).length > 0 : false;

  let classification: InboundClassification;
  if (signals.isUnsubscribe) classification = "unsubscribe";
  else if (signals.isBounce) classification = "bounce";
  else if (signals.isAutoReply) classification = "auto_reply";
  else if (signals.isLikelySpam) classification = "spam";
  else classification = resolvedViaHeaders || hasPriorOutbound ? "reply" : "new_lead";

  const externalId = parsed.messageId ?? `no-message-id:${parsed.providerId}`;
  const input: CreateInboundInput = {
    source: "email",
    externalId,
    fromAddress: parsed.from?.address ?? null,
    fromName: parsed.from?.name ?? null,
    toAddress: parsed.to[0]?.address ?? null,
    subject: parsed.subject,
    bodyText: parsed.text,
    messageId: parsed.messageId,
    inReplyTo: parsed.inReplyTo,
    references: parsed.references,
    threadKey,
    contactId: contact?.id ?? null,
    classification,
    payload: { replyText: parsed.replyText, bouncedRecipient: signals.bouncedRecipient, attachments: attachmentMeta(parsed.attachments) },
  };
  const inserted = ctx.db.inbound.insertIfNew(input);
  if (!inserted.created) return inserted.event;
  const event =
    parsed.attachments.length > 0
      ? ctx.db.inbound.patchPayload(inserted.event.id, {
          attachments: saveAttachments(attachmentsRoot(ctx.config.dataDir), inserted.event.id, parsed.attachments),
        })
      : inserted.event;

  ctx.db.audit.append({
    kind: "inbound.received",
    agentId: null,
    taskId: null,
    conversationId: null,
    data: { id: event.id, source: "email", classification, from: event.fromAddress, subject: event.subject },
  });
  ctx.bus.emit("inbound.received", { id: event.id, classification, from: event.fromAddress, subject: event.subject });

  routeInboundEvent(ctx, event);
  return ctx.db.inbound.get(event.id)!;
}

/** Ingest a webhook-sourced lead (POST /v1/inbound/webhook/:source) — always routed as new_lead. */
export function ingestWebhookLead(
  ctx: InboundCtx,
  source: string,
  body: WebhookLeadRequest,
): { event: InboundEvent; created: boolean } {
  const dedupeKey = body.externalId ?? createHash("sha256").update(JSON.stringify(body)).digest("hex");
  const externalId = `${source}:${dedupeKey}`;
  const { event, created } = ctx.db.inbound.insertIfNew({
    source: "webhook",
    externalId,
    fromAddress: body.email.toLowerCase(),
    fromName: body.name ?? null,
    subject: null,
    bodyText: body.message ?? "",
    classification: "new_lead",
    payload: {
      webhookSource: source,
      companyName: body.companyName,
      companyDomain: body.companyDomain,
      title: body.title,
      phone: body.phone,
      fields: body.fields,
    },
  });
  if (!created) return { event, created };

  ctx.db.audit.append({
    kind: "inbound.received",
    agentId: null,
    taskId: null,
    conversationId: null,
    data: { id: event.id, source: "webhook", classification: "new_lead", from: event.fromAddress },
  });
  ctx.bus.emit("inbound.received", { id: event.id, classification: "new_lead", from: event.fromAddress });
  routeNewLead(ctx, event);
  return { event: ctx.db.inbound.get(event.id)!, created: true };
}

/** Where an EmailPoller gets its provider from; lets the provider be hot-swapped (see setup/email-runtime.ts). */
export interface PollSource {
  provider(): EmailProvider | null;
  intervalMs(): number;
  /** Bumped on every provider swap: a poll that started under an older generation discards its results. */
  generation?(): number;
}

/** Polls an EmailProvider on an interval, persisting its cursor across restarts via db.channelCursors. */
export class EmailPoller {
  #ctx: InboundCtx;
  #source: PollSource;
  #cursorKey = "email";
  #timer: NodeJS.Timeout | null = null;
  #stopped = false;
  #started = false;
  #polling: Promise<void> | null = null;
  #lastPollAt: string | null = null;
  #lastError: string | null = null;

  /** `source` may be a fixed provider + interval (the original signature) or a PollSource for hot-swapping. */
  constructor(ctx: InboundCtx, source: EmailProvider | PollSource, intervalMs?: number) {
    this.#ctx = ctx;
    this.#source =
      "fetchNew" in source
        ? { provider: () => source, intervalMs: () => intervalMs ?? 60_000 }
        : source;
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

  /** Re-arm immediately (after a provider swap / interval change): polls now, then on the new interval. */
  restart(): void {
    if (!this.#started || this.#stopped) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#lastError = null;
    this.#schedule(0);
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  /** stop() + wait for an in-flight poll to settle. */
  async stopAndDrain(): Promise<void> {
    this.stop();
    await this.#polling?.catch(() => {});
  }

  #schedule(delayMs: number): void {
    if (this.#stopped) return;
    this.#timer = setTimeout(() => {
      void this.#poll().finally(() => this.#schedule(this.#source.intervalMs()));
    }, delayMs);
  }

  #poll(): Promise<void> {
    if (this.#polling) return this.#polling;
    this.#polling = this.#pollOnce().finally(() => {
      this.#polling = null;
    });
    return this.#polling;
  }

  async #pollOnce(): Promise<void> {
    const provider = this.#source.provider();
    const generation = this.#source.generation?.() ?? 0;
    const stale = () => (this.#source.generation?.() ?? 0) !== generation;
    try {
      if (!provider) {
        this.#lastError = null;
        return;
      }
      const cursor = this.#ctx.db.channelCursors.get(this.#cursorKey);
      const { messages, cursor: nextCursor } = await provider.fetchNew(cursor, { limit: 25 });
      // The mailbox was swapped while we were fetching: these messages belong to the old setup, and writing their
      // cursor would corrupt the new one.
      if (stale()) return;
      for (const msg of messages) {
        try {
          ingestEmail(this.#ctx, msg);
        } catch (err) {
          this.#ctx.bus.emit("inbound.error", { error: (err as Error).message });
        }
      }
      if (nextCursor !== cursor && !stale()) this.#ctx.db.channelCursors.set(this.#cursorKey, nextCursor);
      this.#lastError = null;
    } catch (err) {
      if (stale()) return;
      this.#lastError = (err as Error).message;
      this.#ctx.bus.emit("inbound.error", { error: this.#lastError });
    } finally {
      this.#lastPollAt = nowIso();
    }
  }
}
