import { describe, expect, it } from "vitest";
import { openDb } from "../src/index.ts";

describe("agentTokens", () => {
  it("issues a token that verifies, and rejects a wrong one", () => {
    const db = openDb(":memory:");
    db.agents.create({
      id: "sdr-01",
      role: "sales-sdr",
      displayName: "SDR",
      model: "m",
      workspacePath: "/tmp/sdr-01",
      policy: { builtins: [], mcp: [] },
    });

    const token = db.agentTokens.issue("sdr-01");
    expect(typeof token).toBe("string");
    expect(db.agentTokens.verify("sdr-01", token)).toBe(true);
    expect(db.agentTokens.verify("sdr-01", "not-the-token")).toBe(false);
    expect(db.agentTokens.verify("sdr-01", token + "x")).toBe(false);
    db.close();
  });

  it("reissue revokes the previous token", () => {
    const db = openDb(":memory:");
    db.agents.create({
      id: "sdr-01",
      role: "sales-sdr",
      displayName: "SDR",
      model: "m",
      workspacePath: "/tmp/sdr-01",
      policy: { builtins: [], mcp: [] },
    });

    const first = db.agentTokens.issue("sdr-01");
    const second = db.agentTokens.issue("sdr-01");
    expect(db.agentTokens.verify("sdr-01", first)).toBe(false);
    expect(db.agentTokens.verify("sdr-01", second)).toBe(true);
    db.close();
  });

  it("explicit revoke invalidates the token", () => {
    const db = openDb(":memory:");
    db.agents.create({
      id: "sdr-01",
      role: "sales-sdr",
      displayName: "SDR",
      model: "m",
      workspacePath: "/tmp/sdr-01",
      policy: { builtins: [], mcp: [] },
    });
    const token = db.agentTokens.issue("sdr-01");
    db.agentTokens.revoke("sdr-01");
    expect(db.agentTokens.verify("sdr-01", token)).toBe(false);
    db.close();
  });

  it("verify is false for an agent that never had a token", () => {
    const db = openDb(":memory:");
    expect(db.agentTokens.verify("nope", "anything")).toBe(false);
    db.close();
  });
});
