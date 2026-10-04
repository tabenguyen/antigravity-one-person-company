// FacebookSender: every gate the email Sender has (kill switch, quiet hours, rate limit, shadow tier, final guard) and the
// Facebook-specific ones: posts are only ever SCHEDULED (>= lead time ahead), a comment is answered once, nothing is
// sent for a comment that changed meanwhile, a crashed send is never retried blindly.
import { describe, expect, it } from "vitest";
import { FacebookError } from "@agyhq/channels";
import type { OutboxItem } from "@agyhq/core";
import { plannedPublishTime } from "../src/facebook/sender.ts";
import { addKb, setupFanpage, type FanpageEnv } from "./facebook-helpers.ts";

const HOUR = 3_600_000;

async function approvedPost(e: FanpageEnv, extra: Record<string, unknown> = {}): Promise<OutboxItem> {
  addKb(e.db, "Mẹo: đặt tồn kho tối thiểu cao hơn khả năng nhập hàng trong một tuần.");
  const res = await e.call("fb_draft_post", { postType: "tip", message: "Mẹo nhỏ: đặt tồn kho tối thiểu cao hơn khả năng nhập hàng trong một tuần.", reason: "KB", ...extra }, e.newTask("fanpage.draft_post"));
  return e.db.outbox.decide(res.data!.item.id, "approved", { decidedBy: "human:ops" });
}

async function approvedReply(e: FanpageEnv, commentId = "c1"): Promise<OutboxItem> {
  e.ingestComment({ id: commentId });
  const res = await e.call("fb_draft_reply", { commentId, message: "Dạ có bạn nhé.", reason: "KB" });
  return e.db.outbox.decide(res.data!.item.id, "approved", { decidedBy: "human:ops" });
}

describe("plannedPublishTime", () => {
  const now = new Date("2026-10-04T12:00:00.000Z");
  it("is never earlier than now + the lead time, and keeps a later proposed time", () => {
    expect(plannedPublishTime(null, now, 24).toISOString()).toBe("2026-10-05T12:00:00.000Z");
    expect(plannedPublishTime("2026-10-04T13:00:00.000Z", now, 24).toISOString()).toBe("2026-10-05T12:00:00.000Z"); // too early: pushed back
    expect(plannedPublishTime("2026-10-07T01:30:00.000Z", now, 24).toISOString()).toBe("2026-10-07T01:30:00.000Z");
    expect(plannedPublishTime("garbage", now, 24).toISOString()).toBe("2026-10-05T12:00:00.000Z");
  });
});

describe("FacebookSender: posts are only ever scheduled", () => {
  it("schedules an approved post at now + the lead time (never immediately), records the post and the audit row", async () => {
    const e = setupFanpage();
    const item = await approvedPost(e);
    await e.sender().tick();

    expect(e.provider.created).toHaveLength(1);
    const { post, result } = e.provider.created[0]!;
    expect(post.mode).toBe("scheduled"); // never "immediate"
    expect(post.scheduledPublishTime).toBe(new Date(e.clock.now.getTime() + 24 * HOUR).toISOString());
    expect(e.provider.created.some((c) => c.post.mode === "immediate")).toBe(false);

    const sent = e.db.outbox.get(item.id)!;
    expect(sent).toMatchObject({ status: "sent", messageId: result.postId });
    expect(sent.payload).toMatchObject({ fbPostId: result.postId, scheduledPublishTime: post.scheduledPublishTime });
    expect(e.db.facebook.getPost(result.postId)).toMatchObject({ source: "agent", outboxId: item.id, isPublished: false });
    expect(e.db.audit.list({ kind: ["facebook.post_scheduled"] })[0]!.data).toMatchObject({ id: item.id, postId: result.postId });
    expect((await e.provider.listScheduledPosts()).map((p) => p.id)).toEqual([result.postId]);
  });

  it("keeps a later proposed time, and pushes an earlier one back to the lead time", async () => {
    const later = setupFanpage();
    await approvedPost(later, { publishAt: "2026-10-09T01:30:00.000Z" });
    await later.sender().tick();
    expect(later.provider.created[0]!.post.scheduledPublishTime).toBe("2026-10-09T01:30:00.000Z");

    const early = setupFanpage();
    await approvedPost(early, { publishAt: "2026-10-04T12:30:00.000Z" });
    await early.sender().tick();
    expect(early.provider.created[0]!.post.scheduledPublishTime).toBe("2026-10-05T12:00:00.000Z");
  });

  it("a human can move the planned time before approval (PATCH publishAt is stored in the payload)", async () => {
    const e = setupFanpage();
    const item = await approvedPost(e, { publishAt: "2026-10-09T01:30:00.000Z" });
    e.db.outbox.setPayload(item.id, { ...(item.payload as Extract<NonNullable<OutboxItem["payload"]>, { kind: "post" }>), publishAt: "2026-10-12T02:00:00.000Z" });
    await e.sender().tick();
    expect(e.provider.created[0]!.post.scheduledPublishTime).toBe("2026-10-12T02:00:00.000Z");
  });

  it("blocks a post planned more than 75 days ahead instead of failing at Facebook", async () => {
    const e = setupFanpage();
    const item = await approvedPost(e, { publishAt: "2027-03-01T00:00:00.000Z" });
    await e.sender().tick();
    expect(e.provider.created).toHaveLength(0);
    expect(e.db.outbox.get(item.id)).toMatchObject({ status: "blocked" });
    expect(e.db.outbox.get(item.id)!.statusReason).toMatch(/75 days/);
  });
});

