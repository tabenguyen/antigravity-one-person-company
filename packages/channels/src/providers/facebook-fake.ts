// In-memory FacebookPageProvider for daemon tests and evals (the "L0" rung of the test ladder in
// docs/FANPAGE-RESEARCH.md section 3): `addPost` / `addComment` stage what Facebook would show, `fetchNew` drains it the
// way the Graph provider does (null cursor = from now, comments at or after the cursor), and every write is recorded
// instead of sent. A reply we accept shows up in the next fetch as a comment written by the Page, as on Facebook.

import type {
  FacebookPageProvider,
  FbAuthor,
  FbComment,
  FbFetchResult,
  FbInspection,
  FbPageIdentity,
  FbPost,
  FbPostResult,
  FbReplyResult,
  OutgoingFbPost,
  OutgoingFbReply,
} from "@agyhq/core";
import { FB_REQUIRED_PERMISSIONS } from "@agyhq/core";

import { FacebookError } from "../facebook-errors.ts";
import { validateScheduleWindow } from "../facebook-schedule.ts";

export interface FakeFacebookOptions {
  /** @default "page-1" */
  pageId?: string;
  /** @default "Fake Page" */
  pageName?: string;
  now?: () => Date;
}

type FakeOp = "fetchNew" | "createPost" | "listScheduledPosts" | "cancelScheduledPost" | "replyToComment" | "hideComment" | "inspect";

export class FakeFacebookProvider implements FacebookPageProvider {
  readonly kind = "fake";
  readonly pageId: string;
  readonly pageName: string;
  /** Every createPost call, in order (all modes). */
  readonly created: { post: OutgoingFbPost; result: FbPostResult }[] = [];
  readonly replies: { commentId: string; message: string; replyId: string }[] = [];
  readonly hidden: string[] = [];
  readonly cancelled: string[] = [];

  #now: () => Date;
  #posts: FbPost[] = [];
  #comments: FbComment[] = [];
  #scheduled = new Map<string, FbPost>();
  #seq = 0;
  #failNext = new Map<FakeOp, Error>();
  #inspection: FbInspection;

