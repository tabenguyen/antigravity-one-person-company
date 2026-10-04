import { describe, expect, it } from "vitest";
import type { OutboxPayload } from "@agyhq/core";
import { openDb } from "../src/index.ts";

function withAgent(db: ReturnType<typeof openDb>, id = "fp-01") {
  db.agents.create({ id, role: "fanpage-manager", displayName: "Fan", model: "m", workspacePath: `/tmp/${id}`, policy: { builtins: [], mcp: [] } });
  return id;
}

const comment = (id: string, over: Partial<Parameters<ReturnType<typeof openDb>["facebook"]["insertCommentIfNew"]>[0]> = {}) => ({
  id,
  postId: "p1",
  parentId: null,
  message: `comment ${id}`,
  authorId: "u1",
  authorName: "An",
  createdTime: "2026-10-04T10:00:00.000Z",
  status: "new" as const,
  ...over,
});

describe("facebook repo", () => {
  it("stores a comment once: the Facebook comment id is the dedupe key", () => {
    const db = openDb(":memory:");
    const first = db.facebook.insertCommentIfNew(comment("c1"));
    const again = db.facebook.insertCommentIfNew(comment("c1", { message: "edited later" }));
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.comment.message).toBe("comment c1"); // the first version wins
    expect(db.facebook.listComments()).toHaveLength(1);
    db.close();
  });

  it("assign() gives a comment at most one task (and the unique index refuses a task reused for another comment)", () => {
    const db = openDb(":memory:");
    withAgent(db);
    db.facebook.insertCommentIfNew(comment("c1"));
    db.facebook.insertCommentIfNew(comment("c2"));
    expect(db.facebook.listUnassigned().map((c) => c.id)).toEqual(["c1", "c2"]);

    db.facebook.assign("c1", "task-a", "fp-01");
    expect(db.facebook.getComment("c1")).toMatchObject({ status: "assigned", taskId: "task-a", agentId: "fp-01" });
    db.facebook.assign("c1", "task-b", "fp-01"); // no-op: already assigned
    expect(db.facebook.getComment("c1")!.taskId).toBe("task-a");
    expect(db.facebook.listUnassigned().map((c) => c.id)).toEqual(["c2"]);
    expect(() => db.facebook.assign("c2", "task-a", "fp-01")).toThrow(/UNIQUE/);
    db.close();
  });

  it("own comments are stored but never listed as unassigned", () => {
    const db = openDb(":memory:");
    db.facebook.insertCommentIfNew(comment("c1", { status: "own", statusReason: "written by the Page", authorId: "page-1" }));
    expect(db.facebook.listUnassigned()).toEqual([]);
    expect(db.facebook.listComments({ status: ["own"] })).toHaveLength(1);
    db.facebook.setCommentStatus("c1", "replied");
    expect(db.facebook.getComment("c1")).toMatchObject({ status: "replied", statusReason: "written by the Page" });
    db.close();
  });

  it("keeps the reply mapping: which comment our reply answers, and whether an id is ours", () => {
    const db = openDb(":memory:");
    db.facebook.recordReply({ replyId: "r1", commentId: "c1", outboxId: "obx_1" });
    db.facebook.recordReply({ replyId: "r1", commentId: "c1", outboxId: "obx_1" }); // idempotent
    expect(db.facebook.isOurReply("r1")).toBe(true);
    expect(db.facebook.isOurReply("c1")).toBe(false);
    expect(db.facebook.repliesTo("c1")).toMatchObject([{ replyId: "r1", commentId: "c1", outboxId: "obx_1" }]);
    db.close();
  });

  it("upsertPost refreshes a post but keeps the origin of one we created; listPosts can filter to scheduled", () => {
    const db = openDb(":memory:");
    db.facebook.recordAgentPost({ id: "p9", message: "ours", permalinkUrl: null, createdTime: "2026-10-04T09:00:00.000Z", isPublished: false, scheduledPublishTime: "2026-10-06T09:00:00.000Z", outboxId: "obx_9" });
    db.facebook.upsertPost({ id: "p9", message: "ours (seen)", permalinkUrl: "https://x/p9", createdTime: "2026-10-04T09:00:00.000Z", isPublished: false, scheduledPublishTime: "2026-10-06T09:00:00.000Z" });
    db.facebook.upsertPost({ id: "p1", message: "page post", permalinkUrl: null, createdTime: "2026-10-01T09:00:00.000Z", isPublished: true, scheduledPublishTime: null });
    expect(db.facebook.getPost("p9")).toMatchObject({ source: "agent", outboxId: "obx_9", message: "ours (seen)" });
    expect(db.facebook.getPost("p1")).toMatchObject({ source: "page", isPublished: true });
    expect(db.facebook.listPosts({ scheduledAfter: "2026-10-05T00:00:00.000Z" }).map((p) => p.id)).toEqual(["p9"]);
    expect(db.facebook.listPosts({ scheduledAfter: "2026-10-07T00:00:00.000Z" })).toEqual([]);
    db.close();
  });
});

