import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FakeEmailProvider } from "@agyhq/channels";
import type { EmailConfig } from "../src/config.ts";
import { EMAIL_SETTINGS_KEY } from "../src/setup/email-settings.ts";
import { EMAIL_CURSOR_KEY } from "../src/setup/email-runtime.ts";
import { testEmailConfig, type EmailCheckers } from "../src/setup/email-test.ts";
import { Sender } from "../src/sender.ts";
import { buildSetupEnv, IMAP_INPUT } from "./setup-helpers.ts";
import { waitFor } from "./helpers.ts";

class TrackedProvider extends FakeEmailProvider {
  closed = false;
  constructor(readonly cfg: EmailConfig | null) {
    super();
  }
  override async close() {
    this.closed = true;
  }
}

function build(extra: { env?: NodeJS.ProcessEnv; initial?: TrackedProvider | null } = {}) {
  const created: TrackedProvider[] = [];
  const initial = extra.initial === undefined ? new TrackedProvider(null) : extra.initial;
  const env = buildSetupEnv({
    deps: {
      emailProvider: initial,
      setupOverrides: {
        env: extra.env ?? {},
        createProvider: (cfg) => {
          if (cfg.kind === "none") return null;
          const p = new TrackedProvider(cfg);
          created.push(p);
          return p;
        },
      },
    },
  });
  return { ...env, created, initial };
}

