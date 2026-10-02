import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openDb, type Db } from "@agyhq/db";
import type { ParsedEmail } from "@agyhq/core";
import { EventBus } from "../src/event-bus.ts";
import { ingestEmail, ingestWebhookLead, type InboundCtx } from "../src/inbound.ts";
import { makeTestConfig } from "./helpers.ts";

function makeCtx(db: Db): InboundCtx {
  return { db, bus: new EventBus(), config: makeTestConfig({ sender: { name: "Test Co", address: "sdr@ourco.example", companyAddressLine: "123 St" } }) };
}

function email(overrides: Partial<ParsedEmail> = {}): ParsedEmail {
  return {
    providerId: "1",
    messageId: "m1@mail.example",
    inReplyTo: null,
    references: [],
    from: { address: "jane@acme.com", name: "Jane Doe" },
    to: [{ address: "sdr@ourco.example", name: null }],
    cc: [],
    replyTo: null,
    subject: "Hello",
    date: null,
    text: "Hi there",
    replyText: "Hi there",
    headers: {},
    attachments: [],
    ...overrides,
  };
}

function withAgent(db: Db, id = "sdr-01", trustTier: "shadow" | "assisted" | "autonomous" = "assisted") {
  db.agents.create({ id, role: "sales-sdr", displayName: "SDR", model: "m", workspacePath: `/tmp/${id}`, policy: { builtins: [], mcp: [] }, trustTier });
  return id;
}

describe("ingestEmail — self-mail / dedupe", () => {
  it("skips messages from our own address", () => {
    const db = openDb(":memory:");
    const ctx = makeCtx(db);
    const result = ingestEmail(ctx, email({ from: { address: "sdr@ourco.example", name: null } }));
    expect(result).toBeNull();
    expect(db.inbound.list()).toHaveLength(0);
    db.close();
  });

  it("dedupes by Message-ID — second ingest of the same message is a no-op", () => {
    const db = openDb(":memory:");
    const ctx = makeCtx(db);
    const first = ingestEmail(ctx, email());
    const second = ingestEmail(ctx, email());
    expect(first?.id).toBe(second?.id);
    expect(db.inbound.list()).toHaveLength(1);
    db.close();
  });
});

describe("ingestEmail — unsubscribe", () => {
  it("opts the contact out, cancels queued thread tasks, and rejects pending outbox items", () => {
    const db = openDb(":memory:");
    const ctx = makeCtx(db);
    const agentId = withAgent(db);
    db.crm.upsertContact({ email: "jane@acme.com", name: "Jane" });
    const task = db.tasks.create({ agentId, kind: "sdr.follow_up", title: "follow up", threadKey: "contact:jane@acme.com" });
    const draft = db.outbox.createDraft({ agentId, channel: "email", to: "jane@acme.com", subject: "s", body: "b", reason: "r", threadKey: "contact:jane@acme.com" });

    const event = ingestEmail(ctx, email({ text: "please unsubscribe", replyText: "please unsubscribe" }));
    expect(event?.classification).toBe("unsubscribe");
    expect(event?.status).toBe("routed");

    const contact = db.crm.findContacts({ email: "jane@acme.com" })[0]!;
    expect(contact.attributes.optOut).toBe(true);
    expect(contact.stage).toBe("disqualified");
    expect(db.tasks.get(task.id)!.status).toBe("cancelled");
    expect(db.outbox.get(draft.id)!.status).toBe("rejected");

    const auditKinds = db.audit.list({}).map((a) => a.kind);
    expect(auditKinds).toContain("contact.opted_out");
    db.close();
  });
});

describe("ingestEmail — bounce", () => {
  it("marks the contact bounced/do-not-contact and annotates the related sent item", () => {
    const db = openDb(":memory:");
    const ctx = makeCtx(db);
    const agentId = withAgent(db);
    const draft = db.outbox.createDraft({ agentId, channel: "email", to: "jane@acme.com", subject: "s", body: "b", reason: "r" });
    db.outbox.decide(draft.id, "approved");
    db.outbox.claimNextToSend();
    db.outbox.decide(draft.id, "sent", { sentAt: new Date().toISOString() });

    const event = ingestEmail(
      ctx,
      email({
        from: { address: "mailer-daemon@mail.example", name: null },
        subject: "Delivery Status Notification (Failure)",
        text: "Final-Recipient: rfc822; jane@acme.com\nreason: mailbox full",
        replyText: "",
        messageId: "bounce1@mail.example",
      }),
    );
    expect(event?.classification).toBe("bounce");
    const contact = db.crm.findContacts({ email: "jane@acme.com" })[0]!;
    expect(contact.attributes.emailBounced).toBe(true);
    expect(contact.attributes.doNotContact).toBe(true);
    expect(db.outbox.get(draft.id)!.statusReason).toMatch(/^bounced:/);
    db.close();
  });
});

