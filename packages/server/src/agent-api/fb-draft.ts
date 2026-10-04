// `fb_draft_post`, `fb_draft_reply`, `fb_propose_hide`: the only way the Fanpage Manager puts anything in the outbox
// (docs/FANPAGE.md sections 1 and 5). Same promises as `outbox_draft_email`: one draft per target, a draft that is
// stored is already queued for the human, lint errors refuse the draft, the tool message says what happened.
//
//   - one draft per (task, target): a second call rewrites the pending draft in place; once it was reviewed it is a `conflict`;
//   - one live draft per comment across tasks: a comment that already has a pending / approved / sent reply or hide proposal
//     refuses a new one (a duplicate comment can never produce two drafts), and a reply and a hide proposal exclude each other;
//   - nothing is auto-approved except a reply of an `autonomous`-tier agent (and, with autonomousRequiresPriorApproval, only once
//     a human approved and sent one of its replies). Posts and hide proposals always wait for a human.

import { isReplacedDraft } from "@agyhq/core";
import type { Agent, FbDraftOutput, LintFinding, McpToolInput, OutboxChannel, OutboxItem, OutboxPayload, OutboxStatus } from "@agyhq/core";
import type { Db } from "@agyhq/db";
import { HttpError } from "./errors.ts";
import { truncatedString } from "./audit-util.ts";
import type { ResolvedDeps } from "./deps.ts";
import { formatFindings, hasLintErrors, lintFacebookDraft, normalizeUrl } from "../quality/index.ts";

export interface FbDraftCtx {
  db: Db;
  deps: ResolvedDeps;
  agentId: string;
  taskId: string;
  agent: Agent;
}

/** Statuses in which a comment already has a human-visible reply / hide proposal that a new draft must not duplicate. */
const LIVE: OutboxStatus[] = ["pending_approval", "approved", "sending", "sent", "held"];

const STATUS_PHRASE: Record<string, string> = {
  approved: "approved",
  held: "reviewed and held (practice draft)",
  rejected: "rejected",
  sending: "approved and is being sent",
  sent: "approved and sent",
  failed: "approved (sending failed)",
  blocked: "blocked by policy",
};

interface Spec {
  what: "post" | "reply" | "hide proposal";
  channel: OutboxChannel;
  to: string;
  subject: string;
  body: string;
  reason: string;
  threadKey: string | null;
  payload: OutboxPayload;
  lint: LintFinding[];
  /** One draft per target across tasks (comments); false for posts, where many drafts to the Page are normal. */
  exclusiveTarget: boolean;
  /** Targets whose live drafts also exclude this one (a reply and a hide proposal for the same comment). */
  alsoExcludedBy?: string;
  autoApprovable: boolean;
}

function requireFanpage(ctx: FbDraftCtx): void {
  if (ctx.agent.role !== "fanpage-manager") throw new HttpError("forbidden", `this tool is for the fanpage-manager role; "${ctx.agentId}" is a ${ctx.agent.role}`);
}

function refuse(ctx: FbDraftCtx, spec: Spec, reason: string, extra: Record<string, unknown>): void {
  ctx.db.audit.append({
    kind: "outbox.draft_refused",
    agentId: ctx.agentId,
    taskId: ctx.taskId,
    conversationId: null,
    data: { to: spec.to, channel: spec.channel, reason, ...extra },
  });
}

/** Has this agent had a reply approved by a human and actually sent? (The "prior approval" gate for autonomous replies.) */
function hasHumanApprovedReply(db: Db, agentId: string): boolean {
  return db.outbox.list({ agentId, status: ["sent"] }).some((i) => i.channel === "facebook_reply" && i.decidedBy?.startsWith("human:"));
}

