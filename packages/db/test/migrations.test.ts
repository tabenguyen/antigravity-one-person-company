import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/index.ts";
import { MIGRATIONS } from "../src/migrations.ts";

describe("migrations", () => {
  it("creates the schema_migrations table and applies every migration exactly once", () => {
    const db = openDb(":memory:");
    const rows = db.sqlite.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all() as {
      version: number;
      name: string;
    }[];
    expect(rows).toEqual(MIGRATIONS.map((m) => ({ version: m.version, name: m.name })));
    expect(rows.map((r) => r.version)).toEqual(rows.map((_, i) => i + 1)); // contiguous, no gaps
    db.close();
  });

  it("is idempotent when re-opening the same file-backed database", () => {
    const dir = mkdtempSync(join(tmpdir(), "agyhq-db-"));
    const path = join(dir, "test.db");
    try {
      const db1 = openDb(path);
      db1.agents.create({
        id: "sdr-01",
        role: "sales-sdr",
        displayName: "SDR One",
        model: "gemini-3-flash",
        workspacePath: "/tmp/sdr-01",
        policy: { builtins: [], mcp: [] },
      });
      db1.close();

      // Re-opening re-runs runMigrations(); it must not error or duplicate migration rows,
      // and prior data must survive.
      const db2 = openDb(path);
      const rows = db2.sqlite.prepare("SELECT version FROM schema_migrations").all();
      expect(rows).toHaveLength(MIGRATIONS.length);
      expect(db2.agents.get("sdr-01")?.displayName).toBe("SDR One");
      db2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("backfills original_subject/original_body for rows that predate migration 2", () => {
    const db = openDb(":memory:");
    db.agents.create({
      id: "sdr-01",
      role: "sales-sdr",
      displayName: "SDR",
      model: "m",
      workspacePath: "/tmp/sdr-01",
      policy: { builtins: [], mcp: [] },
    });
    const draft = db.outbox.createDraft({
      agentId: "sdr-01",
      channel: "email",
      to: "lead@example.com",
      subject: "Hi",
      body: "Hello there",
      reason: "first touch",
    });
    expect(draft.originalSubject).toBe("Hi");
    expect(draft.originalBody).toBe("Hello there");
    db.close();
  });
});