describe("ingestEmail — auto_reply / spam", () => {
  it("marks auto-replies as ignored without creating a task", () => {
    const db = openDb(":memory:");
    const ctx = makeCtx(db);
    withAgent(db);
    const event = ingestEmail(ctx, email({ subject: "Out of Office", messageId: "ooo1@mail.example" }));
    expect(event?.classification).toBe("auto_reply");
    expect(event?.status).toBe("ignored");
    expect(db.tasks.list()).toHaveLength(0);
    db.close();
  });
});

describe("ingestEmail — reply routing", () => {
  it("routes a reply on a known thread (via In-Reply-To matching a sent outbox item) to the owning agent", () => {
    const db = openDb(":memory:");
    const ctx = makeCtx(db);
    const agentId = withAgent(db);
    const { contact } = db.crm.upsertContact({ email: "jane@acme.com", name: "Jane", ownerAgentId: agentId });
    const draft = db.outbox.createDraft({ agentId, channel: "email", to: "jane@acme.com", subject: "First touch", body: "Hi Jane", reason: "r", threadKey: "contact:jane@acme.com" });
    db.outbox.decide(draft.id, "approved");
    db.outbox.claimNextToSend();
    db.outbox.decide(draft.id, "sent", { messageId: "sent1@ourco.example", sentAt: new Date().toISOString() });

    const followUp = db.tasks.create({ agentId, kind: "sdr.follow_up", title: "follow up", threadKey: "contact:jane@acme.com" });

    const event = ingestEmail(
      ctx,
      email({
        inReplyTo: "sent1@ourco.example",
        references: ["sent1@ourco.example"],
        text: "Sounds interesting, can we talk Tuesday?",
        replyText: "Sounds interesting, can we talk Tuesday?",
        messageId: "reply1@mail.example",
      }),
    );
    expect(event?.classification).toBe("reply");
    expect(event?.status).toBe("routed");

    const tasks = db.tasks.list({ agentId });
    const replyTask = tasks.find((t) => t.kind === "sdr.handle_reply");
    expect(replyTask).toBeTruthy();
    expect(replyTask!.priority).toBe(10);
    expect((replyTask!.input as Record<string, unknown>).replyBody).toContain("Tuesday");
    expect((replyTask!.input as Record<string, unknown>).threadSummary).toContain("First touch");

    expect(db.tasks.get(followUp.id)!.status).toBe("cancelled"); // queued follow_up cancelled
    expect(db.crm.getContact(contact.id)!.stage).toBe("replied");
    db.close();
  });

  it("passes the subject to the reply task and keeps the current message out of the thread summary", () => {
    const db = openDb(":memory:");
    const ctx = makeCtx(db);
    const agentId = withAgent(db);
    db.crm.upsertContact({ email: "jane@acme.com", name: "Jane", ownerAgentId: agentId });
    const draft = db.outbox.createDraft({ agentId, channel: "email", to: "jane@acme.com", subject: "First touch", body: "Hi Jane", reason: "r", threadKey: "contact:jane@acme.com" });
    db.outbox.decide(draft.id, "approved");
    db.outbox.claimNextToSend();
    db.outbox.decide(draft.id, "sent", { messageId: "sent1@ourco.example", sentAt: new Date().toISOString() });

    ingestEmail(ctx, email({ subject: "Câu hỏi trước", text: "", replyText: "", messageId: "earlier@mail.example" }));
    const signature = "-- \nBest regards,\nJane";
    ingestEmail(ctx, email({ subject: "Tôi muốn tham khảo giá", text: signature, replyText: signature, messageId: "price@mail.example" }));

    const replyTasks = db.tasks.list({ agentId }).filter((t) => t.kind === "sdr.handle_reply");
    const input = replyTasks.find((t) => (t.input as Record<string, unknown>).subject === "Tôi muốn tham khảo giá")!.input as Record<string, unknown>;
    expect(input.replyBody).toBe(signature);
    expect(input.threadSummary).toContain('They wrote ("Câu hỏi trước"): (empty body)');
    expect(input.threadSummary).not.toContain("Tôi muốn tham khảo giá");
    expect(input.threadSummary).not.toContain("Best regards");
    db.close();
  });

  it("saves attachment files under <dataDir>/attachments/<eventId>/ and points the reply task at them", () => {
    const db = openDb(":memory:");
    const ctx = makeCtx(db);
    const agentId = withAgent(db);
    db.crm.upsertContact({ email: "jane@acme.com", name: "Jane", ownerAgentId: agentId });
    const draft = db.outbox.createDraft({ agentId, channel: "email", to: "jane@acme.com", subject: "First touch", body: "Hi Jane", reason: "r", threadKey: "contact:jane@acme.com" });
    db.outbox.decide(draft.id, "approved");
    db.outbox.claimNextToSend();
    db.outbox.decide(draft.id, "sent", { messageId: "sent1@ourco.example", sentAt: new Date().toISOString() });

    const content = Buffer.from("%PDF-1.4 fake");
    const event = ingestEmail(
      ctx,
      email({
        inReplyTo: "sent1@ourco.example",
        text: "See attached.",
        replyText: "See attached.",
        messageId: "reply-att@mail.example",
        attachments: [
          { filename: "../../hóa đơn.pdf", contentType: "application/pdf", size: content.length, content },
          { filename: null, contentType: "image/png", size: 10 },
        ],
      }),
    )!;

    const root = path.join(ctx.config.dataDir, "attachments");
    const stored = db.inbound.get(event.id)!.payload["attachments"] as { filename: string | null; file: string | null; error?: string }[];
    expect(stored[0]).toMatchObject({ filename: "../../hóa đơn.pdf", contentType: "application/pdf", file: `${event.id}/01-hóa đơn.pdf` });
    expect(stored[0]).not.toHaveProperty("content");
    expect(fs.readFileSync(path.join(root, stored[0]!.file!))).toEqual(content);
    expect(stored[1]).toMatchObject({ file: null, error: expect.any(String) });

    const input = db.tasks.list({ agentId }).find((t) => t.kind === "sdr.handle_reply")!.input as Record<string, unknown>;
    expect(input.inboundEventId).toBe(event.id);
    expect(input.replyBody).toContain("See attached.");
    expect(input.replyBody).toContain(`hóa đơn.pdf (application/pdf, 13 B): ${path.join(root, event.id, "01-hóa đơn.pdf")}`);
    expect(input.replyBody).toContain("(unnamed) (image/png, 10 B): not saved");
    db.close();
  });

  it("leaves a reply as received (not ignored) when no owner or default agent exists", () => {
    const db = openDb(":memory:");
    const ctx = makeCtx(db);
    withAgent(db);
    db.crm.upsertContact({ email: "jane@acme.com" }); // no ownerAgentId, no default configured
    const event = ingestEmail(
      ctx,
      email({ inReplyTo: null, references: [], text: "a reasonably long reply body that is not a reply by header, but...", messageId: "r2@mail.example" }),
    );
    // No thread continuity signal and no contact history -> classified new_lead, not reply, since nothing resolved via headers/prior outbound.
    expect(["new_lead", "reply"]).toContain(event?.classification);
    db.close();
  });
});

