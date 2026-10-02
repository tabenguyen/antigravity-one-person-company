import { describe, expect, it } from "vitest";
import type { ParsedEmail } from "@agyhq/core";
import { classifyEmail } from "../src/classify.ts";
import { parseRawEmail } from "../src/parse.ts";
import { readFixture } from "./helpers.ts";

function makeEmail(overrides: Partial<ParsedEmail> = {}): ParsedEmail {
  return {
    providerId: "1",
    messageId: "m1@x.com",
    inReplyTo: null,
    references: [],
    from: { address: "someone@example.com", name: "Someone" },
    to: [{ address: "mai@agyhq.test", name: "Mai" }],
    cc: [],
    replyTo: null,
    subject: "Re: hello",
    date: new Date().toISOString(),
    text: "hello",
    replyText: "hello",
    headers: {},
    attachments: [],
    ...overrides,
  };
}

const ours = { ourAddresses: ["mai@agyhq.test"] };

describe("classifyEmail — auto-reply", () => {
  it("flags Auto-Submitted values other than 'no'", () => {
    const email = makeEmail({ headers: { "auto-submitted": "auto-replied" } });
    expect(classifyEmail(email, ours).isAutoReply).toBe(true);
  });

  it("does not flag Auto-Submitted: no", () => {
    const email = makeEmail({ headers: { "auto-submitted": "no" } });
    expect(classifyEmail(email, ours).isAutoReply).toBe(false);
  });

  it("flags presence of X-Autoreply / X-Autorespond even with an empty value", () => {
    expect(classifyEmail(makeEmail({ headers: { "x-autoreply": "" } }), ours).isAutoReply).toBe(true);
    expect(classifyEmail(makeEmail({ headers: { "x-autorespond": "" } }), ours).isAutoReply).toBe(true);
  });

  it("flags Precedence: bulk/junk/auto_reply", () => {
    expect(classifyEmail(makeEmail({ headers: { precedence: "bulk" } }), ours).isAutoReply).toBe(true);
    expect(classifyEmail(makeEmail({ headers: { precedence: "junk" } }), ours).isAutoReply).toBe(true);
    expect(classifyEmail(makeEmail({ headers: { precedence: "auto_reply" } }), ours).isAutoReply).toBe(true);
    expect(classifyEmail(makeEmail({ headers: { precedence: "list" } }), ours).isAutoReply).toBe(false);
  });

  it("flags OOO-shaped subjects (en + vi)", () => {
    expect(classifyEmail(makeEmail({ subject: "Out of Office: see you soon" }), ours).isAutoReply).toBe(true);
    expect(classifyEmail(makeEmail({ subject: "Automatic reply: re: demo" }), ours).isAutoReply).toBe(true);
    expect(classifyEmail(makeEmail({ subject: "Auto: delivery notice" }), ours).isAutoReply).toBe(true);
    expect(classifyEmail(makeEmail({ subject: "Trả lời tự động: xin chào" }), ours).isAutoReply).toBe(true);
    expect(classifyEmail(makeEmail({ subject: "Vắng mặt từ văn phòng" }), ours).isAutoReply).toBe(true);
    expect(classifyEmail(makeEmail({ subject: "Re: normal subject" }), ours).isAutoReply).toBe(false);
  });
});

describe("classifyEmail — bounce", () => {
  it("flags mail from mailer-daemon/postmaster and extracts Final-Recipient", () => {
    const email = makeEmail({
      from: { address: "mailer-daemon@mail.acme.com", name: null },
      text: "Final-Recipient: rfc822; nobody@acme.com\nAction: failed",
    });
    const signals = classifyEmail(email, ours);
    expect(signals.isBounce).toBe(true);
    expect(signals.bouncedRecipient).toBe("nobody@acme.com");
  });

  it("flags multipart/report content-type", () => {
    const email = makeEmail({ headers: { "content-type": "multipart/report; report-type=delivery-status" } });
    expect(classifyEmail(email, ours).isBounce).toBe(true);
  });

  it("prefers X-Failed-Recipients over the body when both are present", () => {
    const email = makeEmail({
      from: { address: "postmaster@mail.acme.com", name: null },
      headers: { "x-failed-recipients": "Failed@Acme.com, other@acme.com" },
      text: "Final-Recipient: rfc822; other-in-body@acme.com",
    });
    expect(classifyEmail(email, ours).bouncedRecipient).toBe("failed@acme.com");
  });

  it("never flags mail from one of our own addresses as a bounce", () => {
    const email = makeEmail({ from: { address: "mailer-daemon@mail.acme.com", name: null } });
    expect(classifyEmail(email, { ourAddresses: ["mailer-daemon@mail.acme.com"] }).isBounce).toBe(false);
  });
});