describe("outbox: facebook channels", () => {
  const post: OutboxPayload = { kind: "post", postType: "tip", link: null, sourceUrl: null, publishAt: "2026-10-06T09:00:00.000Z" };

  it("round-trips the payload, revises it in place, and replaces it with setPayload", () => {
    const db = openDb(":memory:");
    withAgent(db);
    const draft = db.outbox.createDraft({ agentId: "fp-01", channel: "facebook_post", to: "fb:page:p", subject: "Post (tip)", body: "Mẹo hay", reason: "weekly", payload: post });
    expect(db.outbox.get(draft.id)!.payload).toEqual(post);
    expect(db.outbox.createDraft({ agentId: "fp-01", channel: "email", to: "a@b.co", body: "x", reason: "r" }).payload).toBeNull();

    const revised = db.outbox.revise(draft.id, { subject: "Post (tip)", body: "Mẹo hay hơn", reason: "again", threadKey: null, lint: [], payload: { ...post, publishAt: null } });
    expect(revised.payload).toMatchObject({ publishAt: null });
    expect(db.outbox.get(draft.id)!.payload).toMatchObject({ publishAt: null });
    // revise without a payload keeps the current one
    db.outbox.revise(draft.id, { subject: "Post (tip)", body: "v3", reason: "again", threadKey: null, lint: [] });
    expect(db.outbox.get(draft.id)!.payload).toMatchObject({ kind: "post", publishAt: null });

    db.outbox.setPayload(draft.id, { ...post, scheduledPublishTime: "2026-10-06T09:00:00.000Z", fbPostId: "p_1" });
    expect(db.outbox.get(draft.id)!.payload).toMatchObject({ fbPostId: "p_1" });
    db.close();
  });

  it("each sender claims only its own channels", () => {
    const db = openDb(":memory:");
    withAgent(db);
    const email = db.outbox.createDraft({ agentId: "fp-01", channel: "email", to: "a@b.co", subject: "s", body: "b", reason: "r" });
    const reply = db.outbox.createDraft({ agentId: "fp-01", channel: "facebook_reply", to: "fb:comment:c1", body: "cảm ơn", reason: "r" });
    db.outbox.decide(email.id, "approved", { decidedBy: "human:x" });
    db.outbox.decide(reply.id, "approved", { decidedBy: "human:x" });

    expect(db.outbox.claimNextToSend()!.id).toBe(email.id); // default = email only
    expect(db.outbox.claimNextToSend()).toBeNull();
    expect(db.outbox.claimNextToSend(["facebook_post", "facebook_reply", "facebook_hide"])!.id).toBe(reply.id);

    db.outbox.decide(email.id, "sent", { sentAt: new Date().toISOString() });
    db.outbox.decide(reply.id, "sent", { sentAt: new Date().toISOString() });
    expect(db.outbox.countSentSince("2000-01-01T00:00:00.000Z")).toBe(1);
    expect(db.outbox.countSentSince("2000-01-01T00:00:00.000Z", ["facebook_reply"])).toBe(1);
    expect(db.outbox.lastSent(10).map((i) => i.id)).toEqual([email.id]);
    db.close();
  });

  it("listByRecipient filters by recipient (case-insensitive) and status", () => {
    const db = openDb(":memory:");
    withAgent(db);
    const a = db.outbox.createDraft({ agentId: "fp-01", channel: "facebook_reply", to: "fb:comment:C1", body: "x", reason: "r" });
    db.outbox.createDraft({ agentId: "fp-01", channel: "facebook_reply", to: "fb:comment:c2", body: "y", reason: "r" });
    expect(db.outbox.listByRecipient("fb:comment:c1").map((i) => i.id)).toEqual([a.id]);
    expect(db.outbox.listByRecipient("fb:comment:c1", ["sent"])).toEqual([]);
    db.close();
  });
});
