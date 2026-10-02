// `hq email doctor` backend: real IMAP/SMTP protocol servers (channels test bed) + the daemon's dry-run routing.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GMAIL_FOLDERS, TEST_USER, buildEml, startMailServers, type TestMailServers } from "../../channels/test/support/mail-servers.ts";
import type { EmailConfig } from "../src/config.ts";
import { runEmailDoctor } from "../src/email-doctor.ts";
import { buildSetupEnv } from "./setup-helpers.ts";
import { formatEmailDoctor } from "../../cli/src/commands/email.ts";

let servers: TestMailServers;
beforeEach(async () => {
  servers = await startMailServers({ folders: GMAIL_FOLDERS });
});
afterEach(async () => {
  await servers.close();
});

const emailConfig = (extra: Record<string, unknown> = {}): EmailConfig =>
  ({
    kind: "imap-smtp",
    address: TEST_USER,
    displayName: "Mai",
    imap: servers.imapConfig,
    smtp: servers.smtpConfig,
    mailbox: "INBOX",
    sentFolder: null,
    pollIntervalMs: 60_000,
    ...extra,
  }) as EmailConfig;

function env(extra: Record<string, unknown> = {}) {
  const t = buildSetupEnv({ config: { email: emailConfig(extra), sender: { name: "Co", address: TEST_USER, companyAddressLine: "1 St" } } });
  t.db.agents.create({ id: "sdr-01", role: "sales-sdr", displayName: "Mai", model: "m", workspacePath: "/tmp/sdr-01", policy: { builtins: [], mcp: [] } }); // shadow by default
  t.db.settings.patch({ defaultSdrAgentId: "sdr-01" });
  // a thread we already wrote on
  const d = t.db.outbox.createDraft({ agentId: "sdr-01", channel: "email", to: "jane@acme.com", subject: "Báo giá", body: "b", reason: "r", threadKey: "contact:jane@acme.com" });
  t.db.outbox.decide(d.id, "approved");
  t.db.outbox.claimNextToSend();
  t.db.outbox.decide(d.id, "sent", { messageId: "ours-1@agyhq.test", sentAt: new Date().toISOString() });
  t.db.crm.upsertContact({ email: "jane@acme.com", name: "Jane", ownerAgentId: "sdr-01" });
  return t;
}

async function seed() {
  const add = async (o: Record<string, unknown>) => servers.imap.deliver({ raw: await buildEml(o) });
  await add({ from: "Jane <jane@acme.com>", subject: "Re: Báo giá", text: "Cảm ơn, gửi em hợp đồng nhé", inReplyTo: "<ours-1@agyhq.test>", references: ["<ours-1@agyhq.test>"], messageId: "<j1@acme.com>" });
  await add({ from: "Newcomer <new@startup.vn>", subject: "Hỏi về hóa đơn điện tử", text: "Công ty em muốn tìm hiểu", messageId: "<n1@startup.vn>" });
  await add({ from: "Bob <bob@x.com>", subject: "Out of Office", text: "Tôi đang nghỉ phép", headers: { "Auto-Submitted": "auto-replied" }, messageId: "<o1@x.com>" });
  await add({ from: "Eve <eve@x.com>", subject: "Re: hello", text: "Please unsubscribe me", messageId: "<u1@x.com>" });
}

const counts = (t: ReturnType<typeof env>) => ({
  tasks: t.db.tasks.list({}).length,
  inbound: t.db.inbound.list({}).length,
  contacts: t.db.crm.findContacts({}).length,
  outbox: t.db.outbox.list({}).length,
  cursors: t.db.channelCursors.get("email"),
});

