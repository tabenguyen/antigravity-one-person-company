// Comment intake: dedupe by comment id (the duplicate-draft bug of commit 2a39562, here at the source), the Page's own
// comments skipped even when `from` is stripped, no replay of history, tasks created once.
import { describe, expect, it } from "vitest";
import { FacebookError } from "@agyhq/channels";
import { assignComments, storeFetched, whyNotAnswerable } from "../src/facebook/intake.ts";
import { FACEBOOK_CURSOR_KEY } from "../src/facebook/poller.ts";
import { PAGE_ID, setupFanpage } from "./facebook-helpers.ts";

const at = (minutes: number, base = new Date("2026-10-04T12:00:00.000Z")) => new Date(base.getTime() + minutes * 60_000).toISOString();

describe("storeFetched", () => {
  it("stores a comment once however many times it is delivered, and counts the repeats", () => {
    const e = setupFanpage();
    const post = e.provider.addPost({ message: "p", createdTime: at(-60) });
    const comment = { id: "c1", postId: post.id, parentId: null, message: "Giá bao nhiêu?", createdTime: at(1), from: { id: "u1", name: "An" } };
    const first = storeFetched({ db: e.db, pageId: PAGE_ID }, { posts: [post], comments: [comment, comment, comment], cursor: null });
    expect(first).toMatchObject({ posts: 1, newComments: 1, duplicates: 2 });
    const second = storeFetched({ db: e.db, pageId: PAGE_ID }, { posts: [post], comments: [comment], cursor: null });
    expect(second).toMatchObject({ newComments: 0, duplicates: 1 });
    expect(e.db.facebook.listComments()).toHaveLength(1);
    expect(e.db.audit.list({ kind: ["facebook.comment_received"] })).toHaveLength(1);
  });

  it("skips the Page's own comments, our own replies (even with no author), hidden and empty comments", () => {
    const e = setupFanpage();
    e.db.facebook.recordReply({ replyId: "r1", commentId: "c0", outboxId: null });
    const base = { postId: "p", parentId: null, createdTime: at(1) };
    const summary = storeFetched(
      { db: e.db, pageId: PAGE_ID },
      {
        posts: [],
        cursor: null,
        comments: [
          { ...base, id: "by-page", message: "Cảm ơn bạn", from: { id: PAGE_ID, name: "Page" } },
          { ...base, id: "r1", message: "our reply, author stripped", from: null },
          { ...base, id: "hidden", message: "spam", from: { id: "u2", name: "X" }, isHidden: true },
          { ...base, id: "empty", message: "  ", from: { id: "u3", name: "Y" } },
          { ...base, id: "real", message: "Có hỗ trợ Shopee không?", from: null },
        ],
      },
    );
    expect(summary).toMatchObject({ newComments: 1, ownComments: 2, skippedComments: 2 });
    expect(e.db.facebook.getComment("by-page")).toMatchObject({ status: "own", statusReason: "written by the Page itself" });
    expect(e.db.facebook.getComment("r1")).toMatchObject({ status: "own", statusReason: "a reply we posted" });
    expect(e.db.facebook.getComment("hidden")!.status).toBe("skipped");
    expect(e.db.facebook.getComment("real")).toMatchObject({ status: "new", authorId: null, authorName: null }); // `from` is optional
    expect(e.db.facebook.listUnassigned().map((c) => c.id)).toEqual(["real"]);
  });

  it("whyNotAnswerable never depends on `from`", () => {
    const e = setupFanpage();
    const c = { id: "x", postId: "p", parentId: null, message: "hi", createdTime: at(0) };
    expect(whyNotAnswerable({ db: e.db, pageId: PAGE_ID }, { ...c, from: undefined })).toBeNull();
    expect(whyNotAnswerable({ db: e.db, pageId: PAGE_ID }, { ...c, from: { id: PAGE_ID, name: null } })).toMatchObject({ status: "own" });
  });
});

