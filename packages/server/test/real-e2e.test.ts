// Opt-in, full-stack end-to-end test: the real daemon (startDaemon — real
// HTTP server, real orchestrator, real quota poller) spawning the REAL `agy`
// CLI against a REAL (built) @agyhq/hooks + @agyhq/mcp workspace, for a
// fictional Sales SDR lead. Exercises the entire chain described in
// docs/PLAN.md: orchestrator -> agy -> hooks (PreToolUse policy gate over
// HTTP) + company MCP (kb_search/crm_*/outbox_draft_email over HTTP) -> back
// into @agyhq/db.
//
// Gated by AGYHQ_REAL_AGY=1 because it shells out to a real model, costs
// quota/time, and needs the hooks/mcp dist/ artifacts built. Skipped
// otherwise. Only two agy invocations (research_lead, then first_touch) —
// "keep agy usage to a handful of runs" per the task brief.

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { startDaemon, type DaemonHandle } from "../src/main.ts";
import { createAgent } from "../src/provision.ts";
import { syncKb } from "../src/kb-ingest.ts";
import { makeTestConfig, REPO_ROOT } from "./helpers.ts";

/** Poll a task to a settled status, logging its status (and a stderr tail
 *  from the latest run.finished audit event, if any) every ~15s so a slow
 *  real model call is visible as progress rather than silence. */
