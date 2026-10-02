import { describe, expect, it } from "vitest";
import { extractMoney, lintDraft, type LintContext } from "../src/quality/lint.ts";

const codes = (subject: string, body: string, ctx: LintContext = {}) => lintDraft({ subject, body }, { hasPriorThread: true, ...ctx }).map((f) => f.code);
const GOOD_BODY = "Hi Lan, saw your stores sell on two channels. Worth a 15 minute call this week?";

describe("lintDraft: clean draft", () => {
  it("returns no findings for a short, specific draft with a question", () => {
    expect(lintDraft({ subject: "Stock sync across channels", body: GOOD_BODY }, { contact: { name: "Lan Nguyen", language: "en" }, hasPriorThread: false })).toEqual([]);
  });
});

describe("placeholder", () => {
  it.each([
    ["Hi {{firstName}}, quick question?", "{{firstName}}"],
    ["Hi [Name], quick question?", "[Name]"],
    ["Hello <company> team, quick question?", "<company>"],
    ["TODO fill this in. Quick question?", "TODO"],
    ["Hi XXX, quick question?", "XXX"],
    ["Lorem ipsum dolor sit amet. Quick question?", "Lorem ipsum"],
    ["Hi {first_name}, quick question?", "{first_name}"],
  ])("flags %s as an error", (body, token) => {
    const f = lintDraft({ subject: "Hello", body }, { hasPriorThread: true }).find((x) => x.code === "placeholder");
    expect(f?.severity).toBe("error");
    expect(f?.message).toContain(token);
  });

  it("flags placeholders in the subject too", () => {
    expect(codes("Hi {{name}}", GOOD_BODY)).toContain("placeholder");
  });

  it("does not flag markdown links, footnotes, autolinks, html tags or normal brackets", () => {
    const body = "See [our docs](https://example.com/docs) [1] and <https://example.com> or <b>bold</b>. Worth a call?";
    expect(codes("Hello", body)).not.toContain("placeholder");
  });
});

describe("extractMoney", () => {
  it.each([
    ["Gói 1.500.000đ/tháng", "1500000:vnd"],
    ["chỉ 1.500.000 đồng", "1500000:vnd"],
    ["khoảng 1,5 triệu", "1500000:vnd"],
    ["20 triệu một năm", "20000000:vnd"],
    ["500k/tháng", "500000:vnd"],
    ["500k đ", "500000:vnd"],
    ["VND 2,000,000", "2000000:vnd"],
    ["99 VNĐ", "99:vnd"],
    ["only $99/month", "99:usd"],
    ["$1,200.50", "1200.5:usd"],
    ["99 USD", "99:usd"],
    ["giảm 30%", "pct:30"],
    ["20% off", "pct:20"],
    ["15% discount", "pct:15"],
    ["a discount of 10%", "pct:10"],
    ["2tr", "2000000:vnd"],
  ])("extracts %s", (text, key) => {
    expect(extractMoney(text).map((m) => m.key)).toContain(key);
  });

  it.each([
    "Chỉ mất 2 phút",
    "a 15-minute call",
    "100 khách hàng đang dùng",
    "10 users and 5 stores",
    "Meet at 10:30 on 12/05",
    "đánh giá 5 đêm liền",
    "over 20k followers",
    "100% satisfied customers",
  ])("does not treat %s as a price", (text) => {
    expect(extractMoney(text)).toEqual([]);
  });
});

