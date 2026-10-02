import type Database from "better-sqlite3";
import type { Company, Contact, ContactView, LeadStage, Note } from "@agyhq/core";
import { newId, nowIso } from "@agyhq/core";
import { fromJson, toJson } from "../util.ts";
import { NotFoundError } from "../errors.ts";

type SqliteDb = Database.Database;

interface CompanyRow {
  id: string;
  name: string;
  domain: string | null;
  industry: string | null;
  size: string | null;
  country: string | null;
  attributes: string;
  created_at: string;
  updated_at: string;
}

interface ContactRow {
  id: string;
  email: string | null;
  name: string | null;
  title: string | null;
  company_id: string | null;
  phone: string | null;
  linkedin_url: string | null;
  language: string | null;
  stage: string;
  owner_agent_id: string | null;
  source: string | null;
  attributes: string;
  created_at: string;
  updated_at: string;
}

interface NoteRow {
  id: string;
  subject_type: string;
  subject_id: string;
  author_agent_id: string | null;
  body: string;
  created_at: string;
}

function mapCompany(row: CompanyRow): Company {
  return {
    id: row.id,
    name: row.name,
    domain: row.domain,
    industry: row.industry,
    size: row.size,
    country: row.country,
    attributes: fromJson(row.attributes, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapContact(row: ContactRow): Contact {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    title: row.title,
    companyId: row.company_id,
    phone: row.phone,
    linkedinUrl: row.linkedin_url,
    language: row.language,
    stage: row.stage as LeadStage,
    ownerAgentId: row.owner_agent_id,
    source: row.source,
    attributes: fromJson(row.attributes, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapNote(row: NoteRow): Note {
  return {
    id: row.id,
    subjectType: row.subject_type as "contact" | "company",
    subjectId: row.subject_id,
    authorAgentId: row.author_agent_id,
    body: row.body,
    createdAt: row.created_at,
  };
}

export interface UpsertCompanyInput {
  name: string;
  domain?: string | null;
  industry?: string | null;
  size?: string | null;
  country?: string | null;
  attributes?: Record<string, unknown>;
}

export interface UpsertContactInput {
  email: string;
  name?: string | null;
  title?: string | null;
  phone?: string | null;
  linkedinUrl?: string | null;
  language?: string | null;
  source?: string | null;
  ownerAgentId?: string | null;
  companyName?: string;
  companyDomain?: string;
  attributes?: Record<string, unknown>;
}

export interface FindContactQuery {
  email?: string;
  id?: string;
  query?: string;
}

export class CrmRepo {
  #db: SqliteDb;

  constructor(db: SqliteDb) {
    this.#db = db;
  }

  // -- Companies -------------------------------------------------------

  /** Upsert by domain (case-insensitive) if given, else by case-insensitive name. */
  upsertCompany(input: UpsertCompanyInput): { company: Company; created: boolean } {
    const apply = this.#db.transaction((): { company: Company; created: boolean } => {
      let existing: CompanyRow | undefined;
      if (input.domain) {
        existing = this.#db
          .prepare("SELECT * FROM companies WHERE domain IS NOT NULL AND lower(domain) = lower(?)")
          .get(input.domain) as CompanyRow | undefined;
      }
      if (!existing) {
        existing = this.#db
          .prepare("SELECT * FROM companies WHERE name = ? COLLATE NOCASE")
          .get(input.name) as CompanyRow | undefined;
      }

      const now = nowIso();
      if (existing) {
        const merged: Company = {
          id: existing.id,
          name: input.name || existing.name,
          domain: input.domain ?? existing.domain,
          industry: input.industry ?? existing.industry,
          size: input.size ?? existing.size,
          country: input.country ?? existing.country,
          attributes: { ...fromJson<Record<string, unknown>>(existing.attributes, {}), ...(input.attributes ?? {}) },
          createdAt: existing.created_at,
          updatedAt: now,
        };
        this.#db
          .prepare(
            `UPDATE companies SET name = @name, domain = @domain, industry = @industry, size = @size,
               country = @country, attributes = @attributes, updated_at = @updatedAt WHERE id = @id`,
          )
          .run({ ...merged, attributes: toJson(merged.attributes) });
        return { company: merged, created: false };
      }

      const company: Company = {
        id: newId("cmp"),
        name: input.name,
        domain: input.domain ?? null,
        industry: input.industry ?? null,
        size: input.size ?? null,
        country: input.country ?? null,
        attributes: input.attributes ?? {},
        createdAt: now,
        updatedAt: now,
      };
      this.#db
        .prepare(
          `INSERT INTO companies (id, name, domain, industry, size, country, attributes, created_at, updated_at)
           VALUES (@id, @name, @domain, @industry, @size, @country, @attributes, @createdAt, @updatedAt)`,
        )
        .run({ ...company, attributes: toJson(company.attributes) });
      return { company, created: true };
    });
    return apply();
  }

  getCompany(id: string): Company | null {
    const row = this.#db.prepare("SELECT * FROM companies WHERE id = ?").get(id) as CompanyRow | undefined;
    return row ? mapCompany(row) : null;
  }

  // -- Contacts ----------------------------------------------------------

  /** Upsert by lowercase email. Resolves/creates the company by domain or name when given. */
  upsertContact(input: UpsertContactInput): { contact: ContactView; created: boolean } {
    const apply = this.#db.transaction((): { contact: Contact; created: boolean } => {
      const email = input.email.toLowerCase();
      let companyId: string | null = null;
      if (input.companyDomain || input.companyName) {
        const { company } = this.upsertCompany({
          name: input.companyName ?? input.companyDomain!,
          domain: input.companyDomain ?? null,
        });
        companyId = company.id;
      }

      const existing = this.#db.prepare("SELECT * FROM contacts WHERE email = ?").get(email) as
        | ContactRow
        | undefined;
      const now = nowIso();

      if (existing) {
        const merged: Contact = {
          id: existing.id,
          email,
          name: input.name ?? existing.name,
          title: input.title ?? existing.title,
          companyId: companyId ?? existing.company_id,
          phone: input.phone ?? existing.phone,
          linkedinUrl: input.linkedinUrl ?? existing.linkedin_url,
          language: input.language ?? existing.language,
          stage: existing.stage as LeadStage,
          ownerAgentId: input.ownerAgentId ?? existing.owner_agent_id,
          source: input.source ?? existing.source,
          attributes: { ...fromJson<Record<string, unknown>>(existing.attributes, {}), ...(input.attributes ?? {}) },
          createdAt: existing.created_at,
          updatedAt: now,
        };
        this.#db
          .prepare(
            `UPDATE contacts SET name = @name, title = @title, company_id = @companyId, phone = @phone,
               linkedin_url = @linkedinUrl, language = @language, owner_agent_id = @ownerAgentId,
               source = @source, attributes = @attributes, updated_at = @updatedAt
             WHERE id = @id`,
          )
          .run({
            id: merged.id,
            name: merged.name,
            title: merged.title,
            companyId: merged.companyId,
            phone: merged.phone,
            linkedinUrl: merged.linkedinUrl,
            language: merged.language,
            ownerAgentId: merged.ownerAgentId,
            source: merged.source,
            attributes: toJson(merged.attributes),
            updatedAt: merged.updatedAt,
          });
        return { contact: merged, created: false };
      }

      const contact: Contact = {
        id: newId("ctc"),
        email,
        name: input.name ?? null,
        title: input.title ?? null,
        companyId,
        phone: input.phone ?? null,
        linkedinUrl: input.linkedinUrl ?? null,
        language: input.language ?? null,
        stage: "new",
        ownerAgentId: input.ownerAgentId ?? null,
        source: input.source ?? null,
        attributes: input.attributes ?? {},
        createdAt: now,
        updatedAt: now,
      };
      this.#db
        .prepare(
          `INSERT INTO contacts
             (id, email, name, title, company_id, phone, linkedin_url, language, stage, owner_agent_id, source, attributes, created_at, updated_at)
           VALUES (@id, @email, @name, @title, @companyId, @phone, @linkedinUrl, @language, @stage, @ownerAgentId, @source, @attributes, @createdAt, @updatedAt)`,
        )
        .run({ ...contact, attributes: toJson(contact.attributes) });
      return { contact, created: true };
    });

    const { contact, created } = apply();
    return { contact: this.contactView(contact.id)!, created };
  }

  getContact(id: string): Contact | null {
    const row = this.#db.prepare("SELECT * FROM contacts WHERE id = ?").get(id) as ContactRow | undefined;
    return row ? mapContact(row) : null;
  }

  /** Find by exact id, exact (lowercase) email, or a free-text match over contact name/email/company name. */
  findContacts(q: FindContactQuery, limit = 20): ContactView[] {
    let rows: ContactRow[] = [];
    if (q.id) {
      const row = this.#db.prepare("SELECT * FROM contacts WHERE id = ?").get(q.id) as ContactRow | undefined;
      rows = row ? [row] : [];
    } else if (q.email) {
      const row = this.#db.prepare("SELECT * FROM contacts WHERE email = ?").get(q.email.toLowerCase()) as
        | ContactRow
        | undefined;
      rows = row ? [row] : [];
    } else if (q.query) {
      const escaped = q.query.replace(/[\\%_]/g, "\\$&");
      const like = `%${escaped}%`;
      rows = this.#db
        .prepare(
          `SELECT c.* FROM contacts c LEFT JOIN companies co ON co.id = c.company_id
           WHERE c.name LIKE ? ESCAPE '\\' OR c.email LIKE ? ESCAPE '\\' OR co.name LIKE ? ESCAPE '\\'
           ORDER BY c.updated_at DESC LIMIT ?`,
        )
        .all(like, like, like, limit) as ContactRow[];
    }
    return rows.map((r) => this.contactView(r.id)!);
  }

  setStage(contactId: string, stage: LeadStage, reason: string, authorAgentId: string | null = null): Contact {
    const existing = this.getContact(contactId);
    if (!existing) throw new NotFoundError("contact", contactId);
    const updatedAt = nowIso();
    const apply = this.#db.transaction(() => {
      this.#db.prepare("UPDATE contacts SET stage = ?, updated_at = ? WHERE id = ?").run(stage, updatedAt, contactId);
      this.addNote("contact", contactId, `Stage changed to ${stage}: ${reason}`, authorAgentId);
    });
    apply();
    return { ...existing, stage, updatedAt };
  }

  /** Contact + its company + its most recent notes — the shape agents actually need. */
  contactView(contactId: string): ContactView | null {
    const contact = this.getContact(contactId);
    if (!contact) return null;
    const company = contact.companyId ? this.getCompany(contact.companyId) : null;
    const recentNotes = this.listRecentNotes("contact", contactId, 5);
    return { ...contact, company, recentNotes };
  }

  // -- Notes ---------------------------------------------------------------

  addNote(
    subjectType: "contact" | "company",
    subjectId: string,
    body: string,
    authorAgentId: string | null = null,
  ): Note {
    const note: Note = {
      id: newId("note"),
      subjectType,
      subjectId,
      authorAgentId,
      body,
      createdAt: nowIso(),
    };
    this.#db
      .prepare(
        `INSERT INTO notes (id, subject_type, subject_id, author_agent_id, body, created_at)
         VALUES (@id, @subjectType, @subjectId, @authorAgentId, @body, @createdAt)`,
      )
      .run(note);
    return note;
  }

  listRecentNotes(subjectType: "contact" | "company", subjectId: string, n = 10): Note[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM notes WHERE subject_type = ? AND subject_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      )
      .all(subjectType, subjectId, n) as NoteRow[];
    return rows.map(mapNote);
  }
}