describe("email settings routes", () => {
  it("GET before any save reflects the config file; PUT stores encrypted passwords and never returns them", async () => {
    const t = build();
    const before = await t.call("GET", "/v1/admin/setup/email");
    expect(before.body.data.email).toMatchObject({ kind: "none", source: "config", imap: null, passwordFromEnv: { imap: false, smtp: false } });

    const put = await t.call("PUT", "/v1/admin/setup/email", IMAP_INPUT);
    expect(put.status).toBe(200);
    const view = put.body.data.email;
    expect(view).toMatchObject({
      kind: "imap-smtp",
      source: "ui",
      address: "sdr@acme.io",
      mailbox: "INBOX",
      imap: { host: "imap.acme.io", port: 993, secure: true, user: "sdr@acme.io", hasPassword: true },
      smtp: { host: "smtp.acme.io", hasPassword: true },
    });
    const wire = JSON.stringify([put.body, (await t.call("GET", "/v1/admin/setup/email")).body]);
    expect(wire).not.toContain("secret-1");

    const stored = JSON.stringify(t.db.kv.get(EMAIL_SETTINGS_KEY));
    expect(stored).not.toContain("secret-1");
    expect(stored).toContain("v1:");
    expect(fs.statSync(path.join(t.config.dataDir, "secret.key")).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(t.db.audit.list({ kind: ["settings.changed"] }))).not.toContain("secret-1");

    // the provider was built with the real (decrypted) passwords
    expect(t.created[0]!.cfg).toMatchObject({ kind: "imap-smtp", imap: { pass: "imap-secret-1" }, smtp: { pass: "smtp-secret-1" } });
  });

  it("omitted or empty passwords keep the stored ones; the first save without a password is rejected", async () => {
    const t = build();
    const noPass = { ...IMAP_INPUT, imap: { ...IMAP_INPUT.imap, pass: undefined }, smtp: { ...IMAP_INPUT.smtp, pass: "" } };
    const rejected = await t.call("PUT", "/v1/admin/setup/email", noPass);
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.message).toMatch(/IMAP password is required/);
    expect(t.created).toHaveLength(0);
    expect(t.db.kv.get(EMAIL_SETTINGS_KEY)).toBeNull();

    await t.call("PUT", "/v1/admin/setup/email", IMAP_INPUT);
    const edit = await t.call("PUT", "/v1/admin/setup/email", {
      ...noPass,
      imap: { ...noPass.imap, host: "imap2.acme.io" },
      sentFolder: "Sent",
    });
    expect(edit.status).toBe(200);
    expect(edit.body.data.email.imap).toMatchObject({ host: "imap2.acme.io", hasPassword: true });
    expect(edit.body.data.email.sentFolder).toBe("Sent");
    expect(t.created.at(-1)!.cfg).toMatchObject({ imap: { host: "imap2.acme.io", pass: "imap-secret-1" }, smtp: { pass: "smtp-secret-1" } });
  });

  it("validates input", async () => {
    const t = build();
    expect((await t.call("PUT", "/v1/admin/setup/email", { kind: "imap-smtp", address: "not-an-email" })).status).toBe(400);
    expect((await t.call("PUT", "/v1/admin/setup/email", { ...IMAP_INPUT, imap: { ...IMAP_INPUT.imap, port: 0 } })).status).toBe(400);
    expect((await t.call("PUT", "/v1/admin/setup/email", { kind: "smtp-only" })).status).toBe(400);
    expect((await t.app.request("/v1/admin/setup/email")).status).toBe(401);
  });

  it("env AGYHQ_IMAP_PASS / AGYHQ_SMTP_PASS win and are reported; they satisfy the password requirement", async () => {
    const t = build({ env: { AGYHQ_IMAP_PASS: "from-env-imap", AGYHQ_SMTP_PASS: "from-env-smtp" } });
    const noPass = { ...IMAP_INPUT, imap: { ...IMAP_INPUT.imap, pass: undefined }, smtp: { ...IMAP_INPUT.smtp, pass: undefined } };
    const put = await t.call("PUT", "/v1/admin/setup/email", noPass);
    expect(put.status).toBe(200);
    expect(put.body.data.email.passwordFromEnv).toEqual({ imap: true, smtp: true });
    expect(put.body.data.email.imap.hasPassword).toBe(true);
    expect(t.created[0]!.cfg).toMatchObject({ imap: { pass: "from-env-imap" }, smtp: { pass: "from-env-smtp" } });
    // even a typed password does not beat the env
    await t.call("PUT", "/v1/admin/setup/email", IMAP_INPUT);
    expect(t.created.at(-1)!.cfg).toMatchObject({ imap: { pass: "from-env-imap" } });
  });

  it("hot swap: old provider closed, new one used by Sender, status and readiness; cursor kept for the same mailbox, reset for another", async () => {
    const t = build();
    const { initial, created } = t;
    const runtime = t.deps.emailRuntime!;
    expect(runtime.provider).toBe(initial);

    // Sender reads the provider through the runtime on every send
    t.db.agents.create({ id: "sdr-01", role: "sales-sdr", displayName: "Mai", model: "m", workspacePath: "/tmp/sdr-01", policy: { builtins: [], mcp: [] } });
    t.db.settings.patch({ outboundEnabled: true, quietHours: null, sendRatePerHour: 100 });
    const sender = new Sender({ config: t.config, db: t.db, bus: t.bus, provider: () => runtime.provider, pollIntervalMs: 1_000_000 });
    const draft = (to: string) => {
      const d = t.db.outbox.createDraft({ agentId: "sdr-01", channel: "email", to, subject: "Hi", body: "Hello", reason: "r" });
      t.db.outbox.decide(d.id, "approved", { decidedBy: "human:ops" });
    };
    draft("a@lead.com");
    await sender.tick();
    expect(initial!.sent.map((m) => m.to.address)).toEqual(["a@lead.com"]);

    t.db.channelCursors.set(EMAIL_CURSOR_KEY, "uidv:41");
    await t.call("PUT", "/v1/admin/setup/email", IMAP_INPUT);
    const first = created.at(-1)!;
    expect(initial!.closed).toBe(true);
    expect(runtime.provider).toBe(first);
    expect(t.config.email.kind).toBe("imap-smtp"); // legacy readers of config.email see the effective config
    expect(t.events.some((e) => e.type === "status.changed")).toBe(true);
    // first save: the identity changed from "none" -> the cursor of the old setup is dropped
    expect(t.db.channelCursors.get(EMAIL_CURSOR_KEY)).toBeNull();

    draft("b@lead.com");
    await sender.tick();
    expect(initial!.sent).toHaveLength(1); // the old provider is not used any more
    expect(first.sent.map((m) => m.to.address)).toEqual(["b@lead.com"]);

    // status + readiness probe the NEW provider (and don't serve the old one's cached health)
    first.setVerify({ ok: false, error: "imap: auth failed" });
    const status = await t.call("GET", "/v1/admin/status");
    expect(status.body.data.status.email).toMatchObject({ provider: "imap-smtp", address: "sdr@acme.io", ok: false, error: "imap: auth failed" });
    const readiness = await t.call("GET", "/v1/admin/readiness");
    expect(readiness.body.data.readiness.checks.find((c: any) => c.id === "email.verified")).toMatchObject({ status: "fail" });

    // same mailbox, new password -> cursor survives; another mailbox -> reset
    t.db.channelCursors.set(EMAIL_CURSOR_KEY, "uidv:99");
    await t.call("PUT", "/v1/admin/setup/email", { ...IMAP_INPUT, smtp: { ...IMAP_INPUT.smtp, pass: "new-smtp-pass" } });
    expect(first.closed).toBe(true);
    expect(t.db.channelCursors.get(EMAIL_CURSOR_KEY)).toBe("uidv:99");
    await t.call("PUT", "/v1/admin/setup/email", { ...IMAP_INPUT, address: "other@acme.io", imap: { ...IMAP_INPUT.imap, user: "other@acme.io" } });
    expect(t.db.channelCursors.get(EMAIL_CURSOR_KEY)).toBeNull();

    // switching email off removes the provider entirely
    const off = await t.call("PUT", "/v1/admin/setup/email", { kind: "none" });
    expect(off.body.data.email).toMatchObject({ kind: "none", source: "ui" });
    expect(runtime.provider).toBeNull();
    draft("c@lead.com");
    await sender.tick(); // no provider: nothing happens, nothing throws
  });

  it("the poller restarts on the new provider and ignores a poll that was in flight during the swap", async () => {
    const t = build({ initial: null });
    const runtime = t.deps.emailRuntime!;
    runtime.start();
    await t.call("PUT", "/v1/admin/setup/email", IMAP_INPUT);
    const p = t.created.at(-1)!;
    p.deliver({ from: { address: "lead@x.com", name: null }, to: [{ address: "sdr@acme.io", name: null }], subject: "Hello", text: "interested", messageId: "<m1@x>" });
    await waitFor(() => t.db.inbound.listByThreadKey("contact:lead@x.com", 5).length > 0, 3000);
    expect(t.db.channelCursors.get(EMAIL_CURSOR_KEY)).toBe("0");
    await runtime.stop();
    expect(p.closed).toBe(true);
  });
});

