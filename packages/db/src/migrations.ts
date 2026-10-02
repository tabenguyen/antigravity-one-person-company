import type Database from "better-sqlite3";
import { nowIso } from "@agyhq/core";

type SqliteDb = Database.Database;

export interface Migration {
  version: number;
  name: string;
  up: (db: SqliteDb) => void;
}

// Versioned, append-only. Never edit an already-shipped migration; add a new one.
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "init",
    up(db) {
      db.exec(`
        CREATE TABLE agents (
          id TEXT PRIMARY KEY,
          role TEXT NOT NULL,
          display_name TEXT NOT NULL,
          model TEXT NOT NULL,
          status TEXT NOT NULL,
          trust_tier TEXT NOT NULL,
          workspace_path TEXT NOT NULL,
          manager_id TEXT,
          policy TEXT NOT NULL,
          max_concurrency INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX idx_agents_status ON agents(status);
        CREATE INDEX idx_agents_role ON agents(role);

        CREATE TABLE agent_tokens (
          agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
          token_hash TEXT NOT NULL,
          created_at TEXT NOT NULL,
          revoked_at TEXT
        );

        CREATE TABLE tasks (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL REFERENCES agents(id),
          kind TEXT NOT NULL,
          title TEXT NOT NULL,
          input TEXT NOT NULL,
          status TEXT NOT NULL,
          priority INTEGER NOT NULL DEFAULT 0,
          thread_key TEXT,
          conversation_id TEXT,
          parent_task_id TEXT,
          created_by_agent_id TEXT,
          attempts INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL DEFAULT 3,
          wake_at TEXT,
          result TEXT,
          error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX idx_tasks_claim ON tasks(status, priority DESC, created_at ASC);
        CREATE INDEX idx_tasks_agent ON tasks(agent_id);
        CREATE INDEX idx_tasks_thread ON tasks(thread_key);
        CREATE INDEX idx_tasks_wake ON tasks(wake_at);

        CREATE TABLE conversations (
          agent_id TEXT NOT NULL REFERENCES agents(id),
          thread_key TEXT NOT NULL,
          conversation_id TEXT NOT NULL,
          last_used_at TEXT NOT NULL,
          PRIMARY KEY (agent_id, thread_key)
        );

        CREATE TABLE audit (
          id TEXT PRIMARY KEY,
          at TEXT NOT NULL,
          kind TEXT NOT NULL,
          agent_id TEXT,
          task_id TEXT,
          conversation_id TEXT,
          data TEXT NOT NULL
        );
        CREATE INDEX idx_audit_at ON audit(at DESC);
        CREATE INDEX idx_audit_agent ON audit(agent_id);
        CREATE INDEX idx_audit_task ON audit(task_id);
        CREATE INDEX idx_audit_kind ON audit(kind);

        CREATE TABLE kb_documents (
          id TEXT PRIMARY KEY,
          scope TEXT NOT NULL,
          title TEXT NOT NULL,
          source_path TEXT NOT NULL,
          body TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (scope, source_path)
        );
        CREATE INDEX idx_kb_documents_scope ON kb_documents(scope);

        CREATE TABLE kb_chunks (
          id TEXT PRIMARY KEY,
          document_id TEXT NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
          scope TEXT NOT NULL,
          title TEXT NOT NULL,
          ord INTEGER NOT NULL,
          body TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX idx_kb_chunks_document ON kb_chunks(document_id);

        -- Standalone (non-external-content) FTS5 table: we manage inserts/deletes
        -- ourselves alongside kb_chunks, so chunk ids can stay ULIDs instead of rowids.
        -- unicode61 remove_diacritics 2 makes "khach hang" match "khách hàng".
        CREATE VIRTUAL TABLE kb_fts USING fts5(
          body,
          chunk_id UNINDEXED,
          document_id UNINDEXED,
          scope UNINDEXED,
          title UNINDEXED,
          tokenize = 'unicode61 remove_diacritics 2'
        );

        CREATE TABLE memory (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL REFERENCES agents(id),
          subject TEXT,
          content TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX idx_memory_agent ON memory(agent_id);
        CREATE INDEX idx_memory_subject ON memory(subject);

        CREATE TABLE companies (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          domain TEXT,
          industry TEXT,
          size TEXT,
          country TEXT,
          attributes TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX idx_companies_domain ON companies(domain) WHERE domain IS NOT NULL;
        CREATE INDEX idx_companies_name_nocase ON companies(name COLLATE NOCASE);

        CREATE TABLE contacts (
          id TEXT PRIMARY KEY,
          email TEXT,
          name TEXT,
          title TEXT,
          company_id TEXT REFERENCES companies(id),
          phone TEXT,
          linkedin_url TEXT,
          language TEXT,
          stage TEXT NOT NULL,
          owner_agent_id TEXT,
          source TEXT,
          attributes TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX idx_contacts_email ON contacts(email) WHERE email IS NOT NULL;
        CREATE INDEX idx_contacts_company ON contacts(company_id);
        CREATE INDEX idx_contacts_name_nocase ON contacts(name COLLATE NOCASE);

        CREATE TABLE notes (
          id TEXT PRIMARY KEY,
          subject_type TEXT NOT NULL,
          subject_id TEXT NOT NULL,
          author_agent_id TEXT,
          body TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX idx_notes_subject ON notes(subject_type, subject_id, created_at DESC);

        CREATE TABLE outbox (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL REFERENCES agents(id),
          task_id TEXT,
          channel TEXT NOT NULL,
          "to" TEXT NOT NULL,
          subject TEXT,
          body TEXT NOT NULL,
          reason TEXT NOT NULL,
          thread_key TEXT,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX idx_outbox_agent ON outbox(agent_id);
        CREATE INDEX idx_outbox_status ON outbox(status);

        CREATE TABLE quota_snapshots (
          id TEXT PRIMARY KEY,
          at TEXT NOT NULL,
          buckets TEXT NOT NULL
        );
        CREATE INDEX idx_quota_at ON quota_snapshots(at DESC);
      `);
    },
  },
  {
    version: 2,
    name: "phase2_inbound_outbox_settings",
    up(db) {
      db.exec(`
        -- Outbox: full Phase 2 lifecycle fields (see core OutboxItem / OUTBOX_TRANSITIONS).
        ALTER TABLE outbox ADD COLUMN original_subject TEXT;
        ALTER TABLE outbox ADD COLUMN original_body TEXT NOT NULL DEFAULT '';
        ALTER TABLE outbox ADD COLUMN edited_by_human INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE outbox ADD COLUMN decided_by TEXT;
        ALTER TABLE outbox ADD COLUMN decided_at TEXT;
        ALTER TABLE outbox ADD COLUMN decision_note TEXT;
        ALTER TABLE outbox ADD COLUMN status_reason TEXT;
        ALTER TABLE outbox ADD COLUMN message_id TEXT;
        ALTER TABLE outbox ADD COLUMN in_reply_to TEXT;
        ALTER TABLE outbox ADD COLUMN sent_at TEXT;
        ALTER TABLE outbox ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;

        -- Backfill: every row inserted under migration 1 had no original_*; the
        -- agent's draft IS the original at that point (no edits possible yet).
        UPDATE outbox SET original_subject = subject, original_body = body;

        CREATE INDEX idx_outbox_thread ON outbox(thread_key);
        CREATE INDEX idx_outbox_message_id ON outbox(message_id);
        CREATE INDEX idx_outbox_sent_at ON outbox(sent_at);

        CREATE TABLE inbound_events (
          id TEXT PRIMARY KEY,
          source TEXT NOT NULL,
          external_id TEXT NOT NULL,
          from_address TEXT,
          from_name TEXT,
          to_address TEXT,
          subject TEXT,
          body_text TEXT NOT NULL,
          message_id TEXT,
          in_reply_to TEXT,
          "references" TEXT NOT NULL DEFAULT '[]',
          thread_key TEXT,
          contact_id TEXT,
          classification TEXT NOT NULL,
          status TEXT NOT NULL,
          status_reason TEXT,
          routed_task_id TEXT,
          payload TEXT NOT NULL DEFAULT '{}',
          received_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE (source, external_id)
        );
        CREATE INDEX idx_inbound_status ON inbound_events(status);
        CREATE INDEX idx_inbound_classification ON inbound_events(classification);
        CREATE INDEX idx_inbound_received ON inbound_events(received_at DESC);
        CREATE INDEX idx_inbound_thread ON inbound_events(thread_key);
        CREATE INDEX idx_inbound_message_id ON inbound_events(message_id);

        -- Single JSON row (id is always 1) merged over core's DEFAULT_SETTINGS by SettingsRepo.get().
        CREATE TABLE settings (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          data TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        -- Per-channel poll cursor (e.g. key "email" -> IMAP UID / maildir filename).
        CREATE TABLE channel_cursors (
          key TEXT PRIMARY KEY,
          cursor TEXT,
          updated_at TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 3,
    name: "phase3_quality_routines_evals",
    up(db) {
      db.exec(`
        -- Draft quality: lint findings (JSON array of core LintFinding) and structured rejection reason.
        ALTER TABLE outbox ADD COLUMN lint TEXT NOT NULL DEFAULT '[]';
        ALTER TABLE outbox ADD COLUMN rejection_category TEXT;
        CREATE INDEX idx_outbox_decided_at ON outbox(decided_at);

        -- Generic key/value JSON store (e.g. "company_profile").
        CREATE TABLE kv (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        -- Recurring work per agent (core Routine).
        CREATE TABLE routines (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL REFERENCES agents(id),
          kind TEXT NOT NULL,
          name TEXT NOT NULL,
          schedule TEXT NOT NULL,
          timezone TEXT NOT NULL,
          config TEXT NOT NULL DEFAULT '{}',
          enabled INTEGER NOT NULL DEFAULT 1,
          last_run_at TEXT,
          next_run_at TEXT,
          last_result TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX idx_routines_due ON routines(enabled, next_run_at);

        -- Template regression runs (core EvalRun).
        CREATE TABLE eval_runs (
          id TEXT PRIMARY KEY,
          suite TEXT NOT NULL,
          model TEXT NOT NULL,
          status TEXT NOT NULL,
          started_at TEXT NOT NULL,
          finished_at TEXT,
          results TEXT NOT NULL DEFAULT '[]',
          summary TEXT
        );
        CREATE INDEX idx_eval_runs_started ON eval_runs(started_at DESC);
      `);
    },
  },
  {
    version: 4,
    name: "phase4_briefings_roles",
    up(db) {
      // contacts.stage and agents.role are plain TEXT (no CHECK): the new "customer"/"churned" stages and the
      // account-manager / chief-of-staff roles need no schema change. Only new storage + lookup indexes here.
      db.exec(`
        -- The Chief of Staff's daily digests (core Briefing); one per cos.daily_digest task.
        CREATE TABLE briefings (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL REFERENCES agents(id),
          task_id TEXT NOT NULL,
          period_start TEXT NOT NULL,
          period_end TEXT NOT NULL,
          markdown TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX idx_briefings_created ON briefings(created_at DESC);
        CREATE UNIQUE INDEX idx_briefings_task ON briefings(task_id);

        -- Routine snapshots (account_review) and handoff/KPI queries filter contacts by owner and stage.
        CREATE INDEX idx_contacts_owner ON contacts(owner_agent_id);
        CREATE INDEX idx_contacts_stage ON contacts(stage);
        CREATE INDEX idx_tasks_kind ON tasks(kind, created_at);
      `);
    },
  },
];

export function runMigrations(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
  const applied = new Set(
    (db.prepare("SELECT version FROM schema_migrations").all() as { version: number }[]).map((r) => r.version),
  );
  const insertMigration = db.prepare(
    "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
  );
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    const apply = db.transaction(() => {
      migration.up(db);
      insertMigration.run(migration.version, migration.name, nowIso());
    });
    apply();
  }
}
