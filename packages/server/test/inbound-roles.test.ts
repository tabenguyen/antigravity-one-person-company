import { describe, expect, it } from "vitest";
import type { ParsedEmail } from "@agyhq/core";
import { EventBus } from "../src/event-bus.ts";
import { ingestEmail, ingestWebhookLead, routeInboundEvent, type InboundCtx } from "../src/inbound.ts";
import { addAgent, makePhase4Env } from "./phase4-helpers.ts";

function setup() {
  const env = makePhase4Env({ sender: { name: "Test Co", address: "support@ourco.example", companyAddressLine: "1 St" } });
  const ctx: InboundCtx = { db: env.db, bus: new EventBus(), config: env.config };
  addAgent(env.db, "sdr-01", "sales-sdr");
  addAgent(env.db, "am-01", "account-manager");
  return { ...env, ctx };
}

function email(overrides: Partial<ParsedEmail> = {}): ParsedEmail {
  return {
    providerId: "1",
    messageId: "m1@mail.example",
    inReplyTo: null,
    references: [],
    from: { address: "jane@acme.com", name: "Jane Doe" },
    to: [{ address: "support@ourco.example", name: null }],
    cc: [],
    replyTo: null,
    subject: "Question",
    date: null,
    text: "How do I export orders?",
    replyText: "How do I export orders?",
    headers: {},
    attachments: [],
    ...overrides,
  };
}

/** A contact that has already been emailed on its thread, so the next inbound mail classifies as `reply`. */
function emailedContact(env: ReturnType<typeof setup>, over: { ownerAgentId?: string; stage?: "customer" | "contacted" | "qualified" } = {}) {
  const { contact } = env.db.crm.upsertContact({ email: "jane@acme.com", name: "Jane", ownerAgentId: over.ownerAgentId });
  if (over.stage) env.db.crm.setStage(contact.id, over.stage, "test");
  env.db.outbox.createDraft({ agentId: "sdr-01", channel: "email", to: "jane@acme.com", subject: "Hello", body: "b", reason: "r", threadKey: "contact:jane@acme.com" });
  return contact;
}

describe("inbound routing — role-aware replies", () => {
  it("an SDR-owned reply keeps routing to the SDR's reply kind and cancels its follow-ups", () => {
    const env = setup();
    const contact = emailedContact(env, { ownerAgentId: "sdr-01", stage: "contacted" });
    const followUp = env.db.tasks.create({ agentId: "sdr-01", kind: "sdr.follow_up", title: "fu", threadKey: "contact:jane@acme.com" });
    const event = ingestEmail(env.ctx, email())!;
    expect(event.classification).toBe("reply");
    const task = env.db.tasks.get(event.routedTaskId!)!;
    expect(task).toMatchObject({ agentId: "sdr-01", kind: "sdr.handle_reply", priority: 10 });
    expect(env.db.tasks.get(followUp.id)!.status).toBe("cancelled");
    expect(env.db.crm.getContact(contact.id)!.stage).toBe("replied");
  });

  it("an AM-owned reply becomes am.handle_message with the same input shape, cancelling the AM's check-ins only", () => {
    const env = setup();
    emailedContact(env, { ownerAgentId: "am-01", stage: "customer" });
    const checkIn = env.db.tasks.create({ agentId: "am-01", kind: "am.check_in", title: "ci", threadKey: "contact:jane@acme.com" });
    const sdrFollowUp = env.db.tasks.create({ agentId: "sdr-01", kind: "sdr.follow_up", title: "fu", threadKey: "contact:jane@acme.com" });
    const event = ingestEmail(env.ctx, email())!;
    const task = env.db.tasks.get(event.routedTaskId!)!;
    expect(task).toMatchObject({ agentId: "am-01", kind: "am.handle_message", threadKey: "contact:jane@acme.com" });
    expect(task.input).toMatchObject({ contactName: "Jane", contactEmail: "jane@acme.com", subject: "Question", replyBody: "How do I export orders?", inboundEventId: event.id });
    expect(typeof task.input["threadSummary"]).toBe("string");
    expect(env.db.tasks.get(checkIn.id)!.status).toBe("cancelled");
    expect(env.db.tasks.get(sdrFollowUp.id)!.status).toBe("queued"); // not the AM role's follow-up kind
  });

  it("never downgrades a customer to replied", () => {
    const env = setup();
    const contact = emailedContact(env, { ownerAgentId: "am-01", stage: "customer" });
    ingestEmail(env.ctx, email());
    expect(env.db.crm.getContact(contact.id)!.stage).toBe("customer");
  });

  it("a customer without an owner goes to the default Account Manager, not the SDR", () => {
    const env = setup();
    env.db.settings.patch({ defaultSdrAgentId: "sdr-01", defaultAmAgentId: "am-01" });
    emailedContact(env, { stage: "customer" });
    const task = env.db.tasks.get(ingestEmail(env.ctx, email())!.routedTaskId!)!;
    expect(task).toMatchObject({ agentId: "am-01", kind: "am.handle_message" });
  });

  it("falls back to the default SDR for an unowned lead", () => {
    const env = setup();
    env.db.settings.patch({ defaultSdrAgentId: "sdr-01" });
    emailedContact(env);
    expect(env.db.tasks.get(ingestEmail(env.ctx, email())!.routedTaskId!)!.agentId).toBe("sdr-01");
  });

  it("with no owner and no default agent the event stays received (today's behaviour) when there is no Chief of Staff", () => {
    const env = setup();
    emailedContact(env);
    const event = ingestEmail(env.ctx, email())!;
    expect(event.status).toBe("received");
    expect(event.statusReason).toMatch(/no owning or default agent/);
  });
});

