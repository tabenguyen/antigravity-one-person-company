import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMailboxDoctor } from "../src/doctor.ts";
import { parseRawEmail } from "../src/parse.ts";
import { GMAIL_FOLDERS, TEST_USER, buildEml, startMailServers, type TestMailServers } from "./support/mail-servers.ts";

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);
let servers: TestMailServers;

beforeEach(async () => {
  servers = await startMailServers({ folders: GMAIL_FOLDERS });
});
afterEach(async () => {
  await servers.close();
});

const base = () => ({ address: TEST_USER, imap: servers.imapConfig, smtp: servers.smtpConfig, timeoutMs: 5000 });

async function seed() {
  for (const [days, subject] of [[40, "old"], [20, "twenty"], [5, "five"], [2, "Báo giá phần mềm hóa đơn"], [0, "today"]] as const) {
    servers.imap.deliver({ raw: await buildEml({ subject, text: `nội dung ${subject}`, messageId: `<${days}-${subject.length}@acme.com>` }), date: daysAgo(days) });
  }
}

describe("runMailboxDoctor", () => {
  it("full read-only preflight: login, EXAMINE, folders, first-sync forecast, parsed samples, SMTP auth — and sends nothing", async () => {
    await seed();
    const r = await runMailboxDoctor({ ...base(), syncSent: true, sample: 3 });

    expect(r.imap.ok).toBe(true);
    expect(r.imap.error).toBeNull();
    expect(r.mailbox).toMatchObject({ name: "INBOX", readOnly: true, exists: 5, uidValidity: "1", uidNext: 6 });
    expect(r.folders.listed).toBe(true);
    expect(r.folders.sent).toEqual({ ok: true, path: "[Gmail]/Sent Mail", via: "special-use" });
    expect(r.folders.all.map((f) => f.path)).toContain("[Gmail]/Sent Mail");

    // default policy: only mail arriving from now on
    expect(r.firstSync.policy).toEqual({ initialSyncDays: 0, initialSyncMaxMessages: 200 });
    expect(r.firstSync.wouldIngest).toBe(0);
    expect(r.firstSync.totalInMailbox).toBe(5);
    // IMAP SEARCH SINCE is date-granular (whole days, server time zone), so the shortest window is approximate.
    const w = Object.fromEntries(r.firstSync.windows.map((x) => [x.days, x.count]));
    expect(w[1]).toBeGreaterThanOrEqual(1);
    expect(w[1]).toBeLessThanOrEqual(2);
    expect({ 3: w[3], 7: w[7], 14: w[14], 30: w[30] }).toEqual({ 3: 2, 7: 3, 14: 3, 30: 4 });

    // newest 3, oldest first, parsed through the real pipeline (Vietnamese subject intact)
    expect(r.samples.map((s) => s.parsed?.subject)).toEqual(["five", "Báo giá phần mềm hóa đơn", "today"]);
    expect(r.samples.every((s) => s.parseError === null && s.arrivedAt !== null)).toBe(true);

    expect(r.smtp.ok).toBe(true);
    expect(r.sendTest).toMatchObject({ attempted: false, to: null });
    expect(servers.smtp.received).toHaveLength(0);

    // read-only: nothing changed, only read commands issued
    expect(servers.imap.mailbox("INBOX").messages.some((m) => m.flags.length > 0)).toBe(false);
    const forbidden = servers.imap.commands.filter((c) => /^\S+ (STORE|UID STORE|EXPUNGE|COPY|UID COPY|MOVE|DELETE|CREATE|APPEND|SELECT)\b/i.test(c));
    expect(forbidden).toEqual([]);
    expect(servers.imap.commands.some((c) => /EXAMINE INBOX/i.test(c))).toBe(true);
  });

  it("forecasts the configured first-sync window (and honours the cap)", async () => {
    await seed();
    const week = await runMailboxDoctor({ ...base(), initialSyncDays: 7 });
    expect(week.firstSync.wouldIngest).toBe(3);
    const capped = await runMailboxDoctor({ ...base(), initialSyncDays: 30, initialSyncMaxMessages: 2 });
    expect(capped.firstSync.wouldIngest).toBe(2);
  });

  it("wrong IMAP password: failure with a hint, never the password, and no SMTP/other crash", async () => {
    const r = await runMailboxDoctor({ ...base(), imap: { ...servers.imapConfig, pass: "hunter2-wrong" } });
    expect(r.imap.ok).toBe(false);
    expect(r.imap.error).toMatch(/login was rejected/i);
    expect(JSON.stringify(r)).not.toContain("hunter2-wrong");
    expect(JSON.stringify(r)).not.toContain(servers.imapConfig.pass);
    expect(r.mailbox.exists).toBeNull();
    expect(r.smtp.ok).toBe(true); // checked independently
  });

  it("wrong SMTP password: reported on its own, and --send-test sends nothing", async () => {
    const r = await runMailboxDoctor({ ...base(), smtp: { ...servers.smtpConfig, pass: "wrong-smtp-pass" }, sendTest: { to: "me@example.com" } });
    expect(r.imap.ok).toBe(true);
    expect(r.smtp.ok).toBe(false);
    expect(r.smtp.error).toMatch(/login was rejected/i);
    expect(JSON.stringify(r)).not.toContain("wrong-smtp-pass");
    expect(r.sendTest.attempted).toBe(false);
    expect(r.sendTest.error).toMatch(/nothing was sent/);
    expect(servers.smtp.received).toHaveLength(0);
  });

  it("sendTest sends EXACTLY ONE message, to the given address only, and leaves the mailbox untouched", async () => {
    const r = await runMailboxDoctor({ ...base(), displayName: "Mai Nguyễn", sendTest: { to: "owner@example.com" } });
    expect(r.sendTest).toMatchObject({ attempted: true, to: "owner@example.com", error: null });
    expect(r.sendTest.accepted).toEqual(["owner@example.com"]);
    expect(servers.smtp.received).toHaveLength(1);
    const sent = await parseRawEmail(servers.smtp.received[0]!.raw, "x");
    expect(sent.to.map((a) => a.address)).toEqual(["owner@example.com"]);
    expect(sent.subject).toMatch(/^agy-hq email doctor test /);
    expect(sent.messageId).toBe(r.sendTest.messageId);
    expect(sent.headers["auto-submitted"]).toBe("auto-generated");
    expect(servers.imap.commands.filter((c) => /APPEND/i.test(c))).toEqual([]); // no Sent copy appended either
  });

  it("an invalid --send-test address sends nothing", async () => {
    const r = await runMailboxDoctor({ ...base(), sendTest: { to: "not-an-address" } });
    expect(r.sendTest.attempted).toBe(false);
    expect(r.sendTest.error).toMatch(/not a valid email address/);
    expect(servers.smtp.received).toHaveLength(0);
  });

  it("reports a missing Sent folder with the real folder list, and a missing mailbox with a hint", async () => {
    await servers.close();
    servers = await startMailServers({ folders: {} });
    const r = await runMailboxDoctor({ ...base(), mailbox: "Inbox-Typo", sentFolder: "Gesendet" });
    expect(r.folders.sent).toMatchObject({ ok: false });
    if (r.folders.sent && !r.folders.sent.ok) expect(r.folders.sent.available).toContain("INBOX");
    expect(r.mailbox.error).toBeTruthy();
  });

  it("times out instead of hanging on a server that accepts the connection but never answers", async () => {
    const net = await import("node:net");
    const hang = net.createServer(() => {}).listen(0, "127.0.0.1");
    await new Promise((r) => hang.once("listening", r));
    const port = (hang.address() as import("node:net").AddressInfo).port;
    const t0 = Date.now();
    const r = await runMailboxDoctor({ ...base(), imap: { ...servers.imapConfig, port }, timeoutMs: 600 });
    hang.close();
    expect(r.imap.ok).toBe(false);
    expect(r.imap.error).toMatch(/timed out|timeout/i);
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});
