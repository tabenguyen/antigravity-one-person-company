// `outbox_draft_email`: one draft per email, no duplicates in the approval queue.
//
// Rules (docs/TECHNICAL.md "Outbox"):
//   1. Same task, same recipient, earlier draft still `pending_approval` -> the earlier draft is REWRITTEN in place
//      (same id, `revisions` + 1, `outbox.revised` audit row). The reviewer still sees one item. The tool result says
//      "updated", never "created".
//   2. Same task, same recipient, earlier draft already decided (approved / held / rejected / sent / blocked / ...)
//      -> `conflict`: the agent must not create a fresh draft for something a human or policy already handled.
//      (Different recipients in one task are independent drafts.)
//   3. Same agent, same recipient, same thread, a draft from a DIFFERENT task still pending:
//        - the contact wrote on the thread after that draft was queued (it is stale) -> the older draft is closed as
//          superseded (rejected by `policy:superseded`, reason "superseded: ..."; no human verdict, ignored by
//          scorecards / shadow stats / KPIs) and the new draft takes its place;
//        - otherwise (e.g. a follow-up stacked on a draft nobody reviewed yet), or a human already edited the older
//          draft -> `conflict`: the reviewer's pending draft wins, the new one is refused.
//   4. A stored draft always comes back with a message that says it is queued, that warnings are notes for the
//      reviewer, and that the agent must not draft again. Lint errors still refuse the draft ("Draft NOT created").

import { isReplacedDraft } from "@agyhq/core";
import type { Agent, LintFinding, McpToolInput, McpToolOutputs, OutboxItem } from "@agyhq/core";
import type { Db } from "@agyhq/db";
import { HttpError } from "./errors.ts";
import { truncatedString } from "./audit-util.ts";
import type { ResolvedDeps } from "./deps.ts";
import { SUPERSEDED_PREFIX } from "../sent-sync.ts";
import { formatFindings, hasLintErrors, lintNewDraft } from "../quality/index.ts";

export interface DraftCtx {
  db: Db;
  deps: ResolvedDeps;
  agentId: string;
  taskId: string;
  agent: Agent;
}

type Input = McpToolInput<"outbox_draft_email">;
type Output = McpToolOutputs["outbox_draft_email"];

/** Inbound classifications that mean "the contact wrote to us" (auto-replies, bounces, spam and opt-outs do not). */
const CONTACT_WROTE = ["reply", "new_lead", "other"];

const STATUS_PHRASE: Record<string, string> = {
  approved: "approved",
  held: "reviewed and held (practice draft)",
  rejected: "rejected",
  sending: "approved and is being sent",
  sent: "approved and sent",
  failed: "approved (sending failed)",
  blocked: "blocked by policy",
};

const effectiveThreadKey = (threadKey: string | null, to: string) => threadKey ?? `contact:${to.toLowerCase()}`;

function findOptOutReason(db: Db, to: string): string | null {
  const contact = db.crm.findContacts({ email: to })[0] ?? null;
  if (!contact) return null;
  const attrs = contact.attributes ?? {};
  const byAttribute = attrs["optOut"] === true || Boolean(attrs["doNotContact"]) || Boolean(attrs["emailBounced"]);
  let byUnsubscribe = false;
  if (contact.stage === "disqualified") {
    byUnsubscribe = db.crm.listRecentNotes("contact", contact.id, 20).some((n) => n.body.toLowerCase().includes("unsubscribe"));
  }
  return byAttribute || byUnsubscribe ? "recipient has opted out" : null;
}

/** Did the contact write (inbound mail from the address, or on this thread) after `sinceIso`? */
function contactWroteSince(db: Db, to: string, threadKey: string, sinceIso: string): boolean {
  const marks = CONTACT_WROTE.map(() => "?").join(", ");
  const row = db.sqlite
    .prepare(
      `SELECT 1 FROM inbound_events
       WHERE received_at > ? AND classification IN (${marks}) AND (lower(from_address) = ? OR thread_key = ?)
       LIMIT 1`,
    )
    .get(sinceIso, ...CONTACT_WROTE, to.toLowerCase(), threadKey);
  return row !== undefined;
}

function noteBlock(findings: readonly LintFinding[]): string {
  const notes = findings.filter((f) => f.severity !== "error");
  return notes.length > 0 ? `\nNotes for the reviewer:\n${formatFindings(notes)}` : "";
}

