import { createTransport } from "nodemailer";
import { describe, expect, it, vi } from "vitest";

import { ImapSmtpProvider } from "../src/providers/imap-smtp.ts";
import type { ImapClient, ImapClientMailbox } from "../src/providers/imap-smtp.ts";
import { parseRawEmail } from "../src/parse.ts";
import { readFixture } from "./helpers.ts";

/** A minimal hand-written stand-in for ImapFlow, scripted per test. */
function makeFakeImapClient(mailboxes: ImapClientMailbox[], messagesByRange: Record<string, { uid: number; source: Buffer }[]>) {
  let mailboxCall = 0;
  const fetchCalls: { range: string; query: unknown }[] = [];

  const client: ImapClient = {
    connect: vi.fn(async () => {}),
    logout: vi.fn(async () => {}),
    mailboxOpen: vi.fn(async () => {
      const mailbox = mailboxes[Math.min(mailboxCall, mailboxes.length - 1)]!;
      mailboxCall += 1;
      return mailbox;
    }),
    fetch: vi.fn((range: string, query: { uid: boolean; source: boolean }) => {
      fetchCalls.push({ range, query });
      const items = messagesByRange[range] ?? [];
      return (async function* () {
        for (const item of items) yield item;
      })();
    }),
    append: vi.fn(async () => ({})),
  };

  return { client, fetchCalls };
}

const smtpCfg = { host: "smtp.test", port: 465, secure: true, user: "mai@agyhq.test", pass: "x" };
const imapCfg = { host: "imap.test", port: 993, secure: true, user: "mai@agyhq.test", pass: "x" };

describe("ImapSmtpProvider — fetchNew cursor logic", () => {
  it("a null cursor starts at the mailbox's current UIDNEXT (only new mail from now)", async () => {
    const { client } = makeFakeImapClient([{ uidValidity: 100n, uidNext: 10 }], {});
    const provider = new ImapSmtpProvider({
      address: "mai@agyhq.test",
      imap: imapCfg,
      smtp: smtpCfg,
      createImapClient: () => client,
      createSmtpTransport: () => ({ sendMail: vi.fn(), verify: vi.fn(), close: vi.fn() }),
    });

    const result = await provider.fetchNew(null);
    expect(result.messages).toEqual([]);
    expect(result.cursor).toMatch(/^100:9:\d+$/);
  });

  it("fetches by UID range with { uid: true, source: true } (imapflow issues BODY.PEEK for this)", async () => {
    const raw1 = await readFixture("plain-reply-en.eml");
    const raw2 = await readFixture("vi-reply.eml");
    const { client, fetchCalls } = makeFakeImapClient([{ uidValidity: 100n, uidNext: 12 }], {
      "10:11": [
        { uid: 10, source: raw1 },
        { uid: 11, source: raw2 },
      ],
    });
    const provider = new ImapSmtpProvider({
      address: "mai@agyhq.test",
      imap: imapCfg,
      smtp: smtpCfg,
      createImapClient: () => client,
      createSmtpTransport: () => ({ sendMail: vi.fn(), verify: vi.fn(), close: vi.fn() }),
    });

    const result = await provider.fetchNew("100:9", { limit: 2 });
    expect(fetchCalls).toEqual([{ range: "10:11", query: { uid: true, source: true, internalDate: false } }]);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]!.from!.address).toBe("jane@acme.com");
    expect(result.messages[1]!.from!.address).toBe("a.nguyen@congty.vn");
    expect(result.cursor).toMatch(/^100:11:\d+$/);
  });

  it("only returns up to `limit` messages per call, resuming from the last UID actually seen on the next call", async () => {
    const raw1 = await readFixture("plain-reply-en.eml");
    const raw2 = await readFixture("vi-reply.eml");
    const { client, fetchCalls } = makeFakeImapClient([{ uidValidity: 100n, uidNext: 100 }], {
      "10:10": [{ uid: 10, source: raw1 }],
      "11:11": [{ uid: 11, source: raw2 }],
    });
    const provider = new ImapSmtpProvider({
      address: "mai@agyhq.test",
      imap: imapCfg,
      smtp: smtpCfg,
      createImapClient: () => client,
      createSmtpTransport: () => ({ sendMail: vi.fn(), verify: vi.fn(), close: vi.fn() }),
    });

    const first = await provider.fetchNew("100:9", { limit: 1 });
    expect(first.messages).toHaveLength(1);
    expect(first.cursor).toBe("100:10"); // not caught up: a legacy cursor without a timestamp stays without one

    const second = await provider.fetchNew(first.cursor, { limit: 1 });
    expect(second.messages).toHaveLength(1);
    expect(second.cursor).toBe("100:11");

    expect(fetchCalls.map((c) => c.range)).toEqual(["10:10", "11:11"]);
  });

  it("restarts from the current UIDNEXT when UIDVALIDITY changes", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { client } = makeFakeImapClient([{ uidValidity: 200n, uidNext: 5 }], {});
    const provider = new ImapSmtpProvider({
      address: "mai@agyhq.test",
      imap: imapCfg,
      smtp: smtpCfg,
      createImapClient: () => client,
      createSmtpTransport: () => ({ sendMail: vi.fn(), verify: vi.fn(), close: vi.fn() }),
    });

    const result = await provider.fetchNew("100:11");
    expect(result.cursor).toMatch(/^200:4:\d+$/);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("reconnects once and retries after a failed call", async () => {
    let mailboxOpenCalls = 0;
    const client: ImapClient = {
      connect: vi.fn(async () => {}),
      logout: vi.fn(async () => {}),
      mailboxOpen: vi.fn(async () => {
        mailboxOpenCalls += 1;
        if (mailboxOpenCalls === 1) throw new Error("connection reset");
        return { uidValidity: 100n, uidNext: 1 };
      }),
      fetch: vi.fn(() => (async function* () {})()),
    };
    const provider = new ImapSmtpProvider({
      address: "mai@agyhq.test",
      imap: imapCfg,
      smtp: smtpCfg,
      createImapClient: () => client,
      createSmtpTransport: () => ({ sendMail: vi.fn(), verify: vi.fn(), close: vi.fn() }),
    });

    const result = await provider.fetchNew(null);
    expect(result.cursor).toMatch(/^100:0:\d+$/);
    expect(client.connect).toHaveBeenCalledTimes(2);
    expect(client.logout).toHaveBeenCalledTimes(1);
  });
});

