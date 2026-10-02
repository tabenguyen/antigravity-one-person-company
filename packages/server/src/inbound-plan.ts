// Dry-run of the inbound pipeline: "if this email arrived now, what would the harness do with it?" — creating nothing.
// It reuses the exact pieces ingestEmail/routeInboundEvent use (analyzeInbound, resolveReplyOwner, resolveCos, the
// default-SDR rule), and test/inbound-plan.test.ts runs the plan against the real router on the same scenarios, so the
// two cannot drift apart silently. Used by `hq email doctor` to show classification + would-route-to for real mail.

import type { EmailSignals, InboundClassification, ParsedEmail } from "@agyhq/core";
import { analyzeInbound, resolveCos, resolveReplyOwner, type InboundCtx } from "./inbound.ts";
import { isAssignable } from "./routing.ts";

export type PlannedAction = "task" | "opt_out" | "bounce" | "ignore" | "parked" | "skip";

export interface InboundPlan {
  /** Set when the pipeline would drop the message before classifying it (our own mail). */
  skipped: string | null;
  classification: InboundClassification | null;
  signals: EmailSignals | null;
  threadKey: string | null;
  /** The thread was matched through In-Reply-To/References to mail we know (not just "same sender"). */
  knownThread: boolean;
  contact: { email: string | null; stage: string; ownerAgentId: string | null } | null;
  /** The pipeline would create a new CRM contact for the sender. */
  createsContact: boolean;
  /** Message-ID already ingested: a real poll would not process it again. */
  alreadyIngested: boolean;
  route: {
    action: PlannedAction;
    agentId: string | null;
    agentRole: string | null;
    taskKind: string | null;
    /** One human sentence. */
    summary: string;
  };
}

function task(ctx: Pick<InboundCtx, "db">, agentId: string, taskKind: string, summary: string): InboundPlan["route"] {
  return { action: "task", agentId, agentRole: ctx.db.agents.get(agentId)?.role ?? null, taskKind, summary };
}

function noTask(action: Exclude<PlannedAction, "task">, summary: string): InboundPlan["route"] {
  return { action, agentId: null, agentRole: null, taskKind: null, summary };
}

export function planInbound(ctx: Pick<InboundCtx, "db" | "config">, parsed: ParsedEmail): InboundPlan {
  const analysis = analyzeInbound(ctx, parsed);
  const base = {
    classification: null as InboundClassification | null,
    signals: null as EmailSignals | null,
    threadKey: analysis.threadKey,
    knownThread: analysis.resolvedViaHeaders,
    contact: analysis.contact ? { email: analysis.contact.email, stage: analysis.contact.stage, ownerAgentId: analysis.contact.ownerAgentId } : null,
    createsContact: false,
    alreadyIngested: parsed.messageId ? ctx.db.inbound.findByMessageId(parsed.messageId) !== null : false,
  };

  if (parsed.from?.address && analysis.ours.includes(parsed.from.address.toLowerCase())) {
    return { ...base, skipped: "from our own address", route: noTask("skip", "Ignored: it is from our own address.") };
  }

  const { classification, signals, contact } = analysis;
  const common = { ...base, skipped: null, classification, signals };

  switch (classification) {
    case "unsubscribe":
      return { ...common, route: noTask("opt_out", "Opts the sender out, cancels their queued tasks and rejects pending drafts to them.") };
    case "bounce":
      return {
        ...common,
        route: signals.bouncedRecipient
          ? noTask("bounce", `Marks ${signals.bouncedRecipient} as bounced / do-not-contact.`)
          : noTask("ignore", "Ignored: a bounce notice with no identifiable recipient."),
      };
    case "auto_reply":
      return { ...common, route: noTask("ignore", "Ignored: automatic reply / out-of-office.") };
    case "spam":
      return { ...common, route: noTask("ignore", "Ignored: flagged as spam.") };
    case "reply": {
      const owner = resolveReplyOwner(ctx, contact);
      if (owner) return { ...common, route: task(ctx, owner.agentId, owner.replyKind, `A reply: ${owner.agentId} gets a ${owner.replyKind} task; the thread's follow-ups are cancelled.`) };
      const cos = resolveCos(ctx);
      if (cos) return { ...common, route: task(ctx, cos.id, "cos.triage", `Nobody owns this reply: the Chief of Staff (${cos.id}) triages it.`) };
      return { ...common, route: noTask("parked", "Stays 'received': no owning or default agent is configured for replies.") };
    }
    case "new_lead": {
      if (!parsed.from?.address) return { ...common, route: noTask("ignore", "Ignored: no sender address.") };
      const createsContact = contact === null;
      if (contact?.stage === "customer") {
        const owner = resolveReplyOwner(ctx, contact, { sdrFallback: false });
        if (owner) return { ...common, createsContact, route: task(ctx, owner.agentId, owner.replyKind, `An existing customer wrote in: ${owner.agentId} gets a ${owner.replyKind} task.`) };
      }
      const sdrId = ctx.db.settings.get().defaultSdrAgentId;
      const sdr = sdrId ? ctx.db.agents.get(sdrId) : null;
      if (sdrId && isAssignable(sdr)) {
        return { ...common, createsContact, route: task(ctx, sdrId, ctx.config.routing.newLeadKind, `A new sender: ${createsContact ? "creates a contact and " : ""}${sdrId} gets a ${ctx.config.routing.newLeadKind} task.`) };
      }
      const cos = resolveCos(ctx);
      if (cos) return { ...common, createsContact, route: task(ctx, cos.id, "cos.triage", `No default SDR: the Chief of Staff (${cos.id}) triages it.`) };
      return { ...common, createsContact, route: noTask("parked", "Stays 'received': no default SDR agent is configured.") };
    }
    default: {
      const cos = resolveCos(ctx);
      if (cos) return { ...common, route: task(ctx, cos.id, "cos.triage", `Unclassified: the Chief of Staff (${cos.id}) triages it.`) };
      return { ...common, route: noTask("ignore", "Ignored: unclassified and no Chief of Staff configured.") };
    }
  }
}
