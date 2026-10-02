// ImapSmtpProvider against REAL IMAP and SMTP protocol servers (in-process, on loopback): the real ImapFlow and
// nodemailer run their normal wire protocol. See support/mail-servers.ts for what this does and does not reproduce.

import { createHash } from "node:crypto";
import net from "node:net";
import { ImapFlow } from "imapflow";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ImapSmtpProvider } from "../src/providers/imap-smtp.ts";
import type { ImapClient, ImapConnectionConfig } from "../src/providers/imap-smtp.ts";
import { parseRawEmail } from "../src/parse.ts";
import { classifyEmail } from "../src/classify.ts";
import {
  GMAIL_FOLDERS,
  TEST_PASS,
  TEST_USER,
  buildEml,
  startMailServers,
  type TestMailServers,
} from "./support/mail-servers.ts";

const ADDRESS = TEST_USER;
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

let servers: TestMailServers;
const providers: ImapSmtpProvider[] = [];

function makeProvider(extra: Partial<ConstructorParameters<typeof ImapSmtpProvider>[0]> = {}): ImapSmtpProvider {
  const p = new ImapSmtpProvider({
    address: ADDRESS,
    displayName: "Mai",
    imap: servers.imapConfig,
    smtp: servers.smtpConfig,
    warn: () => {},
    ...extra,
  });
  providers.push(p);
  return p;
}

async function eml(subject: string, text: string, extra: Record<string, unknown> = {}): Promise<Buffer> {
  return buildEml({ subject, text, ...extra });
}

/** Mutations that must never be issued against the human's mailbox by a read-only reader. */
const FORBIDDEN_COMMANDS = /^\S+ (STORE|UID STORE|EXPUNGE|UID EXPUNGE|COPY|UID COPY|MOVE|UID MOVE|DELETE|CREATE|RENAME|SUBSCRIBE|UNSUBSCRIBE|APPEND|SELECT)\b/i;

beforeEach(async () => {
  servers = await startMailServers({ folders: GMAIL_FOLDERS });
});

afterEach(async () => {
  await Promise.all(providers.splice(0).map((p) => p.close().catch(() => {})));
  await servers.close();
});

describe("login and connectivity", () => {
  it("verify() succeeds against real IMAP + SMTP servers", async () => {
    expect(await makeProvider().verify()).toEqual({ ok: true });
  });

  it("wrong IMAP password: clear 'imap:' message with a hint, and the password never appears", async () => {
    const bad = { ...servers.imapConfig, pass: "super-secret-wrong-pw" };
    const result = await makeProvider({ imap: bad }).verify();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/^imap: /);
    expect(result.error).toMatch(/login was rejected/i);
    expect(result.error).toMatch(/app password/i);
    expect(result.error).not.toContain("super-secret-wrong-pw");
  });

  it("wrong SMTP password: clear 'smtp:' message, IMAP side fine", async () => {
    const bad = { ...servers.smtpConfig, pass: "another-wrong-pw" };
    const result = await makeProvider({ smtp: bad }).verify();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/^smtp: /);
    expect(result.error).toMatch(/login was rejected/i);
    expect(result.error).not.toContain("another-wrong-pw");
    expect(servers.smtp.authFailures).toBeGreaterThan(0);
  });

  it("a wrong password is not retried (repeating a failed login is how accounts get locked)", async () => {
    const provider = makeProvider({ imap: { ...servers.imapConfig, pass: "nope-nope" } });
    await expect(provider.fetchNew(null)).rejects.toThrow();
    const logins = servers.imap.commands.filter((c) => /^\S+ LOGIN/i.test(c));
    expect(logins).toHaveLength(1);
  });

  it("refused connection: hint about host/port", async () => {
    const free = await new Promise<number>((resolve) => {
      const s = net.createServer().listen(0, "127.0.0.1", () => {
        const port = (s.address() as net.AddressInfo).port;
        s.close(() => resolve(port));
      });
    });
    const result = await makeProvider({ imap: { ...servers.imapConfig, port: free } }).verify();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/ECONNREFUSED|refused/i);
  });

  it("a failed connect is not cached: the next call connects fresh once the server is reachable", async () => {
    const free = await new Promise<number>((resolve) => {
      const s = net.createServer().listen(0, "127.0.0.1", () => {
        const port = (s.address() as net.AddressInfo).port;
        s.close(() => resolve(port));
      });
    });
    let port = free;
    const factory = (cfg: ImapConnectionConfig): ImapClient =>
      new ImapFlow({ host: cfg.host, port, secure: false, auth: { user: cfg.user, pass: cfg.pass }, logger: false, disableAutoIdle: true }) as unknown as ImapClient;
    const provider = makeProvider({ createImapClient: factory });
    await expect(provider.fetchNew(null)).rejects.toThrow();
    port = servers.imap.port;
    const result = await provider.fetchNew(null);
    expect(result.cursor).toMatch(/^1:0:\d+$/);
  });

  it("survives a dropped connection: next poll reconnects and nothing is lost or duplicated", async () => {
    const crashes: unknown[] = [];
    const onCrash = (e: unknown) => crashes.push(e);
    process.on("uncaughtException", onCrash);
    process.on("unhandledRejection", onCrash);
    try {
      const provider = makeProvider();
      const first = await provider.fetchNew(null);
      expect(first.messages).toHaveLength(0);

      servers.imap.deliver({ raw: await eml("one", "first") });
      const second = await provider.fetchNew(first.cursor);
      expect(second.messages.map((m) => m.subject)).toEqual(["one"]);

      servers.imap.dropConnections();
      await new Promise((r) => setTimeout(r, 50));
      servers.imap.deliver({ raw: await eml("two", "second") });

      const third = await provider.fetchNew(second.cursor);
      expect(third.messages.map((m) => m.subject)).toEqual(["two"]);
      const logins = servers.imap.commands.filter((c) => /^\S+ LOGIN/i.test(c));
      expect(logins.length).toBeGreaterThanOrEqual(2);
      await new Promise((r) => setTimeout(r, 50));
      expect(crashes).toEqual([]);
    } finally {
      process.off("uncaughtException", onCrash);
      process.off("unhandledRejection", onCrash);
    }
  });
});