describe("unknown_price", () => {
  const kb = "# Pricing\nGói Growth: 1.500.000đ/tháng. Plan Pro costs $99/month, annual 20% off.\n| Starter | 500.000 |";

  it("errors on amounts that are not in the KB", () => {
    const f = lintDraft({ subject: "Giá", body: "Gói của bên em chỉ 2 triệu/tháng, anh có rảnh không?" }, { hasPriorThread: true, kbText: kb }).find((x) => x.code === "unknown_price");
    expect(f?.severity).toBe("error");
    expect(f?.message).toContain("2 triệu");
  });

  it("errors when there is no KB text at all", () => {
    expect(codes("Price", "It is $49 per seat. Worth a call?")).toContain("unknown_price");
  });

  it("passes a verbatim KB price", () => {
    expect(codes("Giá", "Gói Growth 1.500.000đ/tháng, anh có muốn xem demo không?", { kbText: kb })).not.toContain("unknown_price");
  });

  it("passes the same amount written in another Vietnamese format", () => {
    expect(codes("Giá", "Gói Growth khoảng 1,5 triệu mỗi tháng, anh có muốn xem demo không?", { kbText: kb })).not.toContain("unknown_price");
  });

  it("passes a bare KB table number written with a currency in the draft", () => {
    expect(codes("Giá", "Gói Starter chỉ 500.000đ, anh thử không?", { kbText: kb })).not.toContain("unknown_price");
    expect(codes("Giá", "Gói Starter chỉ 500k đ, anh thử không?", { kbText: kb })).not.toContain("unknown_price");
  });

  it("passes KB-grounded dollars and percentage discounts", () => {
    expect(codes("Pricing", "Pro is $99 a month and 20% off annually. Interested?", { kbText: kb })).not.toContain("unknown_price");
    expect(codes("Pricing", "Giảm 20% nếu trả theo năm, anh quan tâm không?", { kbText: kb })).not.toContain("unknown_price");
  });

  it("flags a discount the KB never published", () => {
    expect(codes("Offer", "I can give you 50% off if you sign today. Interested?", { kbText: kb })).toContain("unknown_price");
  });

  it("accepts a lazy kbText function and only calls it when money is present", () => {
    let calls = 0;
    const ctx: LintContext = { hasPriorThread: true, kbText: () => (calls++, kb) };
    lintDraft({ subject: "Hi", body: "Chỉ mất 2 phút để thử, anh rảnh không?" }, ctx);
    expect(calls).toBe(0);
    lintDraft({ subject: "Hi", body: "Chỉ 1.500.000đ/tháng, anh rảnh không?" }, ctx);
    expect(calls).toBe(1);
  });
});

describe("forbidden_claim", () => {
  const profile = { forbiddenClaims: "# Never say\n- We are the cheapest\n* \"Number one in Vietnam\"\n- Cam kết hoàn tiền\n\n" };

  it("flags forbidden phrases (case and diacritic insensitive)", () => {
    const f = lintDraft({ subject: "Hi", body: "We are THE CHEAPEST option, want to talk?" }, { hasPriorThread: true, profile }).find((x) => x.code === "forbidden_claim");
    expect(f?.severity).toBe("error");
    expect(codes("Hi", "Chúng tôi cam ket hoan tien. Anh rảnh không?", { profile })).toContain("forbidden_claim");
  });

  it("matches quoted phrases inside longer rules", () => {
    expect(codes("Hi", "We are number one in Vietnam. Free to talk?", { profile })).toContain("forbidden_claim");
    const p2 = { forbiddenClaims: 'Never say "guaranteed ROI" to prospects' };
    expect(codes("Hi", "We deliver guaranteed ROI. Free to talk?", { profile: p2 })).toContain("forbidden_claim");
  });

  it("ignores headings and does not fire on clean text", () => {
    expect(codes("Hi", "Never mind the weather. Worth a call?", { profile })).not.toContain("forbidden_claim");
    expect(codes("Hi", GOOD_BODY, { profile: { forbiddenClaims: null } })).not.toContain("forbidden_claim");
  });
});

describe("ai_self_reference", () => {
  it.each([
    "Dạ em là trợ lý AI của NK Invoice nên không hỗ trợ viết code được ạ. Anh cần thêm gì không ạ?",
    "Em được thiết kế chuyên biệt để tư vấn hóa đơn. Anh cần thêm gì không ạ?",
    "Bên em có trợ lý ảo hỗ trợ 24/7, anh hỏi gì cũng được ạ?",
    "Hi Lan, as an AI I can't write code. Want to pick up the stock sync question?",
    "Hi Lan, I'm an AI assistant for the sales team. Worth a call?",
    "Theo Hard Rule 6 em không làm được việc này. Anh rảnh không?",
    "Email này được gửi tự động. Anh rảnh không?",
  ])("blocks %s", (body) => {
    const f = lintDraft({ subject: "Re: Liên hệ", body }, { hasPriorThread: true }).find((x) => x.code === "ai_self_reference");
    expect(f?.severity).toBe("error");
  });

  it.each([
    "NK Risk AI đánh giá rủi ro công ty bán và giải thích kết quả. Anh muốn xem thử không?",
    "Phần mềm được thiết kế để thu thập hóa đơn qua email. Anh rảnh trao đổi không?",
    "Em là Mai, phụ trách tư vấn bên NK Invoice. Anh cần em hỗ trợ gì thêm không ạ?",
    "Anh cho em hỏi ai là người phụ trách kế toán bên mình ạ?",
    "Our AI-powered risk check explains each result. Worth a call?",
  ])("allows %s", (body) => {
    expect(codes("Re: Liên hệ", body)).not.toContain("ai_self_reference");
  });
});

