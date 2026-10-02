import { describe, expect, it } from "vitest";
import { parseRawEmail } from "../src/parse.ts";
import { readFixture } from "./helpers.ts";

describe("parseRawEmail", () => {
  it("maps addresses (lowercased), ids (no angle brackets), and references", async () => {
    const raw = await readFixture("plain-reply-en.eml");
    const email = await parseRawEmail(raw, "uid-1");

    expect(email.providerId).toBe("uid-1");
    expect(email.from).toEqual({ address: "jane@acme.com", name: "Jane Doe" });
    expect(email.to).toEqual([{ address: "mai@agyhq.test", name: "Mai" }]);
    expect(email.messageId).toBe("reply-001@mail.acme.com");
    expect(email.inReplyTo).toBe("outreach-001@agyhq.test");
    expect(email.references).toEqual(["outreach-001@agyhq.test"]);
    expect(email.subject).toBe("Re: Quick question about your SDR tool");
    expect(email.date).toBe(new Date("2024-10-01T09:05:00.000Z").toISOString());
  });

  it("strips quoted history into replyText while keeping the full body in text", async () => {
    const raw = await readFixture("plain-reply-en.eml");
    const email = await parseRawEmail(raw, "uid-1");

    expect(email.text).toContain("Tuesday or Wednesday afternoon");
    expect(email.text).toContain("I noticed Acme has been growing fast");
    expect(email.replyText).toContain("Tuesday or Wednesday afternoon");
    expect(email.replyText).not.toContain("I noticed Acme has been growing fast");
  });

  it("falls back to a generated text body for HTML-only messages", async () => {
    const raw = await readFixture("html-only.eml");
    const email = await parseRawEmail(raw, "uid-2");

    expect(email.text.length).toBeGreaterThan(0);
    expect(email.text).toContain("Thursday");
    expect(email.text).not.toContain("<strong>");
  });

  it("extracts attachments with their decoded content", async () => {
    const raw = await readFixture("plain-reply-en.eml");
    const email = await parseRawEmail(raw, "uid-1");
    expect(email.attachments).toEqual([]);

    const withAtt = await parseRawEmail(await readFixture("reply-with-attachment.eml"), "uid-5");
    expect(withAtt.attachments).toEqual([
      { filename: "hoa-don-mau.pdf", contentType: "application/pdf", size: 52, content: expect.any(Buffer) },
    ]);
    expect(Buffer.from(withAtt.attachments[0]!.content!).subarray(0, 8).toString()).toBe("%PDF-1.4");
    expect(withAtt.text).toContain("invoice template");
  });

  it("extracts only the classification header subset, lowercased", async () => {
    const raw = await readFixture("spam-flagged.eml");
    const email = await parseRawEmail(raw, "uid-3");

    expect(email.headers["x-spam-flag"]).toBe("YES");
    expect(email.headers["x-spam-status"]).toContain("Yes");
    expect(Object.keys(email.headers)).not.toContain("subject");
    expect(Object.keys(email.headers)).not.toContain("date");
  });

  it("captures delivery-status content-type for bounce fixtures", async () => {
    const raw = await readFixture("bounce-dsn.eml");
    const email = await parseRawEmail(raw, "uid-4");
    expect(email.headers["content-type"]).toContain("multipart/report");
    expect(email.from).toEqual({ address: "mailer-daemon@mail.acme.com", name: "Mail Delivery Subsystem" });
  });
});