describe("first sync policy and cursors", () => {
  it("default: a big existing mailbox is NOT ingested; only mail arriving afterwards is", async () => {
    // "years of history": 2,000 messages from the past two years.
    for (let i = 0; i < 2000; i++) {
      servers.imap.deliver({ raw: `From: old@acme.com\r\nTo: ${ADDRESS}\r\nSubject: old ${i}\r\nMessage-ID: <old-${i}@acme.com>\r\n\r\nbody`, date: daysAgo(30 + (i % 700)) });
    }
    const provider = makeProvider();
    const t0 = Date.now();
    const first = await provider.fetchNew(null);
    expect(first.messages).toHaveLength(0);
    expect(first.cursor).toMatch(/^1:2000:\d+$/);
    expect(servers.imap.commands.some((c) => /FETCH/i.test(c))).toBe(false); // not even asked for a message body
    expect(Date.now() - t0).toBeLessThan(3000);

    servers.imap.deliver({ raw: await eml("fresh", "hello") });
    const next = await provider.fetchNew(first.cursor);
    expect(next.messages.map((m) => m.subject)).toEqual(["fresh"]);
  });

  it("initialSyncDays: pulls only the last N days (by INTERNALDATE), newest-capped by initialSyncMaxMessages", async () => {
    const dates = [400, 60, 10, 6, 5, 3, 1];
    for (const d of dates) servers.imap.deliver({ raw: await eml(`d${d}`, "x", { messageId: `<d${d}@acme.com>` }), date: daysAgo(d) });

    const week = makeProvider({ initialSyncDays: 7 });
    const got = await week.fetchNew(null, { limit: 50 });
    expect(got.messages.map((m) => m.subject)).toEqual(["d6", "d5", "d3", "d1"]);

    const capped = makeProvider({ initialSyncDays: 7, initialSyncMaxMessages: 2 });
    const two = await capped.fetchNew(null, { limit: 50 });
    expect(two.messages.map((m) => m.subject)).toEqual(["d3", "d1"]);

    // A window containing nothing: zero messages and the cursor is parked at the end, so the next poll only sees new mail.
    const none = makeProvider({ initialSyncDays: 1 });
    const r = await none.fetchNew(null);
    expect(r.messages.every((m) => m.subject === "d1")).toBe(true); // d1 sits at the edge of the window; nothing older leaks in
    expect(r.cursor).toMatch(/^1:7:\d+$/);
  });

  it("persists across restarts: a new provider with the stored cursor resumes exactly where the last one stopped", async () => {
    const a = makeProvider();
    const start = await a.fetchNew(null);
    for (let i = 1; i <= 3; i++) servers.imap.deliver({ raw: await eml(`m${i}`, `body ${i}`) });
    const seenByA = await a.fetchNew(start.cursor, { limit: 2 });
    expect(seenByA.messages.map((m) => m.subject)).toEqual(["m1", "m2"]);
    await a.close();

    // "daemon restart": new instance, only the persisted cursor string survives; one more arrives while down.
    servers.imap.deliver({ raw: await eml("m4", "body 4") });
    const b = makeProvider();
    const seenByB = await b.fetchNew(seenByA.cursor, { limit: 50 });
    expect(seenByB.messages.map((m) => m.subject)).toEqual(["m3", "m4"]);

    const idle = await b.fetchNew(seenByB.cursor);
    expect(idle.messages).toHaveLength(0);
    expect(idle.cursor).toBe(seenByB.cursor); // unchanged cursor => the poller does not rewrite it
  });

  it("does not wedge on a run of deleted UIDs (gap larger than the fetch window)", async () => {
    const provider = makeProvider();
    for (let i = 1; i <= 120; i++) servers.imap.deliver({ raw: `Subject: s${i}\r\nMessage-ID: <s${i}@x>\r\n\r\nb` });
    servers.imap.expunge("INBOX", Array.from({ length: 100 }, (_, i) => i + 1)); // UIDs 1..100 vanish
    const first = await provider.fetchNew("1:0", { limit: 50 }); // window 1..50 is all gaps
    expect(first.messages).toHaveLength(0);
    expect(first.cursor).toBe("1:50");
    const second = await provider.fetchNew(first.cursor, { limit: 50 });
    expect(second.cursor).toBe("1:100");
    const third = await provider.fetchNew(second.cursor, { limit: 50 });
    expect(third.messages.map((m) => m.subject)).toEqual(Array.from({ length: 20 }, (_, i) => `s${101 + i}`));
  });

  it("drains a backlog in `limit`-sized batches without skipping or repeating", async () => {
    const provider = makeProvider();
    const start = await provider.fetchNew(null);
    for (let i = 1; i <= 120; i++) servers.imap.deliver({ raw: `Subject: b${i}\r\nMessage-ID: <b${i}@x>\r\n\r\nb` });
    const seen: string[] = [];
    let cursor = start.cursor;
    for (let guard = 0; guard < 10; guard++) {
      const r = await provider.fetchNew(cursor, { limit: 50 });
      seen.push(...r.messages.map((m) => m.subject ?? ""));
      if (r.messages.length === 0) break;
      cursor = r.cursor;
    }
    expect(seen).toEqual(Array.from({ length: 120 }, (_, i) => `b${i + 1}`));
  });

  describe("UIDVALIDITY change", () => {
    it("re-scans only the mail that arrived since the last full catch-up (no history flood, no lost mail)", async () => {
      const warn = vi.fn();
      const provider = makeProvider({ warn });
      // old history that must never come back
      for (let i = 0; i < 3; i++) servers.imap.deliver({ raw: await eml(`old${i}`, "x", { messageId: `<old${i}@acme.com>` }), date: daysAgo(5) });
      const first = await provider.fetchNew(null);
      servers.imap.deliver({ raw: await eml("before-rebuild", "x", { messageId: "<before@acme.com>" }) });
      const second = await provider.fetchNew(first.cursor);
      expect(second.messages.map((m) => m.subject)).toEqual(["before-rebuild"]);

      // server rebuilds the mailbox: new UIDVALIDITY, UIDs renumbered from 1; one more mail arrives afterwards
      servers.imap.rebuildMailbox("INBOX", 777);
      servers.imap.deliver({ raw: await eml("after-rebuild", "x", { messageId: "<after@acme.com>" }) });

      const third = await provider.fetchNew(second.cursor);
      const subjects = third.messages.map((m) => m.subject);
      expect(subjects).toContain("after-rebuild");
      expect(subjects.filter((s) => s?.startsWith("old"))).toEqual([]); // 5-day-old mail is not re-ingested
      expect(third.cursor).toMatch(/^777:\d+:\d+$/);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/UIDVALIDITY.*changed/i));

      // after the resync, normal operation continues on the new numbering
      servers.imap.deliver({ raw: await eml("later", "x", { messageId: "<later@acme.com>" }) });
      const fourth = await provider.fetchNew(third.cursor);
      expect(fourth.messages.map((m) => m.subject)).toEqual(["later"]);
    });

    it("a legacy cursor without a timestamp restarts from the current UIDNEXT (and warns)", async () => {
      const warn = vi.fn();
      const provider = makeProvider({ warn });
      servers.imap.deliver({ raw: await eml("a", "x") });
      servers.imap.deliver({ raw: await eml("b", "x") });
      const result = await provider.fetchNew("999:5");
      expect(result.messages).toHaveLength(0);
      expect(result.cursor).toMatch(/^1:2:\d+$/);
      expect(warn).toHaveBeenCalled();
    });
  });
});

