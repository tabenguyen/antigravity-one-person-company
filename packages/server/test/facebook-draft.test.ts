// fb_draft_post / fb_draft_reply / fb_propose_hide: nothing reaches the outbox except as a pending draft, one draft per
// target, news needs its source, autonomy only ever applies to replies.
import { describe, expect, it } from "vitest";
import { addKb, setupFanpage } from "./facebook-helpers.ts";

const NEWS_URL = "https://baomoi-eval.example/kinh-doanh/tmdt-quy-3.html";

describe("fb_draft_reply", () => {
  it("queues a pending reply with the comment preview in the payload, and nothing is sent", async () => {
    const e = setupFanpage();
    const id = e.ingestComment({ id: "c1", message: "Có hỗ trợ TikTok Shop không?", from: { id: "u1", name: "Lan" } });
    const res = await e.call("fb_draft_reply", { commentId: id, message: "Có bạn nhé, bên mình hỗ trợ TikTok Shop.", reason: "KB: supported channels" });
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ outcome: "created", item: { channel: "facebook_reply", to: "fb:comment:c1", status: "pending_approval", threadKey: "fb:comment:c1" } });
    expect(res.data!.item.payload).toMatchObject({ kind: "reply", commentId: "c1", postId: "post-1", commentText: "Có hỗ trợ TikTok Shop không?", commenterName: "Lan" });
    expect(res.data!.message).toMatch(/NOT posted/);
    expect(e.provider.replies).toHaveLength(0);
    expect(e.db.audit.list({ kind: ["outbox.drafted"] })[0]!.data).toMatchObject({ channel: "facebook_reply" });
  });

  it("a second call in the same task rewrites the pending draft in place (one queue item); once reviewed it is a conflict", async () => {
    const e = setupFanpage();
    const id = e.ingestComment({ id: "c1" });
    const task = e.newTask();
    const first = await e.call("fb_draft_reply", { commentId: id, message: "Dạ có ạ.", reason: "r" }, task);
    const second = await e.call("fb_draft_reply", { commentId: id, message: "Dạ có bạn nhé.", reason: "better" }, task);
    expect(second.data).toMatchObject({ outcome: "updated", item: { id: first.data!.item.id, body: "Dạ có bạn nhé.", revisions: 1 } });
    expect(e.db.outbox.list({ agentId: e.agentId })).toHaveLength(1);

    e.db.outbox.decide(first.data!.item.id, "approved", { decidedBy: "human:ops" });
    const third = await e.call("fb_draft_reply", { commentId: id, message: "Lại nữa.", reason: "r" }, task);
    expect(third.status).toBe(409);
    expect(third.error!.message).toMatch(/already reviewed/);
  });

  it("a comment that already has a live draft refuses another task's draft (duplicate comment, one draft)", async () => {
    const e = setupFanpage();
    const id = e.ingestComment({ id: "c1" });
    expect((await e.call("fb_draft_reply", { commentId: id, message: "Dạ có ạ.", reason: "r" })).status).toBe(200);
    const again = await e.call("fb_draft_reply", { commentId: id, message: "Dạ có ạ!", reason: "r" }, e.newTask());
    expect(again.status).toBe(409);
    expect(again.error!.message).toMatch(/one draft/i);
    expect(e.db.outbox.list({ agentId: e.agentId })).toHaveLength(1);
    expect(e.db.audit.list({ kind: ["outbox.draft_refused"] })[0]!.data).toMatchObject({ reason: "comment_already_drafted" });
  });

  it("a rejected reply does not block a new draft from another task", async () => {
    const e = setupFanpage();
    const id = e.ingestComment({ id: "c1" });
    const first = await e.call("fb_draft_reply", { commentId: id, message: "Dạ có ạ.", reason: "r" });
    e.db.outbox.decide(first.data!.item.id, "rejected", { decidedBy: "human:ops" });
    expect((await e.call("fb_draft_reply", { commentId: id, message: "Dạ có bạn nhé.", reason: "r" }, e.newTask())).status).toBe(200);
  });

  it("refuses unknown comments, the Page's own comments and comments already answered or hidden", async () => {
    const e = setupFanpage();
    expect((await e.call("fb_draft_reply", { commentId: "nope", message: "x", reason: "r" })).status).toBe(404);
    const own = e.ingestComment({ id: "c-own", from: { id: "page-1", name: "Eval Page" } });
    const refused = await e.call("fb_draft_reply", { commentId: own, message: "x", reason: "r" });
    expect(refused.status).toBe(409);
    expect(refused.error!.message).toMatch(/written by the Page/);
    const done = e.ingestComment({ id: "c-done" });
    e.db.facebook.setCommentStatus(done, "replied");
    expect((await e.call("fb_draft_reply", { commentId: done, message: "x", reason: "r" })).error!.message).toMatch(/already answered/);
  });

  it("lint errors refuse the draft: a price that is not in the KB, a refund promise", async () => {
    const e = setupFanpage();
    addKb(e.db, "Gói Nâng cao: 499.000đ/tháng.");
    const id = e.ingestComment({ id: "c1", message: "Giá gói Nâng cao?" });
    const wrongPrice = await e.call("fb_draft_reply", { commentId: id, message: "Gói Nâng cao giá 399.000đ/tháng bạn nhé.", reason: "r" });
    expect(wrongPrice.status).toBe(400);
    expect(wrongPrice.error!.message).toMatch(/Draft NOT created/);
    expect(wrongPrice.error!.message).toMatch(/unknown_price/);
    const refund = await e.call("fb_draft_reply", { commentId: id, message: "Bên mình sẽ hoàn tiền cho bạn.", reason: "r" });
    expect(refund.status).toBe(400);
    expect(refund.error!.message).toMatch(/am_refund_promise/);
    expect(e.db.outbox.list({ agentId: e.agentId })).toHaveLength(0);
    expect(e.db.audit.list({ kind: ["outbox.lint_blocked"] })).toHaveLength(2);

    const ok = await e.call("fb_draft_reply", { commentId: id, message: "Gói Nâng cao là 499.000đ/tháng bạn nhé.", reason: "KB price" });
    expect(ok.status).toBe(200);
    expect(ok.data!.item.lint.filter((f) => f.severity === "error")).toEqual([]);
  });

  it("only the fanpage role may use the tools", async () => {
    const e = setupFanpage();
    e.db.agents.create({ id: "sdr-x", role: "sales-sdr", displayName: "S", model: "m", workspacePath: "/tmp/x", policy: e.db.agents.get(e.agentId)!.policy });
    const task = e.db.tasks.create({ agentId: "sdr-x", kind: "sdr.research_lead", title: "t" });
    const token = e.tokens.issue("sdr-x", task.id);
    const res = await e.app.request("/v1/mcp/fb_propose_hide", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "x-agyhq-agent-id": "sdr-x", "x-agyhq-task-id": task.id, "content-type": "application/json" },
      body: JSON.stringify({ commentId: "c", reason: "r" }),
    });
    expect(res.status).toBe(403);
  });
});

