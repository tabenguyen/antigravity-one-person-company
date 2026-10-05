// Opt-in: runs the setup wizard's company researcher against the REAL `agy` for one domain (AGYHQ_REAL_AGY=1).
// Uses a temp dataDir (never ./data). Costs quota/time (several minutes).
//
//   AGYHQ_REAL_AGY=1 AGYHQ_SETUP_DOMAIN=tracuuhddt.com AGYHQ_SETUP_MODEL=gemini-3.8-flash-high \
//   AGYHQ_SETUP_OUT=/tmp/setup-result.json npx vitest run packages/server/test/real-setup-generate.test.ts

import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EventBus } from "../src/event-bus.ts";
import { SetupJobManager } from "../src/setup/jobs.ts";
import { makeTestConfig, openTestDb } from "./helpers.ts";

const AGY_BIN = path.join(homedir(), ".local/bin/agy");
const ENABLED = process.env.AGYHQ_REAL_AGY === "1" && existsSync(AGY_BIN);
const run = ENABLED ? describe : describe.skip;

run("real setup generation (opt-in, AGYHQ_REAL_AGY=1)", () => {
  it(
    "researches a domain with agy and returns a validated GeneratedSetup",
    async () => {
      const config = makeTestConfig({ agyBin: AGY_BIN });
      const db = openTestDb();
      const bus = new EventBus();
      const manager = new SetupJobManager({ config, db, bus });
      bus.subscribe((e) => {
        if (e.type === "setup.job.progress") console.log(`[setup] ${e.data["line"]}`);
      });
      const domain = process.env.AGYHQ_SETUP_DOMAIN ?? "tracuuhddt.com";
      const model = process.env.AGYHQ_SETUP_MODEL ?? "gemini-3.8-flash-high";
      const started = Date.now();
      const job = manager.start({ domain, extraUrls: [], language: "vi", includeFanpage: true, model });
      await manager.waitFor(job.id);
      const done = manager.get(job.id)!;
      const out = process.env.AGYHQ_SETUP_OUT;
      if (out) writeFileSync(out, JSON.stringify({ ...done, durationMs: Date.now() - started }, null, 2));
      console.log(`[setup] status=${done.status} error=${done.error ?? "-"} duration=${Math.round((Date.now() - started) / 1000)}s`);
      expect(done.error).toBeNull();
      expect(done.status).toBe("done");
      expect(done.result!.roleKb.files).toHaveLength(3);
      expect(done.result!.fanpageKb?.files).toHaveLength(3);
    },
    20 * 60_000,
  );
});