describe("FacebookSender: gates", () => {
  it("sends nothing while the kill switch is on, then sends once it is off", async () => {
    const e = setupFanpage();
    await approvedPost(e);
    e.db.settings.patch({ outboundEnabled: false });
    const sender = e.sender();
    await sender.tick();
    expect(e.provider.created).toHaveLength(0);
    e.db.settings.patch({ outboundEnabled: true });
    await sender.tick();
    expect(e.provider.created).toHaveLength(1);
  });

  it("does not send for a shadow-tier agent that was demoted after approval", async () => {
    const e = setupFanpage();
    const item = await approvedReply(e);
    e.db.agents.update(e.agentId, { trustTier: "shadow" });
    await e.sender().tick();
    expect(e.provider.replies).toHaveLength(0);
    expect(e.db.outbox.get(item.id)).toMatchObject({ status: "blocked" });
  });

  it("quiet hours hold replies and hides, but scheduling a post is fine", async () => {
    const e = setupFanpage();
    e.db.settings.patch({ quietHours: { startHour: 0, endHour: 23, timezone: "UTC" } }); // always quiet at 12:00 UTC
    const reply = await approvedReply(e);
    const post = await approvedPost(e);
    const sender = e.sender();
    await sender.tick();
    expect(e.provider.replies).toHaveLength(0);
    expect(e.db.outbox.get(reply.id)!.status).toBe("approved"); // waits
    expect(e.provider.created).toHaveLength(1); // the post was scheduled
    expect(e.db.outbox.get(post.id)!.status).toBe("sent");
    e.db.settings.patch({ quietHours: null });
    await sender.tick();
    expect(e.provider.replies).toHaveLength(1);
  });

  it("honours the hourly rate limit across Facebook items", async () => {
    const e = setupFanpage();
    e.db.settings.patch({ sendRatePerHour: 1 });
    await approvedReply(e, "c1");
    await approvedReply(e, "c2");
    const sender = e.sender();
    await sender.tick();
    await sender.tick();
    expect(e.provider.replies).toHaveLength(1);
  });

  it("an email Sender never claims a Facebook item (and the FacebookSender never claims email)", async () => {
    const e = setupFanpage();
    const reply = await approvedReply(e);
    expect(e.db.outbox.claimNextToSend()).toBeNull(); // default = email
    const email = e.db.outbox.createDraft({ agentId: e.agentId, channel: "email", to: "a@b.co", subject: "s", body: "b", reason: "r" });
    e.db.outbox.decide(email.id, "approved", {});
    await e.sender().tick();
    expect(e.db.outbox.get(reply.id)!.status).toBe("sent");
    expect(e.db.outbox.get(email.id)!.status).toBe("approved");
  });
});

