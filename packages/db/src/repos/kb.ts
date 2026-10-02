import type Database from "better-sqlite3";
import type { Iso, KbHit, KbScope } from "@agyhq/core";
import { newId, nowIso } from "@agyhq/core";
import { sanitizeFtsQuery, sha256Hex } from "../util.ts";
import { chunkMarkdown } from "../kbChunk.ts";

type SqliteDb = Database.Database;

export interface KbDocument {
  id: string;
  scope: KbScope;
  title: string;
  sourcePath: string;
  body: string;
  contentHash: string;
  updatedAt: Iso;
}

interface DocumentRow {
  id: string;
  scope: string;
  title: string;
  source_path: string;
  body: string;
  content_hash: string;
  updated_at: string;
}

function mapDocRow(row: DocumentRow): KbDocument {
  return {
    id: row.id,
    scope: row.scope as KbScope,
    title: row.title,
    sourcePath: row.source_path,
    body: row.body,
    contentHash: row.content_hash,
    updatedAt: row.updated_at,
  };
}

export interface UpsertDocumentInput {
  scope: KbScope;
  title: string;
  sourcePath: string;
  body: string;
}

export interface UpsertDocumentResult {
  document: KbDocument;
  changed: boolean;
}

export class KbRepo {
  #db: SqliteDb;

  constructor(db: SqliteDb) {
    this.#db = db;
  }

  upsertDocument(input: UpsertDocumentInput): UpsertDocumentResult {
    const contentHash = sha256Hex(input.body);
    const existing = this.#db
      .prepare("SELECT * FROM kb_documents WHERE scope = ? AND source_path = ?")
      .get(input.scope, input.sourcePath) as DocumentRow | undefined;

    if (existing && existing.content_hash === contentHash && existing.title === input.title) {
      return { document: mapDocRow(existing), changed: false };
    }

    const apply = this.#db.transaction((): KbDocument => {
      const id = existing?.id ?? newId("doc");
      const updatedAt = nowIso();
      this.#db
        .prepare(
          `INSERT INTO kb_documents (id, scope, title, source_path, body, content_hash, updated_at)
           VALUES (@id, @scope, @title, @sourcePath, @body, @contentHash, @updatedAt)
           ON CONFLICT(scope, source_path) DO UPDATE SET
             title = excluded.title, body = excluded.body, content_hash = excluded.content_hash, updated_at = excluded.updated_at`,
        )
        .run({ id, scope: input.scope, title: input.title, sourcePath: input.sourcePath, body: input.body, contentHash, updatedAt });

      if (existing) this.#deleteChunks(existing.id);

      const chunks = chunkMarkdown(input.body);
      const insertChunk = this.#db.prepare(
        `INSERT INTO kb_chunks (id, document_id, scope, title, ord, body, updated_at)
         VALUES (@id, @documentId, @scope, @title, @ord, @body, @updatedAt)`,
      );
      const insertFts = this.#db.prepare(
        `INSERT INTO kb_fts (body, chunk_id, document_id, scope, title) VALUES (?, ?, ?, ?, ?)`,
      );
      chunks.forEach((body, ord) => {
        const chunkId = newId("chk");
        insertChunk.run({ id: chunkId, documentId: id, scope: input.scope, title: input.title, ord, body, updatedAt });
        insertFts.run(body, chunkId, id, input.scope, input.title);
      });

      return { id, scope: input.scope, title: input.title, sourcePath: input.sourcePath, body: input.body, contentHash, updatedAt };
    });

    return { document: apply(), changed: true };
  }

  getDocument(id: string): KbDocument | null {
    const row = this.#db.prepare("SELECT * FROM kb_documents WHERE id = ?").get(id) as DocumentRow | undefined;
    return row ? mapDocRow(row) : null;
  }

  #deleteChunks(documentId: string): void {
    const ids = this.#db.prepare("SELECT id FROM kb_chunks WHERE document_id = ?").all(documentId) as {
      id: string;
    }[];
    const deleteFts = this.#db.prepare("DELETE FROM kb_fts WHERE chunk_id = ?");
    for (const { id } of ids) deleteFts.run(id);
    this.#db.prepare("DELETE FROM kb_chunks WHERE document_id = ?").run(documentId);
  }

  deleteDocument(id: string): void {
    const del = this.#db.transaction(() => {
      this.#deleteChunks(id);
      this.#db.prepare("DELETE FROM kb_documents WHERE id = ?").run(id);
    });
    del();
  }

  listDocuments(scope?: KbScope): KbDocument[] {
    const rows = scope
      ? (this.#db.prepare("SELECT * FROM kb_documents WHERE scope = ? ORDER BY updated_at DESC").all(
          scope,
        ) as DocumentRow[])
      : (this.#db.prepare("SELECT * FROM kb_documents ORDER BY updated_at DESC").all() as DocumentRow[]);
    return rows.map(mapDocRow);
  }

  /**
   * Full-text search over chunks, scoped to the given KB scopes, ranked by bm25 (returned as a higher-is-better score).
   * `snippet` is the whole matching chunk (~800 chars): short FTS snippets made agents re-query endlessly for context.
   */
  search(query: string, scopes: KbScope[], limit = 10): KbHit[] {
    const match = sanitizeFtsQuery(query);
    if (!match || scopes.length === 0) return [];
    const scopePlaceholders = scopes.map((_, i) => `@scope${i}`).join(", ");
    const params: Record<string, unknown> = { match, limit };
    scopes.forEach((s, i) => {
      params[`scope${i}`] = s;
    });
    const rows = this.#db
      .prepare(
        `SELECT chunk_id AS chunkId, document_id AS documentId, scope, title,
                bm25(kb_fts) AS rank,
                body AS snippet
         FROM kb_fts
         WHERE kb_fts MATCH @match AND scope IN (${scopePlaceholders})
         ORDER BY rank ASC
         LIMIT @limit`,
      )
      .all(params) as { chunkId: string; documentId: string; scope: string; title: string; rank: number; snippet: string }[];

    return rows.map((r) => ({
      docId: r.documentId,
      title: r.title,
      scope: r.scope as KbScope,
      snippet: r.snippet,
      score: -r.rank, // bm25() is "lower = more relevant"; negate so higher score = more relevant.
    }));
  }
}
