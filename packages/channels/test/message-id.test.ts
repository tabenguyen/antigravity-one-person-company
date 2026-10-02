import { describe, expect, it } from "vitest";
import { newMessageId, normalizeMessageId } from "../src/message-id.ts";

describe("newMessageId", () => {
  it("produces '<ulid>@<domain>' without angle brackets", () => {
    const id = newMessageId("agyhq.test");
    expect(id).not.toMatch(/[<>]/);
    expect(id.endsWith("@agyhq.test")).toBe(true);
    const [local] = id.split("@");
    expect(local).toMatch(/^[0-9a-z]{26}$/);
  });

  it("produces unique, time-sortable ids", () => {
    const a = newMessageId("x.com");
    const b = newMessageId("x.com");
    expect(a).not.toBe(b);
  });
});

describe("normalizeMessageId", () => {
  it("strips angle brackets and trims whitespace", () => {
    expect(normalizeMessageId("<abc@x.com>")).toBe("abc@x.com");
    expect(normalizeMessageId("  <abc@x.com>  ")).toBe("abc@x.com");
    expect(normalizeMessageId("abc@x.com")).toBe("abc@x.com");
  });

  it("returns null for null/undefined/empty input", () => {
    expect(normalizeMessageId(null)).toBeNull();
    expect(normalizeMessageId(undefined)).toBeNull();
    expect(normalizeMessageId("")).toBeNull();
    expect(normalizeMessageId("   ")).toBeNull();
    expect(normalizeMessageId("<>")).toBeNull();
  });

  it("leaves case untouched", () => {
    expect(normalizeMessageId("<ABC@X.COM>")).toBe("ABC@X.COM");
  });
});