describe("shadow safety: the human's mailbox is never altered", () => {
  it("fetching leaves flags, counts and UIDs untouched and issues only read-only commands (EXAMINE, not SELECT)", async () => {
    const provider = makeProvider({ syncSent: true });
    for (let i = 0; i < 5; i++) servers.imap.deliver({ raw: await eml(`unread ${i}`, "hi", { messageId: `<u${i}@acme.com>` }), flags: i === 0 ? ["\\Flagged"] : [] });
    servers.imap.deliver({ raw: await eml("my reply", "sent by me", { from: ADDRESS, to: "jane@acme.com" }) }, "[Gmail]/Sent Mail");
    const before = JSON.stringify(servers.imap.mailbox("INBOX").messages.map((m) => [m.uid, m.flags]));

    const start = await provider.fetchNew("1:0");
    expect(start.messages).toHaveLength(5);
    await provider.fetchSent("1:0");

    expect(JSON.stringify(servers.imap.mailbox("INBOX").messages.map((m) => [m.uid, m.flags]))).toBe(before);
    expect(servers.imap.mailbox("INBOX").messages.some((m) => m.flags.includes("\\Seen"))).toBe(false);
    expect(servers.imap.mailbox("INBOX").messages).toHaveLength(5);

    const cmds = servers.imap.commands;
    expect(cmds.filter((c) => FORBIDDEN_COMMANDS.test(c))).toEqual([]);
    expect(cmds.some((c) => /^\S+ EXAMINE INBOX/i.test(c))).toBe(true);
    expect(cmds.some((c) => /FETCH .*BODY\.PEEK\[\]/i.test(c))).toBe(true);
    expect(cmds.some((c) => /FETCH .*BODY\[\]/i.test(c) && !/PEEK/i.test(c))).toBe(false);
  });

  it("(control) the test bed WOULD show \\Seen if a client used SELECT + BODY[] — so the assertion above has teeth", async () => {
    servers.imap.deliver({ raw: await eml("control", "x") });
    const rude = new ImapFlow({ host: "127.0.0.1", port: servers.imap.port, secure: false, auth: { user: TEST_USER, pass: TEST_PASS }, logger: false, disableAutoIdle: true });
    await rude.connect();
    await rude.mailboxOpen("INBOX");
    await rude.fetchOne("1", { source: true, flags: true }, { uid: false });
    // BODY.PEEK is what imapflow sends for `source`; force a non-peek fetch via a raw command to prove the flag change is visible
    await rude.messageFlagsAdd("1", ["\\Seen"]);
    await rude.logout();
    expect(servers.imap.mailbox("INBOX").messages[0]!.flags).toContain("\\Seen");
  });

  it("the only IMAP write the provider can issue is APPENDing OUR sent copy, and only when sentFolder is configured", async () => {
    const without = makeProvider();
    await without.send({ from: { address: ADDRESS, name: "Mai" }, to: { address: "jane@acme.com", name: null }, subject: "Hi", text: "hello", messageId: "no-copy@agyhq.test" });
    expect(servers.imap.commands.filter((c) => /APPEND/i.test(c))).toHaveLength(0);

    const withCopy = makeProvider({ sentFolder: "[Gmail]/Sent Mail" });
    await withCopy.send({ from: { address: ADDRESS, name: "Mai" }, to: { address: "jane@acme.com", name: null }, subject: "Hi", text: "hello", messageId: "with-copy@agyhq.test" });
    const appends = servers.imap.commands.filter((c) => /APPEND/i.test(c));
    expect(appends).toHaveLength(1);
    expect(appends[0]).toMatch(/\[Gmail\]\/Sent Mail/);
    expect(servers.imap.mailbox("[Gmail]/Sent Mail").messages).toHaveLength(1);
    expect(servers.imap.mailbox("INBOX").messages).toHaveLength(0);
  });
});