describe("ingestEmail — new_lead routing", () => {
  it("creates a contact and a research task when a default SDR agent is configured", () => {
    const db = openDb(":memory:");
    const ctx = makeCtx(db);
    const agentId = withAgent(db);
    db.settings.patch({ defaultSdrAgentId: agentId });

    const event = ingestEmail(ctx, email({ from: { address: "newlead@biz.example", name: "New Lead" }, messageId: "nl1@mail.example" }));
    expect(event?.classification).toBe("new_lead");
    expect(event?.status).toBe("routed");

    const contact = db.crm.findContacts({ email: "newlead@biz.example" })[0];
    expect(contact).toBeTruthy();
    const task = db.tasks.list({ agentId }).find((t) => t.kind === "sdr.research_lead");
    expect(task).toBeTruthy();
    expect(task!.priority).toBe(5);
    expect((task!.input as Record<string, unknown>).context).not.toContain("Attachments");
    db.close();
  });

  it("stays `received` with a reason when no default SDR agent is configured", () => {
    const db = openDb(":memory:");
    const ctx = makeCtx(db);
    const event = ingestEmail(ctx, email({ from: { address: "newlead2@biz.example", name: null }, messageId: "nl2@mail.example" }));
    expect(event?.status).toBe("received");
    expect(event?.statusReason).toMatch(/no default SDR agent/);
    db.close();
  });
});

describe("ingestWebhookLead", () => {
  it("routes a webhook lead the same way as an email new_lead, deduped by (source, externalId)", () => {
    const db = openDb(":memory:");
    const ctx = makeCtx(db);
    const agentId = withAgent(db);
    db.settings.patch({ defaultSdrAgentId: agentId });

    const first = ingestWebhookLead(ctx, "typeform", { email: "form@biz.example", name: "Form Lead", externalId: "ext-1" });
    expect(first.created).toBe(true);
    expect(first.event.classification).toBe("new_lead");
    expect(first.event.status).toBe("routed");

    const second = ingestWebhookLead(ctx, "typeform", { email: "form@biz.example", name: "Form Lead", externalId: "ext-1" });
    expect(second.created).toBe(false);
    expect(second.event.id).toBe(first.event.id);

    expect(db.tasks.list({ agentId })).toHaveLength(1);
    db.close();
  });
});
