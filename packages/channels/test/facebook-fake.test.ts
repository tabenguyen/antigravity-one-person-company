import { describe, expect, it } from "vitest";
import { FB_REQUIRED_PERMISSIONS } from "@agyhq/core";
import { FacebookError, FakeFacebookProvider, createFacebookProvider } from "../src/index.ts";

const NOW = new Date("2026-10-04T12:00:00.000Z");
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000).toISOString();

describe("FakeFacebookProvider", () => {
  it("fetchNew: null cursor means from now (no comments), then returns comments at or after the cursor, oldest first", async () => {
    const fb = new FakeFacebookProvider({ now: () => NOW });
    const post = fb.addPost({ message: "hello", createdTime: at(-600) });
    fb.addComment({ postId: post.id, message: "old", createdTime: at(-100) });

    const first = await fb.fetchNew(null);
    expect(first.comments).toEqual([]);
    expect(first.cursor).toBe(NOW.toISOString());
    expect(first.posts.map((p) => p.id)).toEqual([post.id]);

    fb.addComment({ postId: post.id, message: "second", createdTime: at(20) });
    fb.addComment({ postId: post.id, message: "first", createdTime: at(10) });
    const next = await fb.fetchNew(first.cursor);
    expect(next.comments.map((c) => c.message)).toEqual(["first", "second"]);
    expect(next.cursor).toBe(at(20));
    expect((await fb.fetchNew(next.cursor)).comments.map((c) => c.message)).toEqual(["second"]); // overlaps by design
  });

  it("addComment can strip the author (from: null) to model Facebook hiding it", async () => {
    const fb = new FakeFacebookProvider({ now: () => NOW });
    const post = fb.addPost({ message: "p" });
    fb.addComment({ postId: post.id, message: "anon", from: null, createdTime: at(1) });
    const { comments } = await fb.fetchNew(at(0));
    expect(comments[0]!.from).toBeNull();
  });

  it("scheduled posts obey the real window; preview and immediate do not need a time", async () => {
    const fb = new FakeFacebookProvider({ now: () => NOW });
    await expect(fb.createPost({ message: "x", mode: "scheduled", scheduledPublishTime: at(5) })).rejects.toMatchObject({ code: "schedule_window" });
    const scheduled = await fb.createPost({ message: "later", mode: "scheduled", scheduledPublishTime: at(24 * 60) });
    expect(scheduled.scheduledPublishTime).toBe(at(24 * 60));
    await fb.createPost({ message: "draft", mode: "preview" });
    await fb.createPost({ message: "now", mode: "immediate" });

    expect((await fb.listScheduledPosts()).map((p) => p.message)).toEqual(["later"]);
    expect((await fb.fetchNew(null)).posts.map((p) => p.message)).toEqual(["now"]); // scheduled / preview never show in the feed
    expect(fb.created.map((c) => c.post.mode)).toEqual(["scheduled", "preview", "immediate"]);

    await fb.cancelScheduledPost(scheduled.postId);
    expect(await fb.listScheduledPosts()).toEqual([]);
    expect(fb.cancelled).toEqual([scheduled.postId]);
    await expect(fb.cancelScheduledPost(scheduled.postId)).rejects.toMatchObject({ code: "not_found" });
  });

  it("a reply we send comes back in the next fetch as a comment written by the Page", async () => {
    const fb = new FakeFacebookProvider({ pageId: "pg", now: () => NOW });
    const post = fb.addPost({ message: "p" });
    const c = fb.addComment({ postId: post.id, message: "giá bao nhiêu?", createdTime: at(1) });
    const { replyId } = await fb.replyToComment({ commentId: c.id, message: "Dạ bạn nhắn tin cho page nhé" });
    expect(fb.replies).toEqual([{ commentId: c.id, message: "Dạ bạn nhắn tin cho page nhé", replyId }]);
    const { comments } = await fb.fetchNew(at(0));
    const ours = comments.find((x) => x.id === replyId)!;
    expect(ours).toMatchObject({ parentId: c.id, from: { id: "pg" } });
    await expect(fb.replyToComment({ commentId: "nope", message: "x" })).rejects.toBeInstanceOf(FacebookError);
  });

  it("hideComment records and marks the comment hidden", async () => {
    const fb = new FakeFacebookProvider({ now: () => NOW });
    const post = fb.addPost({ message: "p" });
    const c = fb.addComment({ postId: post.id, message: "spam", createdTime: at(1) });
    await fb.hideComment(c.id);
    expect(fb.hidden).toEqual([c.id]);
    expect((await fb.fetchNew(at(0))).comments[0]!.isHidden).toBe(true);
  });

  it("failNext makes exactly the next call of that operation throw", async () => {
    const fb = new FakeFacebookProvider({ now: () => NOW });
    fb.failNext("createPost", new FacebookError("rate limited", { code: "rate_limit", transient: true }));
    await expect(fb.createPost({ message: "x", mode: "preview" })).rejects.toMatchObject({ code: "rate_limit" });
    await expect(fb.createPost({ message: "x", mode: "preview" })).resolves.toMatchObject({ mode: "preview" });
  });

  it("inspect() works offline and reports every required permission; setInspection changes it", async () => {
    const fb = new FakeFacebookProvider({ pageId: "pg", pageName: "Acme" });
    const r = await fb.inspect();
    expect(r).toMatchObject({ tokenValid: true, page: { id: "pg", name: "Acme" } });
    expect(r.granted).toEqual([...FB_REQUIRED_PERMISSIONS]);
    fb.setInspection({ tokenValid: false, tokenError: "expired" });
    expect(await fb.verify()).toEqual({ ok: false, error: "expired" });
  });
});

describe("createFacebookProvider", () => {
  it("none -> null, fake -> FakeFacebookProvider, graph -> reads the token from the named env var", () => {
    expect(createFacebookProvider({ kind: "none" })).toBeNull();
    expect(createFacebookProvider({ kind: "fake", pageId: "p" })).toBeInstanceOf(FakeFacebookProvider);
    const graph = createFacebookProvider({ kind: "graph", pageId: "1", apiVersion: "v21.0", tokenEnv: "MY_FB_TOKEN" }, { env: { MY_FB_TOKEN: "tok" } });
    expect(graph?.kind).toBe("graph");
    expect(graph?.pageId).toBe("1");
  });

  it("graph without the env var set fails with an auth error that names the variable", () => {
    expect(() => createFacebookProvider({ kind: "graph", pageId: "1", apiVersion: "v21.0" }, { env: {} })).toThrow(/AGYHQ_FB_PAGE_TOKEN/);
    expect(() => createFacebookProvider({ kind: "graph", pageId: "1", apiVersion: "v21.0", tokenEnv: "OTHER" }, { env: {} })).toThrow(/OTHER/);
  });
});