describe("guarantee_language", () => {
  it.each(["We guarantee results.", "100% success rate.", "Cam kết 100% hài lòng.", "It is risk-free.", "There is no risk at all."])("warns on %s", (sentence) => {
    const f = lintDraft({ subject: "Hi", body: `${sentence} Worth a call?` }, { hasPriorThread: true }).find((x) => x.code === "guarantee_language");
    expect(f?.severity).toBe("warn");
  });

  it("does not warn on ordinary wording", () => {
    expect(codes("Hi", "We can help reduce overselling. Worth a call?")).not.toContain("guarantee_language");
  });
});

describe("length rules", () => {
  const words = (n: number) => `${Array.from({ length: n }, (_, i) => `w${i}`).join(" ")}?`;

  it("first touch: warns above 180 words, not at 180", () => {
    expect(codes("Hi", words(180), { hasPriorThread: false })).not.toContain("too_long");
    expect(codes("Hi", words(181), { hasPriorThread: false })).toContain("too_long");
  });

  it("follow-ups: only warns above 250 words", () => {
    expect(codes("Hi", words(200), { hasPriorThread: true })).not.toContain("too_long");
    expect(codes("Hi", words(251), { hasPriorThread: true })).toContain("too_long");
  });

  it("ignores quoted reply lines when counting", () => {
    const quoted = Array.from({ length: 60 }, () => "> " + "word ".repeat(10)).join("\n");
    expect(codes("Re: hi", `Sounds good?\n${quoted}`)).not.toContain("too_long");
  });

  it("subject_too_long above 70 characters", () => {
    expect(codes("a".repeat(70), GOOD_BODY)).not.toContain("subject_too_long");
    expect(codes("a".repeat(71), GOOD_BODY)).toContain("subject_too_long");
  });
});

describe("subject_spammy", () => {
  it.each(["BUY NOW before it ends", "Get it NOW, ACT fast", "Great offer!!!", "FREE audit for your store", "Miễn phí 100% tháng đầu", "A 100% free trial", "Act now, hurry", "Earn $$$ fast"])("warns on %s", (subject) => {
    expect(codes(subject, GOOD_BODY)).toContain("subject_spammy");
  });

  it.each(["Stock sync across channels", "Câu hỏi nhanh về kho hàng", "CRM for Hanoi Fashion", "Quick question, Lan?", "Hướng dẫn tải file XML từ PDF hóa đơn"])("does not warn on %s", (subject) => {
    expect(codes(subject, GOOD_BODY)).not.toContain("subject_spammy");
  });
});

describe("no_cta / multiple_links", () => {
  it("warns when there is no question, link or ask", () => {
    expect(codes("Hi", "We sell inventory software. It syncs stock.")).toContain("no_cta");
  });

  it("is satisfied by a question mark (also Vietnamese)", () => {
    expect(codes("Hi", "Anh có thể trao đổi 15 phút tuần này không?")).not.toContain("no_cta");
  });

  it("is satisfied by CTA verbs", () => {
    expect(codes("Hi", "Reply with a time that works.")).not.toContain("no_cta");
    expect(codes("Hi", "Anh vui lòng liên hệ lại với em nhé.")).not.toContain("no_cta");
    expect(codes("Hi", "Cho mình biết khung giờ phù hợp nhé.")).not.toContain("no_cta");
  });

  it("is satisfied by the profile meeting link or a known booking host", () => {
    const profile = { meetingLink: "https://cal.example.com/acme" };
    expect(codes("Hi", "Book here: https://cal.example.com/acme", { profile })).not.toContain("no_cta");
    expect(codes("Hi", "Slots at https://calendly.com/acme/15min")).not.toContain("no_cta");
  });

  it("is skipped for the chief-of-staff role", () => {
    expect(codes("Hi", "Summary of the week is attached.", { role: "chief-of-staff" })).not.toContain("no_cta");
  });

  it("warns on more than 2 distinct links", () => {
    const three = "See https://a.example.com and https://b.example.com and https://c.example.com. Worth a call?";
    expect(codes("Hi", three)).toContain("multiple_links");
    const two = "See https://a.example.com and https://b.example.com. Worth a call?";
    expect(codes("Hi", two)).not.toContain("multiple_links");
    const repeated = "https://a.example.com https://a.example.com https://a.example.com. Worth a call?";
    expect(codes("Hi", repeated)).not.toContain("multiple_links");
  });
});