describe("classifyEmail — unsubscribe", () => {
  it("flags a short reply containing an unsubscribe phrase (en)", () => {
    const email = makeEmail({ replyText: "Please unsubscribe me, not interested." });
    expect(classifyEmail(email, ours).isUnsubscribe).toBe(true);
  });

  it("flags Vietnamese unsubscribe phrases", () => {
    expect(classifyEmail(makeEmail({ replyText: "Vui lòng hủy đăng ký giúp tôi." }), ours).isUnsubscribe).toBe(true);
    expect(classifyEmail(makeEmail({ replyText: "Làm ơn ngừng gửi email cho tôi." }), ours).isUnsubscribe).toBe(true);
    expect(classifyEmail(makeEmail({ replyText: "Tôi không muốn nhận thêm email." }), ours).isUnsubscribe).toBe(true);
  });

  it("does not flag a long reply that happens to mention 'stop'", () => {
    const longText = `Please don't stop sending me updates, this is genuinely useful for our team. ${"Lorem ipsum dolor sit amet. ".repeat(15)}`;
    expect(longText.length).toBeGreaterThan(400);
    expect(classifyEmail(makeEmail({ replyText: longText }), ours).isUnsubscribe).toBe(false);
  });

  it("does not flag a short reply with no unsubscribe language", () => {
    expect(classifyEmail(makeEmail({ replyText: "Sounds good, talk soon!" }), ours).isUnsubscribe).toBe(false);
  });

  it("never flags mail from one of our own addresses as an unsubscribe request", () => {
    const email = makeEmail({ from: { address: "mai@agyhq.test", name: "Mai" }, replyText: "please unsubscribe me" });
    expect(classifyEmail(email, ours).isUnsubscribe).toBe(false);
  });
});

describe("classifyEmail — spam", () => {
  it("flags X-Spam-Flag: YES", () => {
    expect(classifyEmail(makeEmail({ headers: { "x-spam-flag": "YES" } }), ours).isLikelySpam).toBe(true);
  });

  it("does not flag when the header is absent or not YES", () => {
    expect(classifyEmail(makeEmail(), ours).isLikelySpam).toBe(false);
    expect(classifyEmail(makeEmail({ headers: { "x-spam-flag": "NO" } }), ours).isLikelySpam).toBe(false);
  });
});

describe("classifyEmail — fixtures end to end", () => {
  it("ooo-en.eml is an auto-reply", async () => {
    const email = await parseRawEmail(await readFixture("ooo-en.eml"), "u1");
    expect(classifyEmail(email, ours).isAutoReply).toBe(true);
  });

  it("ooo-vi.eml is an auto-reply", async () => {
    const email = await parseRawEmail(await readFixture("ooo-vi.eml"), "u2");
    expect(classifyEmail(email, ours).isAutoReply).toBe(true);
  });

  it("bounce-dsn.eml is a bounce with the bounced recipient extracted", async () => {
    const email = await parseRawEmail(await readFixture("bounce-dsn.eml"), "u3");
    const signals = classifyEmail(email, ours);
    expect(signals.isBounce).toBe(true);
    expect(signals.bouncedRecipient).toBe("nobody@acme.com");
  });

  it("unsubscribe-en.eml and unsubscribe-vi.eml are unsubscribe requests", async () => {
    const en = await parseRawEmail(await readFixture("unsubscribe-en.eml"), "u4");
    const vi = await parseRawEmail(await readFixture("unsubscribe-vi.eml"), "u5");
    expect(classifyEmail(en, ours).isUnsubscribe).toBe(true);
    expect(classifyEmail(vi, ours).isUnsubscribe).toBe(true);
  });

  it("long-not-unsubscribe.eml is not an unsubscribe request", async () => {
    const email = await parseRawEmail(await readFixture("long-not-unsubscribe.eml"), "u6");
    expect(classifyEmail(email, ours).isUnsubscribe).toBe(false);
  });

  it("spam-flagged.eml is flagged as likely spam", async () => {
    const email = await parseRawEmail(await readFixture("spam-flagged.eml"), "u7");
    expect(classifyEmail(email, ours).isLikelySpam).toBe(true);
  });

  it("plain-reply-en.eml is none of the above", async () => {
    const email = await parseRawEmail(await readFixture("plain-reply-en.eml"), "u8");
    const signals = classifyEmail(email, ours);
    expect(signals).toEqual({ isAutoReply: false, isBounce: false, bouncedRecipient: null, isUnsubscribe: false, isLikelySpam: false });
  });
});