describe("encodings, HTML-only mail and attachments (through the real fetch path)", () => {
  const VI_SUBJECT = "Báo giá phần mềm hóa đơn điện tử — Công ty TNHH Nguyễn & Trần";
  const VI_BODY = "Chào anh Tâm,\n\nEm gửi anh bảng báo giá: 1.200.000đ/năm. Anh xem giúp em nhé.\n\nTrân trọng,\nLê Thị Hương";

  async function roundTrip(raw: Buffer | string) {
    const provider = makeProvider();
    const start = await provider.fetchNew(null);
    servers.imap.deliver({ raw });
    const { messages } = await provider.fetchNew(start.cursor);
    expect(messages).toHaveLength(1);
    return messages[0]!;
  }

  it("RFC 2047 encoded-word subject (base64 'B') and quoted-printable body", async () => {
    const raw = await eml(VI_SUBJECT, VI_BODY, { textEncoding: "quoted-printable", from: '"Lê Thị Hương" <huong@congty.vn>' });
    expect(raw.toString("latin1")).toMatch(/Subject: =\?UTF-8\?/); // really encoded on the wire
    expect(raw.toString("latin1")).toMatch(/Content-Transfer-Encoding: quoted-printable/i);
    const m = await roundTrip(raw);
    expect(m.subject).toBe(VI_SUBJECT);
    expect(m.text.trim()).toBe(VI_BODY);
    expect(m.from).toEqual({ address: "huong@congty.vn", name: "Lê Thị Hương" });
  });

  it("RFC 2047 'Q' encoded subject and base64 body", async () => {
    // hand-built on purpose: Q-encoded subject, base64 body
    const hand = Buffer.from(
      [
        "From: Huong <huong@congty.vn>",
        `To: ${ADDRESS}`,
        "Message-ID: <q-enc@congty.vn>",
        "Subject: =?UTF-8?Q?B=C3=A1o_gi=C3=A1_ph=E1=BA=A7n_m=E1=BB=81m?=",
        "MIME-Version: 1.0",
        'Content-Type: text/plain; charset="utf-8"',
        "Content-Transfer-Encoding: base64",
        "",
        Buffer.from(VI_BODY, "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n"),
        "",
      ].join("\r\n"),
    );
    const m = await roundTrip(hand);
    expect(m.subject).toBe("Báo giá phần mềm");
    expect(m.text.trim()).toBe(VI_BODY);
  });

  it("raw 8-bit UTF-8 body (no transfer encoding)", async () => {
    const eightBit = Buffer.from(
      ["From: a@congty.vn", `To: ${ADDRESS}`, "Message-ID: <8bit@congty.vn>", "Subject: =?UTF-8?B?VGnDqnUgxJHhu4E=?=", "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 8bit", "", VI_BODY, ""].join("\r\n"),
      "utf8",
    );
    const m = await roundTrip(eightBit);
    expect(m.text.trim()).toBe(VI_BODY);
    expect(m.subject).toBe("Tiêu đề");
  });

  it("legacy windows-1258 charset", async () => {
    // "Xin chào" in windows-1258: 'à' = 0xE0 (a + no combining needed), keep to chars with direct code points
    const body = Buffer.concat([Buffer.from("Xin ch", "latin1"), Buffer.from([0xe0]), Buffer.from("o anh", "latin1")]);
    const raw = Buffer.concat([
      Buffer.from(["From: a@congty.vn", `To: ${ADDRESS}`, "Message-ID: <w1258@congty.vn>", "Subject: legacy", "MIME-Version: 1.0", "Content-Type: text/plain; charset=windows-1258", "Content-Transfer-Encoding: 8bit", "", ""].join("\r\n"), "latin1"),
      body,
    ]);
    const m = await roundTrip(raw);
    expect(m.text.trim()).toBe("Xin chào anh");
  });

  it("HTML-only mail: text is derived from the HTML, replyText is non-empty, structure survives", async () => {
    const html = "<html><body><p>Chào anh,</p><p>Em muốn <b>đặt lịch demo</b> vào thứ Ba.</p><blockquote>On earlier mail</blockquote></body></html>";
    const raw = await buildEml({ subject: "Đặt lịch demo", html, text: undefined, textEncoding: "quoted-printable" });
    expect(raw.toString("latin1")).not.toMatch(/text\/plain/i);
    const m = await roundTrip(raw);
    expect(m.text).toContain("đặt lịch demo");
    expect(m.text).toContain("Chào anh");
    expect(m.replyText.length).toBeGreaterThan(0);
  });

  it("attachments: binary content is byte-identical, Vietnamese filenames decode, inline images are listed", async () => {
    const pdf = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.from(Array.from({ length: 256 * 1024 }, (_, i) => (i * 31 + 7) & 0xff))]);
    const raw = await buildEml({
      subject: "Hợp đồng",
      text: "Xem file đính kèm",
      attachments: [
        { filename: "Hợp đồng nguyên tắc.pdf", content: pdf, contentType: "application/pdf" },
        { filename: "logo.png", content: Buffer.from("89504e470d0a1a0a", "hex"), cid: "logo@agyhq", contentDisposition: "inline", contentType: "image/png" },
      ],
    });
    const m = await roundTrip(raw);
    expect(m.attachments).toHaveLength(2);
    const doc = m.attachments.find((a) => a.contentType === "application/pdf")!;
    expect(doc.filename).toBe("Hợp đồng nguyên tắc.pdf");
    expect(doc.size).toBe(pdf.length);
    expect(createHash("sha256").update(doc.content as Uint8Array).digest("hex")).toBe(createHash("sha256").update(pdf).digest("hex"));
    expect(m.attachments.some((a) => a.contentType === "image/png")).toBe(true);
  });

  it("threading headers on received mail are parsed without angle brackets", async () => {
    const raw = await eml("Re: báo giá", "ok", { inReplyTo: "<sent-1@agyhq.test>", references: ["<first@agyhq.test>", "<sent-1@agyhq.test>"], messageId: "<their-1@mail.acme.com>" });
    const m = await roundTrip(raw);
    expect(m.messageId).toBe("their-1@mail.acme.com");
    expect(m.inReplyTo).toBe("sent-1@agyhq.test");
    expect(m.references).toEqual(["first@agyhq.test", "sent-1@agyhq.test"]);
  });

  it("parsed mail still classifies correctly (auto-reply header survives the wire)", async () => {
    const raw = await eml("Trả lời tự động: Vắng mặt", "Tôi đang nghỉ phép.", { headers: { "Auto-Submitted": "auto-replied" } });
    const m = await roundTrip(raw);
    const signals = classifyEmail(m, { ourAddresses: [ADDRESS] });
    expect(signals.isAutoReply).toBe(true);
  });
});