function store(ctx: FbDraftCtx, spec: Spec): FbDraftOutput {
  const { db, deps } = ctx;
  const now = deps.now();

  // -- 1/2. this task already drafted for this target -----------------------------------------------------------
  const earlier = db.outbox.listByTaskAndRecipient(ctx.taskId, spec.to)[0] ?? null;
  if (earlier && earlier.status !== "pending_approval") {
    refuse(ctx, spec, "already_reviewed", { existingId: earlier.id, existingStatus: earlier.status });
    throw new HttpError(
      "conflict",
      `Draft NOT created: this task already drafted a ${spec.what} for this target (outbox ${earlier.id}) and it was already reviewed: it is ${STATUS_PHRASE[earlier.status] ?? earlier.status}${earlier.statusReason ? ` (${earlier.statusReason})` : ""}. A task gets one draft per target, so do not draft it again. If the human needs something different, finish the task with status "needs_human" and say so in your summary.`,
    );
  }
  if (earlier?.editedByHuman) {
    refuse(ctx, spec, "human_editing", { existingId: earlier.id });
    throw new HttpError("conflict", `Draft NOT created: a human reviewer is already editing your earlier ${spec.what} (outbox ${earlier.id}), so it can no longer be rewritten. Do not draft it again; finish the task and mention it in your summary.`);
  }

  // -- 3. another task already has a live draft for this comment -------------------------------------------------
  if (spec.exclusiveTarget) {
    const sameTarget = earlier ? [] : db.outbox.listByRecipient(spec.to, LIVE).filter((i) => i.taskId !== ctx.taskId);
    const opposite = spec.alsoExcludedBy ? db.outbox.listByRecipient(spec.alsoExcludedBy, LIVE) : []; // a reply and a hide proposal exclude each other, even within one task
    const other = [...sameTarget, ...opposite][0];
    if (other) {
      refuse(ctx, spec, "comment_already_drafted", { existingId: other.id, existingStatus: other.status, existingChannel: other.channel });
      throw new HttpError(
        "conflict",
        `Draft NOT created: this comment already has a ${other.channel === "facebook_hide" ? "hide proposal" : "reply"} (outbox ${other.id}, ${STATUS_PHRASE[other.status] ?? other.status.replace("_", " ")}). One comment, one draft: do not draft another. Finish the task and say what already exists in your summary.`,
      );
    }
  }

  // -- limits ------------------------------------------------------------------------------------------------------
  let blockedReason: string | null = null;
  if (!earlier) {
    const startOfDay = new Date(now);
    startOfDay.setUTCHours(0, 0, 0, 0);
    const todayCount = db.outbox.list({ agentId: ctx.agentId }).filter((i) => i.createdAt >= startOfDay.toISOString() && !isReplacedDraft(i)).length;
    if (todayCount >= deps.outboxDailyLimit) blockedReason = `daily outbox limit (${deps.outboxDailyLimit}) reached`;
  }

  // -- lint: an `error` stores nothing (the agent fixes it and calls again) ---------------------------------------------
  if (!blockedReason && hasLintErrors(spec.lint)) {
    db.audit.append({
      kind: "outbox.lint_blocked",
      agentId: ctx.agentId,
      taskId: ctx.taskId,
      conversationId: null,
      data: { to: spec.to, channel: spec.channel, subject: truncatedString(spec.subject, 200), findings: spec.lint },
    });
    throw new HttpError(
      "invalid_request",
      `Draft NOT created${earlier ? " or changed (your earlier draft is still queued as it was)" : ""}: it failed automatic checks. Fix every [error] below (facts, numbers and prices only from kb_search; news only with the source URL from the task), then call the tool again.\n${formatFindings(spec.lint)}`,
    );
  }

  // -- store (new, or rewrite in place) ----------------------------------------------------------------------------
  let item: OutboxItem;
  if (earlier) {
    item = db.outbox.revise(earlier.id, { subject: spec.subject, body: spec.body, reason: spec.reason, threadKey: spec.threadKey, lint: spec.lint, payload: spec.payload });
    db.audit.append({
      kind: "outbox.revised",
      agentId: ctx.agentId,
      taskId: ctx.taskId,
      conversationId: null,
      data: { id: item.id, to: item.to, revisions: item.revisions, previousBodyLength: earlier.body.length, bodyLength: item.body.length },
    });
  } else {
    item = db.outbox.createDraft({
      agentId: ctx.agentId,
      taskId: ctx.taskId,
      channel: spec.channel,
      to: spec.to,
      subject: spec.subject,
      body: spec.body,
      reason: spec.reason,
      threadKey: spec.threadKey,
      lint: spec.lint,
      payload: spec.payload,
    });
  }

  if (blockedReason) {
    item = db.outbox.decide(item.id, "blocked", { statusReason: blockedReason });
  } else if (spec.autoApprovable && ctx.agent.trustTier === "autonomous") {
    const settings = db.settings.get();
    if (!settings.autonomousRequiresPriorApproval || hasHumanApprovedReply(db, ctx.agentId)) {
      item = db.outbox.decide(item.id, "approved", { decidedBy: "policy:autonomous", decidedAt: now.toISOString() });
    }
  }

  if (!earlier) {
    db.audit.append({
      kind: "outbox.drafted",
      agentId: ctx.agentId,
      taskId: ctx.taskId,
      conversationId: null,
      data: { id: item.id, to: item.to, channel: item.channel, status: item.status, ...(blockedReason ? { blockedReason } : {}) },
    });
    deps.emit("outbox.drafted", { id: item.id, agentId: ctx.agentId, status: item.status });
  } else {
    deps.emit("outbox.updated", { outboxId: item.id, status: item.status, revised: true });
  }

  return { item, outcome: earlier ? "updated" : "created", message: resultMessage(item, spec, Boolean(earlier), blockedReason) };
}

function resultMessage(item: OutboxItem, spec: Spec, updated: boolean, blockedReason: string | null): string {
  const lead = updated
    ? `Draft ${item.id} UPDATED in place (revision ${item.revisions}): your earlier ${spec.what} for this target was still waiting for review, so it was replaced, not duplicated.`
    : `Draft ${item.id} saved.`;
  let state: string;
  if (item.status === "blocked") state = `It was BLOCKED by policy (${blockedReason ?? item.statusReason ?? "see outbox"}); the human can see why. It will not be sent.`;
  else if (item.status === "approved") state = "It was approved by policy and is queued for sending.";
  else if (spec.what === "post") state = "It is queued for the human reviewer (pending_approval) and is NOT published. When approved it is only ever SCHEDULED, at least a day ahead, so a human can still cancel it.";
  else state = `It is queued for the human reviewer (pending_approval) and is NOT ${spec.what === "reply" ? "posted" : "hidden"}.`;
  const warns = item.lint.filter((f) => f.severity !== "error");
  const warnLine = warns.length > 0 ? `\nNotes for the reviewer (not errors; the draft is already saved, do NOT call the tool again because of them):\n${formatFindings(warns)}` : "";
  return `${lead} ${state}${warnLine}\nDo not draft this again; finish the task.`;
}