describe("runEmailDoctor", () => {
  it("classifies and dry-run-routes the latest mail, creating NOTHING and never touching the mailbox", async () => {
    await seed();
    const t = env();
    const before = counts(t);
    const report = await runEmailDoctor({ config: t.config, db: t.db }, emailConfig(), { sample: 10 });

    expect(report.ok).toBe(true);
    const bySubject = Object.fromEntries(report.samples.map((s) => [s.subject, s]));
    expect(bySubject["Re: Báo giá"]).toMatchObject({ classification: "reply", knownThread: true });
    expect(bySubject["Re: Báo giá"]!.route).toMatchObject({ action: "task", agentId: "sdr-01", taskKind: "sdr.handle_reply" });
    expect(bySubject["Hỏi về hóa đơn điện tử"]).toMatchObject({ classification: "new_lead" });
    expect(bySubject["Hỏi về hóa đơn điện tử"]!.route).toMatchObject({ action: "task", agentId: "sdr-01", taskKind: "sdr.research_lead" });
    expect(bySubject["Out of Office"]).toMatchObject({ classification: "auto_reply", signals: ["auto-reply"] });
    expect(bySubject["Out of Office"]!.route!.action).toBe("ignore");
    expect(bySubject["Re: hello"]).toMatchObject({ classification: "unsubscribe" });
    expect(bySubject["Re: hello"]!.route!.action).toBe("opt_out");
    expect(report.routingSummary).toMatchObject({ "task:sdr.handle_reply": 1, "task:sdr.research_lead": 1, ignore: 1, opt_out: 1 });

    expect(counts(t)).toEqual(before); // nothing created
    expect(servers.imap.mailbox("INBOX").messages.every((m) => m.flags.length === 0)).toBe(true);
    expect(servers.smtp.received).toHaveLength(0);

    const ids = report.checks.map((c) => `${c.id}:${c.status}`);
    expect(ids).toContain("imap.login:pass");
    expect(ids).toContain("imap.mailbox:pass");
    expect(ids).toContain("imap.sent_folder:pass");
    expect(ids).toContain("sync.first:pass");
    expect(ids).toContain("mail.parse:pass");
    expect(ids).toContain("smtp.auth:pass");
    expect(ids).toContain("safety.shadow:pass");
    expect(report.safety.nothingCanBeSent).toBe(true);
  });

  it("never contains a password anywhere in the report or the printed output", async () => {
    await seed();
    const t = env();
    const report = await runEmailDoctor({ config: t.config, db: t.db }, emailConfig());
    const text = JSON.stringify(report) + formatEmailDoctor(report).join("\n");
    expect(text).not.toContain(servers.imapConfig.pass);
    expect(report.config.imap).toMatchObject({ hasPassword: true });

    const bad = await runEmailDoctor({ config: t.config, db: t.db }, emailConfig({ imap: { ...servers.imapConfig, pass: "totally-wrong-pw" } }));
    expect(bad.ok).toBe(false);
    const badText = JSON.stringify(bad) + formatEmailDoctor(bad).join("\n");
    expect(badText).not.toContain("totally-wrong-pw");
    expect(bad.checks.find((c) => c.id === "imap.login")!.detail).toMatch(/login was rejected/i);
  });

  it("warns when a non-shadow agent could send, and fails if the kill switch is on too", async () => {
    const t = env();
    t.db.agents.update("sdr-01", { trustTier: "assisted" });
    expect((await runEmailDoctor({ config: t.config, db: t.db }, emailConfig())).checks.find((c) => c.id === "safety.shadow")!.status).toBe("warn");
    t.db.settings.patch({ outboundEnabled: true });
    expect((await runEmailDoctor({ config: t.config, db: t.db }, emailConfig())).checks.find((c) => c.id === "safety.shadow")!.status).toBe("fail");
  });

  it("warns that a busy general mailbox would turn newsletters into leads", async () => {
    for (let i = 0; i < 6; i++) servers.imap.deliver({ raw: await buildEml({ from: `News ${i} <news${i}@vendor${i}.com>`, subject: `Promo ${i}`, text: "sale", messageId: `<p${i}@v>` }) });
    const t = env();
    const r = await runEmailDoctor({ config: t.config, db: t.db }, emailConfig());
    expect(r.checks.find((c) => c.id === "routing.dry_run")!.status).toBe("warn");
  });

  it("reports unrouted mail when no default SDR exists", async () => {
    await seed();
    const t = env();
    t.db.settings.patch({ defaultSdrAgentId: null });
    const r = await runEmailDoctor({ config: t.config, db: t.db }, emailConfig());
    expect(r.samples.find((s) => s.subject === "Hỏi về hóa đơn điện tử")!.route!.action).toBe("parked");
  });

  it("--send-test sends exactly one email and audits it; without it nothing is sent", async () => {
    const t = env();
    const r = await runEmailDoctor({ config: t.config, db: t.db }, emailConfig(), { sample: 0, sendTest: "owner@example.com" });
    expect(r.checks.find((c) => c.id === "smtp.send_test")!.status).toBe("pass");
    expect(servers.smtp.received).toHaveLength(1);
    expect(t.db.audit.list({}).filter((a) => a.kind === "email.test_sent")).toHaveLength(1);
  });

  it("explains a missing password, a maildir provider and kind none without any network call", async () => {
    const t = env();
    const noPass = await runEmailDoctor({ config: t.config, db: t.db }, emailConfig({ imap: { ...servers.imapConfig, pass: "" } }));
    expect(noPass.checks[0]).toMatchObject({ id: "config.password", status: "fail" });
    const none = await runEmailDoctor({ config: t.config, db: t.db }, { kind: "none", pollIntervalMs: 1000 });
    expect(none.ok).toBe(false);
    expect(none.checks[0]!.id).toBe("config.kind");
  });

  it("formats a readable report", async () => {
    await seed();
    const t = env();
    const lines = formatEmailDoctor(await runEmailDoctor({ config: t.config, db: t.db }, emailConfig()));
    const out = lines.join("\n");
    expect(out).toMatch(/✓ IMAP login/);
    expect(out).toMatch(/sdr-01 -> sdr\.handle_reply/);
    expect(out).toMatch(/Hỏi về hóa đơn điện tử/);
    expect(out).toMatch(/^OK/m);
  });
});

describe("POST /v1/admin/email/doctor", () => {
  it("runs the same preflight against the saved settings; validates input", async () => {
    await seed();
    const t = env();
    const res = await t.call("POST", "/v1/admin/email/doctor", { sample: 5 });
    expect(res.status).toBe(200);
    expect(res.body.data.report.mode).toBe("daemon");
    expect(res.body.data.report.samples.length).toBe(4);
    expect(JSON.stringify(res.body)).not.toContain(servers.imapConfig.pass);
    expect((await t.call("POST", "/v1/admin/email/doctor", { sendTest: "nope" })).status).toBe(400);
    expect((await t.call("POST", "/v1/admin/email/doctor", { bogus: 1 })).status).toBe(400);
    expect(servers.smtp.received).toHaveLength(0);
    const unauth = await t.app.request("/v1/admin/email/doctor", { method: "POST", body: "{}" });
    expect(unauth.status).toBe(401);
  });
});
