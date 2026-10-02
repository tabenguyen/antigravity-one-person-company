// Wires one Hono app: the admin API (agents/tasks/outbox/memory/kb/contacts/
// quota/audit/events, bearer adminToken) plus the agent-api (/v1/hooks/*,
// /v1/mcp/*, per-run token) that hook scripts and the company MCP server
// talk to from inside an `agy` process. The agent-api itself (auth, the
// PreToolUse policy engine, audit shaping, MCP dispatch) lives in
// ./agent-api/ and is owned by a different part of this build.
import { createAgentApi, RunTokenRegistry } from "./agent-api/index.ts";

import { Hono } from "hono";
import type { EmailProvider } from "@agyhq/core";
import type { Db } from "@agyhq/db";
import type { AgyhqConfig } from "./config.ts";
import { EventBus } from "./event-bus.ts";
import { createAdminApi } from "./admin-api.ts";
import { attachmentsRoot } from "./attachments.ts";
import { roleRouting, roleTaskKinds } from "./routing.ts";
import { Orchestrator } from "./orchestrator.ts";
import { QuotaMonitor } from "./quota.ts";
import { EmailPoller } from "./inbound.ts";
import { Sender } from "./sender.ts";
import { ReadinessMonitor } from "./readiness/monitor.ts";
import { createVerifier } from "./admin-readiness.ts";
import { createUiStaticMiddleware } from "./static-ui.ts";
import { RoutineScheduler } from "./routines/scheduler.ts";
import { EmailRuntime } from "./setup/email-runtime.ts";
import { SecretBox } from "./setup/secrets.ts";
import { SetupJobManager } from "./setup/jobs.ts";

export interface AppHandle {
  app: Hono;
  bus: EventBus;
  tokens: RunTokenRegistry;
  orchestrator: Orchestrator;
  quota: QuotaMonitor;
  /** The live provider (a getter: it changes when the setup wizard saves new email settings). */
  readonly emailProvider: EmailProvider | null;
  readonly emailPoller: EmailPoller;
  emailRuntime: EmailRuntime;
  setupJobs: SetupJobManager;
  sender: Sender;
  readinessMonitor: ReadinessMonitor;
  routineScheduler: RoutineScheduler;
}

/** Build (but don't start listening / polling) the full daemon app + its background workers. */
export function buildApp(config: AgyhqConfig, db: Db): AppHandle {
  const bus = new EventBus();
  const tokens = new RunTokenRegistry();

  const quota = new QuotaMonitor({ config, db, bus });
  const orchestrator = new Orchestrator({ config, db, tokens, bus, quota });

  // The mailbox can be changed at runtime from the setup wizard: everything reads the provider through the runtime.
  const emailRuntime = new EmailRuntime({ config, db, bus, box: new SecretBox(config.dataDir) });
  const setupJobs = new SetupJobManager({ config, db, bus });
  // Mailbox logins are rate-limited by providers: the monitor re-probes at most every 5 minutes.
  const readinessMonitor = new ReadinessMonitor({ config, db, bus, verifyEmail: createVerifier(() => emailRuntime.provider, 300_000) });
  const sender = new Sender({ config, db, bus, provider: () => emailRuntime.provider, beforeSend: () => readinessMonitor.checkIfStale() });
  const routineScheduler = new RoutineScheduler({ db, bus });

  const app = new Hono();
  app.route(
    "/",
    createAdminApi({
      config,
      db,
      bus,
      onRerender: (role) => orchestrator.invalidateTemplateCache(role),
      emailRuntime,
      setupJobs,
      sender,
      runningTasks: () => orchestrator.runningCount,
      quotaThrottled: () => quota.isThrottled(),
    }),
  );
  app.route(
    "/",
    createAgentApi({
      db,
      tokens,
      outboxDailyLimit: config.outboxDailyLimit,
      attachmentsRoot: attachmentsRoot(config.dataDir),
      emit: (t, d) => bus.emit(t, d),
      taskKindsFor: (agent) => roleTaskKinds(config, agent.role),
      followUpKindsFor: (agent) => roleRouting(config, agent?.role ?? "sales-sdr")?.followUpKinds ?? [config.routing.followUpKind],
    }),
  );
  app.use("/*", createUiStaticMiddleware(config.uiDist));

  return {
    app,
    bus,
    tokens,
    orchestrator,
    quota,
    get emailProvider() {
      return emailRuntime.provider;
    },
    emailPoller: emailRuntime.poller,
    emailRuntime,
    setupJobs,
    sender,
    routineScheduler,
    readinessMonitor,
  };
}
