// Facebook comment intake (docs/FANPAGE.md sections 6-7): turn what the provider returned into stored comments, and stored
// comments into `fanpage.reply_comment` tasks. Shared by the FacebookPoller (network) and the `comment_poll` routine (db only).
//
// The dedupe rule that matters (the bug commit 2a39562 fixed for email, here by construction): the Facebook comment id is the
// primary key of fb_comments, a polled comment overlaps with the previous poll by design, and a stored comment gets a task at
// most once because `assign()` only moves `new` -> `assigned` and task_id is unique.

import type { Agent, FbComment, FbFetchResult } from "@agyhq/core";
import type { Db } from "@agyhq/db";
import type { EventBus } from "../event-bus.ts";

export const REPLY_COMMENT_KIND = "fanpage.reply_comment";
export const DRAFT_POST_KIND = "fanpage.draft_post";
export const CONTENT_CALENDAR_KIND = "fanpage.content_calendar";

export interface IntakeCtx {
  db: Db;
  bus?: EventBus;
  /** The Page's own id: comments written by it are never answered. */
  pageId: string;
}

export interface StoreSummary {
  posts: number;
  /** Comments seen for the first time, by what happened to them. */
  newComments: number;
  ownComments: number;
  skippedComments: number;
  /** Comments already stored (every poll overlaps the previous one). */
  duplicates: number;
}

/** Why a comment must not be answered, or null when it should be. Never depends on `from` being present. */
export function whyNotAnswerable(ctx: IntakeCtx, c: FbComment): { status: "own" | "skipped"; reason: string } | null {
  if (c.from?.id && c.from.id === ctx.pageId) return { status: "own", reason: "written by the Page itself" };
  if (ctx.db.facebook.isOurReply(c.id)) return { status: "own", reason: "a reply we posted" };
  if (c.isHidden) return { status: "skipped", reason: "already hidden on Facebook" };
  if (!c.message.trim()) return { status: "skipped", reason: "no text (photo, sticker or empty comment)" };
  return null;
}

/** Store the posts and comments a provider fetch returned. No tasks are created here. */
export function storeFetched(ctx: IntakeCtx, result: FbFetchResult): StoreSummary {
  const { db, bus } = ctx;
  const summary: StoreSummary = { posts: 0, newComments: 0, ownComments: 0, skippedComments: 0, duplicates: 0 };
  const fresh: string[] = [];
  db.transaction(() => {
    for (const p of result.posts) {
      db.facebook.upsertPost({
        id: p.id,
        message: p.message,
        permalinkUrl: p.permalinkUrl,
        createdTime: p.createdTime,
        isPublished: p.isPublished,
        scheduledPublishTime: p.scheduledPublishTime,
      });
      summary.posts += 1;
    }
    for (const c of result.comments) {
      const skip = whyNotAnswerable(ctx, c);
      const { created } = db.facebook.insertCommentIfNew({
        id: c.id,
        postId: c.postId,
        parentId: c.parentId,
        message: c.message,
        authorId: c.from?.id ?? null,
        authorName: c.from?.name ?? null,
        createdTime: c.createdTime,
        status: skip?.status ?? "new",
        statusReason: skip?.reason ?? null,
      });
      if (!created) summary.duplicates += 1;
      else if (!skip) {
        summary.newComments += 1;
        fresh.push(c.id);
        db.audit.append({
          kind: "facebook.comment_received",
          agentId: null,
          taskId: null,
          conversationId: null,
          data: { commentId: c.id, postId: c.postId, hasAuthor: Boolean(c.from?.id) },
        });
      } else if (skip.status === "own") summary.ownComments += 1;
      else summary.skippedComments += 1;
    }
  });
  if (fresh.length > 0) bus?.emit("facebook.comments", { count: fresh.length });
  return summary;
}

/** The active Fanpage agent that receives comments: `settings.defaultFanpageAgentId`, or null. */
export function defaultFanpageAgent(db: Db): Agent | null {
  const id = db.settings.get().defaultFanpageAgentId;
  const agent = id ? db.agents.get(id) : null;
  return agent && agent.role === "fanpage-manager" && agent.status === "active" ? agent : null;
}

const text = (v: string | null | undefined, fallback: string, max = 2000): string => {
  const t = (v ?? "").trim();
  return t ? (t.length > max ? `${t.slice(0, max)}...` : t) : fallback;
};

/** Where the agent may hand a lead or a complaint: the default SDR / Account Manager, when they exist and are active. */
export function handoffTargets(db: Db): { sdrAgentId: string | null; amAgentId: string | null } {
  const s = db.settings.get();
  const active = (id: string | null) => (id && db.agents.get(id)?.status === "active" ? id : null);
  return { sdrAgentId: active(s.defaultSdrAgentId), amAgentId: active(s.defaultAmAgentId) };
}

/**
 * Create a `fanpage.reply_comment` task for stored comments that have none (status `new`), oldest first, at most `max`.
 * Pure db work in one transaction (the routine runner relies on that); the caller emits `task.created` for the returned ids.
 */
export function assignComments(db: Db, agent: Agent, max = 20): { taskIds: string[]; remaining: number } {
  const taskIds: string[] = [];
  const waiting = db.facebook.listUnassigned(Math.max(1, max));
  const targets = handoffTargets(db);
  for (const c of waiting) {
    const post = db.facebook.getPost(c.postId);
    const parent = c.parentId ? db.facebook.getComment(c.parentId) : null;
    const task = db.tasks.create({
      agentId: agent.id,
      kind: REPLY_COMMENT_KIND,
      title: `Reply to ${c.authorName ?? "a visitor"}'s comment`,
      input: {
        commentId: c.id,
        postId: c.postId,
        postText: text(post?.message, "(the post text is not available)"),
        commentText: text(c.message, "(empty)", 4000),
        commenterName: c.authorName ?? "(name not available)",
        commentedAt: c.createdTime,
        parentCommentText: parent ? text(parent.message, "(empty)") : "(top-level comment)",
        handoff: targets,
      },
      threadKey: `fb:comment:${c.id}`,
      priority: 10, // like an inbound reply: a visitor is waiting, so it outranks background work under a quota throttle
    });
    db.facebook.assign(c.id, task.id, agent.id);
    taskIds.push(task.id);
  }
  return { taskIds, remaining: db.facebook.countUnassigned() };
}

/** assignComments() in its own transaction plus the bus events. For callers outside a routine run. */
export function assignAndAnnounce(db: Db, bus: EventBus | undefined, agent: Agent, max = 20): string[] {
  const { taskIds } = db.transaction(() => assignComments(db, agent, max));
  for (const id of taskIds) bus?.emit("task.created", { taskId: id, agentId: agent.id, source: "facebook" });
  return taskIds;
}
