import { describe, expect, it } from "vitest";
import { findUnsourcedStats, lintFanpageDraft, mentionsUrl, normalizeUrl } from "../src/quality/fanpage-lint.ts";
import { lintFacebookDraft, lintOutboxItem } from "../src/quality/lint-context.ts";
import { addKb, setupFanpage } from "./facebook-helpers.ts";

const codes = (f: { code: string }[]) => f.map((x) => x.code);

describe("urls", () => {
  it("normalizes scheme, www, query, fragment and trailing slash", () => {
    expect(normalizeUrl("https://www.VnExpress.net/a-1.html?x=1#top")).toBe("vnexpress.net/a-1.html");
    expect(normalizeUrl("http://site.vn/path/")).toBe("site.vn/path");
  });
  it("finds the source in the text however it is written", () => {
    expect(mentionsUrl("Nguồn: https://www.vnexpress.net/a-1.html?utm=x", "https://vnexpress.net/a-1.html")).toBe(true);
    expect(mentionsUrl("Nguồn: vnexpress.net/a-1.html/", "https://vnexpress.net/a-1.html")).toBe(true);
    expect(mentionsUrl("Nguồn: vnexpress.net/b-2.html", "https://vnexpress.net/a-1.html")).toBe(false);
  });
});

describe("findUnsourcedStats", () => {
  const kb = "Tiết kiệm 40% thời gian nhập liệu. Hiện có 1.200 khách hàng. CSV tối đa 5.000 dòng.";
  it("passes figures the KB contains, in either number format", () => {
    expect(findUnsourcedStats("Giảm 40% thời gian, với 1.200 khách hàng", kb)).toEqual([]);
    expect(findUnsourcedStats("1200 khách hàng tin dùng", kb)).toEqual([]);
  });
  it("flags percentages and customer counts the KB does not contain", () => {
    expect(findUnsourcedStats("Tăng 80% hiệu suất", kb)).toEqual(["80%"]);
    expect(findUnsourcedStats("Hơn 10.000 khách hàng", kb)).toEqual(["10.000 khách hàng"]);
    expect(findUnsourcedStats("Nhanh hơn 4% và 5 khách hàng", "")).toEqual(["4%"]); // a single-digit count is not a claim
  });
  it("does not confuse 4% with 40%", () => {
    expect(findUnsourcedStats("Chỉ 4% thôi", kb)).toEqual(["4%"]);
  });
});

describe("lintFanpageDraft", () => {
  it("news: no source URL is an error; a post that does not quote the URL is an error; quoting it passes", () => {
    expect(codes(lintFanpageDraft({ kind: "post", postType: "news" }, "Tin nóng", ""))).toEqual(["news_missing_source"]);
    expect(codes(lintFanpageDraft({ kind: "post", postType: "news", sourceUrl: "https://a.vn/x" }, "Tin nóng", ""))).toEqual(["news_missing_source"]);
    expect(lintFanpageDraft({ kind: "post", postType: "news", sourceUrl: "https://a.vn/x" }, "Tin nóng. Nguồn: https://a.vn/x", "")).toEqual([]);
    expect(lintFanpageDraft({ kind: "post", postType: "news", sourceUrl: "https://a.vn/x", link: "https://a.vn/x" }, "Tin nóng", "")).toEqual([]);
    expect(lintFanpageDraft({ kind: "post", postType: "tip" }, "Mẹo nhỏ", "")).toEqual([]); // only news needs a source
  });

  it("replies get the Account Manager promise rules; long replies and hashtag piles are warnings", () => {
    expect(codes(lintFanpageDraft({ kind: "reply" }, "Bên mình sẽ hoàn tiền cho bạn nhé.", ""))).toContain("am_refund_promise");
    expect(codes(lintFanpageDraft({ kind: "post", postType: "tip" }, "Bên mình sẽ hoàn tiền", ""))).toEqual([]); // posts are not replies
    const long = lintFanpageDraft({ kind: "reply" }, Array.from({ length: 100 }, () => "chữ").join(" "), "");
    expect(long).toMatchObject([{ code: "fb_reply_too_long", severity: "warn" }]);
    expect(codes(lintFanpageDraft({ kind: "post", postType: "tip" }, "#a #b #c #d #e #f nội dung", ""))).toEqual(["fb_too_many_hashtags"]);
  });
});

describe("lintFacebookDraft / lintOutboxItem (db-backed)", () => {
  it("applies the shared rules: placeholders, ungrounded prices, forbidden claims, AI self-reference; and stays quiet about subject/CTA rules", () => {
    const e = setupFanpage();
    addKb(e.db, "Gói Cơ bản: 199.000đ/tháng.");
    e.db.kv.set("company_profile", { companyName: "X", forbiddenClaims: '- Never say "rẻ nhất thị trường"', meetingLink: null });
    const agent = e.db.agents.get(e.agentId)!;
    const bad = lintFacebookDraft(e.db, { agent, kind: "reply", body: "Gói này 150.000đ, rẻ nhất thị trường, [tên] ơi. Mình là một chatbot." });
    expect(codes(bad)).toEqual(expect.arrayContaining(["placeholder", "unknown_price", "forbidden_claim", "ai_self_reference"]));
    const good = lintFacebookDraft(e.db, { agent, kind: "reply", body: "Gói Cơ bản là 199.000đ/tháng bạn nhé." });
    expect(good).toEqual([]); // no no_cta, no subject rules, no first-touch length warning
  });

  it("re-lints a stored Facebook item by channel (post vs reply) and leaves hide proposals alone", async () => {
    const e = setupFanpage();
    const id = e.ingestComment({ id: "c1" });
    const reply = (await e.call("fb_draft_reply", { commentId: id, message: "Dạ có ạ.", reason: "r" })).data!.item;
    expect(lintOutboxItem(e.db, { ...reply, body: "Bên mình sẽ hoàn tiền nhé." }).map((f) => f.code)).toContain("am_refund_promise");
    const hide = (await e.call("fb_propose_hide", { commentId: e.ingestComment({ id: "c2" }), reason: "spam" })).data!.item;
    expect(lintOutboxItem(e.db, { ...hide, body: "[tên] TODO" })).toEqual([]);
  });
});
