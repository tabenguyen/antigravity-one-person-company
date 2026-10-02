import type Database from "better-sqlite3";
import type { Iso, QuotaBucket } from "@agyhq/core";
import { newId, nowIso } from "@agyhq/core";
import { fromJson, toJson } from "../util.ts";

type SqliteDb = Database.Database;

export interface QuotaSnapshot {
  at: Iso;
  buckets: QuotaBucket[];
}

interface QuotaRow {
  id: string;
  at: string;
  buckets: string;
}

export class QuotaRepo {
  #db: SqliteDb;

  constructor(db: SqliteDb) {
    this.#db = db;
  }

  record(buckets: QuotaBucket[]): QuotaSnapshot {
    const snapshot: QuotaSnapshot = { at: nowIso(), buckets };
    this.#db
      .prepare("INSERT INTO quota_snapshots (id, at, buckets) VALUES (?, ?, ?)")
      .run(newId("quo"), snapshot.at, toJson(snapshot.buckets));
    return snapshot;
  }

  latest(): QuotaSnapshot | null {
    const row = this.#db.prepare("SELECT * FROM quota_snapshots ORDER BY at DESC, rowid DESC LIMIT 1").get() as
      | QuotaRow
      | undefined;
    if (!row) return null;
    return { at: row.at, buckets: fromJson<QuotaBucket[]>(row.buckets, []) };
  }
}
