import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cmdFacebook, FACEBOOK_HELP } from "../src/commands/facebook.ts";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "hq-fb-cli-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

function capture() {
  const out: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a) => void out.push(a.join(" ")));
  return out;
}

function writeConfig(facebook: unknown) {
  const file = path.join(dir, "agyhq.config.json");
  fs.writeFileSync(file, JSON.stringify({ dataDir: path.join(dir, "data"), adminToken: "t", facebook }));
  return file;
}

describe("hq facebook doctor", () => {
  it("prints help and rejects unknown subcommands and flags", async () => {
    const out = capture();
    await cmdFacebook(["--help"], { json: false });
    expect(out.join("\n")).toBe(FACEBOOK_HELP);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    await expect(cmdFacebook(["nope"], { json: false })).rejects.toThrow("exit");
    await expect(cmdFacebook(["doctor", "--bogus"], { json: false })).rejects.toThrow("exit");
    await expect(cmdFacebook(["doctor", "--local", "--daemon"], { json: false })).rejects.toThrow("exit");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("--local with the fake provider works fully offline: every check passes, nothing needs a token or the network", async () => {
    const out = capture();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await cmdFacebook(["doctor", "--local"], { json: false, configPath: writeConfig({ kind: "fake", pageId: "page-1", pageName: "Acme" }) });
    const text = out.join("\n");
    expect(text).toMatch(/facebook doctor +\(local\) +kind fake +page page-1/);
    expect(text).toMatch(/✓ Facebook channel configured/);
    expect(text).toMatch(/✓ Access token/);
    expect(text).toMatch(/✓ Page identity[^\n]*\n\s+Page "Acme" \(page-1\)/);
    for (const perm of ["pages_manage_posts", "pages_read_engagement", "pages_manage_engagement", "pages_read_user_content", "pages_show_list"]) {
      expect(text).toContain(`✓ Permission ${perm}`);
    }
    expect(text).toMatch(/! App mode/); // the fake reports Development
    expect(text).toMatch(/OK \(\d+ warning\(s\) to read above\)\./);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("--json prints the report object", async () => {
    const out = capture();
    await cmdFacebook(["doctor", "--local"], { json: true, configPath: writeConfig({ kind: "fake" }) });
    const report = JSON.parse(out.join("\n")) as { ok: boolean; mode: string; checks: { id: string }[] };
    expect(report).toMatchObject({ ok: true, mode: "local" });
    expect(report.checks.map((c) => c.id)).toContain("facebook.permission.pages_manage_posts");
  });

  it("prints whether the app secret is set and appsecret_proof is sent, never the values", async () => {
    const out = capture();
    vi.stubEnv("AGYHQ_FB_APP_SECRET", "FAKE-app-secret-xyz");
    const file = writeConfig({ kind: "fake", pageId: "page-1" });
    await cmdFacebook(["doctor", "--local"], { json: false, configPath: file });
    const text = out.join("\n");
    expect(text).toMatch(/app \(appId not set in the config\)  \|  app secret n\/a  \|  appsecret_proof not sent/);
    expect(text).not.toContain("FAKE-app-secret-xyz");
    vi.unstubAllEnvs();
  });

  it("exits 1 with the reason when the config is graph but the token env var is not set (and never prints a token)", async () => {
    delete process.env.AGYHQ_FB_PAGE_TOKEN_TEST_UNSET;
    const out = capture();
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    const file = writeConfig({ kind: "graph", pageId: "123", apiVersion: "v21.0", tokenEnv: "AGYHQ_FB_PAGE_TOKEN_TEST_UNSET" });
    await expect(cmdFacebook(["doctor", "--local"], { json: false, configPath: file })).rejects.toThrow("exit");
    expect(exit).toHaveBeenCalledWith(1);
    const text = out.join("\n");
    expect(text).toMatch(/✗ Facebook channel configured/);
    expect(text).toContain("AGYHQ_FB_PAGE_TOKEN_TEST_UNSET");
    expect(text).toMatch(/NOT SET/);
    expect(text).toMatch(/NOT OK: 1 failing check/);
  });

  it("exits 1 when facebook is not configured at all", async () => {
    const out = capture();
    vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    await expect(cmdFacebook(["doctor", "--local"], { json: false, configPath: writeConfig({ kind: "none" }) })).rejects.toThrow("exit");
    expect(out.join("\n")).toMatch(/facebook\.kind is "none"/);
  });
});
