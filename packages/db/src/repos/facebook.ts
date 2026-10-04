import type Database from "better-sqlite3";
import type { FbCommentRecord, FbCommentStatus, FbPostRecord, FbReplyRecord, Iso } from "@agyhq/core";
import { nowIso } from "@agyhq/core";

type SqliteDb = Database.Database;

interface PostRow {
  id: string;
  message: string | null;
  permalink_url: string | null;
  created_time: string;
  is_published: number;
  scheduled_publish_time: string | null;
  source: string;
  outbox_id: string | null;
  seen_at: string;
}

interface CommentRow {
  id: string;
  post_id: string;
  parent_id: string | null;
  message: string;
  author_id: string | null;
  author_name: string | null;
  created_time: string;
  status: string;
  status_reason: string | null;
  task_id: string | null;
  agent_id: string | null;
  ingested_at: string;
}

interface ReplyRow {
  reply_id: string;
  comment_id: string;
  outbox_id: string | null;
  created_at: string;
}

const mapPost = (r: PostRow): FbPostRecord => ({
  id: r.id,
  message: r.message,
  permalinkUrl: r.permalink_url,
  createdTime: r.created_time,
  isPublished: Boolean(r.is_published),
  scheduledPublishTime: r.scheduled_publish_time,
  source: r.source as FbPostRecord["source"],
  outboxId: r.outbox_id,
  seenAt: r.seen_at,
});

const mapComment = (r: CommentRow): FbCommentRecord => ({
  id: r.id,
  postId: r.post_id,
  parentId: r.parent_id,
  message: r.message,
  authorId: r.author_id,
  authorName: r.author_name,
  createdTime: r.created_time,
  status: r.status as FbCommentStatus,
  statusReason: r.status_reason,
  taskId: r.task_id,
  agentId: r.agent_id,
  ingestedAt: r.ingested_at,
});

const mapReply = (r: ReplyRow): FbReplyRecord => ({ replyId: r.reply_id, commentId: r.comment_id, outboxId: r.outbox_id, createdAt: r.created_at });

export interface UpsertPostInput {
  id: string;
  message: string | null;
  permalinkUrl: string | null;
  createdTime: Iso;
  isPublished: boolean;
  scheduledPublishTime: Iso | null;
}

export interface InsertCommentInput {
  id: string;
  postId: string;
  parentId: string | null;
  message: string;
  authorId: string | null;
  authorName: string | null;
  createdTime: Iso;
  /** "new" for a comment that needs a reply, "own" for one the Page or we wrote, "skipped" for nothing to answer. */
  status: Extract<FbCommentStatus, "new" | "own" | "skipped">;
  statusReason?: string | null;
}

/** Posts and comments we saw on the Page, and the reply mapping. The Page itself stays the source of truth. */
export class FacebookRepo {
  #db: SqliteDb;

  constructor(db: SqliteDb) {
    this.#db = db;
  }

  // -- posts ----------------------------------------------------------------

  /** Record a post seen in the feed (or refresh it). Keeps `source`/`outboxId` of a post we created ourselves. */
  upsertPost(input: UpsertPostInput): void {
    this.#db
      .prepare(
        `INSERT INTO fb_posts (id, message, permalink_url, created_time, is_published, scheduled_publish_time, source, outbox_id, seen_at)
         VALUES (@id, @message, @permalinkUrl, @createdTime, @isPublished, @scheduledPublishTime, 'page', NULL, @seenAt)
         ON CONFLICT(id) DO UPDATE SET message = excluded.message, permalink_url = excluded.permalink_url,
           is_published = excluded.is_published, scheduled_publish_time = excluded.scheduled_publish_time, seen_at = excluded.seen_at`,
      )
      .run({ ...input, isPublished: input.isPublished ? 1 : 0, seenAt: nowIso() });
  }

  /** A post we handed to Facebook (scheduled), linked to the outbox draft it came from. */
  recordAgentPost(input: UpsertPostInput & { outboxId: string }): void {
    this.#db
      .prepare(
        `INSERT INTO fb_posts (id, message, permalink_url, created_time, is_published, scheduled_publish_time, source, outbox_id, seen_at)
         VALUES (@id, @message, @permalinkUrl, @createdTime, @isPublished, @scheduledPublishTime, 'agent', @outboxId, @seenAt)
         ON CONFLICT(id) DO UPDATE SET source = 'agent', outbox_id = excluded.outbox_id, scheduled_publish_time = excluded.scheduled_publish_time,
           is_published = excluded.is_published, seen_at = excluded.seen_at`,
      )
      .run({ ...input, isPublished: input.isPublished ? 1 : 0, seenAt: nowIso() });
  }

  deletePost(id: string): void {
    this.#db.prepare("DELETE FROM fb_posts WHERE id = ?").run(id);
  }

  getPost(id: string): FbPostRecord | null {
    const row = this.#db.prepare("SELECT * FROM fb_posts WHERE id = ?").get(id) as PostRow | undefined;
    return row ? mapPost(row) : null;
  }