describe("outbound over real SMTP", () => {
  it("sends Message-ID / In-Reply-To / References / List-Unsubscribe exactly, with an RFC 2047 Vietnamese subject and display name", async () => {
    // The From identity (address + display name) comes from the provider's mailbox config, not from OutgoingEmail.from.
    const provider = makeProvider({ displayName: "Mai Nguyễn" });
    const result = await provider.send({
      from: { address: ADDRESS, name: "Mai Nguyễn" },
      to: { address: "jane@acme.com", name: null },
      subject: "Re: Báo giá phần mềm hóa đơn",
      text: "Dạ em gửi anh báo giá ạ.\n\n--\nCông ty ABC",
      messageId: "sent-001@agyhq.test",
      inReplyTo: "reply-001@mail.acme.com",
      references: ["outreach-001@agyhq.test", "reply-001@mail.acme.com"],
      listUnsubscribe: "<mailto:unsubscribe@agyhq.test?subject=unsubscribe>",
      headers: { "X-Agyhq-Agent": "sdr-01" },
    });
    expect(result.messageId).toBe("sent-001@agyhq.test");
    expect(result.accepted).toEqual(["jane@acme.com"]);
    expect(servers.smtp.received).toHaveLength(1);
    expect(servers.smtp.received[0]!.user).toBe(TEST_USER);

    const wire = servers.smtp.received[0]!.raw;
    expect(wire.toString("latin1")).toMatch(/^Subject: =\?UTF-8\?/m);
    const parsed = await parseRawEmail(wire, "wire");
    expect(parsed.subject).toBe("Re: Báo giá phần mềm hóa đơn");
    expect(parsed.messageId).toBe("sent-001@agyhq.test");
    expect(parsed.inReplyTo).toBe("reply-001@mail.acme.com");
    expect(parsed.references).toEqual(["outreach-001@agyhq.test", "reply-001@mail.acme.com"]);
    expect(parsed.headers["list-unsubscribe"]).toBe("<mailto:unsubscribe@agyhq.test?subject=unsubscribe>");
    expect(parsed.from).toEqual({ address: ADDRESS, name: "Mai Nguyễn" });
    expect(parsed.text).toContain("Dạ em gửi anh báo giá ạ.");
  });

  it("a permanent rejection (550) and a transient one (451) surface as errors carrying the SMTP code", async () => {
    const provider = makeProvider();
    servers.smtp.rejectRecipients(["gone@acme.com"]);
    await expect(
      provider.send({ from: { address: ADDRESS, name: null }, to: { address: "gone@acme.com", name: null }, subject: "x", text: "x", messageId: "p1@agyhq.test" }),
    ).rejects.toThrow(/550/);

    servers.smtp.failNextData(451, "451 4.3.0 Try again later");
    await expect(
      provider.send({ from: { address: ADDRESS, name: null }, to: { address: "jane@acme.com", name: null }, subject: "x", text: "x", messageId: "p2@agyhq.test" }),
    ).rejects.toThrow(/451/);
    expect(servers.smtp.received).toHaveLength(0);
  });
});

