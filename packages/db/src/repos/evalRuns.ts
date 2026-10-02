import type Database from "better-sqlite3";
import type { EvalCaseResult, EvalRun } from "@agyhq/core";
import { newId, nowIso } from "@agyhq/core";
import { fromJson, toJson } from "../util.ts";
import { NotFoundError } from "../errors.ts";

type SqliteDb = Database.Database;

interface EvalRunRow {
  id: string;
  suite: string;
  model: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  results: string;
  summary: string | null;
}

function mapRow(row: EvalRunRow): EvalRun {
  return {
    id: row.id,
    suite: row.suite,
    model: row.model,
    status: row.status as EvalRun["status"],
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    results: fromJson<EvalCaseResult[]>(row.results, []),
    summary: fromJson<EvalRun["summary"]>(row.summary, null),
  };
}

export function summarizeResults(results: EvalCaseResult[]): NonNullable<EvalRun["summary"]> {
  const count = (s: EvalCaseResult["status"]) => results.filter((r) => r.status === s).length;
  return { total: results.length, pass: count("pass"), fail: count("fail"), error: count("error"), skipped: count("skipped") };
}

export class EvalRunsRepo {
  readonly #db: SqliteDb;

  constructor(db: SqliteDb) {
    this.#db = db;
  }

  /** Start a run: status "running", no results yet. */
  create(input: { suite: string; model: string }): EvalRun {
    const run: EvalRun = {
      id: newId("evr"),
      suite: input.suite,
      model: input.model,
      status: "running",
      startedAt: nowIso(),
      finishedAt: null,
      results: [],
      summary: null,
    };
    this.#db
      .prepare(
        `INSERT INTO eval_runs (id, suite, model, status, started_at, finished_at, results, summary)
         VALUES (@id, @suite, @model, @status, @startedAt, @finishedAt, @results, @summary)`,
      )
      .run({ ...run, results: toJson(run.results), summary: null });
    return run;
  }

  get(id: string): EvalRun | null {
    const row = this.#db.prepare("SELECT * FROM eval_runs WHERE id = ?").get(id) as EvalRunRow | undefined;
    return row ? mapRow(row) : null;
  }

  /** Newest first. */
  list(opts: { suite?: string; limit?: number } = {}): EvalRun[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
    const rows = (
      opts.suite
        ? this.#db
            .prepare("SELECT * FROM eval_runs WHERE suite = ? ORDER BY started_at DESC, rowid DESC LIMIT ?")
            .all(opts.suite, limit)
        : this.#db.prepare("SELECT * FROM eval_runs ORDER BY started_at DESC, rowid DESC LIMIT ?").all(limit)
    ) as EvalRunRow[];
    return rows.map(mapRow);
  }

  /** Replace the stored results (progress update while the run is still going). */
  updateResults(id: string, results: EvalCaseResult[]): EvalRun {
    const res = this.#db.prepare("UPDATE eval_runs SET results = ? WHERE id = ?").run(toJson(results), id);
    if (res.changes === 0) throw new NotFoundError("eval run", id);
    return this.get(id)!;
  }

  /** Close the run: stores final results and a computed summary. */
  finish(id: string, status: "done" | "failed", results?: EvalCaseResult[]): EvalRun {
    const existing = this.get(id);
    if (!existing) throw new NotFoundError("eval run", id);
    const finalResults = results ?? existing.results;
    this.#db
      .prepare("UPDATE eval_runs SET status = ?, finished_at = ?, results = ?, summary = ? WHERE id = ?")
      .run(status, nowIso(), toJson(finalResults), toJson(summarizeResults(finalResults)), id);
    return this.get(id)!;
  }
}