describe("assignComments", () => {
  it("creates one fanpage.reply_comment task per stored comment, once, with the post and the handoff targets in the input", () => {
    const e = setupFanpage();
    e.db.agents.create({ id: "sdr-01", role: "sales-sdr", displayName: "Nam", model: "m", workspacePath: "/tmp/s", policy: { builtins: [], mcp: [] } });
    e.db.settings.patch({ defaultSdrAgentId: "sdr-01" });
    e.ingestComment({ id: "c1", message: "Muốn tư vấn gói", from: { id: "u1", name: "Quang" } });
    e.ingestComment({ id: "c2", message: "Cảm ơn team!", from: { id: "u2", name: "Thảo" } });
    const agent = e.db.agents.get(e.agentId)!;

    const first = assignComments(e.db, agent, 20);
    expect(first.taskIds).toHaveLength(2);
    expect(first.remaining).toBe(0);
    const t = e.db.tasks.get(first.taskIds[0]!)!;
    expect(t).toMatchObject({ kind: "fanpage.reply_comment", agentId: e.agentId, threadKey: "fb:comment:c1", priority: 10 });
    expect(t.input).toMatchObject({ commentId: "c1", postId: "post-1", commentText: "Muốn tư vấn gói", commenterName: "Quang", handoff: { sdrAgentId: "sdr-01", amAgentId: null } });
    expect(String(t.input["postText"])).toContain("StockSync 2.4");

    expect(assignComments(e.db, agent, 20).taskIds).toEqual([]); // nothing left: running again creates nothing
    expect(e.db.tasks.list({}).filter((x) => x.kind === "fanpage.reply_comment")).toHaveLength(2);
    expect(e.db.facebook.getComment("c1")).toMatchObject({ status: "assigned", taskId: first.taskIds[0], agentId: e.agentId });
  });

  it("respects the per-run cap and reports what is left", () => {
    const e = setupFanpage();
    for (const id of ["c1", "c2", "c3"]) e.ingestComment({ id });
    const run = assignComments(e.db, e.db.agents.get(e.agentId)!, 2);
    expect(run.taskIds).toHaveLength(2);
    expect(run.remaining).toBe(1);
  });

  it("a threaded comment carries the parent comment's text", () => {
    const e = setupFanpage();
    e.ingestComment({ id: "parent", message: "Có hỗ trợ Amazon không?" });
    e.ingestComment({ id: "child", message: "Còn eBay thì sao?", parentId: "parent" });
    const { taskIds } = assignComments(e.db, e.db.agents.get(e.agentId)!, 10);
    const child = taskIds.map((id) => e.db.tasks.get(id)!).find((t) => t.input["commentId"] === "child")!;
    expect(child.input["parentCommentText"]).toBe("Có hỗ trợ Amazon không?");
  });
});

describe("FacebookPoller", () => {
  it("the first poll replays nothing; later polls ingest each comment once and create one task each", async () => {
    const e = setupFanpage();
    const post = e.provider.addPost({ message: "Bài cũ", createdTime: "2026-10-01T08:00:00.000Z" });
    e.provider.addComment({ postId: post.id, id: "old", message: "bình luận cũ", createdTime: "2026-10-02T08:00:00.000Z" });
    const poller = e.poller();

    const init = await poller.pollNow();
    expect(init).toMatchObject({ newComments: 0, tasksCreated: 0 });
    expect(e.db.channelCursors.get(FACEBOOK_CURSOR_KEY)).toBe(e.clock.now.toISOString());
    expect(e.db.facebook.listComments()).toHaveLength(0); // history is never replayed

    e.provider.addComment({ postId: post.id, id: "c-new", message: "Có hỗ trợ TikTok Shop không?", createdTime: e.clock.now.toISOString() });
    e.clock.now = new Date(e.clock.now.getTime() + 60_000);
    const polled = await poller.pollNow();
    expect(polled).toMatchObject({ newComments: 1, tasksCreated: 1 });
    // overlap: the same comment is fetched again on the next poll (cursor uses >=); still one comment, one task
    const again = await poller.pollNow();
    expect(again).toMatchObject({ newComments: 0, duplicates: 1, tasksCreated: 0 });
    expect(e.db.tasks.list({}).filter((t) => t.kind === "fanpage.reply_comment")).toHaveLength(1);
  });

  it("never answers its own reply: after a reply is sent the next poll marks it own, with or without `from`", async () => {
    const e = setupFanpage();
    const poller = e.poller();
    await poller.pollNow();
    const post = e.provider.addPost({ message: "p" });
    const c = e.provider.addComment({ postId: post.id, id: "c1", message: "Có hỗ trợ Shopee không?", createdTime: e.clock.now.toISOString() });
    await poller.pollNow();
    expect(e.db.facebook.getComment("c1")!.status).toBe("assigned");

    // our reply lands on the Page
    const { replyId } = await e.provider.replyToComment({ commentId: c.id, message: "Có bạn nhé." });
    e.db.facebook.recordReply({ replyId, commentId: c.id, outboxId: null });
    await poller.pollNow();
    expect(e.db.facebook.getComment(replyId)).toMatchObject({ status: "own" });
    expect(e.db.tasks.list({}).filter((t) => t.kind === "fanpage.reply_comment")).toHaveLength(1);
  });

  it("without an active default Fanpage agent comments are stored but get no task (the comment_poll routine picks them up)", async () => {
    const e = setupFanpage();
    e.db.settings.patch({ defaultFanpageAgentId: null });
    const poller = e.poller();
    await poller.pollNow();
    const post = e.provider.addPost({ message: "p" });
    e.provider.addComment({ postId: post.id, id: "c1", message: "Xin chào", createdTime: e.clock.now.toISOString() });
    const res = await poller.pollNow();
    expect(res).toMatchObject({ newComments: 1, tasksCreated: 0 });
    expect(e.db.facebook.listUnassigned().map((c) => c.id)).toEqual(["c1"]);
  });

  it("a provider failure is kept as lastError, not thrown, and the cursor does not move", async () => {
    const e = setupFanpage();
    const poller = e.poller();
    await poller.pollNow();
    const cursor = e.db.channelCursors.get(FACEBOOK_CURSOR_KEY);
    e.provider.failNext("fetchNew", new FacebookError("rate limited", { code: "rate_limit", transient: true }));
    expect(await poller.pollNow()).toBeNull();
    expect(poller.lastError).toBe("rate limited");
    expect(e.db.channelCursors.get(FACEBOOK_CURSOR_KEY)).toBe(cursor);
    await poller.pollNow();
    expect(poller.lastError).toBeNull();
  });
});