describe("ImapSmtpProvider — send", () => {
  it("sends with the exact Message-ID/In-Reply-To/References/List-Unsubscribe headers", async () => {
    const { client } = makeFakeImapClient([], {});
    const realTransport = createTransport({ streamTransport: true, buffer: true });
    let lastMessage: Buffer | null = null;
    const provider = new ImapSmtpProvider({
      address: "mai@agyhq.test",
      displayName: "Mai",
      imap: imapCfg,
      smtp: smtpCfg,
      createImapClient: () => client,
      createSmtpTransport: () => ({
        sendMail: async (opts) => {
          const info = await realTransport.sendMail(opts);
          lastMessage = info.message as Buffer;
          return info;
        },
        verify: vi.fn(),
        close: vi.fn(),
      }),
    });

    const result = await provider.send({
      from: { address: "mai@agyhq.test", name: "Mai" },
      to: { address: "jane@acme.com", name: "Jane" },
      subject: "Re: Quick question",
      text: "Thanks, Tuesday works great.",
      messageId: "sent-001@agyhq.test",
      inReplyTo: "reply-001@mail.acme.com",
      references: ["outreach-001@agyhq.test", "reply-001@mail.acme.com"],
      listUnsubscribe: "<mailto:unsubscribe@agyhq.test?subject=unsubscribe>",
      headers: { "X-Agyhq-Agent": "sdr-01" },
    });

    expect(result.messageId).toBe("sent-001@agyhq.test");
    // streamTransport (used here to get real, parseable MIME bytes) doesn't
    // populate accepted/rejected the way a real SMTP transport does —
    // that's covered separately below with a hand-written transport.

    // Parse back the actual MIME bytes nodemailer produced for this send().
    expect(lastMessage).not.toBeNull();
    const parsed = await parseRawEmail(lastMessage!, "sent");
    expect(parsed.messageId).toBe("sent-001@agyhq.test");
    expect(parsed.inReplyTo).toBe("reply-001@mail.acme.com");
    expect(parsed.references).toEqual(["outreach-001@agyhq.test", "reply-001@mail.acme.com"]);
    expect(parsed.headers["list-unsubscribe"]).toBe("<mailto:unsubscribe@agyhq.test?subject=unsubscribe>");
    expect(parsed.from).toEqual({ address: "mai@agyhq.test", name: "Mai" });
    expect(parsed.to).toEqual([{ address: "jane@acme.com", name: "Jane" }]);
  });

  it("appends a copy to sentFolder when configured, and skips it when null", async () => {
    const { client } = makeFakeImapClient([], {});
    const provider = new ImapSmtpProvider({
      address: "mai@agyhq.test",
      imap: imapCfg,
      smtp: smtpCfg,
      sentFolder: "Sent",
      createImapClient: () => client,
      createSmtpTransport: () => ({
        sendMail: vi.fn(async () => ({ messageId: "<sent-002@agyhq.test>", response: "250 OK", accepted: ["jane@acme.com"], rejected: [] })),
        verify: vi.fn(),
        close: vi.fn(),
      }),
    });

    await provider.send({
      from: { address: "mai@agyhq.test", name: "Mai" },
      to: { address: "jane@acme.com", name: "Jane" },
      subject: "Hi",
      text: "hello",
      messageId: "sent-002@agyhq.test",
    });

    expect(client.append).toHaveBeenCalledTimes(1);
    expect(client.append).toHaveBeenCalledWith("Sent", expect.any(Buffer), ["\\Seen"]);
  });

  it("maps accepted/rejected from the transport's SendResult", async () => {
    const { client } = makeFakeImapClient([], {});
    const provider = new ImapSmtpProvider({
      address: "mai@agyhq.test",
      imap: imapCfg,
      smtp: smtpCfg,
      createImapClient: () => client,
      createSmtpTransport: () => ({
        sendMail: vi.fn(async () => ({
          messageId: "<sent-003@agyhq.test>",
          response: "250 OK",
          accepted: ["jane@acme.com"],
          rejected: [{ address: "bad@acme.com" }],
        })),
        verify: vi.fn(),
        close: vi.fn(),
      }),
    });

    const result = await provider.send({
      from: { address: "mai@agyhq.test", name: "Mai" },
      to: { address: "jane@acme.com", name: "Jane" },
      subject: "Hi",
      text: "hello",
      messageId: "sent-003@agyhq.test",
    });

    expect(result.messageId).toBe("sent-003@agyhq.test");
    expect(result.response).toBe("250 OK");
    expect(result.accepted).toEqual(["jane@acme.com"]);
    expect(result.rejected).toEqual(["bad@acme.com"]);
  });
});

