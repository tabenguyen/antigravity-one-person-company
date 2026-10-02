import fs from "node:fs";
import path from "node:path";
import { FakeEmailProvider } from "@agyhq/channels";
import { createAdminApi } from "../src/admin-api.ts";
import type { AdminApiDeps } from "../src/admin-api.ts";
import { withSetupDefaults } from "../src/admin-setup-wizard.ts";
import { EventBus } from "../src/event-bus.ts";
import type { AgyhqConfig } from "../src/config.ts";
import { makeTempDataDir, makeTestConfig, openTestDb, REPO_ROOT } from "./helpers.ts";

export interface SetupEnv {
  app: ReturnType<typeof createAdminApi>;
  config: AgyhqConfig;
  db: ReturnType<typeof openTestDb>;
  bus: EventBus;
  events: { type: string; data: Record<string, unknown> }[];
  deps: AdminApiDeps;
  call: (method: string, url: string, body?: unknown) => Promise<{ status: number; body: any }>;
}

/** An admin API over a temp data dir with isolated kb/ and templates/ roots (copies of the real templates on request). */
export function buildSetupEnv(opts: { config?: Partial<AgyhqConfig>; deps?: Partial<AdminApiDeps>; realTemplates?: boolean } = {}): SetupEnv {
  const dataDir = makeTempDataDir();
  const templatesRoot = path.join(dataDir, "templates");
  fs.mkdirSync(templatesRoot, { recursive: true });
  if (opts.realTemplates) fs.cpSync(path.join(REPO_ROOT, "templates"), templatesRoot, { recursive: true });
  const config = makeTestConfig({ dataDir, kbRoot: path.join(dataDir, "kb"), templatesRoot, ...opts.config });
  const db = openTestDb();
  const bus = new EventBus();
  const events: SetupEnv["events"] = [];
  bus.subscribe((e) => events.push({ type: e.type, data: e.data }));
  // Fill in the long-lived collaborators here (idempotent) so tests can reach deps.emailRuntime / deps.setupJobs.
  const deps: AdminApiDeps = withSetupDefaults({ config, db, bus, ...opts.deps });
  const app = createAdminApi(deps);
  const headers = { authorization: `Bearer ${config.adminToken}`, "content-type": "application/json" };
  const call: SetupEnv["call"] = async (method, url, body) => {
    const res = await app.request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as any };
  };
  return { app, config, db, bus, events, deps, call };
}

export { FakeEmailProvider };

export const IMAP_INPUT = {
  kind: "imap-smtp" as const,
  address: "sdr@acme.io",
  displayName: "Mai",
  imap: { host: "imap.acme.io", port: 993, secure: true, user: "sdr@acme.io", pass: "imap-secret-1" },
  smtp: { host: "smtp.acme.io", port: 465, secure: true, user: "sdr@acme.io", pass: "smtp-secret-1" },
  mailbox: "INBOX",
  sentFolder: null,
  pollIntervalMs: 60_000,
};
