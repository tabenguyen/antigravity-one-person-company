import type Database from "better-sqlite3";
import { nowIso } from "@agyhq/core";

type SqliteDb = Database.Database;

interface ConversationRow {
  agent_id: string;
  thread_key: string;
  conversation_id: string;
  last_used_at: string;
}

export class ConversationsRepo {
  #db: SqliteDb;

  constructor(db: SqliteDb) {
    this.#db = db;
  }

  get(agentId: string, threadKey: string): string | null {
    const row = this.#db
      .prepare("SELECT * FROM conversations WHERE agent_id = ? AND thread_key = ?")
      .get(agentId, threadKey) as ConversationRow | undefined;
    return row ? row.conversation_id : null;
  }

  set(agentId: string, threadKey: string, conversationId: string): void {
    const now = nowIso();
    this.#db
      .prepare(
        `INSERT INTO conversations (agent_id, thread_key, conversation_id, last_used_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(agent_id, thread_key) DO UPDATE SET conversation_id = excluded.conversation_id, last_used_at = excluded.last_used_at`,
      )
      .run(agentId, threadKey, conversationId, now);
  }
}
