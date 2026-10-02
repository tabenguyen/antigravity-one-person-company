import { describe, expect, it } from "vitest";
import type { ReadinessCheck, ReadinessReport } from "@agyhq/core";
import { openDb } from "@agyhq/db";
import { FakeEmailProvider } from "@agyhq/channels";
import { EventBus } from "../src/event-bus.ts";
import { Sender } from "../src/sender.ts";
import { ReadinessMonitor, readAcknowledged, writeAcknowledged } from "../src/readiness/monitor.ts";
import { makeTestConfig } from "./helpers.ts";

const check = (id: string, status: ReadinessCheck["status"] = "fail"): ReadinessCheck => ({
  id,
  title: `title of ${id}`,
  status,
  detail: "",
  fixPath: null,
});

function setup(initialChecks: ReadinessCheck[] = []) {
  const db = openDb(":memory:");
  const bus = new EventBus();
  const events: string[] = [];
  bus.subscribe((e) => events.push(e.type));
  let checks = initialChecks;
  const compute = async (): Promise<ReadinessReport> => ({
    ready: !checks.some((c) => c.status === "fail"),
    checks,
    at: new Date().toISOString(),
  });
  const config = makeTestConfig({});
  const monitor = new ReadinessMonitor({ config, db, bus, verifyEmail: async () => ({ ok: true }), compute, intervalMs: 60_000 });
  return {
    db,
    bus,
    events,
    config,
    monitor,
    setChecks: (next: ReadinessCheck[]) => {
      checks = next;
    },
    enable: (ack: string[] = []) => {
      db.settings.patch({ outboundEnabled: true, outboundDisabledReason: null });
      writeAcknowledged(db, ack);
    },
  };
}

describe("ReadinessMonitor", () => {
  it("does nothing while outbound is disabled", async () => {
    const { db, monitor } = setup([check("kb.no_placeholders")]);
    const res = await monitor.check();
    expect(res.paused).toBe(false);
    expect(db.settings.get().outboundEnabled).toBe(false);
  });

  it("pauses outbound immediately when a content check fails while sending is on", async () => {
    const { db, events, monitor, enable, setChecks } = setup([check("kb.no_placeholders", "pass")]);
    enable();
    expect((await monitor.check()).paused).toBe(false);

    setChecks([check("kb.no_placeholders"), check("settings.quiet_hours", "warn")]);
    const res = await monitor.check();
    expect(res.paused).toBe(true);
    expect(res.blocking.map((c) => c.id)).toEqual(["kb.no_placeholders"]); // warnings never pause
    const settings = db.settings.get();
    expect(settings.outboundEnabled).toBe(false);
    expect(settings.outboundDisabledReason).toContain("auto-paused");
    expect(settings.outboundDisabledReason).toContain("title of kb.no_placeholders");
    expect(db.audit.list({}).map((a) => a.kind)).toContain("outbound.auto_paused");
    expect(events).toEqual(expect.arrayContaining(["settings.changed", "status.changed", "outbound.auto_paused"]));
  });

  it("respects failures acknowledged by a forced enable, but pauses on a new failure", async () => {
    const { db, monitor, enable, setChecks } = setup([check("company.profile")]);
    enable(["company.profile"]);
    expect((await monitor.check()).paused).toBe(false);
    expect(db.settings.get().outboundEnabled).toBe(true);

    setChecks([check("company.profile"), check("agents.sdr_present")]);
    const res = await monitor.check();
    expect(res.paused).toBe(true);
    expect(res.blocking.map((c) => c.id)).toEqual(["agents.sdr_present"]);
  });

  it("drops an acknowledgement once the check passes, so a later regression pauses", async () => {
    const { db, monitor, enable, setChecks } = setup([check("kb.no_placeholders")]);
    enable(["kb.no_placeholders"]);
    await monitor.check();

    setChecks([check("kb.no_placeholders", "pass")]);
    await monitor.check();
    expect(readAcknowledged(db)).toEqual([]);

    setChecks([check("kb.no_placeholders")]);
    expect((await monitor.check()).paused).toBe(true);
  });

  it("needs two consecutive email.verified failures before pausing", async () => {
    const { db, monitor, enable, setChecks } = setup([check("email.verified")]);
    enable();
    expect((await monitor.check()).paused).toBe(false); // first failure: maybe a network blip
    setChecks([check("email.verified", "pass")]);
    expect((await monitor.check()).paused).toBe(false); // recovered → streak resets
    setChecks([check("email.verified")]);
    expect((await monitor.check()).paused).toBe(false);
    expect((await monitor.check()).paused).toBe(true);
    expect(db.settings.get().outboundEnabled).toBe(false);
  });

  it("is consulted by the sender before each send, so a stale result can't let mail out", async () => {
    const { db, bus, config, enable, setChecks } = setup([]);
    const provider = new FakeEmailProvider();
    const monitor = new ReadinessMonitor({
      config,
      db,
      bus,
      verifyEmail: async () => ({ ok: true }),
      compute: async () => ({ ready: false, checks: [check("kb.no_placeholders")], at: new Date().toISOString() }),
      intervalMs: 0, // always stale
    });
    db.agents.create({ id: "sdr-01", role: "sales-sdr", displayName: "Mai", model: "m", workspacePath: "/tmp/sdr-01", policy: { builtins: [], mcp: [] } });
    db.settings.patch({ quietHours: null });
    const draft = db.outbox.createDraft({ agentId: "sdr-01", channel: "email", to: "lead@acme.com", subject: "Hi", body: "Hello", reason: "r" });
    db.outbox.decide(draft.id, "approved", { decidedBy: "human:ops" });
    enable();
    setChecks([]);

    const sender = new Sender({ config, db, bus, provider, pollIntervalMs: 1_000_000, beforeSend: () => monitor.checkIfStale() });
    await sender.tick();
    expect(provider.sent).toHaveLength(0);
    expect(db.outbox.get(draft.id)?.status).toBe("approved");
    expect(db.settings.get().outboundEnabled).toBe(false);
  });
});
