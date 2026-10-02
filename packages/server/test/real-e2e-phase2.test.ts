// Opt-in, full-stack Phase 2 end-to-end test: the real daemon (startDaemon)
// with a maildir EmailProvider, spawning the REAL `agy` CLI for a single
// sdr.handle_reply task, then exercising the full outbound path (admin
// approve -> Sender -> maildir "sent") against the real sender/compose logic.
//
// Flow:
//   1. seed a contact + a previously-*sent* outbox item with a known Message-ID
//   2. drop a reply .eml into maildir inbox, In-Reply-To that Message-ID
//   3. assert the EmailPoller ingests it, classifies it "reply", and routes a
//      sdr.handle_reply task that completes with a drafted reply (outbox
//      pending_approval)
//   4. approve the draft via the admin API, with outboundEnabled=true and
//      quiet hours disabled
//   5. assert the Sender sends it: a .eml lands in maildir "sent" with the
//      correct In-Reply-To/References/List-Unsubscribe headers and footer.
//
// Gated by AGYHQ_REAL_AGY=1 (costs quota/time) — exactly ONE agy invocation.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { startDaemon, type DaemonHandle } from "../src/main.ts";
import { createAgent } from "../src/provision.ts";
import { syncKb } from "../src/kb-ingest.ts";
import { makeTestConfig, REPO_ROOT } from "./helpers.ts";

const AGY_BIN = path.join(homedir(), ".local/bin/agy");
const HOOKS_DIST = path.join(REPO_ROOT, "packages/hooks/dist/pre-tool-use.mjs");
const MCP_DIST = path.join(REPO_ROOT, "packages/mcp/dist/company-mcp.mjs");

const ENABLED = process.env.AGYHQ_REAL_AGY === "1";
const PREREQS_OK = ENABLED && existsSync(AGY_BIN) && existsSync(HOOKS_DIST) && existsSync(MCP_DIST);

const run = PREREQS_OK ? describe : describe.skip;

if (ENABLED && !PREREQS_OK) {
  // eslint-disable-next-line no-console
  console.warn(
    `[real-e2e-phase2] AGYHQ_REAL_AGY=1 but prerequisites missing (agy: ${existsSync(AGY_BIN)}, hooks dist: ${existsSync(HOOKS_DIST)}, mcp dist: ${existsSync(MCP_DIST)}) — run "npm run build" first. Skipping.`,
  );
}

const CONTACT_EMAIL = "lan.nguyen@vietnamshop-e2e-p2.example";
const CONTACT_NAME = "Lan Nguyen";
const COMPANY_NAME = "Vietnam E-Commerce Co (Phase 2 e2e)";
const THREAD_KEY = `contact:${CONTACT_EMAIL}`;
const KNOWN_SENT_MESSAGE_ID = "firsttouch-e2e-p2@ourco.example";
const OUR_ADDRESS = "mai@ourco-e2e-p2.example";

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor(${label}) timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