describe("fb_propose_hide", () => {
  it("queues a hide proposal, and a hide and a reply for the same comment exclude each other", async () => {
    const e = setupFanpage();
    const id = e.ingestComment({ id: "c-spam", message: "Kiếm 20tr/ngày, inbox Zalo 0900000000" });
    const task = e.newTask();
    const hide = await e.call("fb_propose_hide", { commentId: id, reason: "quảng cáo kiếm tiền online" }, task);
    expect(hide.data).toMatchObject({ outcome: "created", item: { channel: "facebook_hide", to: "fb:hide:c-spam", status: "pending_approval" } });
    expect(hide.data!.item.payload).toMatchObject({ kind: "hide", commentId: id, reason: "quảng cáo kiếm tiền online" });
    expect(hide.data!.message).toMatch(/NOT hidden/);
    // same task, opposite action: refused
    const reply = await e.call("fb_draft_reply", { commentId: id, message: "Cảm ơn bạn.", reason: "r" }, task);
    expect(reply.status).toBe(409);
    expect(reply.error!.message).toMatch(/hide proposal/);
    expect(e.provider.hidden).toEqual([]);
  });
});

describe("fb_draft_post", () => {
  it("queues a pending post that targets the Page, with the proposed time in the payload", async () => {
    const e = setupFanpage();
    addKb(e.db, "Phiên bản 2.4: chỉnh sửa tồn kho hàng loạt.");
    const res = await e.call("fb_draft_post", { postType: "release", message: "StockSync 2.4: chỉnh sửa tồn kho hàng loạt cho nhiều sản phẩm.", publishAt: "2026-10-07T01:30:00.000Z", reason: "KB: release notes 2.4" });
    expect(res.status).toBe(200);
    expect(res.data!.item).toMatchObject({ channel: "facebook_post", to: "fb:page:page-1", status: "pending_approval" });
    expect(res.data!.item.payload).toMatchObject({ kind: "post", postType: "release", publishAt: "2026-10-07T01:30:00.000Z", sourceUrl: null });
    expect(res.data!.message).toMatch(/only ever SCHEDULED/);
    expect(e.provider.created).toHaveLength(0);
  });

  it("is never auto-approved, not even for an autonomous agent", async () => {
    const e = setupFanpage({ trustTier: "autonomous" });
    e.db.settings.patch({ autonomousRequiresPriorApproval: false });
    const res = await e.call("fb_draft_post", { postType: "tip", message: "Mẹo nhỏ cho tuần này.", reason: "r" });
    expect(res.data!.item.status).toBe("pending_approval");
    const hideId = e.ingestComment({ id: "c-spam" });
    expect((await e.call("fb_propose_hide", { commentId: hideId, reason: "spam" })).data!.item.status).toBe("pending_approval");
  });

  it("news needs the task's source URL, the exact same URL, and the post must quote it", async () => {
    const e = setupFanpage();
    const noSource = e.newTask("fanpage.draft_post", { postType: "news", topic: "tin" });
    const r1 = await e.call("fb_draft_post", { postType: "news", message: "Tin nóng về thương mại điện tử.", sourceUrl: NEWS_URL, reason: "r" }, noSource);
    expect(r1.status).toBe(400);
    expect(r1.error!.message).toMatch(/no sourceUrl.*nothing may be invented/s);

    const task = e.newTask("fanpage.draft_post", { postType: "news", sourceUrl: NEWS_URL });
    const wrong = await e.call("fb_draft_post", { postType: "news", message: "Tin: https://other.example/x", sourceUrl: "https://other.example/x", reason: "r" }, task);
    expect(wrong.status).toBe(400);
    expect(wrong.error!.message).toMatch(/exactly the URL the task gave/);
    const missing = await e.call("fb_draft_post", { postType: "news", message: "Thương mại điện tử tiếp tục tăng trưởng trong quý III.", sourceUrl: NEWS_URL, reason: "r" }, task);
    expect(missing.status).toBe(400);
    expect(missing.error!.message).toMatch(/news_missing_source/);
    const ok = await e.call("fb_draft_post", { postType: "news", message: `Thương mại điện tử tiếp tục tăng trưởng trong quý III. Nguồn: ${NEWS_URL}`, sourceUrl: NEWS_URL, reason: "news source" }, task);
    expect(ok.status).toBe(200);
    expect(ok.data!.item.payload).toMatchObject({ postType: "news", sourceUrl: NEWS_URL });
  });

  it("refuses statistics the knowledge base does not contain", async () => {
    const e = setupFanpage();
    addKb(e.db, "StockSync đồng bộ tồn kho trong khoảng một phút.");
    const res = await e.call("fb_draft_post", { postType: "feature", message: "StockSync giúp bạn tiết kiệm 80% thời gian và đã có hơn 10.000 khách hàng.", reason: "r" });
    expect(res.status).toBe(400);
    expect(res.error!.message).toMatch(/unsourced_stat/);
    expect(res.error!.message).toMatch(/80%/);
  });

  it("a second draft in the same task rewrites the pending post; another task can queue its own post", async () => {
    const e = setupFanpage();
    const task = e.newTask("fanpage.draft_post");
    const a = await e.call("fb_draft_post", { postType: "tip", message: "Mẹo 1.", reason: "r" }, task);
    const b = await e.call("fb_draft_post", { postType: "tip", message: "Mẹo 1, viết lại.", reason: "r" }, task);
    expect(b.data).toMatchObject({ outcome: "updated", item: { id: a.data!.item.id } });
    const c = await e.call("fb_draft_post", { postType: "tip", message: "Mẹo 2.", reason: "r" }, e.newTask("fanpage.draft_post"));
    expect(c.data!.outcome).toBe("created");
    expect(e.db.outbox.list({ agentId: e.agentId })).toHaveLength(2);
  });
});