describe("FacebookSender: replies and hides", () => {
  it("posts the reply, stores the reply mapping and marks the comment replied", async () => {
    const e = setupFanpage();
    const item = await approvedReply(e);
    await e.sender().tick();
    expect(e.provider.replies).toEqual([{ commentId: "c1", message: "Dạ có bạn nhé.", replyId: expect.any(String) }]);
    const replyId = e.provider.replies[0]!.replyId;
    expect(e.db.outbox.get(item.id)).toMatchObject({ status: "sent", messageId: replyId });
    expect(e.db.facebook.repliesTo("c1")).toMatchObject([{ replyId, outboxId: item.id }]);
    expect(e.db.facebook.getComment("c1")!.status).toBe("replied");
    expect(e.db.audit.list({ kind: ["facebook.replied"] })).toHaveLength(1);
  });

  it("a comment that already has our reply is blocked, never answered twice", async () => {
    const e = setupFanpage();
    const item = await approvedReply(e);
    e.db.facebook.recordReply({ replyId: "someone-elses-edit", commentId: "c1", outboxId: null });
    await e.sender().tick();
    expect(e.provider.replies).toHaveLength(0);
    expect(e.db.outbox.get(item.id)).toMatchObject({ status: "blocked" });
    expect(e.db.outbox.get(item.id)!.statusReason).toMatch(/already has a reply/);
  });

  it("hides the comment for an approved proposal and marks it hidden; a hidden comment is not replied to", async () => {
    const e = setupFanpage();
    e.ingestComment({ id: "c-spam" });
    const hide = (await e.call("fb_propose_hide", { commentId: "c-spam", reason: "quảng cáo" })).data!.item;
    e.db.outbox.decide(hide.id, "approved", { decidedBy: "human:ops" });
    await e.sender().tick();
    expect(e.provider.hidden).toEqual(["c-spam"]);
    expect(e.db.facebook.getComment("c-spam")!.status).toBe("hidden");
    expect(e.db.outbox.get(hide.id)!.status).toBe("sent");
    expect(e.db.audit.list({ kind: ["facebook.hidden"] })).toHaveLength(1);
  });

  it("blocks a reply whose comment turned out to be the Page's own", async () => {
    const e = setupFanpage();
    const item = await approvedReply(e);
    e.db.facebook.setCommentStatus("c1", "own", "written by the Page itself");
    await e.sender().tick();
    expect(e.db.outbox.get(item.id)).toMatchObject({ status: "blocked" });
    expect(e.provider.replies).toHaveLength(0);
  });
});

describe("FacebookSender: failures", () => {
  it("retries a transient failure (rate limit) with backoff and then succeeds", async () => {
    const e = setupFanpage();
    const item = await approvedReply(e);
    e.provider.failNext("replyToComment", new FacebookError("slow down", { code: "rate_limit", transient: true }));
    const sender = e.sender();
    await sender.tick();
    expect(e.db.outbox.get(item.id)).toMatchObject({ status: "approved", attempts: 1 });
    expect(e.provider.replies).toHaveLength(0);
    sender.clearBackoff(item.id);
    await sender.tick();
    expect(e.db.outbox.get(item.id)!.status).toBe("sent");
  });

  it("fails an item on a permanent error with the typed message, and a human can retry it", async () => {
    const e = setupFanpage();
    const item = await approvedReply(e);
    e.provider.failNext("replyToComment", new FacebookError("(#200) Requires pages_manage_engagement permission", { code: "permission" }));
    await e.sender().tick();
    expect(e.db.outbox.get(item.id)).toMatchObject({ status: "failed", attempts: 1 });
    expect(e.db.outbox.get(item.id)!.statusReason).toMatch(/pages_manage_engagement/);
    expect(e.db.audit.list({ kind: ["outbox.failed"] })).toHaveLength(1);
  });

  it("an item left 'sending' by a crash is failed (never silently re-sent) so a human checks the Page first", async () => {
    const e = setupFanpage();
    const item = await approvedReply(e);
    e.db.outbox.claimNextToSend(["facebook_reply"]); // approved -> sending, then the daemon "dies"
    expect(e.db.outbox.recoverSending()).toEqual([]); // the email recovery leaves Facebook items alone
    const sender = e.sender();
    sender.start();
    sender.stop();
    expect(e.db.outbox.get(item.id)).toMatchObject({ status: "failed" });
    expect(e.db.outbox.get(item.id)!.statusReason).toMatch(/check the Page/);
    expect(e.provider.replies).toHaveLength(0);
  });
});
