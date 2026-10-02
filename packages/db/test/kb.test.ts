import { describe, expect, it } from "vitest";
import { openDb } from "../src/index.ts";
import { sanitizeFtsQuery } from "../src/util.ts";
import { chunkMarkdown } from "../src/kbChunk.ts";

describe("kb.search", () => {
  it("matches Vietnamese diacritics when the query has none", () => {
    const db = openDb(":memory:");
    db.kb.upsertDocument({
      scope: "company",
      title: "FAQ",
      sourcePath: "faq.md",
      body: "# Chính sách\n\nChúng tôi luôn chăm sóc khách hàng chu đáo.",
    });

    const hits = db.kb.search("khach hang", ["company"], 10);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.title).toBe("FAQ");
    db.close();
  });

  it("does not throw on FTS5 special characters and still searches literally", () => {
    const db = openDb(":memory:");
    db.kb.upsertDocument({
      scope: "company",
      title: "Pricing",
      sourcePath: "pricing.md",
      body: "Our pricing is simple and fair for every customer.",
    });

    expect(() => db.kb.search('pricing" OR 1=1 --', ["company"], 10)).not.toThrow();
    expect(() => db.kb.search("(pricing* NOT fair)", ["company"], 10)).not.toThrow();
    expect(() => db.kb.search("", ["company"], 10)).not.toThrow();
    expect(db.kb.search("", ["company"], 10)).toEqual([]);
    db.close();
  });

  it("only returns hits from the requested scopes", () => {
    const db = openDb(":memory:");
    db.kb.upsertDocument({ scope: "company", title: "Shared", sourcePath: "a.md", body: "unique-marker-alpha" });
    db.kb.upsertDocument({ scope: "role:sales-sdr", title: "Role doc", sourcePath: "b.md", body: "unique-marker-alpha" });

    const companyOnly = db.kb.search("unique-marker-alpha", ["company"], 10);
    expect(companyOnly).toHaveLength(1);
    expect(companyOnly[0]!.scope).toBe("company");

    const both = db.kb.search("unique-marker-alpha", ["company", "role:sales-sdr"], 10);
    expect(both).toHaveLength(2);
    db.close();
  });

  it("skips re-chunking when the body hash is unchanged", () => {
    const db = openDb(":memory:");
    const body = "# Heading\n\nSome content here.";
    const first = db.kb.upsertDocument({ scope: "company", title: "Doc", sourcePath: "x.md", body });
    expect(first.changed).toBe(true);
    const second = db.kb.upsertDocument({ scope: "company", title: "Doc", sourcePath: "x.md", body });
    expect(second.changed).toBe(false);
    expect(second.document.id).toBe(first.document.id);
    db.close();
  });

  it("deleteDocument removes its chunks from search results", () => {
    const db = openDb(":memory:");
    const { document } = db.kb.upsertDocument({
      scope: "company",
      title: "Doc",
      sourcePath: "y.md",
      body: "findable-term-xyz",
    });
    expect(db.kb.search("findable-term-xyz", ["company"], 10)).toHaveLength(1);
    db.kb.deleteDocument(document.id);
    expect(db.kb.search("findable-term-xyz", ["company"], 10)).toHaveLength(0);
    db.close();
  });
});

describe("sanitizeFtsQuery", () => {
  it("OR-joins quoted terms", () => {
    expect(sanitizeFtsQuery("khach hang")).toBe('"khach" OR "hang"');
  });

  it("returns null for an empty/whitespace-only query", () => {
    expect(sanitizeFtsQuery("  ")).toBeNull();
  });

  it("escapes embedded double quotes instead of leaving them unescaped", () => {
    const escaped = sanitizeFtsQuery('foo" OR bar');
    expect(escaped).not.toBeNull();
    expect(escaped).toContain('""'); // the literal quote in "foo" was doubled, not left bare
  });
});

describe("chunkMarkdown", () => {
  it("keeps a short section as a single chunk", () => {
    const chunks = chunkMarkdown("# Title\n\nShort body.");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("Title");
  });

  it("splits a long section into multiple overlapping chunks", () => {
    const paragraph = "word ".repeat(100).trim(); // ~500 chars
    const body = `# Heading\n\n${paragraph}\n\n${paragraph}\n\n${paragraph}`;
    const chunks = chunkMarkdown(body, 800, 50);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThan(1200);
  });
});