function resultMessage(item: OutboxItem, opts: { updated: boolean; blockedReason: string | null; supersededIds: string[] }): string {
  const lead = opts.updated
    ? `Draft ${item.id} UPDATED in place (revision ${item.revisions}): your earlier draft for this email was still waiting for review, so it was replaced, not duplicated. The reviewer sees one item.`
    : `Draft ${item.id} saved.`;
  let state: string;
  if (item.status === "blocked") {
    state = `It was BLOCKED by policy (${opts.blockedReason ?? item.statusReason ?? "see outbox"}); the human can see why. It will not be sent.`;
  } else if (item.status === "approved") {
    state = "It was approved by policy and is queued for sending.";
  } else {
    state = "It is queued for the human reviewer (pending_approval) and is NOT sent.";
  }
  const warns = item.lint.filter((f) => f.severity === "warn" || f.severity === "info");
  const warnLine =
    warns.length > 0
      ? `\nIt has ${warns.length} warning(s). Warnings are notes for the reviewer, not errors: the draft is already saved and queued, so do NOT call outbox_draft_email again because of them.`
      : "";
  const supersededLine =
    opts.supersededIds.length > 0
      ? `\nThe contact wrote again after your earlier pending draft on this thread (${opts.supersededIds.join(", ")}) was queued, so that older draft was closed as superseded by this one.`
      : "";
  return `${lead} ${state}${warnLine}${noteBlock(item.lint)}${supersededLine}\nDo not call outbox_draft_email again for this email; finish the task.`;
}