describe("inbound routing — new_lead from a known customer", () => {
  it("routes to the customer's owner as a reply instead of researching a lead", () => {
    const env = setup();
    env.db.settings.patch({ defaultSdrAgentId: "sdr-01" });
    const { contact } = env.db.crm.upsertContact({ email: "jane@acme.com", name: "Jane", ownerAgentId: "am-01" });
    env.db.crm.setStage(contact.id, "customer", "won");
    const event = ingestEmail(env.ctx, email({ providerId: "9", messageId: "m9@mail.example" }))!;
    expect(event.classification).toBe("new_lead");
    const task = env.db.tasks.get(event.routedTaskId!)!;
    expect(task).toMatchObject({ agentId: "am-01", kind: "am.handle_message", threadKey: "contact:jane@acme.com" });
    expect(env.db.crm.getContact(contact.id)!.stage).toBe("customer");
  });

  it("a web-form submission from a customer is routed the same way", () => {
    const env = setup();
    env.db.settings.patch({ defaultSdrAgentId: "sdr-01" });
    const { contact } = env.db.crm.upsertContact({ email: "jane@acme.com", name: "Jane", ownerAgentId: "am-01" });
    env.db.crm.setStage(contact.id, "customer", "won");
    const { event } = ingestWebhookLead(env.ctx, "typeform", { email: "jane@acme.com", message: "Need help with my account" });
    expect(env.db.tasks.get(event.routedTaskId!)).toMatchObject({ agentId: "am-01", kind: "am.handle_message" });
  });

  it("a non-customer contact is still a lead for the default SDR", () => {
    const env = setup();
    env.db.settings.patch({ defaultSdrAgentId: "sdr-01" });
    env.db.crm.upsertContact({ email: "jane@acme.com", name: "Jane", ownerAgentId: "am-01" });
    const event = ingestEmail(env.ctx, email())!;
    expect(env.db.tasks.get(event.routedTaskId!)).toMatchObject({ agentId: "sdr-01", kind: "sdr.research_lead" });
  });
});

describe("inbound routing — Chief of Staff triage", () => {
  it("an `other` event becomes a cos.triage task carrying the roster", () => {
    const env = setup();
    addAgent(env.db, "cos-01", "chief-of-staff");
    addAgent(env.db, "am-old", "account-manager", "archived");
    env.db.settings.patch({ defaultCosAgentId: "cos-01" });
    const event = env.db.inbound.insertIfNew({
      source: "email",
      externalId: "x1",
      fromAddress: "press@news.example",
      fromName: "Press",
      subject: "Interview request",
      bodyText: "Can we interview your CEO?",
      classification: "other",
      payload: {},
    }).event;
    // The email classifier never emits `other` today, so drive the router on the stored event directly.
    routeInboundEvent(env.ctx, event);
    const task = env.db.tasks.get(env.db.inbound.get(event.id)!.routedTaskId!)!;
    expect(task).toMatchObject({ agentId: "cos-01", kind: "cos.triage", priority: 5 });
    expect(task.input).toMatchObject({ inboundEventId: event.id, fromAddress: "press@news.example", subject: "Interview request", classification: "other" });
    const roster = task.input["roster"] as { agentId: string; role: string; kinds: string[] }[];
    expect(roster.map((r) => r.agentId).sort()).toEqual(["am-01", "sdr-01"]); // active, non-CoS only
    expect(roster.find((r) => r.agentId === "am-01")!.kinds).toContain("am.handle_message");
  });

  it("an unroutable reply and an unroutable new_lead go to the Chief of Staff when one is set", () => {
    const env = setup();
    addAgent(env.db, "cos-01", "chief-of-staff");
    env.db.settings.patch({ defaultCosAgentId: "cos-01" });
    emailedContact(env); // reply with no owner and no default SDR/AM
    const reply = ingestEmail(env.ctx, email())!;
    expect(env.db.tasks.get(reply.routedTaskId!)).toMatchObject({ agentId: "cos-01", kind: "cos.triage", priority: 10 });
    expect(env.db.tasks.get(reply.routedTaskId!)!.input["classification"]).toBe("reply");

    const lead = ingestEmail(env.ctx, email({ providerId: "2", messageId: "m2@mail.example", from: { address: "new@other.com", name: "New" } }))!;
    expect(lead.classification).toBe("new_lead");
    expect(env.db.tasks.get(lead.routedTaskId!)).toMatchObject({ agentId: "cos-01", kind: "cos.triage" });
    expect(env.db.crm.findContacts({ email: "new@other.com" })).toHaveLength(1); // the lead is still recorded
  });

  it("a Chief of Staff that is archived is not used", () => {
    const env = setup();
    addAgent(env.db, "cos-01", "chief-of-staff", "archived");
    env.db.settings.patch({ defaultCosAgentId: "cos-01" });
    emailedContact(env);
    expect(ingestEmail(env.ctx, email())!.status).toBe("received");
  });
});
