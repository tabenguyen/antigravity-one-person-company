// Shadow tier must never reach SMTP: every path from "agent drafted" to "provider.send()" is closed for a
// shadow-tier agent, even with the kill switch on, and a draft a human knows is stale cannot slip out either.

import { describe, expect, it } from "vitest";
import { FakeEmailProvider } from "@agyhq/channels";
import { createAdminApi } from "../src/admin-api.ts";
import { EventBus } from "../src/event-bus.ts";
import { Sender } from "../src/sender.ts";
import { makeTestConfig, openTestDb } from "./helpers.ts";

function setup(tier: "shadow" | "assisted" = "shadow") {
  const config = makeTestConfig();
  const db = openTestDb();
  const bus = new EventBus();
  const app = createAdminApi({ config, db, bus });
  const provider = new FakeEmailProvider();
  const sender = new Sender({ config, db, bus, provider, pollIntervalMs: 1_000_000 });
  db.agents.create({ id: "sdr-01", role: "sales-sdr", displayName: "Mai", model: "m", workspacePath: "/tmp/sdr-01", policy: { builtins: [], mcp: [] }, trustTier: tier });
  // The most permissive possible global settings: kill switch ON, no quiet hours, no rate limit worth mentioning.
  db.settings.patch({ outboundEnabled: true, outboundDisabledReason: null, quietHours: null, sendRatePerHour: 1000, autonomousRequiresPriorApproval: false });
  const call = async (method: string, url: string, body: unknown = {}) => {
    const res = await app.request(url, { method, headers: { authorization: `Bearer ${config.adminToken}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as any };
  };
  const draft = (to = "lead@acme.com", threadKey?: string) =>
    db.outbox.createDraft({ agentId: "sdr-01", channel: "email", to, subject: "Hi", body: "Hello there", reason: "first touch", threadKey });
  return { config, db, bus, provider, sender, call, draft };
}

describe("shadow tier never sends", () => {
  it("human approval parks a shadow draft in held; the Sender (outbound ON) never sends it, however often it ticks", async () => {
    const t = setup("shadow");
    const ids = [t.draft("a@acme.com"), t.draft("b@acme.com"), t.draft("c@acme.com")].map((d) => d.id);
    for (const id of ids) {
      const res = await t.call("POST", `/v1/admin/outbox/${id}/approve`);
      expect(res.body.data.item.status).toBe("held");
    }
    for (let i = 0; i < 5; i++) await t.sender.tick();
    expect(t.provider.sent).toHaveLength(0);
    for (const id of ids) expect(t.db.outbox.get(id)!.status).toBe("held");
    expect(t.db.audit.list({}).filter((a) => a.kind === "outbox.sent")).toHaveLength(0);
  });

  it("held is terminal: it cannot be re-approved, retried or sent later (promotion does not release practice drafts)", async () => {
    const t = setup("shadow");
    const d = t.draft();
    await t.call("POST", `/v1/admin/outbox/${d.id}/approve`);
    expect(() => t.db.outbox.decide(d.id, "approved")).toThrow();
    expect((await t.call("POST", `/v1/admin/outbox/${d.id}/retry`)).status).toBeGreaterThanOrEqual(400);
    t.db.agents.update("sdr-01", { trustTier: "assisted" }); // promoted
    await t.sender.tick();
    expect(t.provider.sent).toHaveLength(0);
    expect(t.db.outbox.get(d.id)!.status).toBe("held");
  });

  it("a shadow agent's draft is never auto-approved at draft time, whatever the autonomy settings say", () => {
    const t = setup("shadow");
    const d = t.draft();
    expect(d.status).toBe("pending_approval");
    return t.sender.tick().then(() => expect(t.provider.sent).toHaveLength(0));
  });

  it("belt and braces: an item that is `approved` for an agent that is (now) shadow is refused by the Sender's final guard", async () => {
    const t = setup("assisted");
    const d = t.draft();
    await t.call("POST", `/v1/admin/outbox/${d.id}/approve`);
    expect(t.db.outbox.get(d.id)!.status).toBe("approved");
    t.db.agents.update("sdr-01", { trustTier: "shadow" }); // demoted before the Sender picked it up
    await t.sender.tick();
    expect(t.provider.sent).toHaveLength(0);
    const after = t.db.outbox.get(d.id)!;
    expect(after.status).toBe("blocked");
    expect(after.statusReason).toMatch(/shadow tier/);
  });

  it("control: the same item DOES send for an assisted agent (so the tests above are not passing for the wrong reason)", async () => {
    const t = setup("assisted");
    const d = t.draft();
    await t.call("POST", `/v1/admin/outbox/${d.id}/approve`);
    await t.sender.tick();
    expect(t.provider.sent).toHaveLength(1);
    expect(t.db.outbox.get(d.id)!.status).toBe("sent");
  });
});

describe("superseded drafts (a human already replied)", () => {
  it("approving a superseded pending draft is an explicit human override: the mark clears and it sends", async () => {
    const t = setup("assisted");
    const d = t.draft();
    t.db.outbox.annotateSuperseded(d.id, "superseded: a human already replied from their own mail client");
    const res = await t.call("POST", `/v1/admin/outbox/${d.id}/approve`);
    expect(res.status).toBe(200);
    expect(t.db.outbox.get(d.id)!.statusReason).toBeNull();
    await t.sender.tick();
    expect(t.provider.sent).toHaveLength(1);
  });

  it("an item that becomes superseded AFTER approval is refused by the Sender", async () => {
    const t = setup("assisted");
    const d = t.draft();
    await t.call("POST", `/v1/admin/outbox/${d.id}/approve`);
    t.db.outbox.annotateSuperseded(d.id, "superseded: a human already replied from their own mail client");
    await t.sender.tick();
    expect(t.provider.sent).toHaveLength(0);
    expect(t.db.outbox.get(d.id)!.status).toBe("blocked");
  });
});