describe("autonomous replies", () => {
  it("auto-approves a reply only once a human has approved and sent one of the agent's replies", async () => {
    const e = setupFanpage({ trustTier: "autonomous" });
    const c1 = e.ingestComment({ id: "c1" });
    const first = await e.call("fb_draft_reply", { commentId: c1, message: "Dạ có ạ.", reason: "r" });
    expect(first.data!.item.status).toBe("pending_approval"); // no human-approved sent reply yet

    e.db.outbox.decide(first.data!.item.id, "approved", { decidedBy: "human:ops" });
    e.db.outbox.decide(first.data!.item.id, "sending");
    e.db.outbox.decide(first.data!.item.id, "sent", { sentAt: e.clock.now.toISOString() });
    const c2 = e.ingestComment({ id: "c2" });
    const second = await e.call("fb_draft_reply", { commentId: c2, message: "Dạ có bạn nhé.", reason: "r" });
    expect(second.data!.item).toMatchObject({ status: "approved", decidedBy: "policy:autonomous" });
  });

  it("with autonomousRequiresPriorApproval off, an autonomous agent's reply is approved at once", async () => {
    const e = setupFanpage({ trustTier: "autonomous" });
    e.db.settings.patch({ autonomousRequiresPriorApproval: false });
    const c1 = e.ingestComment({ id: "c1" });
    expect((await e.call("fb_draft_reply", { commentId: c1, message: "Dạ có ạ.", reason: "r" })).data!.item.status).toBe("approved");
  });
});
