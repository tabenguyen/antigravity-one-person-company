import type Database from "better-sqlite3";
import { nowIso } from "@agyhq/core";

type SqliteDb = Database.Database;

/** Small JSON key/value store for singletons that don't deserve a table (e.g. "company_profile"). */
export class KvRepo {
  readonly #db: SqliteDb;

  constructor(db: SqliteDb) {
    this.#db = db;
  }

  get<T>(key: string): T | null {
    const row = this.#db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return null;
    }
  }

  set<T>(key: string, value: T): void {
    this.#db
      .prepare(
        `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(value), nowIso());
  }

  delete(key: string): void {
    this.#db.prepare("DELETE FROM kv WHERE key = ?").run(key);
  }
}
