// Sent-folder awareness (opt-in; `email.syncSent`).
//
// During a shadow run the human keeps answering customers from their OWN mail client, so the harness never sees what
// was actually sent. The EmailPoller reads the mailbox's Sent folder and hands every message here. For each human-sent
// message that is RELATED to something we know (it continues a thread we have seen, or is addressed to an existing
// contact) we:
//   1. record it (human_sent) so it shows up in agents' thread summaries and counts as a touch in pipeline reviews;
//   2. cancel the thread's pending follow-up tasks, exactly like an inbound reply does, and any not-yet-started reply
//      task for an inbound message the human has just answered;
//   3. move a new/researching/qualified contact to "contacted" (what the Sender does after one of our own sends);
//   4. mark pending / approved / held drafts that were written before the human's reply as superseded
//      (`statusReason: "superseded: ..."`, an audit row; an approved one is then refused by the Sender's final guard).
// Unrelated mail (the human's private or non-CRM correspondence) is NOT stored. Messages we sent ourselves (our own
// outbox Message-IDs) are skipped. Everything is idempotent by Message-ID.

import { nowIso } from "@agyhq/core";
import type { HumanSentMessage, ParsedEmail, Task, TaskStatus } from "@agyhq/core";
import type { InboundCtx } from "./inbound.ts";
import { ourAddresses, threadFromHeaders } from "./mail-thread.ts";
import { roleRouting } from "./routing.ts";

export type SentIngestOutcome = "recorded" | "duplicate" | "own" | "unrelated" | "no_recipient";

export interface SentIngestResult {
  outcome: SentIngestOutcome;
  message: HumanSentMessage | null;
  cancelledTasks: string[];
  supersededDrafts: string[];
}

export const SUPERSEDED_PREFIX = "superseded:";

const CANCELLABLE: TaskStatus[] = ["queued", "waiting_approval", "waiting_external"];

function skip(outcome: SentIngestOutcome): SentIngestResult {
  return { outcome, message: null, cancelledTasks: [], supersededDrafts: [] };
}

function followUpAndReplyKinds(ctx: InboundCtx): { followUp: Set<string>; reply: Set<string> } {
  const followUp = new Set<string>([ctx.config.routing.followUpKind]);
  const reply = new Set<string>([ctx.config.routing.replyKind, "cos.triage"]);
  const roles = new Set(ctx.db.agents.list().map((a) => a.role));
  for (const role of roles) {
    const routing = roleRouting(ctx.config, role);
    if (!routing) continue;
    routing.followUpKinds.forEach((k) => followUp.add(k));
    reply.add(routing.replyKind);
  }
  return { followUp, reply };
}

/** Cancel the thread's pending follow-ups, and queued reply tasks for inbound mail this message answers. */
function cancelAnswered(ctx: InboundCtx, msg: HumanSentMessage): string[] {
  if (!msg.threadKey) return [];
  const { followUp, reply } = followUpAndReplyKinds(ctx);
  const answered = new Set([msg.inReplyTo, ...msg.references].filter((x): x is string => !!x));
  // Date headers have 1-second resolution: allow that much slack when comparing with our own timestamps.
  const sentMs = Date.parse(msg.sentAt) + 1000;
  const cancelled: string[] = [];

  const open: Task[] = ctx.db.tasks.list({ status: CANCELLABLE }).filter((t) => t.threadKey === msg.threadKey);
  for (const task of open) {
    // A task created after the human wrote (e.g. scheduled by a later agent run) is not answered by that message.
    if (Date.parse(task.createdAt) > sentMs) continue;
    let cancel = false;
    if (followUp.has(task.kind)) {
      cancel = true;
    } else if (reply.has(task.kind) && task.status === "queued") {
      // Only a reply task that has not started AND is about a message this email replies to.
      const eventId = typeof task.input["inboundEventId"] === "string" ? (task.input["inboundEventId"] as string) : null;
      const event = eventId ? ctx.db.inbound.get(eventId) : null;
      cancel = Boolean(event?.messageId && answered.has(event.messageId));
    }
    if (!cancel) continue;
    try {
      ctx.db.tasks.transition(task.id, "cancelled");
      cancelled.push(task.id);
      ctx.bus.emit("task.transition", { taskId: task.id, to: "cancelled", reason: "human replied from their own mail client" });
    } catch {
      // already terminal
    }
  }
  return cancelled;
}

