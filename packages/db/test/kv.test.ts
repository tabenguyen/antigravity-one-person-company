import { describe, expect, it } from "vitest";
import { openDb } from "../src/index.ts";

describe("kv", () => {
  it("round-trips JSON values, overwrites, and deletes", () => {
    const db = openDb(":memory:");
    expect(db.kv.get("company_profile")).toBeNull();
    db.kv.set("company_profile", { companyName: "Makini", languages: ["vi", "en"] });
    db.kv.set("company_profile", { companyName: "Makini JSC", languages: ["vi"] });
    expect(db.kv.get<{ companyName: string }>("company_profile")?.companyName).toBe("Makini JSC");
    db.kv.delete("company_profile");
    expect(db.kv.get("company_profile")).toBeNull();
    db.close();
  });
});
