// The whole inbound path against real IMAP protocol: ImapSmtpProvider (real ImapFlow) -> EmailPoller -> ingest -> db.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ImapSmtpProvider } from "@agyhq/channels";
import { openDb } from "@agyhq/db";
import { GMAIL_FOLDERS, TEST_USER, buildEml, startMailServers, type TestMailServers } from "../../channels/test/support/mail-servers.ts";
import { EventBus } from "../src/event-bus.ts";
import { EmailPoller, EMAIL_INBOX_CURSOR_KEY, EMAIL_SENT_CURSOR_KEY } from "../src/inbound.ts";
import { makeTestConfig } from "./helpers.ts";

let servers: TestMailServers;
const providers: ImapSmtpProvider[] = [];
beforeEach(async () => {
  servers = await startMailServers({ folders: GMAIL_FOLDERS });
});
afterEach(async () => {
  await Promise.all(providers.splice(0).map((p) => p.close()));
  await servers.close();
});

function world(syncSent = false) {
  const db = openDb(":memory:");
  const config = makeTestConfig({ sender: { name: "Co", address: TEST_USER, companyAddressLine: "1 St" } });
  db.agents.create({ id: "sdr-01", role: "sales-sdr", displayName: "Mai", model: "m", workspacePath: "/tmp/sdr-01", policy: { builtins: [], mcp: [] } });
  db.settings.patch({ defaultSdrAgentId: "sdr-01" });
  const provider = new ImapSmtpProvider({ address: TEST_USER, imap: servers.imapConfig, smtp: servers.smtpConfig, syncSent, warn: () => {} });
  providers.push(provider);
  const poller = new EmailPoller({ db, bus: new EventBus(), config }, provider, 60_000);
  return { db, provider, poller };
}

describe("EmailPoller + real IMAP", () => {
  it("ingests new Vietnamese mail once: same Message-ID under a new UID (e.g. after a mailbox rebuild or copy) is deduped", async () => {
    const { db, poller } = world();
    servers.imap.deliver({ raw: await buildEml({ subject: "Cũ", text: "old history", messageId: "<old@x>" }), date: new Date(Date.now() - 400 * 86_400_000) });
    await poller.pollNow(); // first sync: history is not ingested
    expect(db.inbound.list()).toHaveLength(0);

    const raw = await buildEml({ from: "Hương <huong@congty.vn>", subject: "Báo giá phần mềm hóa đơn điện tử", text: "Chào anh Tâm,\nEm cần báo giá.", messageId: "<dup-1@congty.vn>", textEncoding: "base64" });
    servers.imap.deliver({ raw });
    await poller.pollNow();
    expect(db.inbound.list()).toHaveLength(1);
    expect(db.inbound.list()[0]).toMatchObject({ subject: "Báo giá phần mềm hóa đơn điện tử", fromName: "Hương", classification: "new_lead", status: "routed" });
    expect(db.tasks.list({})).toHaveLength(1);

    servers.imap.deliver({ raw }); // the very same message again, new UID
    await poller.pollNow();
    expect(db.inbound.list()).toHaveLength(1);
    expect(db.tasks.list({})).toHaveLength(1);
    expect(poller.lastError).toBeNull();
  });

  it("persists the cursor so a restarted poller does not re-read or lose mail, and survives a dropped connection", async () => {
    const { db, poller } = world();
    await poller.pollNow();
    servers.imap.deliver({ raw: await buildEml({ subject: "a", text: "a", messageId: "<a@x>" }) });
    await poller.pollNow();
    const cursor = db.channelCursors.get(EMAIL_INBOX_CURSOR_KEY);
    expect(cursor).toMatch(/^1:1:\d+$/);

    servers.imap.dropConnections();
    servers.imap.deliver({ raw: await buildEml({ subject: "b", text: "b", messageId: "<b@x>" }) });
    const second = world(); // "restart": fresh provider + poller on the same db is simulated by reusing the cursor
    second.db.channelCursors.set(EMAIL_INBOX_CURSOR_KEY, cursor);
    await second.poller.pollNow();
    expect(second.db.inbound.list().map((e) => e.subject)).toEqual(["b"]);
    await poller.pollNow(); // original poller reconnects by itself
    expect(poller.lastError).toBeNull();
    expect(db.inbound.list().map((e) => e.subject).sort()).toEqual(["a", "b"]);
  });

  it("Sent-folder sync end to end: a reply the human sends from their own client cancels the follow-up and supersedes the draft", async () => {
    const { db, poller } = world(true);
    // a thread we know: we wrote to Jane, she answered
    db.crm.upsertContact({ email: "jane@acme.com", name: "Jane", ownerAgentId: "sdr-01" });
    const d = db.outbox.createDraft({ agentId: "sdr-01", channel: "email", to: "jane@acme.com", subject: "Hi", body: "b", reason: "r", threadKey: "contact:jane@acme.com" });
    db.outbox.decide(d.id, "approved"); db.outbox.claimNextToSend();
    db.outbox.decide(d.id, "sent", { messageId: "ours-1@agyhq.test", sentAt: new Date().toISOString() });
    await poller.pollNow(); // establishes both cursors ("from now")
    expect(poller.sentSync).toMatchObject({ enabled: true, folder: "[Gmail]/Sent Mail", lastError: null });

    servers.imap.deliver({ raw: await buildEml({ from: "Jane <jane@acme.com>", subject: "Re: Hi", text: "Gửi em báo giá", inReplyTo: "<ours-1@agyhq.test>", references: ["<ours-1@agyhq.test>"], messageId: "<jane-1@acme.com>" }) });
    await poller.pollNow();
    const reply = db.tasks.list({}).find((t) => t.kind === "sdr.handle_reply")!;
    const followUp = db.tasks.create({ agentId: "sdr-01", kind: "sdr.follow_up", title: "chase", threadKey: "contact:jane@acme.com" });
    const draft = db.outbox.createDraft({ agentId: "sdr-01", channel: "email", to: "jane@acme.com", subject: "Re: Hi", body: "agent draft", reason: "r", threadKey: "contact:jane@acme.com" });
    await new Promise((r) => setTimeout(r, 20));

    // the human answers from Gmail/Outlook
    servers.imap.deliver({ raw: await buildEml({ from: TEST_USER, to: "Jane <jane@acme.com>", subject: "Re: Hi", text: "Dạ em gửi chị báo giá ạ.", inReplyTo: "<jane-1@acme.com>", references: ["<ours-1@agyhq.test>", "<jane-1@acme.com>"], messageId: "<human-1@mail.test>" }) }, "[Gmail]/Sent Mail");
    await poller.pollNow();

    expect(poller.sentSync.counts).toMatchObject({ recorded: 1 });
    expect(db.humanSent.listByThreadKey("contact:jane@acme.com")).toHaveLength(1);
    expect(db.tasks.get(followUp.id)!.status).toBe("cancelled");
    expect(db.tasks.get(reply.id)!.status).toBe("cancelled"); // the reply task for the message the human just answered
    expect(db.outbox.get(draft.id)!.statusReason).toMatch(/^superseded:/);
    expect(db.channelCursors.get(EMAIL_SENT_CURSOR_KEY)).not.toBeNull();
    // and the mailbox itself was only ever read
    expect(servers.imap.commands.filter((c) => /^\S+ (STORE|UID STORE|EXPUNGE|COPY|MOVE|DELETE|APPEND|SELECT)\b/i.test(c))).toEqual([]);
  });
});
