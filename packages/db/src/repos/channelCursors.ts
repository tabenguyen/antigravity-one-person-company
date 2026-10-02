import type Database from "better-sqlite3";
import { nowIso } from "@agyhq/core";

type SqliteDb = Database.Database;

/** Per-channel poll cursor (e.g. "email" -> IMAP UID / maildir filename), persisted across daemon restarts. */
export class ChannelCursorsRepo {
  #db: SqliteDb;

  constructor(db: SqliteDb) {
    this.#db = db;
  }

  get(key: string): string | null {
    const row = this.#db.prepare("SELECT cursor FROM channel_cursors WHERE key = ?").get(key) as
      | { cursor: string | null }
      | undefined;
    return row?.cursor ?? null;
  }

  set(key: string, cursor: string | null): void {
    this.#db
      .prepare(
        `INSERT INTO channel_cursors (key, cursor, updated_at) VALUES (@key, @cursor, @updatedAt)
         ON CONFLICT(key) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`,
      )
      .run({ key, cursor, updatedAt: nowIso() });
  }
}
