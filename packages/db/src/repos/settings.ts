import type Database from "better-sqlite3";
import { DEFAULT_SETTINGS } from "@agyhq/core";
import type { HqSettings } from "@agyhq/core";
import { nowIso } from "@agyhq/core";
import { fromJson, toJson } from "../util.ts";

type SqliteDb = Database.Database;

/** Single JSON row (id=1), merged over core's DEFAULT_SETTINGS so a missing/partial row never breaks a reader. */
export class SettingsRepo {
  #db: SqliteDb;

  constructor(db: SqliteDb) {
    this.#db = db;
  }

  get(): HqSettings {
    const row = this.#db.prepare("SELECT data FROM settings WHERE id = 1").get() as { data: string } | undefined;
    if (!row) return { ...DEFAULT_SETTINGS };
    const stored = fromJson<Partial<HqSettings>>(row.data, {});
    return { ...DEFAULT_SETTINGS, ...stored };
  }

  patch(partial: Partial<HqSettings>): HqSettings {
    const merged: HqSettings = { ...this.get(), ...partial };
    this.#db
      .prepare(
        `INSERT INTO settings (id, data, updated_at) VALUES (1, @data, @updatedAt)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
      )
      .run({ data: toJson(merged), updatedAt: nowIso() });
    return merged;
  }
}
