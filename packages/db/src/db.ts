import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import DatabaseCtor from "better-sqlite3";
import type Database from "better-sqlite3";
import { runMigrations } from "./migrations.ts";
import { AgentsRepo } from "./repos/agents.ts";
import { AgentTokensRepo } from "./repos/agentTokens.ts";
import { TasksRepo } from "./repos/tasks.ts";
import { ConversationsRepo } from "./repos/conversations.ts";
import { AuditRepo } from "./repos/audit.ts";
import { KbRepo } from "./repos/kb.ts";
import { MemoryRepo } from "./repos/memory.ts";
import { CrmRepo } from "./repos/crm.ts";
import { OutboxRepo } from "./repos/outbox.ts";
import { QuotaRepo } from "./repos/quota.ts";
import { InboundRepo } from "./repos/inbound.ts";
import { SettingsRepo } from "./repos/settings.ts";
import { ChannelCursorsRepo } from "./repos/channelCursors.ts";
import { KvRepo } from "./repos/kv.ts";
import { RoutinesRepo } from "./repos/routines.ts";
import { EvalRunsRepo } from "./repos/evalRuns.ts";
import { BriefingsRepo } from "./repos/briefings.ts";
import { ShadowRunsRepo } from "./repos/shadowRuns.ts";
import { HumanSentRepo } from "./repos/humanSent.ts";
import { FacebookRepo } from "./repos/facebook.ts";

type SqliteDb = Database.Database;

export interface Db {
  readonly sqlite: SqliteDb;
  agents: AgentsRepo;
  agentTokens: AgentTokensRepo;
  tasks: TasksRepo;
  conversations: ConversationsRepo;
  audit: AuditRepo;
  kb: KbRepo;
  memory: MemoryRepo;
  crm: CrmRepo;
  outbox: OutboxRepo;
  quota: QuotaRepo;
  inbound: InboundRepo;
  settings: SettingsRepo;
  channelCursors: ChannelCursorsRepo;
  kv: KvRepo;
  routines: RoutinesRepo;
  evalRuns: EvalRunsRepo;
  briefings: BriefingsRepo;
  shadowRuns: ShadowRunsRepo;
  humanSent: HumanSentRepo;
  facebook: FacebookRepo;
  /** Run fn inside a single SQLite transaction; its return value is passed through. */
  transaction<T>(fn: () => T): T;
  close(): void;
}

/** Open (and migrate) the SQLite database at `path`, or an in-memory one for ":memory:" / tests. */
export function openDb(path: string | ":memory:"): Db {
  const sqlite = new DatabaseCtor(path);
  sqlite.pragma("journal_mode = WAL"); // no-op (silently ignored) for :memory:
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");

  runMigrations(sqlite);

  const audit = new AuditRepo(sqlite);

  const db: Db = {
    sqlite,
    agents: new AgentsRepo(sqlite),
    agentTokens: new AgentTokensRepo(sqlite),
    tasks: new TasksRepo(sqlite, audit),
    conversations: new ConversationsRepo(sqlite),
    audit,
    kb: new KbRepo(sqlite),
    memory: new MemoryRepo(sqlite),
    crm: new CrmRepo(sqlite),
    outbox: new OutboxRepo(sqlite),
    quota: new QuotaRepo(sqlite),
    inbound: new InboundRepo(sqlite),
    settings: new SettingsRepo(sqlite),
    channelCursors: new ChannelCursorsRepo(sqlite),
    kv: new KvRepo(sqlite),
    routines: new RoutinesRepo(sqlite),
    evalRuns: new EvalRunsRepo(sqlite),
    briefings: new BriefingsRepo(sqlite),
    shadowRuns: new ShadowRunsRepo(sqlite),
    humanSent: new HumanSentRepo(sqlite),
    facebook: new FacebookRepo(sqlite),
    transaction<T>(fn: () => T): T {
      return sqlite.transaction(fn)();
    },
    close(): void {
      sqlite.close();
    },
  };
  return db;
}

/**
 * A throw-away, migrated COPY of the database at `path` for read-only dry runs (e.g. `hq email doctor --local`): the
 * source is opened read-only and copied with SQLite's online backup, so the live file is never written. Falls back to
 * an empty in-memory database when there is nothing to copy. Call `cleanup()` when done.
 */
export async function openDbSnapshot(path: string): Promise<{ db: Db; cleanup: () => void; fromFile: boolean }> {
  if (path !== ":memory:" && fs.existsSync(path)) {
    const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "agyhq-snapshot-"));
    const dest = nodePath.join(dir, "snapshot.db");
    try {
      const src = new DatabaseCtor(path, { readonly: true, fileMustExist: true });
      try {
        await src.backup(dest);
      } finally {
        src.close();
      }
      const db = openDb(dest);
      return {
        db,
        fromFile: true,
        cleanup: () => {
          try {
            db.close();
          } finally {
            fs.rmSync(dir, { recursive: true, force: true });
          }
        },
      };
    } catch {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  const db = openDb(":memory:");
  return { db, fromFile: false, cleanup: () => db.close() };
}
