import { describe, expect, it } from "vitest";
import { extractReplyText } from "../src/reply-text.ts";
import { parseRawEmail } from "../src/parse.ts";
import { readFixture } from "./helpers.ts";

describe("extractReplyText", () => {
  it("strips a '>' quoted block", () => {
    const text = "New reply here.\n\n> old quoted line 1\n> old quoted line 2\n";
    expect(extractReplyText(text)).toBe("New reply here.");
  });

  it("strips a single-line 'On ... wrote:' Gmail quote", () => {
    const text = "Sounds good!\n\nOn Mon, Jan 1, 2024 at 10:00 AM Jane Doe <jane@acme.com> wrote:\n\n> original message\n";
    expect(extractReplyText(text)).toBe("Sounds good!");
  });

  it("strips a two-line 'On ... / wrote:' Gmail quote", () => {
    const text =
      "Sounds good!\n\nOn Mon, Jan 1, 2024 at 10:00 AM Jane Doe <jane@acme.com>\nwrote:\n\n> original message\n";
    expect(extractReplyText(text)).toBe("Sounds good!");
  });

  it("strips the Vietnamese 'Vào ... đã viết:' quote intro", () => {
    const text = "Cảm ơn bạn!\n\nVào Th 2, 1 thg 1, 2024 vào lúc 10:00 Jane <jane@acme.com> đã viết:\n\n> noi dung cu\n";
    expect(extractReplyText(text)).toBe("Cảm ơn bạn!");
  });

  it("strips an Outlook '-----Original Message-----' block", () => {
    const text = "Looks good, thanks.\n\n-----Original Message-----\nFrom: a@b.com\nSent: Monday\n\nold content";
    expect(extractReplyText(text)).toBe("Looks good, thanks.");
  });

  it("strips an Outlook From/Sent/To/Subject header block without the dashed separator", () => {
    const text = "Approved.\n\nFrom: Bob <bob@x.com>\nSent: Monday, Jan 1\nTo: Me <me@x.com>\nSubject: Hi\n\nold content";
    expect(extractReplyText(text)).toBe("Approved.");
  });

  it("strips a long underscore separator", () => {
    const text = "Reply text.\n\n________________________________\nFrom: old sender\n\nold content";
    expect(extractReplyText(text)).toBe("Reply text.");
  });

  it("strips a '-- ' signature delimiter", () => {
    const text = "My reply.\n\n-- \nJohn Doe\nCEO, Example Inc.";
    expect(extractReplyText(text)).toBe("My reply.");
  });

  it("does not treat a bare mention of 'wrote' as a quote intro", () => {
    const text = "I wrote up the proposal yesterday, let me know what you think.";
    expect(extractReplyText(text)).toBe(text);
  });

  it("never returns empty for a non-empty, fully-quoted input", () => {
    const text = "> only quoted content\n> more quoted content\n";
    const result = extractReplyText(text);
    expect(result.length).toBeGreaterThan(0);
  });

  it("returns an empty string only for empty/whitespace input", () => {
    expect(extractReplyText("")).toBe("");
    expect(extractReplyText("   \n  ")).toBe("");
  });

  it("matches the Gmail-quoted fixture end to end", async () => {
    const raw = await readFixture("plain-reply-en.eml");
    const email = await parseRawEmail(raw, "uid-1");
    expect(email.replyText).toBe(
      "Thanks for reaching out! Yes, I'd love to see a demo sometime next week.\nTuesday or Wednesday afternoon both work for me.\n\nBest,\nJane",
    );
  });

  it("matches the Outlook fixture end to end", async () => {
    const raw = await readFixture("outlook-reply.eml");
    const email = await parseRawEmail(raw, "uid-5");
    expect(email.replyText).toContain("Can you send over a pricing sheet");
    expect(email.replyText).not.toContain("I wanted to reach out about a potential partnership");
  });

  it("matches the Vietnamese fixture end to end", async () => {
    const raw = await readFixture("vi-reply.eml");
    const email = await parseRawEmail(raw, "uid-6");
    expect(email.replyText).toContain("bang gia va");
    expect(email.replyText).not.toContain("đội ngũ sales");
  });
});