const iso = (v: string | undefined): string | null => (v ? new Date(v).toISOString() : null);

// ---------------------------------------------------------------------------

export function draftFbPost(ctx: FbDraftCtx, input: McpToolInput<"fb_draft_post">): FbDraftOutput {
  requireFanpage(ctx);
  const task = ctx.db.tasks.get(ctx.taskId);

  if (input.postType === "news") {
    // No invented news: the URL has to be the one the task was given, and the post has to quote it (lint: news_missing_source).
    const given = typeof task?.input["sourceUrl"] === "string" ? (task.input["sourceUrl"] as string).trim() : "";
    if (!given) {
      throw new HttpError(
        "invalid_request",
        'Draft NOT created: this task has no sourceUrl, so there is no news to cite and nothing may be invented. Do not draft it: finish the task with status "needs_human" and ask for the article URL.',
      );
    }
    if (!input.sourceUrl || normalizeUrl(input.sourceUrl) !== normalizeUrl(given)) {
      throw new HttpError("invalid_request", `Draft NOT created: sourceUrl must be exactly the URL the task gave you (${given}), not another one.`);
    }
  }

  const pageId = ctx.deps.facebookPageId() ?? "unconfigured";
  const typeLabel = input.postType;
  const sourceUrl = input.sourceUrl ?? null;
  const lint = lintFacebookDraft(ctx.db, { agent: ctx.agent, kind: "post", body: input.message, postType: input.postType, sourceUrl, link: input.link ?? null });
  return store(ctx, {
    what: "post",
    channel: "facebook_post",
    to: `fb:page:${pageId}`,
    subject: `Facebook post (${typeLabel})`,
    body: input.message,
    reason: input.reason,
    threadKey: null,
    payload: { kind: "post", postType: input.postType, link: input.link ?? null, sourceUrl, publishAt: iso(input.publishAt) },
    lint,
    exclusiveTarget: false,
    autoApprovable: false,
  });
}

function knownComment(ctx: FbDraftCtx, commentId: string) {
  const comment = ctx.db.facebook.getComment(commentId);
  if (!comment) {
    throw new HttpError("not_found", `Draft NOT created: comment "${commentId}" is not known. Use the commentId from the task input exactly as given.`);
  }
  if (comment.status === "own") {
    throw new HttpError("conflict", `Draft NOT created: comment "${commentId}" was written by the Page itself (${comment.statusReason ?? "own comment"}); we never answer our own comments.`);
  }
  return comment;
}

export function draftFbReply(ctx: FbDraftCtx, input: McpToolInput<"fb_draft_reply">): FbDraftOutput {
  requireFanpage(ctx);
  const comment = knownComment(ctx, input.commentId);
  if (comment.status === "replied" || comment.status === "hidden") {
    throw new HttpError("conflict", `Draft NOT created: this comment was already ${comment.status === "replied" ? "answered" : "hidden"}. Finish the task and say so in your summary.`);
  }
  const lint = lintFacebookDraft(ctx.db, { agent: ctx.agent, kind: "reply", body: input.message });
  return store(ctx, {
    what: "reply",
    channel: "facebook_reply",
    to: `fb:comment:${comment.id}`,
    subject: `Reply to ${comment.authorName ?? "a visitor"}`,
    body: input.message,
    reason: input.reason,
    threadKey: `fb:comment:${comment.id}`,
    payload: { kind: "reply", commentId: comment.id, postId: comment.postId, commentText: comment.message, commenterName: comment.authorName },
    lint,
    exclusiveTarget: true,
    alsoExcludedBy: `fb:hide:${comment.id}`,
    autoApprovable: true,
  });
}

export function proposeFbHide(ctx: FbDraftCtx, input: McpToolInput<"fb_propose_hide">): FbDraftOutput {
  requireFanpage(ctx);
  const comment = knownComment(ctx, input.commentId);
  if (comment.status === "hidden") throw new HttpError("conflict", "Draft NOT created: this comment is already hidden.");
  return store(ctx, {
    what: "hide proposal",
    channel: "facebook_hide",
    to: `fb:hide:${comment.id}`,
    subject: `Hide comment by ${comment.authorName ?? "a visitor"}`,
    body: input.reason,
    reason: input.reason,
    threadKey: `fb:comment:${comment.id}`,
    payload: { kind: "hide", commentId: comment.id, postId: comment.postId, commentText: comment.message, commenterName: comment.authorName, reason: input.reason },
    lint: [],
    exclusiveTarget: true,
    alsoExcludedBy: `fb:comment:${comment.id}`,
    autoApprovable: false,
  });
}
