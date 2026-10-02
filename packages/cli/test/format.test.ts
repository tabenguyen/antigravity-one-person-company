import { describe, it, expect, vi, afterEach } from "vitest";
import { printTable, printJson, printKv } from "../src/format.ts";

describe("format", () => {
  afterEach(() => vi.restoreAllMocks());

  it("printTable prints a header, separator and one row per item", () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg: string) => void logs.push(msg));
    printTable([
      { id: "a", name: "Alice" },
      { id: "bb", name: "Bob" },
    ]);
    expect(logs).toHaveLength(4); // header + separator + 2 rows
    expect(logs[0]).toContain("id");
    expect(logs[0]).toContain("name");
    expect(logs[3]).toContain("bb");
    expect(logs[3]).toContain("Bob");
  });

  it("printTable prints a placeholder for an empty list", () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg: string) => void logs.push(msg));
    printTable([]);
    expect(logs).toEqual(["(none)"]);
  });

  it("printJson pretty-prints valid JSON", () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg: string) => void logs.push(msg));
    printJson({ a: 1 });
    expect(JSON.parse(logs[0]!)).toEqual({ a: 1 });
  });

  it("printKv prints each field on its own line", () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg: string) => void logs.push(msg));
    printKv({ id: "sdr-01", status: "active" });
    expect(logs.some((l) => l.includes("sdr-01"))).toBe(true);
    expect(logs.some((l) => l.includes("active"))).toBe(true);
  });
});
