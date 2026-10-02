// planInbound (the doctor's dry run) must agree with the real router on the same mail.
import { describe, expect, it } from "vitest";
import { openDb, type Db } from "@agyhq/db";
import type { ParsedEmail } from "@agyhq/core";
import { EventBus } from "../src/event-bus.ts";
import { ingestEmail, type InboundCtx } from "../src/inbound.ts";
import { planInbound } from "../src/inbound-plan.ts";
import { makeTestConfig } from "./helpers.ts";

function mail(o: Partial<ParsedEmail> = {}): ParsedEmail {
  return { providerId: "1", messageId: `m-${Math.random()}@x`, inReplyTo: null, references: [], from: { address: "jane@acme.com", name: "Jane" }, to: [{ address: "sdr@ourco.example", name: null }], cc: [], replyTo: null, subject: "Hi", date: null, text: "hello", replyText: "hello", headers: {}, attachments: [], ...o };
}

function world(cfg: { sdr?: boolean; cos?: boolean; am?: boolean } = { sdr: true }) {
  const db: Db = openDb(":memory:");
  const ctx: InboundCtx = { db, bus: new EventBus(), config: makeTestConfig({ sender: { name: "Co", address: "sdr@ourco.example", companyAddressLine: "1 St" } }) };
  const mk = (id: string, role: string) => db.agents.create({ id, role: role as never, displayName: id, model: "m", workspacePath: `/tmp/${id}`, policy: { builtins: [], mcp: [] }, trustTier: "assisted" });
  if (cfg.sdr) { mk("sdr-01", "sales-sdr"); db.settings.patch({ defaultSdrAgentId: "sdr-01" }); }
  if (cfg.cos) { mk("cos-01", "chief-of-staff"); db.settings.patch({ defaultCosAgentId: "cos-01" }); }
  if (cfg.am) { mk("am-01", "account-manager"); db.settings.patch({ defaultAmAgentId: "am-01" }); }
  return { db, ctx };
}

function sentTo(db: Db, to: string, mid: string, agentId = "sdr-01") {
  const d = db.outbox.createDraft({ agentId, channel: "email", to, subject: "s", body: "b", reason: "r", threadKey: `contact:${to}` });
  db.outbox.decide(d.id, "approved"); db.outbox.claimNextToSend(); db.outbox.decide(d.id, "sent", { messageId: mid, sentAt: new Date().toISOString() });
}

type Scenario = { name: string; cfg?: Parameters<typeof world>[0]; setup?: (db: Db) => void; mail: Partial<ParsedEmail> };
const scenarios: Scenario[] = [
  { name: "new lead -> default SDR", mail: {} },
  { name: "new lead, no SDR, no CoS -> parked", cfg: {}, mail: {} },
  { name: "new lead, no SDR, CoS -> triage", cfg: { cos: true }, mail: {} },
  { name: "reply on known thread -> owner", setup: (db) => { db.crm.upsertContact({ email: "jane@acme.com", ownerAgentId: "sdr-01" }); sentTo(db, "jane@acme.com", "ours@x"); }, mail: { inReplyTo: "ours@x", references: ["ours@x"] } },
  { name: "reply, the only SDR is archived, no CoS -> parked", setup: (db) => { sentTo(db, "jane@acme.com", "ours@x"); db.agents.setStatus("sdr-01", "archived"); }, mail: { inReplyTo: "ours@x" } },
  { name: "existing customer writes in -> AM", cfg: { sdr: true, am: true }, setup: (db) => { const { contact } = db.crm.upsertContact({ email: "jane@acme.com" }); db.crm.setStage(contact.id, "customer", "t"); }, mail: {} },
  { name: "auto reply -> ignore", mail: { headers: { "auto-submitted": "auto-replied" } } },
  { name: "spam -> ignore", mail: { headers: { "x-spam-flag": "YES" } } },
  { name: "unsubscribe -> opt_out", mail: { text: "unsubscribe me", replyText: "unsubscribe me" } },
  { name: "own address -> skip", mail: { from: { address: "sdr@ourco.example", name: null } } },
];

describe("planInbound agrees with the real router", () => {
  for (const sc of scenarios) {
    it(sc.name, () => {
      const { db, ctx } = world(sc.cfg ?? { sdr: true });
      sc.setup?.(db);
      const m = mail(sc.mail);
      const plan = planInbound(ctx, m);
      const tasksBefore = db.tasks.list({}).length;
      const contactsBefore = db.crm.findContacts({}).length;
      void tasksBefore; void contactsBefore;
      const planAgain = planInbound(ctx, m);
      expect(planAgain.route).toEqual(plan.route); // pure: planning twice changes nothing
      expect(db.tasks.list({}).length).toBe(tasksBefore);
      expect(db.crm.findContacts({}).length).toBe(contactsBefore);

      const event = ingestEmail(ctx, m);
      if (plan.route.action === "skip") { expect(event).toBeNull(); return; }
      expect(event!.classification).toBe(plan.classification);
      const task = event!.routedTaskId ? db.tasks.get(event!.routedTaskId) : null;
      if (plan.route.action === "task") {
        expect(task).not.toBeNull();
        expect({ agentId: task!.agentId, kind: task!.kind }).toEqual({ agentId: plan.route.agentId, kind: plan.route.taskKind });
      } else {
        expect(task).toBeNull();
        if (plan.route.action === "ignore") expect(event!.status).toBe("ignored");
        if (plan.route.action === "parked") expect(event!.status).toBe("received");
        if (plan.route.action === "opt_out") expect(db.crm.findContacts({ email: "jane@acme.com" })[0]!.attributes.optOut).toBe(true);
      }
    });
  }
});