export function draftEmail(ctx: DraftCtx, input: Input): Output {
  const { db, deps } = ctx;
  const now = deps.now();

  const currentTask = db.tasks.get(ctx.taskId);
  // Default to the current task's threadKey when the model doesn't pass one explicitly (the Sender needs it to set
  // In-Reply-To/References; same pattern task_create uses).
  const threadKey = input.threadKey ?? currentTask?.threadKey ?? null;
  const optOutReason = findOptOutReason(db, input.to);

  // -- 1/2. this task already drafted to this recipient --------------------------------------------------------
  const earlier = db.outbox.listByTaskAndRecipient(ctx.taskId, input.to)[0] ?? null;
  if (earlier && earlier.status !== "pending_approval") {
    const phrase = STATUS_PHRASE[earlier.status] ?? earlier.status;
    const replaced = earlier.statusReason ? ` (${earlier.statusReason})` : "";
    db.audit.append({
      kind: "outbox.draft_refused",
      agentId: ctx.agentId,
      taskId: ctx.taskId,
      conversationId: null,
      data: { to: input.to, reason: "already_reviewed", existingId: earlier.id, existingStatus: earlier.status },
    });
    throw new HttpError(
      "conflict",
      `Draft NOT created: this task already drafted an email to ${input.to} (outbox ${earlier.id}) and it was already reviewed: it is ${phrase}${replaced}. A task gets one draft per recipient, so do not draft it again. If the human needs something different, finish the task with status "needs_human" and say so in your summary.`,
    );
  }
  if (earlier?.editedByHuman) {
    db.audit.append({
      kind: "outbox.draft_refused",
      agentId: ctx.agentId,
      taskId: ctx.taskId,
      conversationId: null,
      data: { to: input.to, reason: "human_editing", existingId: earlier.id, existingStatus: earlier.status },
    });
    throw new HttpError(
      "conflict",
      `Draft NOT created: a human reviewer is already editing your earlier draft to ${input.to} (outbox ${earlier.id}), so it can no longer be rewritten. Do not draft it again; finish the task and mention it in your summary.`,
    );
  }

  // -- 3. other tasks' pending drafts to this recipient on this thread -----------------------------------------------
  const key = effectiveThreadKey(threadKey, input.to);
  const sameThread = earlier
    ? []
    : db.outbox
        .list({ agentId: ctx.agentId, status: ["pending_approval"] })
        .filter((i) => i.taskId !== ctx.taskId && i.to.toLowerCase() === input.to.toLowerCase() && effectiveThreadKey(i.threadKey, i.to) === key);
  const stale: OutboxItem[] = [];
  for (const old of sameThread) {
    if (!old.editedByHuman && contactWroteSince(db, input.to, key, old.createdAt)) {
      stale.push(old);
      continue;
    }
    db.audit.append({
      kind: "outbox.draft_refused",
      agentId: ctx.agentId,
      taskId: ctx.taskId,
      conversationId: null,
      data: { to: input.to, reason: "pending_on_thread", existingId: old.id, humanEditing: old.editedByHuman },
    });
    throw new HttpError(
      "conflict",
      `Draft NOT created: an earlier draft to ${input.to} on this thread (outbox ${old.id}, "${truncatedString(old.subject ?? "(no subject)", 80)}") is still waiting for the human reviewer${old.editedByHuman ? " and a human is already editing it" : ""}, and the contact has not written since. Do not stack another email on top of it: the reviewer deals with the pending one first. Finish the task (status "needs_human" if the contact is waiting on an answer) and say this in your summary.`,
    );
  }

  // A draft the policy blocks (opt-out, daily limit) is stored regardless so the human sees why; a rewrite of a pending
  // draft doesn't count against the daily limit (it adds no queue item), and replaced drafts don't count either.
  let blockedReason: string | null = optOutReason;
  if (!blockedReason && !earlier) {
    const startOfDay = new Date(now);
    startOfDay.setUTCHours(0, 0, 0, 0);
    const todayCount = db.outbox.list({ agentId: ctx.agentId }).filter((item) => item.createdAt >= startOfDay.toISOString() && !isReplacedDraft(item)).length;
    if (todayCount >= deps.outboxDailyLimit) blockedReason = `daily outbox limit (${deps.outboxDailyLimit}) reached`;
  }

  // -- lint: an `error` means nothing is stored / changed (the agent fixes it and calls again) ----------------------
  const lint = lintNewDraft(db, {
    agent: ctx.agent,
    to: input.to,
    threadKey,
    excludeOutboxId: earlier?.id ?? null,
    subject: input.subject,
    body: input.body,
  });
  if (!blockedReason && hasLintErrors(lint)) {
    db.audit.append({
      kind: "outbox.lint_blocked",
      agentId: ctx.agentId,
      taskId: ctx.taskId,
      conversationId: null,
      data: { to: input.to, subject: truncatedString(input.subject, 200), findings: lint },
    });
    throw new HttpError(
      "invalid_request",
      `Draft NOT created${earlier ? " or changed (your earlier draft for this email is still queued as it was)" : ""}: it failed automatic checks. Fix every [error] below (keep to published facts and prices from kb_search), then call outbox_draft_email again.\n${formatFindings(lint)}`,
    );
  }

  // -- store (new, or rewrite in place) ---------------------------------------------------------------------------
  const updated = earlier !== null;
  let item: OutboxItem;
  if (earlier) {
    item = db.outbox.revise(earlier.id, { subject: input.subject, body: input.body, reason: input.reason, threadKey, lint });
    db.audit.append({
      kind: "outbox.revised",
      agentId: ctx.agentId,
      taskId: ctx.taskId,
      conversationId: null,
      data: {
        id: item.id,
        to: item.to,
        revisions: item.revisions,
        previousSubject: truncatedString(earlier.subject ?? "", 200),
        previousBodyLength: earlier.body.length,
        bodyLength: item.body.length,
      },
    });
  } else {
    item = db.outbox.createDraft({
      agentId: ctx.agentId,
      taskId: ctx.taskId,
      channel: "email",
      to: input.to,
      subject: input.subject,
      body: input.body,
      reason: input.reason,
      threadKey,
      lint,
    });
  }

  // Outbox policy (docs/PLAN.md §3.4 trust tiers): blocked drafts stay blocked; otherwise an autonomous-tier agent is
  // auto-approved when the daemon settings don't require prior human approval, or this recipient already got one.
  if (blockedReason) {
    item = db.outbox.decide(item.id, "blocked", { statusReason: blockedReason });
  } else if (ctx.agent.trustTier === "autonomous") {
    const settings = db.settings.get();
    if (!settings.autonomousRequiresPriorApproval || db.outbox.hasHumanApprovedSentTo(input.to)) {
      item = db.outbox.decide(item.id, "approved", { decidedBy: "policy:autonomous", decidedAt: now.toISOString() });
    }
  }

  // The new draft is in the queue: close the stale ones it replaces (never when it is itself blocked).
  const supersededIds: string[] = [];
  if (!blockedReason) {
    for (const old of stale) {
      db.outbox.supersede(
        old.id,
        `${SUPERSEDED_PREFIX} replaced by a newer draft (${item.id}, task ${ctx.taskId}); the contact wrote again after this one was queued`,
      );
      db.audit.append({
        kind: "outbox.superseded",
        agentId: old.agentId,
        taskId: old.taskId,
        conversationId: null,
        data: { id: old.id, status: "rejected", by: "newer_draft", replacedBy: item.id },
      });
      deps.emit("outbox.updated", { outboxId: old.id, status: "rejected", superseded: true });
      supersededIds.push(old.id);
    }
  }

  if (!updated) {
    db.audit.append({
      kind: "outbox.drafted",
      agentId: ctx.agentId,
      taskId: ctx.taskId,
      conversationId: null,
      data: {
        id: item.id,
        to: item.to,
        status: item.status,
        ...(blockedReason ? { blockedReason } : {}),
        ...(supersededIds.length > 0 ? { supersededIds } : {}),
      },
    });
    deps.emit("outbox.drafted", { id: item.id, agentId: ctx.agentId, status: item.status });
  } else {
    deps.emit("outbox.updated", { outboxId: item.id, status: item.status, revised: true });
  }

  return { item, outcome: updated ? "updated" : "created", message: resultMessage(item, { updated, blockedReason, supersededIds }) };
}