  constructor(opts: FakeFacebookOptions = {}) {
    this.pageId = opts.pageId ?? "page-1";
    this.pageName = opts.pageName ?? "Fake Page";
    this.#now = opts.now ?? (() => new Date());
    this.#inspection = {
      tokenValid: true,
      tokenError: null,
      page: { id: this.pageId, name: this.pageName },
      granted: [...FB_REQUIRED_PERMISSIONS],
      declined: [],
      appMode: "development",
      appSecretProof: false,
      notes: ["fake provider: nothing here talks to Facebook"],
    };
  }

  /** Stage a published post on the Page. */
  addPost(post: Partial<FbPost> & { message: string }): FbPost {
    const id = post.id ?? `${this.pageId}_post${++this.#seq}`;
    const p: FbPost = {
      id,
      pageId: this.pageId,
      message: post.message,
      permalinkUrl: post.permalinkUrl ?? `https://facebook.example/${id}`,
      createdTime: post.createdTime ?? this.#now().toISOString(),
      isPublished: post.isPublished ?? true,
      scheduledPublishTime: post.scheduledPublishTime ?? null,
    };
    this.#posts.push(p);
    return p;
  }

  /** Stage a comment. `from: null` simulates Facebook stripping the author; omit it for a default stranger. */
  addComment(c: { postId: string; message: string; id?: string; parentId?: string | null; from?: FbAuthor | null; createdTime?: string }): FbComment {
    const id = c.id ?? `${c.postId}_c${++this.#seq}`;
    const comment: FbComment = {
      id,
      postId: c.postId,
      parentId: c.parentId ?? null,
      message: c.message,
      createdTime: c.createdTime ?? this.#now().toISOString(),
      from: c.from === undefined ? { id: `user-${this.#seq}`, name: `User ${this.#seq}` } : c.from,
      permalinkUrl: `https://facebook.example/${id}`,
      isHidden: false,
    };
    this.#comments.push(comment);
    return comment;
  }

  /** The next call of `op` rejects with this error (one-shot). */
  failNext(op: FakeOp, err: Error): void {
    this.#failNext.set(op, err);
  }

  /** What `inspect()` reports from now on (merged over the current value). */
  setInspection(patch: Partial<FbInspection>): void {
    this.#inspection = { ...this.#inspection, ...patch };
  }

  #maybeFail(op: FakeOp): void {
    const err = this.#failNext.get(op);
    if (err) {
      this.#failNext.delete(op);
      throw err;
    }
  }

  async fetchNew(cursor: string | null, _opts: { limit?: number; lookbackDays?: number } = {}): Promise<FbFetchResult> {
    this.#maybeFail("fetchNew");
    const posts = this.#posts.filter((p) => p.isPublished).sort((a, b) => b.createdTime.localeCompare(a.createdTime));
    if (cursor === null) return { posts, comments: [], cursor: this.#now().toISOString() };
    const fresh = this.#comments
      .filter((c) => c.createdTime >= cursor)
      .sort((a, b) => a.createdTime.localeCompare(b.createdTime) || a.id.localeCompare(b.id));
    const newest = fresh.length > 0 ? fresh[fresh.length - 1]!.createdTime : cursor;
    return { posts, comments: fresh.map((c) => ({ ...c })), cursor: newest > cursor ? newest : cursor };
  }

  async createPost(post: OutgoingFbPost): Promise<FbPostResult> {
    this.#maybeFail("createPost");
    let scheduledPublishTime: string | null = null;
    if (post.mode === "scheduled") scheduledPublishTime = validateScheduleWindow(post.scheduledPublishTime, this.#now()).toISOString();
    const id = `${this.pageId}_${post.mode}${++this.#seq}`;
    const stored: FbPost = {
      id,
      pageId: this.pageId,
      message: post.message,
      permalinkUrl: `https://facebook.example/${id}`,
      createdTime: this.#now().toISOString(),
      isPublished: post.mode === "immediate",
      scheduledPublishTime,
    };
    if (post.mode === "immediate") this.#posts.push(stored);
    else if (post.mode === "scheduled") this.#scheduled.set(id, stored);
    const result: FbPostResult = { postId: id, mode: post.mode, scheduledPublishTime };
    this.created.push({ post: { ...post }, result });
    return result;
  }

  async listScheduledPosts(): Promise<FbPost[]> {
    this.#maybeFail("listScheduledPosts");
    return [...this.#scheduled.values()].sort((a, b) => (a.scheduledPublishTime ?? "").localeCompare(b.scheduledPublishTime ?? ""));
  }

  async cancelScheduledPost(postId: string): Promise<void> {
    this.#maybeFail("cancelScheduledPost");
    if (!this.#scheduled.delete(postId)) throw new FacebookError(`scheduled post ${postId} does not exist`, { code: "not_found" });
    this.cancelled.push(postId);
  }

  async replyToComment(reply: OutgoingFbReply): Promise<FbReplyResult> {
    this.#maybeFail("replyToComment");
    const parent = this.#comments.find((c) => c.id === reply.commentId);
    if (!parent) throw new FacebookError(`comment ${reply.commentId} does not exist`, { code: "not_found" });
    const created = this.addComment({
      postId: parent.postId,
      message: reply.message,
      parentId: reply.commentId,
      from: { id: this.pageId, name: this.pageName },
    });
    this.replies.push({ commentId: reply.commentId, message: reply.message, replyId: created.id });
    return { replyId: created.id };
  }

  async hideComment(commentId: string): Promise<void> {
    this.#maybeFail("hideComment");
    const c = this.#comments.find((x) => x.id === commentId);
    if (!c) throw new FacebookError(`comment ${commentId} does not exist`, { code: "not_found" });
    c.isHidden = true;
    this.hidden.push(commentId);
  }

  async inspect(): Promise<FbInspection> {
    this.#maybeFail("inspect");
    return { ...this.#inspection, granted: this.#inspection.granted ? [...this.#inspection.granted] : null, notes: [...this.#inspection.notes] };
  }

  async verify(): Promise<{ ok: true; page: FbPageIdentity } | { ok: false; error: string }> {
    if (!this.#inspection.tokenValid) return { ok: false, error: this.#inspection.tokenError ?? "token is not valid" };
    return { ok: true, page: { id: this.pageId, name: this.pageName } };
  }

  async close(): Promise<void> {
    // nothing to release
  }
}