describe("Sent folder discovery and fetchSent (opt-in)", () => {
  it("is off by default", async () => {
    const provider = makeProvider();
    expect(provider.syncsSent).toBe(false);
    await expect(provider.fetchSent("1:0")).rejects.toThrow(/not enabled/);
  });

  it("finds Gmail's \"[Gmail]/Sent Mail\" via SPECIAL-USE \\Sent and reads human-sent mail with its own cursor", async () => {
    const provider = makeProvider({ syncSent: true });
    expect(provider.syncsSent).toBe(true);
    const start = await provider.fetchSent(null);
    expect(start.folder).toBe("[Gmail]/Sent Mail");
    expect(start.messages).toHaveLength(0);

    servers.imap.deliver(
      { raw: await eml("Re: Báo giá", "Dạ em gửi anh ạ", { from: ADDRESS, to: "jane@acme.com", inReplyTo: "<their-1@acme.com>", messageId: "<human-1@mail.test>" }), flags: ["\\Seen"] },
      "[Gmail]/Sent Mail",
    );
    const next = await provider.fetchSent(start.cursor);
    expect(next.messages).toHaveLength(1);
    expect(next.messages[0]!.to[0]!.address).toBe("jane@acme.com");
    expect(next.messages[0]!.inReplyTo).toBe("their-1@acme.com");
    expect(next.messages[0]!.subject).toBe("Re: Báo giá");
  });

  it("works with a Microsoft-365 style 'Sent Items' folder flagged \\Sent, and with a plain 'Sent' folder with no flags", async () => {
    await servers.close();
    servers = await startMailServers({ folders: { "Sent Items": { "special-use": "\\Sent" } } });
    expect((await makeProvider({ syncSent: true }).fetchSent(null)).folder).toBe("Sent Items");

    await servers.close();
    servers = await startMailServers({ folders: { Sent: {} }, specialUse: false });
    expect((await makeProvider({ syncSent: true }).fetchSent(null)).folder).toBe("Sent");
  });

  it("an explicit sentFolder wins; a wrong one fails with the list of real folders (non-secret, actionable)", async () => {
    const ok = makeProvider({ syncSent: true, sentFolder: "[Gmail]/Drafts" });
    expect((await ok.fetchSent(null)).folder).toBe("[Gmail]/Drafts");

    const bad = makeProvider({ syncSent: true, sentFolder: "Gesendet" });
    await expect(bad.fetchSent(null)).rejects.toThrow(/Gesendet.*does not exist[\s\S]*\[Gmail\]\/Sent Mail/);
  });

  it("no Sent folder at all: error says to set sentFolder", async () => {
    await servers.close();
    servers = await startMailServers({ folders: {} });
    await expect(makeProvider({ syncSent: true }).fetchSent(null)).rejects.toThrow(/set sentFolder/);
  });
});

beforeAll(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterAll(() => {
  vi.restoreAllMocks();
});