async function waitForTaskSettled(handle: DaemonHandle, taskId: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  let lastLog = 0;
  for (;;) {
    const task = handle.db.tasks.get(taskId)!;
    if (["done", "waiting_approval", "waiting_external", "failed"].includes(task.status)) return;
    const elapsed = Date.now() - start;
    if (elapsed - lastLog > 15_000) {
      lastLog = elapsed;
      // eslint-disable-next-line no-console
      console.info(`[real-e2e] ${taskId} still ${task.status} after ${Math.round(elapsed / 1000)}s (attempts=${task.attempts})`);
    }
    if (elapsed > timeoutMs) {
      const auditTrail = handle.db.audit.list({ taskId, limit: 20 });
      throw new Error(
        `task ${taskId} did not settle within ${timeoutMs}ms (status=${task.status}); recent audit: ${JSON.stringify(auditTrail.map((e) => ({ kind: e.kind, data: e.data })))}`,
      );
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

const AGY_BIN = path.join(homedir(), ".local/bin/agy");
const HOOKS_DIST = path.join(REPO_ROOT, "packages/hooks/dist/pre-tool-use.mjs");
const MCP_DIST = path.join(REPO_ROOT, "packages/mcp/dist/company-mcp.mjs");

const ENABLED = process.env.AGYHQ_REAL_AGY === "1";
const PREREQS_OK = ENABLED && existsSync(AGY_BIN) && existsSync(HOOKS_DIST) && existsSync(MCP_DIST);

const run = PREREQS_OK ? describe : describe.skip;

if (ENABLED && !PREREQS_OK) {
  // eslint-disable-next-line no-console
  console.warn(
    `[real-e2e] AGYHQ_REAL_AGY=1 but prerequisites missing (agy: ${existsSync(AGY_BIN)}, hooks dist: ${existsSync(HOOKS_DIST)}, mcp dist: ${existsSync(MCP_DIST)}) — run "npm run build" first. Skipping.`,
  );
}

const CONTACT_EMAIL = "lan.nguyen@vietnamshop-e2e.example";
const CONTACT_NAME = "Lan Nguyen";
const COMPANY_NAME = "Vietnam E-Commerce Co";
const THREAD_KEY = `contact:${CONTACT_EMAIL}`;

run("real end-to-end: sdr-01 researches and first-touches a fictional lead (opt-in, AGYHQ_REAL_AGY=1)", () => {
  let handle: DaemonHandle;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "agyhq-real-e2e-"));
    const config = makeTestConfig({
      dataDir,
      agyBin: AGY_BIN,
      pollIntervalMs: 500,
      runTimeoutMs: 240_000,
      quota: { minRemainingFraction: 0.15, pollIntervalMs: 600_000 },
    });

    handle = await startDaemon(config);

    createAgent({ config: handle.config, db: handle.db }, { id: "sdr-01", role: "sales-sdr", displayName: "Mai", model: "gemini-3.8-flash-medium" });
    syncKb({ config: handle.config, db: handle.db });

    handle.db.crm.upsertContact({
      email: CONTACT_EMAIL,
      name: CONTACT_NAME,
      title: "Head of Ops",
      companyName: COMPANY_NAME,
      companyDomain: "vietnamshop-e2e.example",
      language: "vi",
      source: "agy-hq phase-1 e2e test (fictional lead)",
    });
  }, 30_000);

  afterAll(async () => {
    await handle?.stop();
    if (dataDir && process.env.AGYHQ_E2E_KEEP_DATA !== "1") rmSync(dataDir, { recursive: true, force: true });
    else if (dataDir) console.info("[real-e2e] kept data dir for inspection:", dataDir);
  });

  it(
    "research_lead then first_touch both complete with a structured result, via real hooks + MCP policy/audit",
    async () => {
      const researchTask = handle.db.tasks.create({
        agentId: "sdr-01",
        kind: "sdr.research_lead",
        title: `Research ${CONTACT_NAME}`,
        threadKey: THREAD_KEY,
        input: {
          contactName: CONTACT_NAME,
          contactEmail: CONTACT_EMAIL,
          leadCompanyName: COMPANY_NAME,
          leadCompanyDomain: "vietnamshop-e2e.example",
          context:
            "Fictional lead for an agy-hq phase-1 end-to-end test: Head of Ops at a 50-person Vietnamese " +
            "e-commerce company, evaluating whether an AI SDR tool is worth a conversation. Not a real company.",
        },
      });

      await waitForTaskSettled(handle, researchTask.id, 230_000);
      const research = handle.db.tasks.get(researchTask.id)!;
      // eslint-disable-next-line no-console
      console.info("[real-e2e] research_lead ->", research.status, JSON.stringify(research.result ?? research.error));
      expect(["done", "waiting_approval"]).toContain(research.status);
      expect(research.result).not.toBeNull();
      expect(research.result!.summary.length).toBeGreaterThan(0);

      const firstTouchTask = handle.db.tasks.create({
        agentId: "sdr-01",
        kind: "sdr.first_touch",
        title: `First touch ${CONTACT_NAME}`,
        threadKey: THREAD_KEY,
        input: {
          contactName: CONTACT_NAME,
          contactEmail: CONTACT_EMAIL,
          leadCompanyName: COMPANY_NAME,
          qualificationSummary: research.result!.summary,
          bantScore: JSON.stringify((research.result!.data as Record<string, unknown> | undefined)?.bantScore ?? "n/a"),
        },
      });

      await waitForTaskSettled(handle, firstTouchTask.id, 230_000);
      const firstTouch = handle.db.tasks.get(firstTouchTask.id)!;
      // eslint-disable-next-line no-console
      console.info("[real-e2e] first_touch ->", firstTouch.status, JSON.stringify(firstTouch.result ?? firstTouch.error));
      expect(["done", "waiting_approval"]).toContain(firstTouch.status);
      expect(firstTouch.result).not.toBeNull();

      // -- Audit: company MCP tool calls were policy-checked (tool.pre) --
      const toolPreEvents = handle.db.audit.list({ agentId: "sdr-01", kind: ["tool.pre"] });
      // eslint-disable-next-line no-console
      console.info(
        "[real-e2e] tool.pre audit events:",
        toolPreEvents.map((e) => e.data),
      );
      expect(toolPreEvents.length).toBeGreaterThan(0);
      const mcpPreEvents = toolPreEvents.filter((e) => (e.data as Record<string, unknown>).toolName === "call_mcp_tool");
      expect(mcpPreEvents.length).toBeGreaterThan(0);

      // -- No denied built-ins/MCP tools that the agent's own policy allows --
      const agent = handle.db.agents.get("sdr-01")!;
      const deniedEvents = handle.db.audit.list({ agentId: "sdr-01", kind: ["tool.denied"] });
      // eslint-disable-next-line no-console
      console.info("[real-e2e] tool.denied audit events:", deniedEvents.map((e) => e.data));
      for (const ev of deniedEvents) {
        const data = ev.data as { toolName?: string; mcpServer?: string; mcpTool?: string };
        if (data.toolName === "call_mcp_tool") {
          const allowed = agent.policy.mcp.some(
            (ref) => (ref.server === data.mcpServer || ref.server === "*") && (ref.tool === data.mcpTool || ref.tool === "*"),
          );
          expect(allowed, `MCP tool ${data.mcpServer}/${data.mcpTool} was denied but is in the agent's policy`).toBe(false);
        } else if (data.toolName) {
          expect(agent.policy.builtins, `builtin "${data.toolName}" was denied but is in the agent's policy`).not.toContain(data.toolName);
        }
      }

      // -- Outbox: a draft was created and is pending approval --
      const outboxItems = handle.db.outbox.list({ agentId: "sdr-01" });
      // eslint-disable-next-line no-console
      console.info(
        "[real-e2e] outbox items:",
        outboxItems.map((o) => ({ id: o.id, to: o.to, subject: o.subject, status: o.status, body: o.body })),
      );
      const pendingDraft = outboxItems.find((o) => o.status === "pending_approval");
      if (pendingDraft) {
        // eslint-disable-next-line no-console
        console.info("[real-e2e] DRAFT EMAIL:\n--- subject ---\n", pendingDraft.subject, "\n--- body ---\n", pendingDraft.body);
      }
      expect(outboxItems.length, "expected at least one outbox draft from first_touch (unless it returned needs_human)").toBeGreaterThanOrEqual(
        firstTouch.status === "waiting_approval" && firstTouch.result?.status === "needs_human" ? 0 : 1,
      );
    },
    520_000,
  );
});