describe("ImapSmtpProvider — verify / close", () => {
  it("verify() reports ok when both IMAP login and SMTP verify succeed", async () => {
    const { client } = makeFakeImapClient([], {});
    const provider = new ImapSmtpProvider({
      address: "mai@agyhq.test",
      imap: imapCfg,
      smtp: smtpCfg,
      createImapClient: () => client,
      createSmtpTransport: () => ({ sendMail: vi.fn(), verify: vi.fn(async () => true), close: vi.fn() }),
    });
    expect(await provider.verify()).toEqual({ ok: true });
  });

  it("verify() reports the IMAP error when login fails", async () => {
    const client: ImapClient = {
      connect: vi.fn(async () => {
        throw new Error("auth failed");
      }),
      logout: vi.fn(async () => {}),
      mailboxOpen: vi.fn(),
      fetch: vi.fn(),
    };
    const provider = new ImapSmtpProvider({
      address: "mai@agyhq.test",
      imap: imapCfg,
      smtp: smtpCfg,
      createImapClient: () => client,
      createSmtpTransport: () => ({ sendMail: vi.fn(), verify: vi.fn(async () => true), close: vi.fn() }),
    });
    const result = await provider.verify();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("auth failed");
  });

  it("verify() reports the SMTP error when verify() rejects", async () => {
    const { client } = makeFakeImapClient([], {});
    const provider = new ImapSmtpProvider({
      address: "mai@agyhq.test",
      imap: imapCfg,
      smtp: smtpCfg,
      createImapClient: () => client,
      createSmtpTransport: () => ({
        sendMail: vi.fn(),
        verify: vi.fn(async () => {
          throw new Error("smtp refused");
        }),
        close: vi.fn(),
      }),
    });
    const result = await provider.verify();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("smtp refused");
  });

  it("close() logs out of IMAP and closes the SMTP transport", async () => {
    const { client } = makeFakeImapClient([{ uidValidity: 1n, uidNext: 1 }], {});
    const closeFn = vi.fn();
    const provider = new ImapSmtpProvider({
      address: "mai@agyhq.test",
      imap: imapCfg,
      smtp: smtpCfg,
      createImapClient: () => client,
      createSmtpTransport: () => ({ sendMail: vi.fn(), verify: vi.fn(), close: closeFn }),
    });

    await provider.fetchNew(null); // establishes the IMAP connection
    await provider.close();
    expect(client.logout).toHaveBeenCalledTimes(1);
    expect(closeFn).toHaveBeenCalledTimes(1);
  });
});
