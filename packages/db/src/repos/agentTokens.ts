import type Database from "better-sqlite3";
import { nowIso } from "@agyhq/core";
import { randomToken, sha256Hex, timingSafeEqualHex } from "../util.ts";

type SqliteDb = Database.Database;

interface TokenRow {
  agent_id: string;
  token_hash: string;
  created_at: string;
  revoked_at: string | null;
}

export class AgentTokensRepo {
  #db: SqliteDb;

  constructor(db: SqliteDb) {
    this.#db = db;
  }

  /** Issue a fresh token for an agent, replacing (revoking) any existing one. Returns the plaintext — store it nowhere else. */
  issue(agentId: string): string {
    const plaintext = randomToken();
    const hash = sha256Hex(plaintext);
    const now = nowIso();
    this.#db
      .prepare(
        `INSERT INTO agent_tokens (agent_id, token_hash, created_at, revoked_at)
         VALUES (?, ?, ?, NULL)
         ON CONFLICT(agent_id) DO UPDATE SET token_hash = excluded.token_hash, created_at = excluded.created_at, revoked_at = NULL`,
      )
      .run(agentId, hash, now);
    return plaintext;
  }

  /** Timing-safe check of a presented token against the stored hash for this agent. */
  verify(agentId: string, token: string): boolean {
    const row = this.#db.prepare("SELECT * FROM agent_tokens WHERE agent_id = ?").get(agentId) as
      | TokenRow
      | undefined;
    if (!row || row.revoked_at) return false;
    return timingSafeEqualHex(sha256Hex(token), row.token_hash);
  }

  revoke(agentId: string): void {
    this.#db.prepare("UPDATE agent_tokens SET revoked_at = ? WHERE agent_id = ?").run(nowIso(), agentId);
  }
}