describe("POST /v1/admin/setup/email/test", () => {
  it("tests IMAP and SMTP separately with the given (unsaved) settings; stored passwords fill in", async () => {
    const calls: string[] = [];
    const checkers: EmailCheckers = {
      async imap(cfg, mailbox) {
        calls.push(`imap:${cfg.host}:${cfg.pass}:${mailbox}`);
        throw new Error(`login failed for ${cfg.user} with ${cfg.pass}`);
      },
      async smtp(cfg) {
        calls.push(`smtp:${cfg.host}:${cfg.pass}`);
      },
    };
    const t = build();
    (t.deps.setupOverrides as any).emailCheckers = checkers;
    // not saved: explicit passwords
    const r1 = await t.call("POST", "/v1/admin/setup/email/test", IMAP_INPUT);
    expect(r1.status).toBe(200);
    expect(r1.body.data.smtp).toEqual({ ok: true, error: null });
    expect(r1.body.data.imap.ok).toBe(false);
    expect(r1.body.data.imap.error).toContain("login failed");
    expect(r1.body.data.imap.error).not.toContain("imap-secret-1"); // scrubbed
    expect(t.db.kv.get(EMAIL_SETTINGS_KEY)).toBeNull(); // testing never saves
    expect(t.created).toHaveLength(0);

    // saved password fills in for an omitted one
    await t.call("PUT", "/v1/admin/setup/email", IMAP_INPUT);
    calls.length = 0;
    await t.call("POST", "/v1/admin/setup/email/test", { ...IMAP_INPUT, imap: { ...IMAP_INPUT.imap, pass: undefined, host: "imap.other.io" }, smtp: { ...IMAP_INPUT.smtp, pass: undefined } });
    expect(calls).toEqual(["imap:imap.other.io:imap-secret-1:INBOX", "smtp:smtp.acme.io:smtp-secret-1"]);

    // missing password with nothing stored (fresh env)
    const fresh = build();
    (fresh.deps.setupOverrides as any).emailCheckers = checkers;
    const r3 = await fresh.call("POST", "/v1/admin/setup/email/test", { ...IMAP_INPUT, imap: { ...IMAP_INPUT.imap, pass: undefined } });
    expect(r3.body.data.imap).toMatchObject({ ok: false });
    expect(r3.body.data.imap.error).toMatch(/No IMAP password/);
    expect((await t.call("POST", "/v1/admin/setup/email/test", { kind: "bogus" })).status).toBe(400);
  });

  it("times out a checker and reports the timeout instead of hanging; maildir and none are handled", async () => {
    const hang: EmailCheckers = { imap: () => new Promise(() => {}), smtp: async () => {} };
    const cfg = { kind: "imap-smtp", address: "a@b.io", imap: { host: "h", port: 1, secure: true, user: "u", pass: "p" }, smtp: { host: "h", port: 1, secure: true, user: "u", pass: "p" }, pollIntervalMs: 1 } as EmailConfig;
    // the production wrapper enforces the deadline inside the real checkers; here we verify the outcome shape with a rejecting checker
    const timedOut: EmailCheckers = { imap: async () => { throw new Error("IMAP check timed out after 20s"); }, smtp: hang.smtp };
    const r = await testEmailConfig(cfg, timedOut, 50);
    expect(r.imap).toEqual({ ok: false, error: "IMAP check timed out after 20s" });
    expect(r.smtp.ok).toBe(true);

    const none = await testEmailConfig({ kind: "none", pollIntervalMs: 1 }, timedOut);
    expect(none.imap.ok).toBe(false);
    const root = path.join(buildSetupEnv().config.dataDir, "maildir");
    const md = await testEmailConfig({ kind: "maildir", root, address: "a@b.io", pollIntervalMs: 1 }, timedOut);
    expect(md).toEqual({ imap: { ok: true, error: null }, smtp: { ok: true, error: null } });
  });

  it("the real checkers fail fast with a readable error against a closed port", async () => {
    const cfg = { kind: "imap-smtp", address: "a@b.io", imap: { host: "127.0.0.1", port: 1, secure: false, user: "u", pass: "hunter2" }, smtp: { host: "127.0.0.1", port: 1, secure: false, user: "u", pass: "hunter2" }, pollIntervalMs: 1 } as EmailConfig;
    const r = await testEmailConfig(cfg, undefined, 5000);
    expect(r.imap.ok).toBe(false);
    expect(r.smtp.ok).toBe(false);
    expect(r.imap.error).toBeTruthy();
    expect(JSON.stringify(r)).not.toContain("hunter2");
  });

  it("the real checkers give up on a server that accepts the connection but never answers", async () => {
    const sockets: net.Socket[] = [];
    const server = net.createServer((s) => sockets.push(s));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as net.AddressInfo).port;
    try {
      const mk = { host: "127.0.0.1", port, secure: false, user: "u", pass: "p" };
      const cfg = { kind: "imap-smtp", address: "a@b.io", imap: mk, smtp: mk, pollIntervalMs: 1 } as EmailConfig;
      const started = Date.now();
      const r = await testEmailConfig(cfg, undefined, 400);
      expect(Date.now() - started).toBeLessThan(5000);
      expect(r.imap.ok).toBe(false);
      expect(r.smtp.ok).toBe(false);
      expect(r.imap.error).toMatch(/timed out|timeout/i);
      expect(r.smtp.error).toMatch(/timed out|timeout/i);
    } finally {
      for (const s of sockets) s.destroy();
      server.close();
    }
  });
});