  /** Newest first. `scheduledOnly`: posts we know are scheduled and not yet live (scheduled_publish_time in the future of `now`). */
  listPosts(opts: { limit?: number; source?: FbPostRecord["source"]; scheduledAfter?: Iso } = {}): FbPostRecord[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (opts.source) {
      clauses.push("source = ?");
      params.push(opts.source);
    }
    if (opts.scheduledAfter) {
      clauses.push("is_published = 0 AND scheduled_publish_time > ?");
      params.push(opts.scheduledAfter);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.#db
      .prepare(`SELECT * FROM fb_posts ${where} ORDER BY created_time DESC, rowid DESC LIMIT ?`)
      .all(...params, opts.limit ?? 50) as PostRow[];
    return rows.map(mapPost);
  }

  // -- comments ---------------------------------------------------------------

  /**
   * Store a comment unless its id is already known (INSERT OR IGNORE on the primary key). `created` is false for a
   * repeat, whatever the existing row's status: a comment is ingested exactly once.
   */
  insertCommentIfNew(input: InsertCommentInput): { comment: FbCommentRecord; created: boolean } {
    const res = this.#db
      .prepare(
        `INSERT OR IGNORE INTO fb_comments (id, post_id, parent_id, message, author_id, author_name, created_time, status, status_reason, ingested_at)
         VALUES (@id, @postId, @parentId, @message, @authorId, @authorName, @createdTime, @status, @statusReason, @ingestedAt)`,
      )
      .run({ ...input, statusReason: input.statusReason ?? null, ingestedAt: nowIso() });
    return { comment: this.getComment(input.id)!, created: res.changes > 0 };
  }

  getComment(id: string): FbCommentRecord | null {
    const row = this.#db.prepare("SELECT * FROM fb_comments WHERE id = ?").get(id) as CommentRow | undefined;
    return row ? mapComment(row) : null;
  }

  /** Newest first. */
  listComments(opts: { status?: FbCommentStatus[]; postId?: string; limit?: number } = {}): FbCommentRecord[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (opts.status?.length) {
      clauses.push(`status IN (${opts.status.map(() => "?").join(", ")})`);
      params.push(...opts.status);
    }
    if (opts.postId) {
      clauses.push("post_id = ?");
      params.push(opts.postId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.#db
      .prepare(`SELECT * FROM fb_comments ${where} ORDER BY created_time DESC, rowid DESC LIMIT ?`)
      .all(...params, opts.limit ?? 100) as CommentRow[];
    return rows.map(mapComment);
  }

  /** Stored comments waiting for a task (status `new`, no task), oldest first. */
  listUnassigned(limit = 100): FbCommentRecord[] {
    const rows = this.#db
      .prepare(`SELECT * FROM fb_comments WHERE status = 'new' AND task_id IS NULL ORDER BY created_time ASC, rowid ASC LIMIT ?`)
      .all(limit) as CommentRow[];
    return rows.map(mapComment);
  }

  countUnassigned(): number {
    return (this.#db.prepare(`SELECT COUNT(*) AS c FROM fb_comments WHERE status = 'new' AND task_id IS NULL`).get() as { c: number }).c;
  }

  /** `new` -> `assigned`: record the task that will answer it. The unique index on task_id makes a second task impossible. */
  assign(commentId: string, taskId: string, agentId: string): void {
    this.#db
      .prepare(`UPDATE fb_comments SET status = 'assigned', task_id = ?, agent_id = ? WHERE id = ? AND status = 'new' AND task_id IS NULL`)
      .run(taskId, agentId, commentId);
  }

  setCommentStatus(commentId: string, status: FbCommentStatus, reason: string | null = null): void {
    this.#db.prepare("UPDATE fb_comments SET status = ?, status_reason = COALESCE(?, status_reason) WHERE id = ?").run(status, reason, commentId);
  }

  countCommentsSince(since: Iso): number {
    return (this.#db.prepare("SELECT COUNT(*) AS c FROM fb_comments WHERE ingested_at >= ? AND status != 'own'").get(since) as { c: number }).c;
  }

  // -- reply mapping ------------------------------------------------------------

  /** Remember that comment `replyId` is the reply we posted to `commentId`. */
  recordReply(input: { replyId: string; commentId: string; outboxId: string | null }): void {
    this.#db
      .prepare(`INSERT OR IGNORE INTO fb_replies (reply_id, comment_id, outbox_id, created_at) VALUES (@replyId, @commentId, @outboxId, @createdAt)`)
      .run({ ...input, createdAt: nowIso() });
  }

  isOurReply(replyId: string): boolean {
    return this.#db.prepare("SELECT 1 FROM fb_replies WHERE reply_id = ?").get(replyId) !== undefined;
  }

  /** The replies we posted to a comment, oldest first. */
  repliesTo(commentId: string): FbReplyRecord[] {
    const rows = this.#db.prepare("SELECT * FROM fb_replies WHERE comment_id = ? ORDER BY created_at ASC, rowid ASC").all(commentId) as ReplyRow[];
    return rows.map(mapReply);
  }
}
