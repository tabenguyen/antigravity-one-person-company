import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { openDb, type Db } from "@agyhq/db";
import type { AgyhqConfig } from "../src/config.ts";

export const REPO_ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "../../..");
export const FAKE_AGY = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "fixtures/fake-agy.mjs");

export function makeTempDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agyhq-test-"));
}

export function makeTestConfig(overrides: Partial<AgyhqConfig> = {}): AgyhqConfig {
  const dataDir = overrides.dataDir ?? makeTempDataDir();
  return {
    dataDir,
    dbPath: path.join(dataDir, "agyhq.db"),
    workspacesRoot: path.join(dataDir, "workspaces"),
    host: "127.0.0.1",
    port: 0,
    adminToken: "test-admin-token",
    companyName: "Test Co",
    templatesRoot: path.join(REPO_ROOT, "templates"),
    kbRoot: path.join(dataDir, "kb-empty"),
    agyBin: FAKE_AGY,
    nodeBin: process.execPath,
    hooksDistDir: path.join(REPO_ROOT, "packages/hooks/dist"),
    mcpEntry: path.join(REPO_ROOT, "packages/mcp/dist/company-mcp.mjs"),
    workerConcurrency: 3,
    pollIntervalMs: 30,
    runTimeoutMs: 5_000,
    quota: { minRemainingFraction: 0.15, pollIntervalMs: 60_000 },
    outboxDailyLimit: 50,
    configPath: null,
    email: { kind: "none", pollIntervalMs: 60_000 },
    sender: { name: "Test Co", address: "sdr@test.example", companyAddressLine: "123 Test St, Test City" },
    unsubscribeMailto: "unsubscribe@test.example",
    webhooks: {},
    routing: { replyKind: "sdr.handle_reply", newLeadKind: "sdr.research_lead", followUpKind: "sdr.follow_up" },
    uiDist: path.join(REPO_ROOT, "packages/ui/dist"),
    ...overrides,
  };
}

export function openTestDb(): Db {
  return openDb(":memory:");
}

export async function waitFor(predicate: () => boolean, timeoutMs = 5000, intervalMs = 15): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: condition not met within timeout");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export const RESEARCH_LEAD_INPUT = {
  contactName: "Lan Nguyen",
  contactEmail: "lan@example.com",
  leadCompanyName: "Example Co",
  leadCompanyDomain: "example.com",
  context: "inbound demo request",
};
