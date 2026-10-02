import { describe, expect, it } from "vitest";
import { classifyEmail, extractReplyText, newMessageId, normalizeMessageId, parseRawEmail, FakeEmailProvider } from "@agyhq/channels";

describe("ids", () => {
  it("newMessageId produces unique ids without angle brackets", () => {
    const a = newMessageId("acme.com");
    const b = newMessageId("acme.com");
    expect(a).not.toContain("<");
    expect(a).not.toContain(">");
    expect(a.endsWith("@acme.com")).toBe(true);
    expect(a).not.toBe(b);
  });

  it("normalizeMessageId strips angle brackets and handles null", () => {
    expect(normalizeMessageId("<abc@x.com>")).toBe("abc@x.com");
    expect(normalizeMessageId("abc@x.com")).toBe("abc@x.com");
    expect(normalizeMessageId(null)).toBeNull();
    expect(normalizeMessageId("  ")).toBeNull();
  });
});

describe("parseRawEmail", () => {
  it("parses headers, plain body and threading headers", async () => {
    const raw = [
      "Message-ID: <reply1@mail.example>",
      "In-Reply-To: <orig1@mail.example>",
      "References: <orig0@mail.example> <orig1@mail.example>",
      "From: Jane Doe <jane@acme.com>",
      "To: Mai <mai@ourco.example>",
      "Subject: Re: Hello",
      "Date: Mon, 01 Sep 2025 10:00:00 +0000",
      "",
      "Sounds interesting — can you do Tuesday?",
      "",
      "On Mon, Sep 1, 2025 Mai wrote:",
      "> original message text",
    ].join("\r\n");

    const parsed = await parseRawEmail(raw, "fixture-1");
    expect(parsed.providerId).toBe("fixture-1");
    expect(parsed.messageId).toBe("reply1@mail.example");
    expect(parsed.inReplyTo).toBe("orig1@mail.example");
    expect(parsed.references).toEqual(["orig0@mail.example", "orig1@mail.example"]);
    expect(parsed.from).toEqual({ address: "jane@acme.com", name: "Jane Doe" });
    expect(parsed.subject).toBe("Re: Hello");
    expect(parsed.text).toContain("Sounds interesting");
    expect(parsed.replyText).toBe("Sounds interesting — can you do Tuesday?");
  });

  it("decodes quoted-printable bodies", async () => {
    const raw = [
      "Message-ID: <m1@x.com>",
      "From: a@x.com",
      "To: b@x.com",
      "Subject: s",
      "Content-Transfer-Encoding: quoted-printable",
      "",
      "Caf=C3=A9 time",
    ].join("\r\n");
    const parsed = await parseRawEmail(raw, "fixture-2");
    expect(parsed.text).toBe("Café time");
  });
});

describe("extractReplyText", () => {
  it("strips quoted lines and On...wrote headers", () => {
    const text = ["Sure, Tuesday works.", "", "On Mon, Sep 1, 2025 at 10:00 Mai wrote:", "> original"].join("\n");
    expect(extractReplyText(text)).toBe("Sure, Tuesday works.");
  });

  it("strips signature delimiters", () => {
    const text = ["Thanks!", "--", "Jane Doe", "VP of Ops"].join("\n");
    expect(extractReplyText(text)).toBe("Thanks!");
  });
});

describe("classifyEmail", () => {
  function msg(overrides: Partial<Parameters<typeof classifyEmail>[0]> = {}) {
    return {
      providerId: "1",
      messageId: "m1@x.com",
      inReplyTo: null,
      references: [],
      from: { address: "jane@acme.com", name: "Jane" },
      to: [{ address: "sdr@ourco.example", name: null }],
      cc: [],
      replyTo: null,
      subject: "Re: hi",
      date: null,
      text: "Sounds good, talk soon.",
      replyText: "Sounds good, talk soon.",
      headers: {},
      attachments: [],
      ...overrides,
    };
  }

  it("detects an unsubscribe reply (short + keyword)", () => {
    const signals = classifyEmail(msg({ text: "unsubscribe please", replyText: "unsubscribe please" }), {
      ourAddresses: ["sdr@ourco.example"],
    });
    expect(signals.isUnsubscribe).toBe(true);
  });

  it("does not flag a long email that merely mentions unsubscribe (over the length cutoff)", () => {
    const longText = `unsubscribe ${"word ".repeat(120)}`; // > 400 chars
    const signals = classifyEmail(msg({ text: longText, replyText: longText }), { ourAddresses: [] });
    expect(signals.isUnsubscribe).toBe(false);
  });

  it("detects an auto-reply via subject", () => {
    const signals = classifyEmail(msg({ subject: "Out of Office" }), { ourAddresses: [] });
    expect(signals.isAutoReply).toBe(true);
  });

  it("detects an auto-reply via Auto-Submitted header", () => {
    const signals = classifyEmail(msg({ headers: { "auto-submitted": "auto-replied" } }), { ourAddresses: [] });
    expect(signals.isAutoReply).toBe(true);
  });

  it("detects a bounce from mailer-daemon addressed to us", () => {
    const signals = classifyEmail(
      msg({
        from: { address: "mailer-daemon@mail.example", name: null },
        subject: "Delivery Status Notification (Failure)",
        text: "Final-Recipient: rfc822; lead@acme.com\nreason: mailbox full",
      }),
      { ourAddresses: ["sdr@ourco.example"] },
    );
    expect(signals.isBounce).toBe(true);
    expect(signals.bouncedRecipient).toBe("lead@acme.com");
  });

  it("classifies a normal reply as none of the above", () => {
    const signals = classifyEmail(msg(), { ourAddresses: ["sdr@ourco.example"] });
    expect(signals).toEqual({ isAutoReply: false, isBounce: false, bouncedRecipient: null, isUnsubscribe: false, isLikelySpam: false });
  });
});

describe("FakeEmailProvider", () => {
  it("delivers queued messages via fetchNew with an advancing cursor", async () => {
    const provider = new FakeEmailProvider();
    provider.deliver({
      providerId: "1",
      messageId: "m1@x.com",
      inReplyTo: null,
      references: [],
      from: { address: "a@x.com", name: null },
      to: [],
      cc: [],
      replyTo: null,
      subject: "hi",
      date: null,
      text: "hi",
      replyText: "hi",
      headers: {},
      attachments: [],
    });
    const first = await provider.fetchNew(null);
    expect(first.messages).toHaveLength(1);
    const second = await provider.fetchNew(first.cursor);
    expect(second.messages).toHaveLength(0);
  });

  it("records sent emails and can be made to fail once", async () => {
    const provider = new FakeEmailProvider();
    const email = {
      from: { address: "sdr@ourco.example", name: "Mai" },
      to: { address: "lead@acme.com", name: null },
      subject: "hi",
      text: "hi",
      messageId: "m1@ourco.example",
    };
    provider.failNextSend(new Error("smtp timeout"));
    await expect(provider.send(email)).rejects.toThrow("smtp timeout");
    const result = await provider.send(email);
    expect(result.messageId).toBe("m1@ourco.example");
    expect(provider.sent).toHaveLength(1);
  });

  it("verify() returns whatever was configured", async () => {
    const provider = new FakeEmailProvider();
    expect(await provider.verify()).toEqual({ ok: true });
    provider.setVerify({ ok: false, error: "nope" });
    expect(await provider.verify()).toEqual({ ok: false, error: "nope" });
  });
});
