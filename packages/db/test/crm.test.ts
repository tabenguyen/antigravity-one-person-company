import { describe, expect, it } from "vitest";
import { openDb } from "../src/index.ts";

describe("crm.upsertContact", () => {
  it("dedupes by lowercase email", () => {
    const db = openDb(":memory:");
    const a = db.crm.upsertContact({ email: "Jane@Acme.com", name: "Jane" });
    expect(a.created).toBe(true);
    const b = db.crm.upsertContact({ email: "jane@acme.com", name: "Jane Doe" });
    expect(b.created).toBe(false);
    expect(b.contact.id).toBe(a.contact.id);
    expect(b.contact.name).toBe("Jane Doe");
    expect(b.contact.email).toBe("jane@acme.com");

    const found = db.crm.findContacts({ email: "JANE@ACME.COM" });
    expect(found).toHaveLength(1);
    expect(found[0]!.id).toBe(a.contact.id);
    db.close();
  });

  it("creates a new contact for a different email", () => {
    const db = openDb(":memory:");
    db.crm.upsertContact({ email: "a@x.com" });
    const result = db.crm.upsertContact({ email: "b@x.com" });
    expect(result.created).toBe(true);
    db.close();
  });
});

describe("crm.upsertCompany (via upsertContact)", () => {
  it("dedupes companies by domain", () => {
    const db = openDb(":memory:");
    const a = db.crm.upsertContact({ email: "a@acme.com", companyName: "Acme Inc", companyDomain: "acme.com" });
    const b = db.crm.upsertContact({ email: "b@acme.com", companyName: "Acme Incorporated", companyDomain: "ACME.COM" });
    expect(a.contact.companyId).not.toBeNull();
    expect(b.contact.companyId).toBe(a.contact.companyId);
    db.close();
  });

  it("dedupes companies by case-insensitive name when no domain is given", () => {
    const db = openDb(":memory:");
    const a = db.crm.upsertCompany({ name: "Acme Inc" });
    const b = db.crm.upsertCompany({ name: "acme inc" });
    expect(b.created).toBe(false);
    expect(b.company.id).toBe(a.company.id);
    db.close();
  });
});

describe("crm.setStage / notes / contactView", () => {
  it("records a note and updates stage", () => {
    const db = openDb(":memory:");
    const { contact } = db.crm.upsertContact({ email: "c@x.com", name: "Cara" });
    const updated = db.crm.setStage(contact.id, "qualified", "Replied positively to outreach");
    expect(updated.stage).toBe("qualified");

    const view = db.crm.contactView(contact.id)!;
    expect(view.stage).toBe("qualified");
    expect(view.recentNotes.length).toBeGreaterThan(0);
    expect(view.recentNotes[0]!.body).toContain("qualified");
    db.close();
  });

  it("contactView includes the company and respects the notes limit via listRecentNotes", () => {
    const db = openDb(":memory:");
    const { contact } = db.crm.upsertContact({
      email: "d@x.com",
      companyName: "Beta Co",
      companyDomain: "beta.co",
    });
    for (let i = 0; i < 8; i++) db.crm.addNote("contact", contact.id, `note ${i}`);
    const view = db.crm.contactView(contact.id)!;
    expect(view.company?.name).toBe("Beta Co");
    expect(view.recentNotes).toHaveLength(5); // contactView caps at 5

    const more = db.crm.listRecentNotes("contact", contact.id, 100);
    expect(more.length).toBe(8);
    db.close();
  });

  it("findContacts matches free text across name, email and company name", () => {
    const db = openDb(":memory:");
    db.crm.upsertContact({ email: "findme@x.com", name: "Zed Zebra", companyName: "Zoo Corp" });
    expect(db.crm.findContacts({ query: "Zebra" })).toHaveLength(1);
    expect(db.crm.findContacts({ query: "Zoo Corp" })).toHaveLength(1);
    expect(db.crm.findContacts({ query: "findme" })).toHaveLength(1);
    expect(db.crm.findContacts({ query: "nonexistent" })).toHaveLength(0);
    db.close();
  });
});
