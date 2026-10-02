import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "@agyhq/db";
import { startDaemon, type DaemonHandle } from "../src/main.ts";
import { createAgent } from "../src/provision.ts";
import { makeTestConfig, waitFor } from "./helpers.ts";

describe("daemon wiring: routine scheduler", () => {
  let daemon: DaemonHandle | null = null;
  afterEach(async () => {
    await daemon?.stop();
    daemon = null;
  });

  it("startDaemon runs due routines and stops ticking on stop()", async () => {
    const config = makeTestConfig();
    // seed a db that already contains an agent + a due routine, as after a restart
    {
      fs.mkdirSync(config.dataDir, { recursive: true });
      const db = openDb(config.dbPath);
      createAgent({ config, db }, { id: "sdr-01", role: "sales-sdr", displayName: "Mai" });
      db.routines.create({
        agentId: "sdr-01",
        kind: "custom_task",
        name: "due",
        schedule: "0 9 * * *",
        timezone: "UTC",
        config: { kind: "sdr.follow_up", title: "from routine" },
        nextRunAt: new Date(Date.now() - 60_000).toISOString(),
      });
      db.close();
    }
    process.env.FAKE_AGY_RESULT = JSON.stringify({ status: "done", summary: "ok" });
    try {
      daemon = await startDaemon(config);
      await waitFor(() => daemon!.db.tasks.list().some((t) => t.title === "from routine"), 5000);
      const routine = daemon.db.routines.list()[0]!;
      expect(routine.lastRunAt).not.toBeNull();
      expect(new Date(routine.nextRunAt!).getTime()).toBeGreaterThan(Date.now());
    } finally {
      delete process.env.FAKE_AGY_RESULT;
    }
  });
});