run("real end-to-end Phase 2: inbound reply -> handle_reply task -> approve -> maildir send (opt-in, AGYHQ_REAL_AGY=1)", () => {
  let handle: DaemonHandle;
  let dataDir: string;
  let maildirRoot: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "agyhq-real-e2e-p2-"));
    maildirRoot = mkdtempSync(path.join(tmpdir(), "agyhq-real-e2e-p2-maildir-"));
    mkdirSync(path.join(maildirRoot, "inbox"), { recursive: true });

    // Drop the reply .eml BEFORE the daemon starts — the maildir provider
    // backfills everything present in inbox/ on its first poll (cursor=null
    // means "start from the top" for maildir, unlike IMAP's "only new from now").
    const replyEml = [
      "Message-ID: <reply1-e2e-p2@mail.example>",
      `In-Reply-To: <${KNOWN_SENT_MESSAGE_ID}>`,
      `References: <${KNOWN_SENT_MESSAGE_ID}>`,
      `From: ${CONTACT_NAME} <${CONTACT_EMAIL}>`,
      `To: Mai <${OUR_ADDRESS}>`,
      "Subject: Re: quick question about your SDR tool",
      "Date: " + new Date().toUTCString(),
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Sounds interesting — can you do Tuesday? What does it cost?",
    ].join("\r\n");
    writeFileSync(path.join(maildirRoot, "inbox", "001.e2e-p2.eml"), replyEml, "utf8");

    const config = makeTestConfig({
      dataDir,
      agyBin: AGY_BIN,
      pollIntervalMs: 500,
      runTimeoutMs: 300_000,
      quota: { minRemainingFraction: 0.15, pollIntervalMs: 600_000 },
      email: { kind: "maildir", root: maildirRoot, address: OUR_ADDRESS, pollIntervalMs: 500 },
      sender: { name: "Mai", address: OUR_ADDRESS, companyAddressLine: "1 Test St, Test City" },
      unsubscribeMailto: "unsubscribe@ourco-e2e-p2.example",
    });

    handle = await startDaemon(config);

    createAgent(
      { config: handle.config, db: handle.db },
      { id: "sdr-01", role: "sales-sdr", displayName: "Mai", model: "gemini-3.8-flash-medium", trustTier: "assisted" },
    );
    syncKb({ config: handle.config, db: handle.db });

    handle.db.crm.upsertContact({
      email: CONTACT_EMAIL,
      name: CONTACT_NAME,
      title: "Head of Ops",
      companyName: COMPANY_NAME,
      companyDomain: "vietnamshop-e2e-p2.example",
      language: "vi",
      ownerAgentId: "sdr-01",
      source: "agy-hq phase-2 e2e test (fictional lead)",
    });

    // Seed a previously-sent first-touch email on this thread, with the known
    // Message-ID the dropped reply's In-Reply-To points at.
    const seedDraft = handle.db.outbox.createDraft({
      agentId: "sdr-01",
      channel: "email",
      to: CONTACT_EMAIL,
      subject: "Quick question about your SDR tool",
      body: "Hi Lan, following up on our AI SDR tool — worth a quick chat?",
      reason: "first touch (e2e seed)",
      threadKey: THREAD_KEY,
    });
    handle.db.outbox.decide(seedDraft.id, "approved", { decidedBy: "human:e2e-seed" });
    handle.db.outbox.claimNextToSend();
    handle.db.outbox.decide(seedDraft.id, "sent", { messageId: KNOWN_SENT_MESSAGE_ID, sentAt: new Date().toISOString() });
  }, 30_000);

  afterAll(async () => {
    await handle?.stop();
    if (dataDir && process.env.AGYHQ_E2E_KEEP_DATA !== "1") rmSync(dataDir, { recursive: true, force: true });
    if (maildirRoot && process.env.AGYHQ_E2E_KEEP_DATA !== "1") rmSync(maildirRoot, { recursive: true, force: true });
    if (process.env.AGYHQ_E2E_KEEP_DATA === "1") {
      // eslint-disable-next-line no-console
      console.info("[real-e2e-phase2] kept data dirs for inspection:", dataDir, maildirRoot);
    }
  });

  it(
    "ingests the reply, runs handle_reply, drafts a reply, and sends it on approval with correct threading + footer",
    async () => {
      // -- 1. Inbound ingestion + deterministic routing (no model call) ------
      await waitFor(() => handle.db.inbound.list().some((e) => e.classification === "reply" && e.status === "routed"), 15_000, "inbound routed");
      const inboundEvent = handle.db.inbound.list().find((e) => e.classification === "reply")!;
      expect(inboundEvent.routedTaskId).not.toBeNull();
      // eslint-disable-next-line no-console
      console.info("[real-e2e-phase2] inbound event:", { id: inboundEvent.id, classification: inboundEvent.classification, status: inboundEvent.status });

      // -- 2. The real agy run: sdr.handle_reply ------------------------------
      const taskId = inboundEvent.routedTaskId!;
      await waitFor(() => ["done", "waiting_approval", "waiting_external", "failed"].includes(handle.db.tasks.get(taskId)!.status), 280_000, "handle_reply settled");
      const task = handle.db.tasks.get(taskId)!;
      // eslint-disable-next-line no-console
      console.info("[real-e2e-phase2] handle_reply task ->", task.status, JSON.stringify(task.result ?? task.error));
      expect(["done", "waiting_approval"]).toContain(task.status);
      expect(task.result).not.toBeNull();

      const draft = handle.db.outbox.list({ agentId: "sdr-01" }).find((o) => o.status === "pending_approval" && o.threadKey === THREAD_KEY);
      // eslint-disable-next-line no-console
      console.info("[real-e2e-phase2] DRAFTED REPLY:\n--- subject ---\n", draft?.subject, "\n--- body ---\n", draft?.body);
      expect(draft, "expected a pending_approval draft reply from handle_reply (unless the agent judged this needs_human with no draft)").toBeTruthy();
      if (!draft) return;

      // -- 3. Approve via the admin API, with outbound enabled + no quiet hours --
      handle.db.settings.patch({ quietHours: null, sendRatePerHour: 1000 });
      const token = handle.config.adminToken;
      // This hermetic daemon has no company profile etc., so readiness fails: enable through the
      // kill switch with force (that acknowledges the known failures, so the readiness monitor
      // doesn't auto-pause sending again).
      const enableRes = await fetch(`http://${handle.config.host}:${handle.port}/v1/admin/killswitch`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ outboundEnabled: true, force: true, reason: "e2e" }),
      });
      expect(enableRes.status).toBe(200);
      const approveRes = await fetch(`http://${handle.config.host}:${handle.port}/v1/admin/outbox/${draft.id}/approve`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ reviewer: "e2e-phase2" }),
      });
      expect(approveRes.status).toBe(200);
      const approved = (await approveRes.json()) as { data: { item: { status: string } } };
      expect(approved.data.item.status).toBe("approved");

      // -- 4. The Sender picks it up and sends via the maildir provider -------
      await waitFor(() => handle.db.outbox.get(draft.id)!.status === "sent", 15_000, "outbox sent");
      const sent = handle.db.outbox.get(draft.id)!;
      expect(sent.messageId).not.toBeNull();

      const sentDir = path.join(maildirRoot, "sent");
      await waitFor(() => existsSync(sentDir) && readdirSync(sentDir).length > 0, 5_000, "sent .eml written");
      const sentFiles = readdirSync(sentDir);
      const sentFile = sentFiles.find((f) => f.includes(sent.messageId!)) ?? sentFiles[0]!;
      const raw = readFileSync(path.join(sentDir, sentFile), "utf8");
      // eslint-disable-next-line no-console
      console.info("[real-e2e-phase2] SENT .eml:\n", raw);

      // In-Reply-To threads to the message we're directly replying to (the inbound
      // reply itself); References accumulates the whole chain, including the
      // original first-touch Message-ID we seeded.
      expect(raw).toContain("In-Reply-To: <reply1-e2e-p2@mail.example>");
      expect(raw).toMatch(/References:[\s\S]*reply1-e2e-p2@mail\.example/);
      expect(raw).toContain(KNOWN_SENT_MESSAGE_ID); // present in References too
      expect(raw.toLowerCase()).toContain("list-unsubscribe:");
      expect(raw).toContain("unsubscribe@ourco-e2e-p2.example");
      expect(raw).toContain("1 Test St, Test City"); // footer company address line
    },
    330_000,
  );
});