/** Annotate drafts written before the human's reply to the same person/thread. Returns the annotated outbox ids. */
function supersedeDrafts(ctx: InboundCtx, msg: HumanSentMessage): string[] {
  const sentMs = Date.parse(msg.sentAt) + 1000; // Date headers have 1-second resolution
  const recipients = new Set(msg.recipients);
  const items = ctx.db.outbox.list({ status: ["pending_approval", "approved", "held"] });
  const out: string[] = [];
  for (const item of items) {
    if (item.statusReason?.startsWith(SUPERSEDED_PREFIX)) continue;
    const sameThread = !!msg.threadKey && item.threadKey === msg.threadKey;
    if (!sameThread && !recipients.has(item.to.toLowerCase())) continue;
    if (Date.parse(item.createdAt) > sentMs) continue;
    const reason = `${SUPERSEDED_PREFIX} a human already replied from their own mail client (${msg.sentAt.slice(0, 16).replace("T", " ")} UTC${msg.subject ? `, "${msg.subject.slice(0, 80)}"` : ""})`;
    ctx.db.outbox.annotateSuperseded(item.id, reason);
    ctx.db.audit.append({
      kind: "outbox.superseded",
      agentId: item.agentId,
      taskId: item.taskId,
      conversationId: null,
      data: { id: item.id, status: item.status, humanSentId: msg.id, messageId: msg.messageId },
    });
    ctx.bus.emit("outbox.updated", { outboxId: item.id, status: item.status, superseded: true });
    out.push(item.id);
  }
  return out;
}

/** Record one message from the Sent folder (see the file header). `folder` is only informational. */
export function ingestSentEmail(ctx: InboundCtx, parsed: ParsedEmail, folder: string | null): SentIngestResult {
  const ours = new Set(ourAddresses(ctx.config, ctx.db));

  // A message our own Sender produced (Gmail/M365 save SMTP sends in Sent; `sentFolder` appends a copy): already known.
  if (parsed.messageId && ctx.db.outbox.findByMessageId(parsed.messageId)) return skip("own");

  const recipients = [...new Set([...parsed.to, ...parsed.cc].map((a) => a.address.toLowerCase()))].filter((a) => !ours.has(a));
  if (recipients.length === 0) return skip("no_recipient");

  const headerThread = threadFromHeaders(ctx.db, parsed);
  const knownContact = recipients.map((a) => ctx.db.crm.findContacts({ email: a })[0] ?? null).find((c) => c !== null) ?? null;
  if (!headerThread && !knownContact) return skip("unrelated");

  const toAddress = knownContact?.email?.toLowerCase() ?? recipients[0]!;
  const threadKey = headerThread ?? `contact:${toAddress}`;
  const now = nowIso();
  const sentAt = parsed.date && parsed.date < now ? parsed.date : now;
  const externalId = parsed.messageId ?? `no-message-id:${folder ?? "sent"}:${parsed.providerId}`;

  const inserted = ctx.db.humanSent.insertIfNew({
    externalId,
    messageId: parsed.messageId,
    inReplyTo: parsed.inReplyTo,
    references: parsed.references,
    toAddress,
    recipients,
    subject: parsed.subject,
    bodyText: parsed.replyText.trim() ? parsed.replyText : parsed.text,
    threadKey,
    contactId: knownContact?.id ?? null,
    folder,
    sentAt,
  });
  if (!inserted.created) return { outcome: "duplicate", message: inserted.message, cancelledTasks: [], supersededDrafts: [] };

  const msg = inserted.message;
  const cancelledTasks = cancelAnswered(ctx, msg);
  const supersededDrafts = supersedeDrafts(ctx, msg);

  if (knownContact && (["new", "researching", "qualified"] as string[]).includes(knownContact.stage)) {
    ctx.db.crm.setStage(knownContact.id, "contacted", "a human emailed them from their own mail client");
  }

  ctx.db.audit.append({
    kind: "email.human_sent",
    agentId: null,
    taskId: null,
    conversationId: null,
    data: { id: msg.id, to: toAddress, threadKey, subject: msg.subject, cancelledTasks, supersededDrafts },
  });
  ctx.bus.emit("email.human_sent", { id: msg.id, to: toAddress, threadKey, subject: msg.subject });
  return { outcome: "recorded", message: msg, cancelledTasks, supersededDrafts };
}