describe("missing_greeting_name", () => {
  it("is info when the known name is not used", () => {
    const f = lintDraft({ subject: "Hi", body: "Hello there. Worth a call?" }, { hasPriorThread: true, contact: { name: "Nguyễn Văn Lan" } }).find((x) => x.code === "missing_greeting_name");
    expect(f?.severity).toBe("info");
  });

  it("is satisfied by any name token, with or without diacritics", () => {
    const ctx = { contact: { name: "Nguyễn Văn Lan" } };
    expect(codes("Hi", "Chào anh Lan, anh rảnh không?", ctx)).not.toContain("missing_greeting_name");
    expect(codes("Hi", "Chao Nguyen, anh ranh khong?", ctx)).not.toContain("missing_greeting_name");
  });

  it("does not fire without a contact name, or on partial-word matches", () => {
    expect(codes("Hi", "Hello there. Worth a call?", { contact: { name: null } })).not.toContain("missing_greeting_name");
    expect(codes("Hi", "Hello Island. Worth a call?", { contact: { name: "Lan" } })).toContain("missing_greeting_name");
  });
});

describe("language_mismatch", () => {
  const en = "Hello, we help online stores keep stock in sync across the channels that you sell on, and we would like to share how.";
  const vi = "Chào anh Lan, bên em giúp các cửa hàng online đồng bộ tồn kho giữa các kênh bán hàng. Anh có thể dành 15 phút trao đổi không ạ?";

  it("warns when a Vietnamese contact gets an English email", () => {
    expect(codes("Hi", en, { contact: { language: "vi" } })).toContain("language_mismatch");
    expect(codes("Hi", en, { contact: { language: "vi-VN" } })).toContain("language_mismatch");
  });

  it("warns when an English contact gets a Vietnamese email", () => {
    expect(codes("Hi", vi, { contact: { language: "en" } })).toContain("language_mismatch");
  });

  it("passes matching languages and mixed-in product names", () => {
    expect(codes("Hi", vi, { contact: { language: "vi" } })).not.toContain("language_mismatch");
    expect(codes("Hi", en + " Nguyễn", { contact: { language: "en" } })).not.toContain("language_mismatch");
    expect(codes("Hi", "Chào anh, bên em có tích hợp Shopee, Lazada và Shopify. Anh rảnh không?", { contact: { language: "vi" } })).not.toContain("language_mismatch");
  });

  it("skips unknown languages, no contact and very short bodies", () => {
    expect(codes("Hi", en, { contact: { language: "fr" } })).not.toContain("language_mismatch");
    expect(codes("Hi", en, {})).not.toContain("language_mismatch");
    expect(codes("Hi", "Hello. Free?", { contact: { language: "vi" } })).not.toContain("language_mismatch");
  });
});

describe("deceptive_subject", () => {
  it("errors on Re:/Fwd: with no prior thread", () => {
    for (const s of ["Re: our call", "RE: our call", "Fwd: intro", "fw: intro"]) {
      const f = lintDraft({ subject: s, body: GOOD_BODY }, { hasPriorThread: false }).find((x) => x.code === "deceptive_subject");
      expect(f?.severity).toBe("error");
    }
  });

  it("allows Re: when there is a prior thread, and ignores 'Re' inside words", () => {
    expect(codes("Re: our call", GOOD_BODY, { hasPriorThread: true })).not.toContain("deceptive_subject");
    expect(lintDraft({ subject: "Reply needed on stock", body: GOOD_BODY }, { hasPriorThread: false }).map((f) => f.code)).not.toContain("deceptive_subject");
  });
});

describe("ordering", () => {
  it("lists errors before warnings before info", () => {
    const f = lintDraft({ subject: "FREE!!!", body: "Hi [Name]. We guarantee it." }, { hasPriorThread: true, contact: { name: "Lan" } });
    const sev = f.map((x) => x.severity);
    expect(sev).toEqual([...sev].sort((a, b) => ["error", "warn", "info"].indexOf(a) - ["error", "warn", "info"].indexOf(b)));
    expect(sev[0]).toBe("error");
  });
});

describe("price grounding ignores 'don't quote X' lines", () => {
  it("a price mentioned only in a negated instruction is still unknown", async () => {
    const { groundingText } = await import("../src/quality/lint-context.ts");
    const kb = groundingText(
      [
        "Gói SME 12 tháng: 600.000đ cho 2.000 hóa đơn (chưa gồm VAT).",
        "Không báo giá theo các gói thuê bao tháng cũ (50.000đ, 129.000đ, 249.000đ).",
        "Never quote the legacy $49/mo plan.",
      ].join("\n"),
    );
    const listed = lintDraft({ subject: "Giá", body: "Gói SME là 600.000đ cho 12 tháng, anh rảnh không?" }, { hasPriorThread: true, kbText: kb });
    expect(listed.map((f) => f.code)).not.toContain("unknown_price");
    for (const body of ["Gói cơ bản chỉ 50.000đ/tháng, anh rảnh không?", "Only $49/mo — want a demo?"]) {
      const f = lintDraft({ subject: "Giá", body }, { hasPriorThread: true, kbText: kb });
      expect(f.map((x) => x.code), body).toContain("unknown_price");
    }
  });
});
