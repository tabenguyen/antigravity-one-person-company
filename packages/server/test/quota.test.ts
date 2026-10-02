import { describe, it, expect, afterEach } from "vitest";
import { QuotaMonitor } from "../src/quota.ts";
import { EventBus } from "../src/event-bus.ts";
import { makeTestConfig, openTestDb } from "./helpers.ts";

describe("QuotaMonitor", () => {
  const monitors: QuotaMonitor[] = [];
  afterEach(() => {
    delete process.env.FAKE_AGY_QUOTA_FRACTION;
    for (const m of monitors.splice(0)) m.stop();
  });

  it("records a snapshot and is not throttled when quota is healthy", async () => {
    process.env.FAKE_AGY_QUOTA_FRACTION = "0.8";
    const config = makeTestConfig({ quota: { minRemainingFraction: 0.15, pollIntervalMs: 60_000 } });
    const db = openTestDb();
    const bus = new EventBus();
    const monitor = new QuotaMonitor({ config, db, bus });
    monitors.push(monitor);

    await monitor.start();

    expect(monitor.isThrottled()).toBe(false);
    const snapshot = db.quota.latest();
    expect(snapshot?.buckets[0]?.remainingFraction).toBe(0.8);
    db.close();
  });

  it("throttles when any bucket drops below minRemainingFraction", async () => {
    process.env.FAKE_AGY_QUOTA_FRACTION = "0.05";
    const config = makeTestConfig({ quota: { minRemainingFraction: 0.15, pollIntervalMs: 60_000 } });
    const db = openTestDb();
    const bus = new EventBus();
    const events: string[] = [];
    bus.subscribe((e) => events.push(e.type));
    const monitor = new QuotaMonitor({ config, db, bus });
    monitors.push(monitor);

    await monitor.start();

    expect(monitor.isThrottled()).toBe(true);
    expect(events).toContain("quota.throttle");
    db.close();
  });

  it("never throws even if the underlying agy binary fails", async () => {
    const config = makeTestConfig({ agyBin: "/no/such/binary-xyz", quota: { minRemainingFraction: 0.15, pollIntervalMs: 60_000 } });
    const db = openTestDb();
    const bus = new EventBus();
    const monitor = new QuotaMonitor({ config, db, bus });
    monitors.push(monitor);

    await expect(monitor.start()).resolves.toBeUndefined();
    expect(monitor.isThrottled()).toBe(false);
    expect(db.quota.latest()).toBeNull();
    db.close();
  });
});
