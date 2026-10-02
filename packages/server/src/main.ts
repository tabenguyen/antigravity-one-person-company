// Daemon entrypoint: open the db, re-render every agent's workspace and sync
// the KB (templates/kb may have changed since the last run), start the
// scheduler + quota poller, and serve the HTTP app. Returns a handle with
// stop() so tests (and the `hq serve` CLI command) can shut it down cleanly.

import fs from "node:fs";
import { serve, type ServerType } from "@hono/node-server";
import { openDb, type Db } from "@agyhq/db";
import { assertBuildArtifacts, type AgyhqConfig } from "./config.ts";
import { rerenderAll } from "./provision.ts";
import { syncKb } from "./kb-ingest.ts";
import { buildApp } from "./app.ts";
import type { EventBus } from "./event-bus.ts";
import type { Orchestrator } from "./orchestrator.ts";
import type { QuotaMonitor } from "./quota.ts";
import { abortAllEvals, failInterruptedEvalRuns } from "./evals/manager.ts";

export interface DaemonHandle {
  db: Db;
  config: AgyhqConfig;
  server: ServerType;
  bus: EventBus;
  orchestrator: Orchestrator;
  quota: QuotaMonitor;
  port: number;
  stop(): Promise<void>;
}

export async function startDaemon(config: AgyhqConfig): Promise<DaemonHandle> {
  assertBuildArtifacts(config);
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.workspacesRoot, { recursive: true });

  const db = openDb(config.dbPath);
  const { app, bus, orchestrator, quota, emailRuntime, setupJobs, sender, routineScheduler, readinessMonitor } = buildApp(config, db);

  // Templates (and company/role KB) may have changed since agents were
  // provisioned or since the daemon last ran — refresh both before the
  // scheduler starts claiming work.
  const rerenderResults = rerenderAll({ config, db });
  const failedRerenders = rerenderResults.filter((r) => !r.ok);
  if (failedRerenders.length > 0) {
    bus.emit("daemon.rerender-warnings", { failures: failedRerenders });
  }
  syncKb({ config, db });

  let serverRef!: ServerType;
  const port = await new Promise<number>((resolve, reject) => {
    try {
      serverRef = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => resolve(info.port));
    } catch (err) {
      reject(err as Error);
    }
  });

  // config.port may have been 0 (OS-assigned ephemeral port, e.g. in tests);
  // reconcile it to the port we actually bound BEFORE the orchestrator starts
  // claiming tasks. orchestrator.ts, provision.ts and admin-api.ts all hold
  // this same config object by reference (from buildApp above), so mutating
  // it here is enough for AGYHQ_API_URL (built fresh per task run) to be
  // correct — without this, every `agy` process gets a dead
  // "http://127.0.0.1:0" and every hook/MCP call fails closed (found via the
  // real end-to-end test: zero tool.pre audit events, hooks' audit spool
  // full of "fetch failed").
  if (config.port !== port) config.port = port;

  orchestrator.start();
  await quota.start();
  readinessMonitor.start();
  sender.start(); // also recovers any outbox item stuck "sending" from a prior crash
  emailRuntime.start();
  failInterruptedEvalRuns(db); // runs a previous process never finished can't resume
  routineScheduler.start();

  return {
    db,
    config,
    server: serverRef,
    bus,
    orchestrator,
    quota,
    port,
    async stop(): Promise<void> {
      routineScheduler.stop();
      await abortAllEvals(db);
      await setupJobs.abortAll();
      await emailRuntime.stop();
      sender.stop();
      readinessMonitor.stop();
      quota.stop();
      await orchestrator.stop();
      await new Promise<void>((resolve, reject) => {
        serverRef.close((err) => (err ? reject(err) : resolve()));
      });
      db.close();
    },
  };
}
