import { describe, expect, it } from "vitest";
import { FakeEmailProvider } from "@agyhq/channels";
import { Sender } from "../src/sender.ts";
import { ingestEmail } from "../src/inbound.ts";
import { computeReadiness } from "../src/readiness/checks.ts";
import { effectiveSender, SENDER_SETTINGS_KEY } from "../src/setup/sender-settings.ts";
import { buildSetupEnv } from "./setup-helpers.ts";

const UI_SENDER = {
  name: "Acme Sales",
  address: "mai@acme.io",
  companyAddressLine: "Acme Ltd, 1 Nguyen Hue, HCMC",
  unsubscribeMailto: "optout@acme.io",
};

const EXAMPLE_CONFIG = {
  sender: { name: "Your Company Sales", address: "sdr@yourcompany.com", companyAddressLine: "Your Company, 123 Main St" },
  unsubscribeMailto: "unsubscribe@yourcompany.com",
};

describe("sender settings routes", () => {
  it("GET falls back to the config file; PUT persists in kv and wins; validates and trims", async () => {
    const t = buildSetupEnv({ config: EXAMPLE_CONFIG });
    const before = await t.call("GET", "/v1/admin/setup/sender");
    expect(before.body.data.sender).toMatchObject({ source: "config", address: "sdr@yourcompany.com", unsubscribeMailto: "unsubscribe@yourcompany.com" });

    expect((await t.call("PUT", "/v1/admin/setup/sender", { ...UI_SENDER, address: "nope" })).status).toBe(400);
    expect((await t.call("PUT", "/v1/admin/setup/sender", { ...UI_SENDER, companyAddressLine: "x" })).status).toBe(400);
    expect((await t.call("PUT", "/v1/admin/setup/sender", { name: "A" })).status).toBe(400);
    expect(t.db.kv.get(SENDER_SETTINGS_KEY)).toBeNull();

    const put = await t.call("PUT", "/v1/admin/setup/sender", { ...UI_SENDER, name: "  Acme Sales ", unsubscribeMailto: "mailto:optout@acme.io" });
    expect(put.status).toBe(200);
    expect(put.body.data.sender).toEqual({ ...UI_SENDER, source: "ui" });
    expect((await t.call("GET", "/v1/admin/setup/sender")).body.data.sender.source).toBe("ui");
    expect(effectiveSender(t.config, t.db)).toEqual({ ...UI_SENDER, source: "ui" });
    expect(t.db.audit.list({ kind: ["settings.changed"] })[0]!.data).toMatchObject({ area: "sender", address: "mai@acme.io" });
    expect(t.events.some((e) => e.type === "settings.changed")).toBe(true);
  });

  it("UI sender drives the outgoing From, footer and List-Unsubscribe (not the config file)", async () => {
    const t = buildSetupEnv({ config: EXAMPLE_CONFIG });
    const provider = new FakeEmailProvider();
    t.db.agents.create({ id: "sdr-01", role: "sales-sdr", displayName: "Mai", model: "m", workspacePath: "/tmp/sdr-01", policy: { builtins: [], mcp: [] } });
    t.db.settings.patch({ outboundEnabled: true, quietHours: null, sendRatePerHour: 100 });
    const sender = new Sender({ config: t.config, db: t.db, bus: t.bus, provider, pollIntervalMs: 1_000_000 });
    const approve = (to: string) => {
      const d = t.db.outbox.createDraft({ agentId: "sdr-01", channel: "email", to, subject: "Hi", body: "Hello there", reason: "r" });
      t.db.outbox.decide(d.id, "approved", { decidedBy: "human:ops" });
    };

    approve("a@lead.com");
    await sender.tick();
    expect(provider.sent[0]!.from.address).toBe("sdr@yourcompany.com");

    await t.call("PUT", "/v1/admin/setup/sender", UI_SENDER); // no restart
    approve("b@lead.com");
    await sender.tick();
    const mail = provider.sent[1]!;
    expect(mail.from).toEqual({ address: "mai@acme.io", name: "Acme Sales" });
    expect(mail.text).toContain("Acme Ltd, 1 Nguyen Hue, HCMC");
    expect(mail.text).toContain("optout@acme.io");
    expect(mail.text).not.toContain("yourcompany");
    expect(mail.listUnsubscribe).toBe("<mailto:optout@acme.io?subject=unsubscribe>");
    expect(mail.messageId).toContain("acme.io");
  });

  it("readiness sender.identity / unsubscribe.mailto follow the UI settings", async () => {
    const t = buildSetupEnv({ config: EXAMPLE_CONFIG });
    const check = async (id: string) =>
      (await computeReadiness({ config: t.config, db: t.db, verifyEmail: async () => ({ ok: true }) })).checks.find((c) => c.id === id)!;
    expect((await check("sender.identity")).status).toBe("fail");
    expect((await check("unsubscribe.mailto")).status).toBe("fail");
    expect((await check("sender.identity")).detail).toMatch(/Setup page/);

    await t.call("PUT", "/v1/admin/setup/sender", UI_SENDER);
    expect((await check("sender.identity")).status).toBe("pass");
    expect((await check("unsubscribe.mailto")).status).toBe("pass");

    // placeholder-looking UI values still fail
    await t.call("PUT", "/v1/admin/setup/sender", { ...UI_SENDER, address: "sdr@yourcompany.com" });
    expect((await check("sender.identity")).status).toBe("fail");
  });

  it("inbound mail from the UI-configured sender address is recognised as our own and skipped", async () => {
    const t = buildSetupEnv({ config: EXAMPLE_CONFIG });
    await t.call("PUT", "/v1/admin/setup/sender", UI_SENDER);
    const provider = new FakeEmailProvider();
    const parsed = provider.deliver({ from: { address: "mai@acme.io", name: "Mai" }, to: [{ address: "x@y.com", name: null }], subject: "s", text: "t" });
    expect(ingestEmail({ db: t.db, bus: t.bus, config: t.config }, parsed)).toBeNull();
  });
});
