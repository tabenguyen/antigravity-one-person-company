import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadSuite, listSuites } from "../src/evals/suite.ts";
import { ValidationError } from "../src/util.ts";
import { REPO_ROOT } from "./helpers.ts";

const TEMPLATES = path.join(REPO_ROOT, "templates");

describe("shipped eval suites for every role load with the role-generic loader", () => {
  it.each([
    ["account-manager", 6],
    ["chief-of-staff", 4],
  ])("%s has at least %i valid cases with unique ids and a template for the suite's role", (role, min) => {
    expect(listSuites(TEMPLATES)).toContain(role);
    const suite = loadSuite(TEMPLATES, role);
    expect(suite.cases.length).toBeGreaterThanOrEqual(min);
    expect(new Set(suite.cases.map((c) => c.id)).size).toBe(suite.cases.length);
    for (const c of suite.cases) {
      expect(() => c.assertions.forEach(function walk(a: unknown): void {
        const o = a as Record<string, unknown>;
        for (const k of ["pattern", "notPattern"]) if (typeof o[k] === "string") new RegExp(o[k] as string, "i");
        if (Array.isArray(o["of"])) o["of"].forEach(walk);
      })).not.toThrow();
    }
  });
});

describe("shipped sales-sdr eval suite", () => {
  const suite = loadSuite(TEMPLATES, "sales-sdr");

  it("is discoverable and loads with unique, valid cases", () => {
    expect(listSuites(TEMPLATES)).toContain("sales-sdr");
    expect(suite.cases.length).toBeGreaterThanOrEqual(6);
    expect(new Set(suite.cases.map((c) => c.id)).size).toBe(suite.cases.length);
  });

  it("covers the required scenarios", () => {
    const ids = suite.cases.map((c) => c.id).join(" ");
    for (const needle of ["interested-asks-price", "not-now", "stop-contacting", "wrong-person", "vietnamese", "first-touch", "out-of-icp"]) {
      expect(ids).toContain(needle);
    }
    const kinds = new Set(suite.cases.map((c) => c.kind));
    expect(kinds).toEqual(new Set(["sdr.handle_reply", "sdr.first_touch", "sdr.research_lead"]));
  });

  it("ships a hermetic test KB with no price list", () => {
    expect(suite.kbFiles.length).toBeGreaterThanOrEqual(4);
    expect(suite.config.companyName).toBe("StockSync");
  });

  it("every regex pattern in the suite compiles", () => {
    const walk = (a: unknown): void => {
      if (!a || typeof a !== "object") return;
      const o = a as Record<string, unknown>;
      if (typeof o["pattern"] === "string") expect(() => new RegExp(o["pattern"] as string, "i")).not.toThrow();
      if (Array.isArray(o["of"])) o["of"].forEach(walk);
    };
    for (const c of suite.cases) c.assertions.forEach(walk);
  });

  it("rejects unknown suites with a helpful message", () => {
    expect(() => loadSuite(TEMPLATES, "nope")).toThrow(ValidationError);
    expect(() => loadSuite(TEMPLATES, "../etc")).toThrow(/invalid suite name/);
  });
});
